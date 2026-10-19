import type { DagAgentTool } from './agent';
import type { CompareOp, Condition } from './conditions';
import type { DagNode, DagPlan, Guard } from './dag-plan';

/** Test support, not in the production bundle: seeded random DAG plans covering every shape a durable replay meets. */

/** How a fuzz action's fake call ends: `fails-once` fails its first attempt only; `fatal` meets a fatal error at its step's lookup, before its call. */
export type Behaviour = 'ok' | 'fails' | 'fails-once' | 'fatal';

/** A value a fuzz step can answer with, each of a kind a JSON row would not keep as it is. */
export const YIELDS = [
  'date',
  'undefined',
  'nan',
  'infinity',
  'null',
  'nested',
  'array',
  'true',
  'false',
  'zero',
  'text',
] as const;

export type Yield = (typeof YIELDS)[number];

/** The value `yields` names. */
export function fuzzValue(yields: Yield): unknown {
  switch (yields) {
    case 'date':
      return new Date(Date.UTC(2026, 0, 1));
    case 'undefined':
      return undefined;
    case 'nan':
      return NaN;
    case 'infinity':
      return Infinity;
    case 'null':
      return null;
    case 'nested':
      return { deep: { flag: true, list: [1, 2] } };
    case 'array':
      return [0, 'x'];
    case 'true':
      return true;
    case 'false':
      return false;
    case 'zero':
      return 0;
    case 'text':
      return 'x';
  }
}

/** The props every fuzz action carries. */
export interface FuzzActionProps {
  latencyMs: number;
  behaviour: Behaviour;
  /** What its output carries as `v`. */
  yields?: Yield;
}

/** How often the generator reaches for each shape that decides a router's route. */
export interface PlanMix {
  /** Share of nodes that are routers. */
  routers: number;
  /** Chance a router reads an earlier step rather than a constant. */
  conditions: number;
  /** Chance an ok action is pinned. */
  leafPins: number;
  /** Chance a wait, delay, loop or fan-out carries a pin, which nothing reads. */
  otherPins: number;
  /** Chance a node comes after nothing. */
  roots: number;
  /** How deep plans nest, and how many nodes the top level has. */
  depth: number;
  size: [number, number];
}

/** The mix every fuzz plan is drawn from. */
export const FUZZ_MIX: PlanMix = {
  routers: 0.08,
  conditions: 0.6,
  leafPins: 0.06,
  otherPins: 0.05,
  roots: 0.25,
  depth: 2,
  size: [2, 7],
};

/** A mix heavy in routers reading earlier steps, joins and pins: what decides a replay's route. */
export const ROUTED_MIX: PlanMix = {
  routers: 0.3,
  conditions: 0.9,
  leafPins: 0.3,
  otherPins: 0.3,
  roots: 0.05,
  depth: 1,
  size: [6, 12],
};

const OPS: CompareOp[] = ['truthy', 'falsy', 'eq', 'ne', 'gt', 'lt', 'contains'];
const RIGHTS: unknown[] = [null, 0, 'x', true, false, 1];

export const FUZZ_ACTION = 'fuzz.step';
export const FUZZ_WORKFLOW = 'fuzz-child';
const TOPICS = ['approval', 'legal', 'finance'];
const ALWAYS = { left: true, op: 'truthy' } as const;

/** Every shape the generator emits, each recorded on the plan that carries it. */
export const FEATURES = [
  'zero-delay',
  'short-delay',
  'mid-delay',
  'long-delay',
  'wait',
  'agent',
  'failing-tool',
  'workflow-tool',
  'small-budget',
  'fails',
  'fails-once',
  'continue',
  'retry',
  'error-lane',
  'lane-then-fatal',
  'call-workflow',
  'while',
  'for-each',
  'parallel',
  'router',
  'pin',
  'wide',
] as const;

export type Feature = (typeof FEATURES)[number];

export interface FuzzPlan {
  plan: DagPlan;
  pins: Record<string, unknown>;
  /** The sub-workflow invocation budget the run starts with: small whenever an agent can call a workflow. */
  budget: number;
  features: ReadonlySet<Feature>;
  /** The ids of the actions whose step meets a fatal error at its lookup. */
  fatal: ReadonlySet<string>;
}

/** A seeded uniform generator in [0, 1). */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random plan; the same `rand` state always yields the same plan. */
export function randomDagPlan(rand: () => number, id = 'fuzz', mix: PlanMix = FUZZ_MIX): FuzzPlan {
  const builder = new PlanBuilder(rand, id, mix);
  const nodes = builder.level(mix.depth, builder.int(...mix.size), true);
  const budget = builder.features.has('workflow-tool') ? builder.int(1, 2) : 64;
  if (budget < 64) builder.features.add('small-budget');
  return {
    plan: { id, nodes },
    pins: builder.pins,
    budget,
    features: builder.features,
    fatal: builder.fatal,
  };
}

class PlanBuilder {
  readonly features = new Set<Feature>();
  readonly pins: Record<string, unknown> = {};
  readonly fatal = new Set<string>();
  private next = 0;

  constructor(
    private readonly rand: () => number,
    private readonly planId: string,
    private readonly mix: PlanMix,
  ) {}

  int(min: number, max: number): number {
    return min + Math.floor(this.rand() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.rand() < p;
  }

  level(depth: number, size: number, root = false): DagNode[] {
    const nodes: DagNode[] = [];
    if (root && this.chance(0.15)) this.wide(nodes);
    if (this.chance(0.12)) this.laneThenFatal(nodes);
    for (let k = 0; k < size; k++) {
      const guards = this.guards(nodes);
      nodes.push(this.chance(this.mix.routers) ? this.router(guards, nodes) : this.node(depth, guards));
    }
    return nodes;
  }

  private node(depth: number, guards: Guard[]): DagNode {
    const roll = this.rand();
    const nested = depth > 0;
    if (roll < 0.3) return this.action(guards);
    if (roll < 0.4) return this.pinnedOrNot(this.delay(guards));
    if (roll < 0.52) return this.pinnedOrNot(this.wait(guards));
    if (roll < 0.6) return this.action(guards);
    if (roll < 0.68) return this.agent(guards, depth);
    if (roll < 0.73) return this.callWorkflow(guards, depth);
    if (nested && roll < 0.82) return this.pinnedOrNot(this.parallel(guards, depth));
    if (nested && roll < 0.9) return this.pinnedOrNot(this.forEach(guards, depth));
    if (nested && roll < 0.96) return this.pinnedOrNot(this.whileLoop(guards, depth));
    return this.action(guards);
  }

  // A pin on a node that is no leaf: the interpreter replays pins on leaves alone, so it changes nothing.
  private pinnedOrNot(node: DagNode): DagNode {
    if (this.chance(this.mix.otherPins)) {
      this.pins[node.id] = { pinned: node.id, v: fuzzValue(this.yields()) };
      this.features.add('pin');
    }
    return node;
  }

  private yields(): FuzzActionProps['yields'] & {} {
    return YIELDS[this.int(0, YIELDS.length - 1)]!;
  }

  private id(): string {
    return `n${this.next++}`;
  }

  private props(): FuzzActionProps {
    const roll = this.rand();
    let behaviour: Behaviour = 'ok';
    if (roll < 0.1) behaviour = 'fails';
    else if (roll < 0.18) behaviour = 'fails-once';
    if (behaviour !== 'ok') this.features.add(behaviour);
    return { latencyMs: this.int(1, 400), behaviour, yields: this.yields() };
  }

  private action(guards: Guard[], props: FuzzActionProps = this.props()): DagNode {
    const id = this.id();
    const node: DagNode = { kind: 'action', id, actionId: FUZZ_ACTION, props: { ...props }, guards };
    if (props.behaviour === 'fails-once' && this.chance(0.7)) {
      node.retry = { maxAttempts: this.int(2, 3), backoffMs: 0 };
      this.features.add('retry');
    }
    if (props.behaviour !== 'ok' && this.chance(0.5)) {
      if (this.chance(0.5)) {
        node.onError = 'continue';
        this.features.add('continue');
      } else {
        node.onErrorBranch = this.lane(id);
      }
    }
    if (props.behaviour === 'ok' && this.chance(this.mix.leafPins)) {
      this.pins[id] = { pinned: id, v: fuzzValue(this.yields()) };
      this.features.add('pin');
    }
    return node;
  }

  private lane(ownerId: string): DagPlan {
    this.features.add('error-lane');
    return { id: `${this.planId}#${ownerId}:error`, nodes: this.level(0, this.int(1, 2)) };
  }

  private delay(guards: Guard[]): DagNode {
    const roll = this.rand();
    let ms = this.int(1, 5_000);
    let feature: Feature = 'short-delay';
    if (roll < 0.1) {
      ms = 0;
      feature = 'zero-delay';
    } else if (roll < 0.4) {
      ms = this.int(60_001, 180_000);
      feature = 'long-delay';
    } else if (roll < 0.6) {
      ms = this.int(10_001, 60_000);
      feature = 'mid-delay';
    }
    this.features.add(feature);
    return { kind: 'delay', id: this.id(), ms, guards };
  }

  private wait(guards: Guard[]): DagNode {
    this.features.add('wait');
    const topic = TOPICS[this.int(0, TOPICS.length - 1)]!;
    return { kind: 'waitForEvent', id: this.id(), topic, timeoutMs: this.int(2_000, 200_000), guards };
  }

  private router(guards: Guard[], earlier: readonly DagNode[]): DagNode {
    this.features.add('router');
    if (this.chance(0.5))
      return { kind: 'if', id: this.id(), condition: this.condition(guards, earlier), guards };
    const cases = Array.from({ length: this.int(1, 3) }, () => ({
      condition: this.condition(guards, earlier),
    }));
    return { kind: 'switch', id: this.id(), cases, guards };
  }

  // Reads a step the router comes after, that writes a value to scope; else a constant.
  private condition(guards: readonly Guard[], earlier: readonly DagNode[]): Condition {
    const readable = upstream(guards, earlier).filter(
      (n) => n.kind !== 'if' && n.kind !== 'switch' && n.kind !== 'delay',
    );
    if (readable.length === 0 || !this.chance(this.mix.conditions)) return ALWAYS;
    const source = readable[this.int(0, readable.length - 1)]!;
    return {
      left: this.chance(0.7) ? `{{${source.id}.v}}` : `{{${source.id}}}`,
      op: OPS[this.int(0, OPS.length - 1)]!,
      right: RIGHTS[this.int(0, RIGHTS.length - 1)],
    };
  }

  private agent(guards: Guard[], depth: number): DagNode {
    this.features.add('agent');
    const id = this.id();
    const tools: DagAgentTool[] = Array.from({ length: this.int(1, 3) }, (_, k) => {
      if (this.chance(0.35)) {
        this.features.add('workflow-tool');
        return { kind: 'workflow', name: `w${k}`, workflowId: FUZZ_WORKFLOW };
      }
      const props = this.props();
      if (props.behaviour !== 'ok') this.features.add('failing-tool');
      return { kind: 'action', name: `t${k}`, actionId: FUZZ_ACTION, props: { ...props } };
    });
    const rounds = this.int(1, 3);
    return {
      kind: 'agent',
      id,
      systemPrompt: `fuzz node=${id} rounds=${rounds} calls=${this.int(1, 2)}`,
      model: { provider: 'claude', model: 'fuzz' },
      maxSteps: this.int(rounds, rounds + 1),
      tools,
      guards,
      ...(depth > 0 && this.chance(0.2) ? { onErrorBranch: this.lane(id) } : {}),
    };
  }

  private callWorkflow(guards: Guard[], depth: number): DagNode {
    this.features.add('call-workflow');
    const id = this.id();
    return {
      kind: 'callWorkflow',
      id,
      workflowId: FUZZ_WORKFLOW,
      input: {},
      guards,
      ...(depth > 0 && this.chance(0.2) ? { onErrorBranch: this.lane(id) } : {}),
    };
  }

  private parallel(guards: Guard[], depth: number): DagNode {
    this.features.add('parallel');
    const id = this.id();
    const branches = Array.from({ length: this.int(2, 4) }, (_, b) => ({
      id: `${this.planId}#${id}|${b}`,
      nodes: this.level(depth - 1, this.int(1, 3)),
    }));
    return { kind: 'parallel', id, branches, guards };
  }

  private forEach(guards: Guard[], depth: number): DagNode {
    this.features.add('for-each');
    const id = this.id();
    const body = { id: `${this.planId}#${id}`, nodes: this.level(depth - 1, this.int(1, 3)) };
    return { kind: 'forEach', id, items: '{{trigger.items}}', itemVar: 'item', body, guards };
  }

  private whileLoop(guards: Guard[], depth: number): DagNode {
    this.features.add('while');
    const id = this.id();
    const body = { id: `${this.planId}#${id}`, nodes: this.level(depth - 1, this.int(1, 3)) };
    return { kind: 'while', id, condition: ALWAYS, maxIterations: this.int(1, 3), body, guards };
  }

  // Nine or more nodes ready at once, past the scheduler's bound of eight.
  private wide(nodes: DagNode[]): void {
    this.features.add('wide');
    const hub = this.action([]);
    nodes.push(hub);
    for (let k = this.int(9, 12); k > 0; k--) {
      const guard = [{ source: hub.id, port: 0 }];
      nodes.push(
        this.chance(0.7) ? this.action(guard) : this.chance(0.5) ? this.wait(guard) : this.delay(guard),
      );
    }
  }

  // An error lane that finishes first, beside a sibling already running whose next step then meets a fatal error.
  private laneThenFatal(nodes: DagNode[]): void {
    this.features.add('lane-then-fatal');
    const failing = this.id();
    nodes.push({
      kind: 'action',
      id: failing,
      actionId: FUZZ_ACTION,
      props: { latencyMs: 5, behaviour: 'fails' },
      onErrorBranch: {
        id: `${this.planId}#${failing}:error`,
        nodes: [this.action([], { latencyMs: 5, behaviour: 'ok' })],
      },
      guards: [],
    });
    const sibling = this.id();
    const gate: DagNode = {
      kind: 'action',
      id: this.id(),
      actionId: FUZZ_ACTION,
      props: { latencyMs: 900, behaviour: 'ok' },
      guards: [],
    };
    const fatal = this.action([{ source: gate.id, port: 0 }], { latencyMs: 5, behaviour: 'fatal' });
    this.fatal.add(fatal.id);
    nodes.push({
      kind: 'parallel',
      id: sibling,
      branches: [{ id: `${this.planId}#${sibling}|0`, nodes: [gate, fatal] }],
      guards: [],
    });
  }

  private guards(earlier: DagNode[]): Guard[] {
    if (earlier.length === 0 || this.chance(this.mix.roots)) return [];
    return Array.from({ length: this.int(1, 2) }, () => {
      const source = earlier[this.int(0, earlier.length - 1)]!;
      return { source: source.id, port: this.int(0, ports(source) - 1) };
    });
  }
}

// Every node among `earlier` that a node with `guards` comes after.
function upstream(guards: readonly Guard[], earlier: readonly DagNode[]): DagNode[] {
  const byId = new Map(earlier.map((n) => [n.id, n]));
  const found = new Map<string, DagNode>();
  const visit = (id: string): void => {
    const node = byId.get(id);
    if (!node || found.has(id)) return;
    found.set(id, node);
    for (const g of node.guards) visit(g.source);
  };
  for (const g of guards) visit(g.source);
  return [...found.values()];
}

function ports(node: DagNode): number {
  if (node.kind === 'if') return 2;
  return node.kind === 'switch' ? node.cases.length + 1 : 1;
}
