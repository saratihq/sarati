import { emptySettings, type IRNode, type WorkflowIR } from '../../ir/models';
import { deriveDesiredActivations, reconcileActivations, type EnvPointerInput } from './reconcile';
import { type ActivationKind, type DesiredActivation } from './trigger-activation';

// ─── fixtures ───

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

const WF = 'wf000000000000000000000000000001';
const PROD = 'env-prod';
const STAGING = 'env-staging';
const WEBHOOK = node({
  id: 'trigwebhook01',
  node_type: 'orchestr:webhook',
  parameters: { path: 'orders' },
});
const POLLER = node({
  id: 'trigpoll00001',
  node_type: 'gmail.poll_new_email',
  parameters: { url: 'x' },
  // Catalog polling triggers carry the trigger marker (isTriggerNode reads it).
  metadata: { trigger: true },
});
const ACTION = node({ id: 'stepaction001', node_type: 'text.concat', parameters: { text: 'a' } });
// A trigger node with NO runtime activation — the real kindOf returns null for it.
const MANUAL = node({ id: 'trigmanual001', node_type: 'orchestr:trigger', parameters: {} });

const kindOf = (n: IRNode): ActivationKind | null =>
  n.node_type === 'orchestr:trigger' ? null : n.node_type === 'orchestr:webhook' ? 'webhook' : 'polling';

function desired(over: Partial<DesiredActivation> & Pick<DesiredActivation, 'key'>): DesiredActivation {
  return {
    kind: 'polling',
    triggerType: 'gmail.poll_new_email',
    versionId: 'v1',
    props: {},
    connection: null,
    paused: false,
    ...over,
  };
}

// ─── deriveDesiredActivations ───

describe('deriveDesiredActivations (DESIRED = env pointers × version-doc trigger nodes)', () => {
  it('extracts only trigger nodes (actions excluded), one per (env, node)', () => {
    const pointers: EnvPointerInput[] = [
      { environmentId: PROD, versionId: 'v5', ir: ir([WEBHOOK, POLLER, ACTION]) },
    ];
    const result = deriveDesiredActivations({
      workflowId: WF,
      pointers,
      kindOf,
      connectionOf: (_env, n) => (kindOf(n) === 'polling' ? { connectionId: 'c1', ownerUserId: 'u1' } : null),
    });
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.key.triggerNodeId).sort()).toEqual([WEBHOOK.id, POLLER.id].sort());
    const webhook = result.find((r) => r.key.triggerNodeId === WEBHOOK.id)!;
    expect(webhook.kind).toBe('webhook');
    expect(webhook.connection).toBeNull();
    expect(webhook.versionId).toBe('v5');
  });

  it('excludes the MANUAL trigger — it fires on demand only, so it has no runtime activation', () => {
    const pointers: EnvPointerInput[] = [
      { environmentId: PROD, versionId: 'v5', ir: ir([MANUAL, POLLER, ACTION]) },
    ];
    const result = deriveDesiredActivations({ workflowId: WF, pointers, kindOf, connectionOf: () => null });
    expect(result.map((r) => r.key.triggerNodeId)).toEqual([POLLER.id]);
  });

  it('unions across env pointers — the same trigger node yields one activation per env', () => {
    const pointers: EnvPointerInput[] = [
      { environmentId: PROD, versionId: 'v5', ir: ir([WEBHOOK]) },
      { environmentId: STAGING, versionId: 'v7', ir: ir([WEBHOOK]) },
    ];
    const result = deriveDesiredActivations({ workflowId: WF, pointers, kindOf, connectionOf: () => null });
    expect(result.map((r) => r.key.environmentId).sort()).toEqual([PROD, STAGING].sort());
  });
});

// ─── reconcileActivations ───

describe('reconcileActivations (idempotent desired-vs-actual sweep)', () => {
  const key = { workflowId: WF, environmentId: PROD, triggerNodeId: POLLER.id };

  it('empty vs empty → empty plan', () => {
    expect(reconcileActivations([], [])).toEqual({ toCreate: [], toUpdate: [], toDelete: [] });
  });

  it('a desired key with no actual → toCreate', () => {
    const d = desired({ key });
    const plan = reconcileActivations([d], []);
    expect(plan.toCreate).toEqual([d]);
    expect(plan.toUpdate).toHaveLength(0);
    expect(plan.toDelete).toHaveLength(0);
  });

  it('an actual key no longer desired → toDelete (e.g. after unpromote)', () => {
    const a = desired({ key });
    const plan = reconcileActivations([], [a]);
    expect(plan.toDelete).toEqual([a]);
    expect(plan.toCreate).toHaveLength(0);
  });

  it('fully converged (same version, same descriptor) → no-op, and is idempotent', () => {
    const d = desired({ key, versionId: 'v5', props: { url: 'x' } });
    const plan = reconcileActivations([d], [d]);
    expect(plan).toEqual({ toCreate: [], toUpdate: [], toDelete: [] });
  });

  it('same config but a NEW version answers (promote of an unchanged trigger) → update, cursor KEPT', () => {
    const d = desired({
      key,
      versionId: 'v6',
      props: { url: 'x' },
      connection: { connectionId: 'c1', ownerUserId: 'u1' },
    });
    const a = desired({
      key,
      versionId: 'v5',
      props: { url: 'x' },
      connection: { connectionId: 'c1', ownerUserId: 'u1' },
    });
    const plan = reconcileActivations([d], [a]);
    expect(plan.toUpdate).toHaveLength(1);
    expect(plan.toUpdate[0]!.cursorAction).toBe('keep');
    expect(plan.toUpdate[0]!.desired.versionId).toBe('v6');
  });

  it('trigger props changed across the promote → update, cursor RESET', () => {
    const d = desired({ key, versionId: 'v6', props: { url: 'y' } });
    const a = desired({ key, versionId: 'v5', props: { url: 'x' } });
    expect(reconcileActivations([d], [a]).toUpdate[0]!.cursorAction).toBe('reset');
  });

  it('a slot swap (connection change, same version) → update, cursor RESET', () => {
    const d = desired({
      key,
      versionId: 'v5',
      props: { url: 'x' },
      connection: { connectionId: 'c2', ownerUserId: 'u2' },
    });
    const a = desired({
      key,
      versionId: 'v5',
      props: { url: 'x' },
      connection: { connectionId: 'c1', ownerUserId: 'u1' },
    });
    const plan = reconcileActivations([d], [a]);
    expect(plan.toUpdate).toHaveLength(1);
    expect(plan.toUpdate[0]!.cursorAction).toBe('reset');
  });

  it('pausing an activation is a descriptor change → update, cursor RESET', () => {
    const d = desired({ key, versionId: 'v5', props: { url: 'x' }, paused: true });
    const a = desired({ key, versionId: 'v5', props: { url: 'x' }, paused: false });
    expect(reconcileActivations([d], [a]).toUpdate[0]!.cursorAction).toBe('reset');
  });

  it('mixed sweep: create + keep-update + delete in one pass', () => {
    const keep = { workflowId: WF, environmentId: PROD, triggerNodeId: POLLER.id };
    const gone = { workflowId: WF, environmentId: STAGING, triggerNodeId: POLLER.id };
    const fresh = { workflowId: WF, environmentId: 'env-uat', triggerNodeId: WEBHOOK.id };

    const desiredSet = [
      desired({ key: keep, versionId: 'v6', props: { url: 'x' } }),
      desired({ key: fresh, kind: 'webhook', versionId: 'v6' }),
    ];
    const actualSet = [
      desired({ key: keep, versionId: 'v5', props: { url: 'x' } }),
      desired({ key: gone, versionId: 'v5' }),
    ];
    const plan = reconcileActivations(desiredSet, actualSet);
    expect(plan.toCreate.map((c) => c.key.environmentId)).toEqual(['env-uat']);
    expect(plan.toUpdate.map((u) => u.cursorAction)).toEqual(['keep']);
    expect(plan.toDelete.map((x) => x.key.environmentId)).toEqual([STAGING]);
  });
});
