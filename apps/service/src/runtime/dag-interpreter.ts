import { Inject, Injectable, Optional } from '@nestjs/common';

import {
  MANAGED_INTEGRATION_PROVIDER,
  type ManagedIntegrationProvider,
} from '../providers/managed-integration-provider';
import {
  AGENT_MODEL_CALL,
  AGENT_STEP_SINK,
  AGENT_TOOL_CATALOG,
  type AgentModelPort,
  type AgentStepSink,
  type AgentToolCatalog,
} from './agent';
import { BasePlanInterpreter, type RunContext, type RunOptions } from './base-plan-interpreter';
import { BLOB_STORE, type BlobStore } from './blob-store';
import { CodeRunner } from './code-runner';
import { evaluateCondition } from './conditions';
import type { DagIfNode, DagNode, DagPlan, DagSwitchNode, Guard } from './dag-plan';
import type { RunResult } from './run-plan';

/** Default bound on how many READY-and-live nodes run at once (slice 5); no user-facing knob. */
export const DAG_MAX_CONCURRENCY = 8;

/** DI seam for the concurrency bound — unregistered by default (the constant wins). */
export const DAG_CONCURRENCY = Symbol('DAG_CONCURRENCY');

/**
 * The ONE runtime (slice 4): a gating scheduler over a flat, topo-sorted `DagPlan` whose
 * control flow is expressed by GUARDS. It owns ONLY scheduling; every per-node semantic is
 * inherited from `BasePlanInterpreter`.
 *
 * A node runs when it is a root or ≥1 guard is live; a guard `{source, port}` is live iff `source`
 * ran and that port is live (an IF/SWITCH makes only its selected port live). A node whose guards
 * are all dead is skipped, writing and recording nothing. Fan-in is an OR-join: one node, one run,
 * fired by any live path. Execution is a bounded concurrent wave (slice 5); `concurrency === 1`
 * reproduces a sequential topo sweep byte-for-byte, though trace order becomes interleaved.
 */
@Injectable()
export class DagInterpreter extends BasePlanInterpreter {
  /** Max nodes in flight per scheduling scope; ≥1 (clamped). Injectable for tests. */
  private readonly concurrency: number;

  constructor(
    @Inject(MANAGED_INTEGRATION_PROVIDER) provider: ManagedIntegrationProvider,
    @Optional() @Inject(BLOB_STORE) blobStore?: BlobStore,
    @Optional() @Inject(DAG_CONCURRENCY) concurrency: number = DAG_MAX_CONCURRENCY,
    @Optional() codeRunner?: CodeRunner,
    @Optional() @Inject(AGENT_MODEL_CALL) agentModel?: AgentModelPort,
    @Optional() @Inject(AGENT_TOOL_CATALOG) agentToolCatalog?: AgentToolCatalog,
    @Optional() @Inject(AGENT_STEP_SINK) agentStepSink?: AgentStepSink,
  ) {
    super(provider, blobStore, codeRunner, agentModel, agentToolCatalog, agentStepSink);
    this.concurrency = Math.max(1, concurrency);
  }

  run(plan: DagPlan, opts: RunOptions): Promise<RunResult> {
    return this.runProgram(plan, opts, (nodes, scope, path, ctx) => this.schedule(nodes, scope, path, ctx));
  }

  /**
   * A bounded concurrent wave over a flat node list. Nodes are topo-sorted with the IR-order
   * tie-break, so a node's guard sources always precede it: track how many in-plan sources have yet
   * to settle, run once that hits zero, and roll the wave forward. Always taking the LOWEST ready
   * index is what makes `concurrency === 1` byte-identical to a sequential sweep.
   */
  private async schedule(
    nodes: DagNode[],
    scope: Record<string, unknown>,
    path: string,
    ctx: RunContext,
  ): Promise<void> {
    // Ids must be unique: bookkeeping is keyed by id, and under concurrency the base's per-node
    // duplicate guard is racy (two same-id nodes could both pass it before either writes).
    const seen = new Set<string>();
    for (const node of nodes) {
      if (seen.has(node.id)) throw new Error(`Duplicate node id "${node.id}" in plan ${ctx.planId}`);
      seen.add(node.id);
    }

    const byId = new Map(nodes.map((n) => [n.id, n]));
    // In `ran` once EXECUTED (not skipped); absent ⇒ skipped or not yet settled.
    const ran = new Set<string>();
    const ifLivePort = new Map<string, number>();
    const switchLivePort = new Map<string, number>();

    const guardLive = (guard: Guard): boolean => {
      if (!ran.has(guard.source)) return false; // source skipped/absent → its ports are dead
      const source = byId.get(guard.source);
      // Only an IF/SWITCH's SELECTED port is live; every other source's single output
      // (port 0) is live once it ran.
      if (source && source.kind === 'if') return ifLivePort.get(guard.source) === guard.port;
      if (source && source.kind === 'switch') return switchLivePort.get(guard.source) === guard.port;
      return true;
    };

    // ── Worklist state ───────────────────────────────────────────────────────
    // A node is READY once every guard source that lives in THIS plan has settled. An external
    // source can never settle — it is permanently dead, as `guardLive` treats it — so it must NOT
    // be counted, else the node would hang forever.
    const inPlanSources = (n: DagNode): Set<string> =>
      new Set(n.guards.map((g) => g.source).filter((s) => byId.has(s)));
    const pending = nodes.map((n) => inPlanSources(n).size);
    // source id → distinct dependent indices (once per source, even across two ports).
    const dependents = new Map<string, number[]>();
    nodes.forEach((n, i) => {
      for (const source of inPlanSources(n)) {
        const list = dependents.get(source);
        if (list) list.push(i);
        else dependents.set(source, [i]);
      }
    });
    // Indices whose in-plan sources have all settled; always take the LOWEST next.
    const ready: number[] = [];
    pending.forEach((count, i) => {
      if (count === 0) ready.push(i);
    });

    let halted = false; // once a node fails / error-lane-halts: launch no NEW work
    let haltError: unknown = null; // the first outcome to propagate after draining
    const active = new Set<Promise<void>>();

    // Unblock a settled node's dependents; enqueue any that are now ready.
    const settle = (id: string): void => {
      for (const depIdx of dependents.get(id) ?? []) {
        const remaining = pending[depIdx]! - 1;
        pending[depIdx] = remaining;
        if (remaining === 0) ready.push(depIdx);
      }
    };
    const takeLowest = (): number => {
      let best = 0;
      for (let i = 1; i < ready.length; i++) if (ready[i]! < ready[best]!) best = i;
      return ready.splice(best, 1)[0]!;
    };

    // Launch READY-and-live nodes up to the bound. Skip / IF / SWITCH are pure, I/O-free settles
    // done inline (no slot consumed); every other live node holds a slot until it settles.
    const pump = (): void => {
      while (!halted && active.size < this.concurrency && ready.length > 0) {
        const idx = takeLowest();
        const node = nodes[idx]!;
        const live = node.guards.length === 0 || node.guards.some(guardLive);
        if (!live) {
          // Skipped: record the id as `undefined` so a downstream OR-join referencing it
          // resolves to `undefined` instead of tripping the resolver's fail-fast "unknown
          // step" throw. A truly-unknown id stays absent, so typo protection holds.
          scope[node.id] = undefined;
          settle(node.id);
          continue;
        }
        if (node.kind === 'if') {
          // Pure routing (no scope output, no I/O): settle synchronously so the
          // selected port is visible before any dependent is scheduled.
          ifLivePort.set(node.id, evaluateCondition(node.condition, scope) ? 0 : 1);
          ran.add(node.id);
          settle(node.id);
          continue;
        }
        if (node.kind === 'switch') {
          // Pure routing, like IF: cases evaluate IN ORDER, first match wins, else the
          // default port. Settled synchronously so the port is visible before any dependent.
          let selected = node.cases.length; // default/fallback when no case matches
          for (let i = 0; i < node.cases.length; i++) {
            if (evaluateCondition(node.cases[i]!.condition, scope)) {
              selected = i;
              break;
            }
          }
          switchLivePort.set(node.id, selected);
          ran.add(node.id);
          settle(node.id);
          continue;
        }
        const promise = this.executeLiveNode(node, scope, path, ctx)
          .then(() => {
            ran.add(node.id);
            settle(node.id);
          })
          .catch((err: unknown) => {
            // Fatal error OR ErrorLaneHalt: stop launching NEW work and keep the first outcome.
            // In-flight siblings are NOT cancelled (a provider call can't be un-fired) — the
            // driver below drains them before rethrowing, so no write is lost.
            if (!halted) {
              halted = true;
              haltError = err;
            }
          })
          .finally(() => {
            active.delete(promise);
          });
        active.add(promise);
      }
    };

    // Drive the wave until everything settles, or (on halt) every in-flight promise drains.
    // Chained promises always RESOLVE (the `.catch` swallows), so the race never throws —
    // propagation flows through `halted`/`haltError`.
    pump();
    while (active.size > 0) {
      await Promise.race(active);
      pump();
    }
    if (halted) throw haltError instanceof Error ? haltError : new Error(String(haltError));
  }

  /**
   * Execute ONE live, work-bearing node (everything but the pure routers the scheduler settles
   * inline). Sub-plans recurse through the SAME scheduler, so the bound holds at every nesting level.
   */
  private executeLiveNode(
    node: Exclude<DagNode, DagIfNode | DagSwitchNode>,
    scope: Record<string, unknown>,
    path: string,
    ctx: RunContext,
  ): Promise<void> {
    switch (node.kind) {
      case 'action':
        // The error lane is a nested DagPlan run in place, passed as a callback so the
        // base executor never sees the plan shape; a lane that runs throws ErrorLaneHalt.
        return this.executeAction(
          node,
          scope,
          path,
          ctx,
          node.onErrorBranch && node.onErrorBranch.nodes.length > 0
            ? () => this.schedule(node.onErrorBranch!.nodes, scope, path, ctx)
            : null,
        );
      case 'code':
        // The snippet runs in the WASM sandbox, honouring the same error lane as an action.
        return this.executeCode(
          node,
          scope,
          path,
          ctx,
          node.onErrorBranch && node.onErrorBranch.nodes.length > 0
            ? () => this.schedule(node.onErrorBranch!.nodes, scope, path, ctx)
            : null,
        );
      case 'forEach':
        return this.executeForEach(node, scope, path, ctx, (childScope, childPath) =>
          this.schedule(node.body.nodes, childScope, childPath, ctx),
        );
      case 'while':
        // The same nested-body walk as forEach; the do-while control + cap live in the base.
        return this.executeWhile(node, scope, path, ctx, (childScope, childPath) =>
          this.schedule(node.body.nodes, childScope, childPath, ctx),
        );
      case 'parallel':
        return this.executeParallel(
          node,
          node.branches.length,
          scope,
          path,
          ctx,
          (branchScope, i, childPath) => this.schedule(node.branches[i]!.nodes, branchScope, childPath, ctx),
        );
      case 'agent':
        // The durable tool-calling loop runs in the base executor, routing a
        // max_steps exhaustion into the same error lane as an action failure.
        return this.executeAgent(
          node,
          scope,
          path,
          ctx,
          node.onErrorBranch && node.onErrorBranch.nodes.length > 0
            ? () => this.schedule(node.onErrorBranch!.nodes, scope, path, ctx)
            : null,
        );
      case 'callWorkflow':
        // The child runs nested through the same seam an agent's sub-workflow tool uses,
        // and a failure inside it routes into this node's error lane like any other.
        return this.executeCallWorkflow(
          node,
          scope,
          path,
          ctx,
          node.onErrorBranch && node.onErrorBranch.nodes.length > 0
            ? () => this.schedule(node.onErrorBranch!.nodes, scope, path, ctx)
            : null,
        );
      case 'delay':
        return this.executeDelay(node, scope, path, ctx);
      case 'waitForEvent':
        return this.executeWaitForEvent(node, scope, path, ctx);
    }
  }
}
