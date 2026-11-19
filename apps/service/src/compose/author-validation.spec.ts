import { DomainError } from '../common/domain-error';
import {
  assertAuthoredIrValid,
  connectionRequirements,
  getNodeCategory,
  isToolEligibleTarget,
  NODE_ID_RE,
  refWarningsOf,
  triggerTypesOf,
  unconfiguredConnections,
  unknownTriggerTypeHint,
  validateAuthoredIr,
  type AuthoringFacts,
} from './author-validation';

const BUILT_IN = [
  'orchestr:trigger',
  'orchestr:webhook',
  'orchestr:schedule',
  'orchestr:chat',
  'orchestr:tool_trigger',
];
/** What the trigger picker offers this workspace: the built-in kinds, an SDK poll, and one app trigger Composio lists. */
const OFFERED = new Set([...BUILT_IN, 'rss.new_item', 'gmail.new_email']);

/** A workspace whose Composio listing can be read, so the picker's list decides every trigger type. */
const FACTS: AuthoringFacts = {
  controlTypes: new Set(['orchestr:if', 'orchestr:agent', 'orchestr:loop', 'orchestr:code']),
  authOf: (type) => (type === 'slack.send_channel_message' ? 'oauth2' : 'none'),
  isTriggerType: (type) => type === 'rss.new_item',
  offersTrigger: (type) => OFFERED.has(type),
};

/** One whose Composio listing failed or ran late: only what is offered without it is decided. */
const UNLISTED: AuthoringFacts = {
  ...FACTS,
  offersTrigger: (type) => (OFFERED.has(type) && type !== 'gmail.new_email' ? true : 'listing_unavailable'),
};

/** One with no Composio key: likewise, for another reason. */
const KEYLESS: AuthoringFacts = {
  ...FACTS,
  offersTrigger: (type) => (OFFERED.has(type) && type !== 'gmail.new_email' ? true : 'no_composio_key'),
};

const unchecked = (type: string, why: 'no_composio_key' | 'listing_unavailable'): string =>
  why === 'no_composio_key'
    ? `Node "start" is this workflow's trigger, "${type}", an app trigger only Composio can fire, and this workspace has no Composio key: its list of app triggers can't be checked, so nothing refuses it; it can't fire until the workspace has a Composio key, and then only if Composio lists it.`
    : `Node "start" is this workflow's trigger, "${type}", an app trigger only Composio can fire, and Composio's list of app triggers could not be read just now — the listing failed or did not answer in time — so nothing refuses it; if Composio lists no such trigger, it never fires.`;

const unknownTrigger = (type: string): string =>
  `Node "start" is this workflow's trigger, but "${type}" is not a known trigger type — pick one from the trigger picker, or search the catalog for kind "trigger" and copy its exact "type"; the built-in ones are orchestr:trigger, orchestr:webhook, orchestr:schedule, orchestr:chat, orchestr:tool_trigger. As it is, the trigger never fires.`;

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

  /** A catalog trigger authored as a step is a MISSING MARKER, never an unknown type. */
  it('names the missing trigger marker instead of calling a catalog trigger unrecognized', () => {
    const report = validateAuthoredIr(doc({ nodes: [node({ node_type: 'rss.new_item' })] }), FACTS);
    const [first] = report.errors;
    expect(first?.code).toBe('trigger_not_marked');
    expect(first?.message).toContain('"metadata": {"trigger": true}');
    expect(report.errors.map((e) => e.code)).not.toContain('unresolvable_node_type');
  });

  it('accepts the same node once it carries the trigger marker', () => {
    const marked = doc({
      nodes: [node({ node_type: 'rss.new_item', metadata: { trigger: true } })],
    });
    expect(validateAuthoredIr(marked, FACTS).valid).toBe(true);
  });

  /** The compiler peels every trigger, so a trigger no rail can stand up would save and never fire. */
  it('refuses a trigger whose type names no trigger, whether or not Composio can be asked', () => {
    for (const facts of [FACTS, UNLISTED, KEYLESS]) {
      for (const trigger of [
        { node_type: 'orchestr:webhok', metadata: { trigger: true } },
        { node_type: 'form_trigger' },
        { node_type: 'orchestr:code', parameters: { code: 'return 1;' }, metadata: { trigger: true } },
        { node_type: 'Acme.new_deal', metadata: { trigger: true } },
        { node_type: '.new_deal', metadata: { trigger: true } },
        { node_type: 'gmail.', metadata: { trigger: true } },
        { node_type: 'orchestr.webhook', metadata: { trigger: true } },
        { node_type: 'gmail.New_Mail', metadata: { trigger: true } },
        { node_type: 'n8n-nodes-base.manualTrigger', metadata: { trigger: true } },
      ]) {
        const report = validateAuthoredIr(doc({ nodes: [node({ id: 'start', ...trigger })] }), facts);
        expect(report.errors).toEqual([
          {
            code: 'unknown_trigger_type',
            node_id: 'start',
            node_name: 'Say',
            node_type: trigger.node_type,
            message: unknownTrigger(trigger.node_type),
          },
        ]);
      }
    }
  });

  it('refuses an app trigger the listing does not offer, as the composer refuses to retype to it', () => {
    for (const type of ['gmail.new_emial', 'orchestr.webhook', 'acmecrm.new_deal']) {
      const trigger = node({ id: 'start', node_type: type, metadata: { trigger: true } });
      const report = validateAuthoredIr(doc({ nodes: [trigger, node()] }), FACTS);
      expect(report.errors).toEqual([
        {
          code: 'unknown_trigger_type',
          node_id: 'start',
          node_name: 'Say',
          node_type: type,
          message: unknownTrigger(type),
        },
      ]);
    }
  });

  /** Composio being down, or not set up for the workspace, never blocks a save — it flags what it could not check, and why. */
  it("admits an app trigger Composio can't be asked about, flagged as unchecked for the reason it can't", () => {
    for (const [facts, why] of [
      [UNLISTED, 'listing_unavailable'],
      [KEYLESS, 'no_composio_key'],
    ] as const) {
      for (const type of ['gmail.new_email', 'gmail.new_emial', 'acmecrm.new_deal']) {
        const trigger = node({ id: 'start', node_type: type, metadata: { trigger: true } });
        const report = validateAuthoredIr(doc({ nodes: [trigger, node()] }), facts);
        expect(report.errors).toEqual([]);
        expect(report.warnings).toEqual([
          {
            code: 'trigger_type_unverified',
            node_id: 'start',
            node_name: 'Say',
            node_type: type,
            message: unchecked(type, why),
          },
        ]);
      }
    }
  });

  /** Row 25: a known type the instance does not serve is refused in the words its route refusal uses, naming its subscribed twin. */
  it('refuses the hand-polled Gmail trigger where it is not offered, naming the trigger to use instead', () => {
    const type = 'gmail.gmail_new_email_received';
    expect(FACTS.offersTrigger(type)).toBe(false);
    const notServed = `Use "New Gmail Message Received Trigger" (gmail.gmail_new_gmail_message) instead: this instance doesn't run "New Email" (${type}), which would spend one of the account owner's monthly app actions on every poll, whether or not anything arrived. Composio checks the app for the one to use, and each event it delivers counts as a trigger event, not an app action`;
    const trigger = node({ id: 'start', node_type: type, metadata: { trigger: true } });
    expect(validateAuthoredIr(doc({ nodes: [trigger, node()] }), FACTS).errors).toEqual([
      {
        code: 'unknown_trigger_type',
        node_id: 'start',
        node_name: 'Say',
        node_type: type,
        message: `Node "start" is this workflow's trigger. ${notServed}.`,
      },
    ]);
    expect(unknownTriggerTypeHint(type)).toBe(notServed);
  });

  it('accepts every trigger the listing offers, flagging none', () => {
    for (const facts of [FACTS, UNLISTED, KEYLESS]) {
      for (const type of [...OFFERED].filter((t) => facts.offersTrigger(t) === true)) {
        const trigger = node({ id: 'start', node_type: type, metadata: { trigger: true } });
        const report = validateAuthoredIr(doc({ nodes: [trigger, node()] }), facts);
        expect(report.errors).toEqual([]);
        expect(report.warnings).toEqual([]);
      }
    }
  });

  it('names the type of every node a document marks as its trigger, and no step', () => {
    const marked = node({ id: 'start', node_type: 'gmail.new_email', metadata: { trigger: true } });
    expect(
      triggerTypesOf(doc({ nodes: [marked, node(), node({ id: 'hook', node_type: 'orchestr:webhook' })] })),
    ).toEqual(['gmail.new_email', 'orchestr:webhook']);
  });

  /** Reported once, from the compiler that refuses it, with the node it names. */
  it('refuses a Code step in a language the sandbox does not run, saying which ones it does', () => {
    for (const language of ['python', 'typescript', 'javascript', 'JS', '', 5]) {
      const code = node({
        id: 'calc',
        node_type: 'orchestr:code',
        parameters: { language, code: 'return 1;' },
      });
      expect(validateAuthoredIr(doc({ nodes: [code] }), FACTS).errors).toEqual([
        {
          code: 'unsupported_code_language',
          node_id: 'calc',
          node_name: 'Say',
          node_type: 'orchestr:code',
          message: `Code node "calc" has "language": ${JSON.stringify(language)}, which the sandbox does not run — set it to "js" or "ts", or remove it for "js"`,
        },
      ]);
    }
  });

  it('accepts a Code step in js, in ts, or with no language or a null one, which is js', () => {
    for (const parameters of [{ language: 'js' }, { language: 'ts' }, {}, { language: null }]) {
      const code = node({ node_type: 'orchestr:code', parameters: { ...parameters, code: 'return 1;' } });
      expect(validateAuthoredIr(doc({ nodes: [code] }), FACTS).errors).toEqual([]);
    }
  });

  /** Whatever fails at run fails at save: the compiler reads both arrays, so a document missing one never runs. */
  it('refuses a document with no nodes array or no edges array, rather than skipping the checks the compiler runs', () => {
    const code = node({
      id: 'calc',
      node_type: 'orchestr:code',
      parameters: { language: 'python', code: 'x' },
    });
    const structure = {
      code: 'invalid_workflow_structure',
      message:
        'A workflow document needs a "nodes" array and an "edges" array — an empty "edges" when nothing is connected.',
    };
    for (const over of [{ edges: undefined }, { edges: null }, { edges: {} }, { nodes: { calc: code } }]) {
      expect(validateAuthoredIr(doc({ nodes: [code], ...over }), FACTS).errors).toEqual([structure]);
    }
    expect(codesOf(doc({ nodes: [code], edges: [] }))).toEqual(['unsupported_code_language']);
  });

  it('refuses both at the commit path as a 422 carrying the code and the node type', () => {
    const refusalOf = (over: Record<string, unknown>): Record<string, unknown> | undefined => {
      try {
        assertAuthoredIrValid(doc({ nodes: [node(over)] }), FACTS);
        return undefined;
      } catch (err) {
        expect((err as DomainError).status).toBe(422);
        return (err as DomainError).details;
      }
    };
    expect(refusalOf({ node_type: 'orchestr:webhok', metadata: { trigger: true } })).toMatchObject({
      code: 'unknown_trigger_type',
      node_type: 'orchestr:webhok',
    });
    expect(
      refusalOf({ node_type: 'orchestr:code', parameters: { language: 'python', code: 'x' } }),
    ).toMatchObject({
      code: 'unsupported_code_language',
      node_id: 'say',
      node_type: 'orchestr:code',
    });
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

  it('warns on {{$account…}} only where the action signs in to nothing, whatever account the step chose', () => {
    const ir = doc({
      nodes: [
        node({
          id: 'post',
          name: 'Post as me',
          node_type: 'slack.send_channel_message',
          parameters: { text: 'From {{$account.name}}' },
        }),
        node({ id: 'join', name: 'Join', parameters: { texts: ['{{$account.email}}'], connectionId: 'c1' } }),
        node({
          id: 'ghost',
          name: 'Ghost',
          node_type: 'ghost.vanished',
          parameters: { to: '{{$account.email}}' },
        }),
      ],
    });
    const expected = [
      '"Join" uses {{$account.email}}, but its action signs in to nothing, so nothing can fill it',
    ];
    expect(validateAuthoredIr(ir, FACTS).ref_warnings).toEqual(expected);
    expect(refWarningsOf(ir, FACTS)).toEqual(expected);
  });

  it('warns once on a step whose action signs in to nothing, even for a field an account lacks', () => {
    const ir = doc({
      nodes: [
        node({
          id: 'post',
          name: 'Post as me',
          node_type: 'slack.send_channel_message',
          parameters: { text: 'From {{$account.address}}' },
        }),
        node({
          id: 'join',
          name: 'Join',
          parameters: { texts: ['{{$account.address}}', '{{$account.phone}}'] },
        }),
      ],
    });
    const expected = [
      '"Post as me" uses {{$account.address}}, but an account has only an email, handle, id and name',
      '"Join" uses {{$account.address}}, but its action signs in to nothing, so nothing can fill it',
    ];
    expect(validateAuthoredIr(ir, FACTS).ref_warnings).toEqual(expected);
    expect(refWarningsOf(ir, FACTS)).toEqual(expected);
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
