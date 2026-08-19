import { compileWorkflowIrDag } from '../compiler/compile-ir-dag';
import { emptySettings, type IREdge, type IRNode, type WorkflowIR } from '../ir/models';
import type { ManagedIntegrationProvider } from '../providers/managed-integration-provider';
import type { RunOptions } from './base-plan-interpreter';
import { DagInterpreter } from './dag-interpreter';
import type { RunResult } from './run-plan';

/**
 * Code node end-to-end: a code leaf participates like any action — reading the run
 * scope, producing `scope[id]`, and flowing through the policy and pins.
 * Uses the REAL sandbox, so this is a live proof.
 */

function echoProvider(): ManagedIntegrationProvider {
  return {
    key: 'echo',
    runAction: (input) => Promise.resolve({ output: { ran: input.actionId, props: input.props } }),
    enableTrigger: () => Promise.resolve(),
    pollTrigger: () => Promise.resolve([]),
    disableTrigger: () => Promise.resolve(),
  };
}
function node(id: string, node_type: string, parameters: Record<string, unknown> = {}): IRNode {
  return { id, name: id, node_type, type_version: 1, parameters, position: { x: 0, y: 0 }, metadata: {} };
}
const act = (id: string, parameters: Record<string, unknown> = {}): IRNode =>
  node(id, `test.${id}`, parameters);
const code = (id: string, snippet: string, extra: Record<string, unknown> = {}): IRNode =>
  node(id, 'orchestr:code', { code: snippet, ...extra });
function edge(source: string, target: string, port_type = 'main'): IREdge {
  return {
    id: `${source}->${target}:${port_type}`,
    source_node_id: source,
    source_port: 0,
    target_node_id: target,
    target_port: 0,
    port_type,
  };
}
const ir = (nodes: IRNode[], edges: IREdge[] = []): WorkflowIR => ({
  version: '1',
  name: 'code-run',
  description: '',
  nodes,
  edges,
  settings: emptySettings(),
  metadata: {},
});
function run(workflow: WorkflowIR, opts: Partial<RunOptions> = {}): Promise<RunResult> {
  return new DagInterpreter(echoProvider()).run(compileWorkflowIrDag(workflow), {
    externalUserId: 'u',
    ...opts,
  });
}

describe('code node execution (live sandbox)', () => {
  it('transforms an upstream step output and downstream refs read the result', async () => {
    const { outputs } = await run(
      ir(
        [
          act('fetch'),
          code('shape', 'return { label: steps.fetch.ran, doubled: 21 * 2 };'),
          act('use', { note: '{{shape.label}}-{{shape.doubled}}' }),
        ],
        [edge('fetch', 'shape'), edge('shape', 'use')],
      ),
    );
    expect(outputs.shape).toEqual({ label: 'test.fetch', doubled: 42 });
    expect(outputs.use).toEqual({ ran: 'test.use', props: { note: 'test.fetch-42' } });
  });

  it('reads the trigger payload and awaits an async snippet', async () => {
    const { outputs } = await run(ir([code('c', 'return await Promise.resolve(trigger.amount * 2);')]), {
      initialScope: { trigger: { amount: 5 } },
    });
    expect(outputs.c).toBe(10);
  });

  it('a throwing snippet with onError:"continue" is tolerated and the run goes on', async () => {
    const { outputs } = await run(
      ir(
        [code('boom', 'throw new Error("nope");', { onError: 'continue' }), act('after')],
        [edge('boom', 'after')],
      ),
    );
    expect(outputs.boom).toMatchObject({
      __errored: true,
      error: { message: expect.stringContaining('nope') },
    });
    expect(outputs.after).toEqual({ ran: 'test.after', props: {} }); // downstream still ran
  });

  it('a snippet failure routes the error lane, then the run completes', async () => {
    const { outputs } = await run(
      ir(
        [
          code('risky', 'throw new Error("bad data");'),
          code('recover', 'return { recovered: steps.risky.error.message };'),
        ],
        [edge('risky', 'recover', 'error')],
      ),
    );
    expect(outputs.recover).toEqual({ recovered: expect.stringContaining('bad data') });
  });

  it('a stop-policy snippet failure halts the run (default)', async () => {
    await expect(run(ir([code('boom', 'throw new Error("fatal");')]))).rejects.toThrow(/fatal/);
  });

  it('a pinned code node replays its captured output and never executes', async () => {
    // The snippet would throw — but the pin replaces execution entirely, so the run succeeds.
    const { outputs } = await run(ir([code('pinned', 'throw new Error("should not run");')]), {
      pins: { pinned: { replayed: true } },
    });
    expect(outputs.pinned).toEqual({ replayed: true });
  });
});
