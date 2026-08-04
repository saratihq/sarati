import { emptySettings, type IRNode, type WorkflowIR } from '../../ir/models';
import { triggerConfigChangedAcrossVersions } from './trigger-config-diff';

function node(overrides: Partial<IRNode> & Pick<IRNode, 'id' | 'node_type'>): IRNode {
  return {
    name: overrides.id,
    type_version: 1,
    parameters: {},
    position: { x: 0, y: 0 },
    metadata: {},
    ...overrides,
  };
}

function ir(nodes: IRNode[]): WorkflowIR {
  return {
    version: '1',
    name: 'wf',
    description: '',
    nodes,
    edges: [],
    settings: emptySettings(),
    metadata: {},
  };
}

const TRIGGER = 'trig000000aa';
const STEP = 'step000000bb';

describe('triggerConfigChangedAcrossVersions (Obstacle 3 — via computeDiff, invariant #4)', () => {
  it('is false when the trigger node is byte-for-byte the same across versions', () => {
    const t = node({ id: TRIGGER, node_type: 'orchestr:webhook', parameters: { path: 'orders' } });
    expect(triggerConfigChangedAcrossVersions(ir([t]), ir([t]), TRIGGER)).toBe(false);
  });

  it('is true when the trigger node parameters change', () => {
    const before = node({ id: TRIGGER, node_type: 'orchestr:webhook', parameters: { path: 'orders' } });
    const after = node({
      id: TRIGGER,
      node_type: 'orchestr:webhook',
      parameters: { path: 'invoices' },
    });
    expect(triggerConfigChangedAcrossVersions(ir([before]), ir([after]), TRIGGER)).toBe(true);
  });

  it('is scoped to the node id: a change to a DIFFERENT node does not flag the trigger', () => {
    const t = node({ id: TRIGGER, node_type: 'orchestr:webhook', parameters: { path: 'orders' } });
    const stepBefore = node({ id: STEP, node_type: 'text.concat', parameters: { text: 'a' } });
    const stepAfter = node({ id: STEP, node_type: 'text.concat', parameters: { text: 'b' } });
    expect(triggerConfigChangedAcrossVersions(ir([t, stepBefore]), ir([t, stepAfter]), TRIGGER)).toBe(false);
  });

  it('is insensitive to parameter key ordering (deepEqual parity, not JSON.stringify)', () => {
    const before = node({ id: TRIGGER, node_type: 'orchestr:webhook', parameters: { a: 1, b: 2 } });
    const after = node({ id: TRIGGER, node_type: 'orchestr:webhook', parameters: { b: 2, a: 1 } });
    expect(triggerConfigChangedAcrossVersions(ir([before]), ir([after]), TRIGGER)).toBe(false);
  });
});
