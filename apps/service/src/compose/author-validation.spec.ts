import { DomainError } from '../common/domain-error';
import {
  assertAuthoredIrValid,
  connectionRequirements,
  getNodeCategory,
  isToolEligibleTarget,
  NODE_ID_RE,
  unconfiguredConnections,
  validateAuthoredIr,
  type CatalogFacts,
} from './author-validation';

const FACTS: CatalogFacts = {
  controlTypes: new Set(['orchestr:if', 'orchestr:agent', 'orchestr:loop']),
  authOf: (type) => (type === 'slack.send_channel_message' ? 'oauth2' : 'none'),
};

const node = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'say',
  name: 'Say',
  node_type: 'text.concat',
  type_version: 1,
  parameters: { texts: ['hi'], separator: '' },
  position: { x: 0, y: 0 },
  metadata: {},
  ...over,
});

const doc = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: '1.0',
  name: 'doc',
  nodes: [node()],
  edges: [],
  settings: { execution_order: 'v1', extra: {} },
  metadata: {},
  ...over,
});

const codesOf = (ir: Record<string, unknown>): string[] =>
  validateAuthoredIr(ir, FACTS).errors.map((e) => e.code);

describe('the one author-time gate', () => {
  it('passes a document that will commit, compile and run', () => {
    const report = validateAuthoredIr(doc(), FACTS);
    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it('rejects a node id that is not a stable identifier (invariant #13)', () => {
    expect(codesOf(doc({ nodes: [node({ id: 'not a valid id!' })] }))).toContain('invalid_node_id');
    expect(NODE_ID_RE.test('send_email-2')).toBe(true);
  });

  it('rejects two nodes sharing an id — ids are identity', () => {
    expect(codesOf(doc({ nodes: [node(), node({ name: 'Other' })] }))).toContain('duplicate_node_id');
  });

  it('rejects a type no rail can run', () => {
    expect(codesOf(doc({ nodes: [node({ node_type: 'ghost.vanished' })] }))).toContain(
      'unresolvable_node_type',
    );
  });

  /** The compiler peels every trigger, so a second one would silently never fire. */
  it('rejects a second trigger rather than letting the compiler swallow it', () => {
    const codes = codesOf(
      doc({
        nodes: [
          node({ id: 'a', node_type: 'orchestr:webhook' }),
          node({ id: 'b', node_type: 'orchestr:schedule' }),
        ],
      }),
    );
    expect(codes).toContain('multiple_triggers');
  });

  it('accepts exactly one trigger', () => {
    const report = validateAuthoredIr(
      doc({ nodes: [node({ id: 'a', node_type: 'orchestr:webhook' }), node()] }),
      FACTS,
    );
    expect(report.errors.map((e) => e.code)).not.toContain('multiple_triggers');
  });

  /** The compiler drops such an edge silently, so reporting it must not block a commit. */
  it('reports an edge to a node that does not exist as ADVISORY, not blocking', () => {
    const report = validateAuthoredIr(
      doc({
        edges: [
          {
            id: 'e1',
            source_node_id: 'say',
            source_port: 0,
            target_node_id: 'nowhere',
            target_port: 0,
            port_type: 'main',
          },
        ],
      }),
      FACTS,
    );
    expect(report.warnings.map((w) => w.code)).toContain('dangling_edge');
    expect(report.errors).toEqual([]);
    expect(report.valid).toBe(true);
  });

  it('rejects a node wired to itself', () => {
    const codes = codesOf(
      doc({
        edges: [
          {
            id: 'e1',
            source_node_id: 'say',
            source_port: 0,
            target_node_id: 'say',
            target_port: 0,
            port_type: 'main',
          },
        ],
      }),
    );
    expect(codes).toContain('self_edge');
  });

  it('rejects a tool edge bound to something the agent cannot call (invariant #14)', () => {
    const codes = codesOf(
      doc({
        nodes: [
          node({ id: 'brain', node_type: 'orchestr:agent' }),
          node({ id: 'gate', node_type: 'orchestr:if' }),
        ],
        edges: [
          {
            id: 'e1',
            source_node_id: 'brain',
            source_port: 0,
            target_node_id: 'gate',
            target_port: 0,
            port_type: 'tool',
          },
        ],
      }),
    );
    expect(codes).toContain('tool_edge_ineligible_target');
    expect(isToolEligibleTarget({ node_type: 'orchestr:if' })).toBe(false);
    expect(isToolEligibleTarget({ node_type: 'slack.send_channel_message' })).toBe(true);
  });

  /**
   * The compiler peels EVERY trigger before the tool-edge peel (`isTriggerNode`), so a tool edge
   * to one is dropped in silence — the gate must categorise the whole trigger family as a trigger.
   */
  it('refuses a tool edge bound to a trigger, whichever way that node declares itself', () => {
    expect(getNodeCategory('orchestr:tool_trigger')).toBe('trigger');
    expect(isToolEligibleTarget({ node_type: 'orchestr:tool_trigger' })).toBe(false);
    // An app trigger is lexically an action; only `metadata.trigger` tells it apart.
    expect(isToolEligibleTarget({ node_type: 'gmail.new_email', metadata: { trigger: true } })).toBe(false);
    expect(isToolEligibleTarget({ node_type: 'gmail.new_email' })).toBe(true);

    const toolEdgeTo = (targetId: string, target: Record<string, unknown>): string[] =>
      codesOf(
        doc({
          nodes: [node({ id: 'brain', node_type: 'orchestr:agent' }), node({ id: targetId, ...target })],
          edges: [
            {
              id: 'e1',
              source_node_id: 'brain',
              source_port: 0,
              target_node_id: targetId,
              target_port: 0,
              port_type: 'tool',
            },
          ],
        }),
      );
    expect(toolEdgeTo('start', { node_type: 'orchestr:tool_trigger' })).toContain(
      'tool_edge_ineligible_target',
    );
    expect(toolEdgeTo('inbox', { node_type: 'gmail.new_email', metadata: { trigger: true } })).toContain(
      'tool_edge_ineligible_target',
    );
  });

  /**
   * Layout is presentation, so this must stay ADVISORY — `/api/deploy` accepts position-less
   * documents. It is reported because a node without one stacks at the origin, NOT because the
   * document is unrunnable: `ir/diff.ts` reads such a node without throwing (its own named test).
   */
  it('reports a node with no usable position as ADVISORY, not blocking', () => {
    const positionless = node();
    delete positionless.position;
    const report = validateAuthoredIr(doc({ nodes: [positionless] }), FACTS);
    expect(report.warnings.map((w) => w.code)).toContain('invalid_node_position');
    expect(report.valid).toBe(true);

    const warningsOf = (ir: Record<string, unknown>): string[] =>
      validateAuthoredIr(ir, FACTS).warnings.map((w) => w.code);
    expect(warningsOf(doc({ nodes: [node({ position: { x: 'left', y: 0 } })] }))).toContain(
      'invalid_node_position',
    );
    expect(warningsOf(doc({ nodes: [node({ position: { x: Number.NaN, y: 0 } })] }))).toContain(
      'invalid_node_position',
    );
    expect(warningsOf(doc())).not.toContain('invalid_node_position');
  });

  /** An unknown lane is not a lane: the compiler routes main/error/tool and drops everything else. */
  it('refuses an edge on a lane the compiler cannot route, and reads an absent lane as main', () => {
    const edgeOn = (portType: unknown): Record<string, unknown> => ({
      id: 'e1',
      source_node_id: 'say',
      source_port: 0,
      target_node_id: 'other',
      target_port: 0,
      ...(portType === undefined ? {} : { port_type: portType }),
    });
    const withEdge = (portType: unknown): Record<string, unknown> =>
      doc({ nodes: [node(), node({ id: 'other' })], edges: [edgeOn(portType)] });

    expect(codesOf(withEdge('sideways'))).toContain('unknown_edge_port_type');
    expect(codesOf(withEdge(''))).toContain('unknown_edge_port_type');
    for (const lane of ['main', 'error', 'tool', undefined]) {
      expect(codesOf(withEdge(lane))).not.toContain('unknown_edge_port_type');
    }
  });

  it('reports every node that needs a credential and whether it has one', () => {
    const ir = doc({
      nodes: [
        node({ id: 'wired', node_type: 'slack.send_channel_message', parameters: { connectionId: 'c1' } }),
        node({ id: 'bare', node_type: 'slack.send_channel_message', parameters: {} }),
        node(),
      ],
    });
    expect(connectionRequirements(ir, FACTS).map((r) => [r.node_id, r.configured])).toEqual([
      ['wired', true],
      ['bare', false],
    ]);
    expect(unconfiguredConnections(ir, FACTS).map((r) => r.node_id)).toEqual(['bare']);
  });

  it('throws the first error as a 422 carrying its machine code, for the commit path', () => {
    expect.assertions(3);
    try {
      assertAuthoredIrValid(doc({ nodes: [node({ id: 'bad id' })] }), FACTS);
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).status).toBe(422);
      expect((err as DomainError).details?.code).toBe('invalid_node_id');
    }
  });

  it('returns the report when the document is clean, so commit reuses its ref warnings', () => {
    expect(assertAuthoredIrValid(doc(), FACTS).valid).toBe(true);
  });

  /** The client's phantom-flagging UI reads `node_type` off the error body. */
  it('carries the offending node_type on an unresolvable-type refusal', () => {
    expect.assertions(1);
    try {
      assertAuthoredIrValid(doc({ nodes: [node({ node_type: 'ghost.vanished' })] }), FACTS);
    } catch (err) {
      expect((err as DomainError).details?.node_type).toBe('ghost.vanished');
    }
  });
});
