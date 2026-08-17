/**
 * The built-in engine's control nodes (`orchestr:*`) — the SINGLE SOURCE OF TRUTH for their
 * parameter schema; the palette and the compose catalog both derive from it (spec-guarded).
 */

/** One configurable parameter on a control node. */
export type ControlNodeParam = {
  type: string;
  description: string;
  required: boolean;
  /** Seed value `defaultParamsFromSchema` writes onto a freshly-placed node. */
  defaultValue?: unknown;
  /** Advisory documented default (surfaced to the model; not seeded). */
  default?: unknown;
};

/** A runtime control construct's catalog schema — the single source both surfaces derive from. */
export type ControlNodeSchema = {
  name: string;
  type: string;
  category: 'control';
  /** Client-palette (UX) description. The compose catalog projects its own agent-facing copy. */
  description: string;
  auth: 'none';
  parameters: Record<string, ControlNodeParam>;
};

export const CONTROL_NODE_SCHEMAS: readonly ControlNodeSchema[] = [
  {
    name: 'If',
    type: 'orchestr:if',
    category: 'control',
    description:
      'Branch the flow: the first output runs when the condition holds, the second when it does not.',
    auth: 'none',
    parameters: {
      left: {
        type: 'string',
        description: 'Left value — a literal or a {{step.path}} reference',
        required: true,
      },
      op: {
        type: 'string',
        description: 'One of: eq, ne, gt, gte, lt, lte, contains, truthy, falsy',
        required: true,
        // Seeded so the editor's displayed operator and the deploy gate agree from node one.
        defaultValue: 'eq',
      },
      right: { type: 'string', description: 'Right value (omit for truthy/falsy)', required: false },
    },
  },
  {
    name: 'Switch',
    type: 'orchestr:switch',
    category: 'control',
    description:
      'Route by condition: N outputs, first match wins. Each case is a condition ({left, op, right}); the flow leaves on the first output whose case holds — output 0 for case 0, output 1 for case 1, and so on. If no case matches, the flow leaves on the last output (the default/fallback). A generalization of If (which is a 2-way switch: match / default).',
    auth: 'none',
    parameters: {
      cases: {
        type: 'array',
        description:
          'Ordered list of conditions, one per output. Each is {left, op (eq|ne|gt|gte|lt|lte|contains|truthy|falsy), right}. Case i is output i (source_port i); the default/fallback is the next output (source_port = cases.length).',
        required: true,
      },
    },
  },
  {
    name: 'Wait for event',
    type: 'orchestr:wait_for_event',
    category: 'control',
    description:
      'Pause the run until an event arrives on the topic (human approval, external callback) or the timeout passes.',
    auth: 'none',
    parameters: {
      topic: {
        type: 'string',
        description: 'Event name the run waits for, e.g. manager_approval',
        required: true,
      },
      timeout_ms: { type: 'number', description: 'How long to wait, in milliseconds', required: false },
    },
  },
  {
    name: 'Code',
    type: 'orchestr:code',
    category: 'control',
    description:
      "Run a code snippet in a secure sandbox to transform the run data. The snippet is an (async) function body: it receives the run so far as `steps` (prior nodes keyed by id — read a field as `steps.<nodeId>.body.<field>`) plus a `trigger` alias for the firing event, may `await`, and returns a value — that return becomes this node's output (downstream refs read it as {{<this node id>.path}}). No network, filesystem, `require`, `process`, or host access. Bounded: 5s wall-clock and 128MB memory; a throw, timeout, or overrun fails the node like any step.",
    auth: 'none',
    parameters: {
      language: {
        type: 'string',
        description:
          'Snippet language: "js" or "ts" (TypeScript is type-stripped before it runs). Default "js".',
        required: false,
      },
      code: {
        type: 'string',
        description:
          'The snippet — an (async) function body. Read inputs via `steps`/`trigger` and `return` the output, e.g. `return { total: steps.calc.body.a + steps.calc.body.b };`',
        required: true,
      },
    },
  },
  {
    name: 'Loop',
    type: 'orchestr:loop',
    category: 'control',
    description:
      'Repeat a body sub-flow. Connect the body to output 0 (runs each round) and any after-loop steps to output 1 (runs once). Two modes: "items" (default) runs the body once per element of a collection — the body reads {{item}}/{{itemIndex}}; "while" repeats the body do-while a condition holds (the body always runs at least once), bounded by a required max_iterations cap — the body reads the round index as {{loopRound}} and the previous round\'s outputs as {{loopPrev}}. In both modes, steps after the loop read the per-round results as {{<loop step>}}.',
    auth: 'none',
    parameters: {
      mode: {
        type: 'string',
        description:
          'Loop driver: "items" (iterate a collection, default) or "while" (repeat while a condition holds).',
        required: false,
      },
      items: {
        type: 'string',
        description:
          'items mode: expression resolving to an array, e.g. {{fetch_rows.rows}} (required in items mode).',
        required: false,
      },
      item_var: {
        type: 'string',
        description:
          'items mode: name bound to each element in the body (default "item"; index is <item_var>Index).',
        required: false,
      },
      condition: {
        type: 'object',
        description:
          'while mode: {left, op, right} (the same shape as IF) tested AFTER each round; the loop repeats while it holds (required in while mode).',
        required: false,
      },
      max_iterations: {
        type: 'number',
        description:
          'while mode: a positive integer hard cap on rounds — the required infinite-loop guard; reaching it stops the loop cleanly (required in while mode).',
        required: false,
      },
    },
  },
  {
    name: 'AI Agent',
    type: 'orchestr:agent',
    category: 'control',
    description:
      'A durable tool-calling agent: it runs a model in a loop, calling the tools wired to its "tools" handle (port_type "tool") until it produces a final answer — that answer becomes this node\'s output. Give it tools by wiring action nodes (or an orchestr:call_workflow node) to its tools port. Parameters: system_prompt (how it should behave), input (the task/user message it works on — defaults to the whole trigger payload if empty), model ({ provider, model }, provider one of openai|claude|gemini|mistral), connectionId (OPTIONAL — a promoted/environment run resolves the model from that environment\'s connection slot for the provider; set it only to run the agent by hand on a Default/test run), max_steps (the hard cap on model + tool rounds before it must answer).',
    auth: 'none',
    parameters: {
      system_prompt: {
        type: 'longText',
        description:
          'Instructions that steer the agent every turn — its role, how to use its tools, and when to stop.',
        required: false,
      },
      input: {
        type: 'longText',
        description:
          'The task/user message the agent works on, usually a trigger field (e.g. {{trigger.message}}). Leave empty to hand the agent the whole trigger payload.',
        required: false,
      },
      model: {
        type: 'object',
        description:
          'The model to run, as { provider, model }: provider is one of openai|claude|gemini|mistral and model is that provider\'s model id (default { provider: "claude", model: "claude-opus-4-8" }).',
        required: false,
      },
      connectionId: {
        type: 'string',
        description:
          "Optional override for the model's account. A promoted/environment run resolves the model connection from that environment's slot for the provider (the same slot the <provider>.generate_text LLM nodes use) — leave it empty for those. Set it to run the agent by hand on a Default/test run, or to pin a specific account.",
        required: false,
      },
      max_steps: {
        type: 'number',
        description:
          'Hard cap on model + tool rounds before the agent must answer — the infinite-loop guard; a positive integer (default 25, max 100).',
        required: false,
        default: 25,
      },
    },
  },
  {
    name: 'Call workflow',
    type: 'orchestr:call_workflow',
    category: 'control',
    description:
      'Run another workflow and use its result — later steps read it as {{<node id>}}. Wire it to an agent\'s tools handle instead, and the agent decides when to call it. The target must declare itself callable with a "Called by another workflow" trigger; it runs its live version for the current environment, on your accounts.',
    auth: 'none',
    parameters: {
      workflow_id: {
        type: 'string',
        description: 'The workflow this step runs (its id). Cannot be the workflow you are editing.',
        required: true,
      },
      input: {
        type: 'object',
        description:
          "What the target workflow receives as its firing event — an object whose keys are the inputs it declares, read inside it as {{trigger.<key>}}. Values may reference this workflow's steps (e.g. {{trigger.email}}). Ignored when the node is wired as an agent tool: the model produces the input then.",
        required: false,
      },
    },
  },
];
