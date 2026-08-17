import { randomUUID } from 'node:crypto';

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { resolveDropdownParams } from './dropdown-values';
import { fillParams, type ParamCompleteFn } from './param-filler';
import type { PendingAnswers } from './pending-answers';
import type { BriefData, ComposerEvent, ComposeOp } from './protocol';
import type { ComposerSession } from './sessions';
import type { CatalogEntry, RunRecord, WorkflowServiceClient } from './workflow-client';

/**
 * The composer's tool surface — thin wrappers over workflow-service plus the
 * conversation tools (A1: brief / questions / assumptions). Handlers close
 * over the session (the draft they mutate) and the event channel, so
 * tool-side events (op_applied, brief, question, assumption) reach the
 * client the moment they happen, between the SDK's own stream events.
 */

export interface ToolContext {
  session: ComposerSession;
  client: WorkflowServiceClient;
  /** Sequenced session emitter — events reach the live SSE consumer AND the replay buffer. */
  emit: (event: ComposerEvent) => void;
  answers: PendingAnswers;
  /** The focused param-filling completion (PARAM_MODEL) — null leaves fill_params unregistered. */
  paramCompleter: ParamCompleteFn | null;
}

export const COMPOSER_TOOL_NAMES = [
  'mcp__composer__search_catalog',
  'mcp__composer__read_workflow',
  'mcp__composer__get_action_schema',
  'mcp__composer__apply_ops',
  'mcp__composer__post_brief',
  'mcp__composer__ask_user',
  'mcp__composer__note_assumption',
  'mcp__composer__test_step',
  'mcp__composer__get_samples',
  'mcp__composer__run_draft',
  'mcp__composer__read_run',
  'mcp__composer__list_runs',
  'mcp__composer__connections_status',
  'mcp__composer__offer_save',
  'mcp__composer__find_trigger',
  'mcp__composer__need_connection',
  'mcp__composer__fill_params',
] as const;

/** The two-fix bound (code-enforced): after this many failures on one step, stop and report. */
export const MAX_FIX_ATTEMPTS = 2;

/** How long a clarifying question waits before the agent proceeds with its default. */
export const QUESTION_TIMEOUT_MS = 5 * 60 * 1000;

export function buildComposerServer(ctx: ToolContext): ReturnType<typeof createSdkMcpServer> {
  const searchCatalog = tool(
    'search_catalog',
    'Search the action catalog for steps that can do a job (e.g. "post a message to a slack channel"). ' +
      'Returns candidate actions with their exact "type" and parameter schemas. ' +
      'Call this before adding any action step and copy the type verbatim.',
    {
      query: z.string().min(1).max(500).describe('What the step should do, in plain words'),
      top_k: z.number().int().min(1).max(15).default(8).describe('How many candidates to return'),
    },
    async ({ query, top_k }) => {
      try {
        const results = await ctx.client.searchCatalog(query, top_k, ctx.session.callerToken);
        if (results.length === 0) {
          return { content: [{ type: 'text' as const, text: `No catalog matches for "${query}".` }] };
        }
        return { content: [{ type: 'text' as const, text: results.map(formatEntry).join('\n\n') }] };
      } catch (err) {
        return toolError(err);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const readWorkflow = tool(
    'read_workflow',
    'Read an existing workflow: its name and committed graph. ' +
      'Use it when the person refers to a workflow you are not already holding.',
    { workflow_id: z.string().min(1).describe('The workflow id (UUID)') },
    async ({ workflow_id }) => {
      try {
        const wf = await ctx.client.readWorkflow(workflow_id, ctx.session.callerToken);
        const text = [
          `Workflow "${wf.name}"`,
          wf.ir ? `Committed graph:\n${JSON.stringify(wf.ir)}` : 'No committed version yet.',
        ].join('\n');
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        return toolError(err);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const applyOps = tool(
    'apply_ops',
    'Apply a batch of graph operations to the draft canvas. Each op is one of:\n' +
      '{"op":"add_node","node":{"id":"<snake_case>","name":"<human name>","node_type":"<exact catalog type or orchestr:trigger|orchestr:if|orchestr:wait_for_event>","parameters":{...}}}\n' +
      '{"op":"update_node","node_id":"<id>","name"?,"node_type"?,"parameters"?:{...merged keys}}\n' +
      '{"op":"connect","source_node_id":"<id>","target_node_id":"<id>","source_port"?:0|1}\n' +
      '{"op":"remove_node","node_id":"<id>"}\n' +
      'node_type on update_node re-types the TRIGGER node ONLY (id "trigger") to set how the workflow ' +
      'starts: "orchestr:webhook" (something sends a request), "orchestr:schedule" (parameters: exactly one of ' +
      '{interval_minutes:N} or {cron:"0 9 * * 1-5"}, plus optional {timezone:"Europe/Zurich"}), ' +
      "or an app trigger type from find_trigger. Re-typing replaces the trigger's parameters. Actions keep their type.\n" +
      'The batch is atomic — on rejection nothing changed; fix the reported op and retry.',
    {
      ops: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .max(50)
        .describe('The operations, applied in order'),
    },
    ({ ops }) => runApplyOps(ctx, ops as ComposeOp[]),
  );

  const getActionSchema = tool(
    'get_action_schema',
    'Fetch ONE action\'s full parameter schema by its exact "type". ' +
      "Call this before setting a catalog action's parameters (add_node or update_node) — " +
      'search results are trimmed; this is the real schema.',
    { type: z.string().min(1).describe('The exact action type, e.g. slack.send_channel_message') },
    ({ type }) => runGetActionSchema(ctx, type),
    { annotations: { readOnlyHint: true } },
  );

  const postBrief = tool(
    'post_brief',
    'Show (or update) the plan card the person sees: goal, trigger, steps, and what you still need. ' +
      'Post it BEFORE building anything new, and re-post it whenever the plan changes — the card is replaced.',
    {
      goal: z.string().min(1).max(300).describe('What the workflow achieves, in one plain sentence'),
      trigger: z.string().min(1).max(200).describe('What starts it, in plain words ("A form is submitted")'),
      steps: z.array(z.string().min(1).max(200)).min(1).max(12).describe('The steps, one plain phrase each'),
      needs: z
        .array(z.string().min(1).max(200))
        .max(6)
        .default([])
        .describe('What you still need from them ("Which channel?") — empty when nothing is missing'),
    },
    (input) => Promise.resolve(runPostBrief(ctx, input)),
  );

  const askUser = tool(
    'ask_user',
    'Ask ONE clarifying question and wait for the answer (the person taps an option or types). ' +
      'Use it only when a wrong guess would be expensive — accounts/credentials, destinations ' +
      '(channels, sheets, addresses), or business rules (thresholds). Otherwise assume and use note_assumption.',
    {
      question: z.string().min(1).max(300).describe('The question, phrased like a colleague would ask it'),
      options: z.array(z.string().min(1).max(120)).min(2).max(4).describe('2–4 tappable answers'),
      node_id: z
        .string()
        .optional()
        .describe('The draft step this concerns — pins the question to that node on the canvas'),
      fallback: z
        .string()
        .optional()
        .describe('What you will do if no answer arrives (defaults to the first option)'),
    },
    (input) => runAskUser(ctx, input),
  );

  const noteAssumption = tool(
    'note_assumption',
    'Record an assumption on a draft step so it shows as a badge on the canvas ' +
      '(e.g. text "assumed: #general"). Use it for every guess you make instead of asking.',
    {
      node_id: z.string().min(1).describe('The draft step the assumption belongs to'),
      text: z.string().min(1).max(160).describe("Short badge text, e.g. 'assumed: #general'"),
    },
    (input) => Promise.resolve(runNoteAssumption(ctx, input)),
  );

  const testStep = tool(
    'test_step',
    'Run ONE draft step in isolation with sample upstream data and report the result. ' +
      'Cheap and transient — use it as you configure no-effect steps. sample_scope seeds ' +
      '{{refs}}: e.g. {"trigger": {"amount": 700}}.',
    {
      node_id: z.string().min(1).describe('The draft step to test'),
      sample_scope: z
        .record(z.string(), z.unknown())
        .default({})
        .describe('Upstream outputs to seed, keyed by step id (include "trigger")'),
    },
    ({ node_id, sample_scope }) => runTestStep(ctx, node_id, sample_scope),
  );

  const runDraft = tool(
    'run_draft',
    'Run the WHOLE draft canvas once, uncommitted, with a synthesized trigger payload. ' +
      'Green/red beads land on every step. Steps with live side effects actually fire — ' +
      "get the person's okay first (ask_user).",
    {
      trigger_payload: z
        .record(z.string(), z.unknown())
        .default({})
        .describe('The pretend triggering event — say in chat what you are using'),
    },
    ({ trigger_payload }) => runRunDraft(ctx, trigger_payload),
  );

  const getSamples = tool(
    'get_samples',
    "Real data from this workflow's last completed run: `trigger` + one key per executed step. " +
      'Fetch it BEFORE wiring {{refs}} or seeding test_step — real values beat invented ones, and ' +
      'quoting the real resolved line back to the person proves the mapping.',
    {},
    () => runGetSamples(ctx),
    { annotations: { readOnlyHint: true } },
  );

  const listRuns = tool(
    'list_runs',
    'The workflow\'s run history, newest first — the entry point for "why did this fail?". ' +
      'Read the failing run with read_run afterwards for per-step detail.',
    { limit: z.number().int().min(1).max(20).default(5).describe('How many recent runs') },
    ({ limit }) => runListRuns(ctx, limit),
    { annotations: { readOnlyHint: true } },
  );

  const connectionsStatus = tool(
    'connections_status',
    "The person's app connections (provider + status). Check BEFORE a live-effect test so you can " +
      'name exactly which connection a step still needs instead of discovering it red.',
    {},
    () => runConnectionsStatus(ctx),
    { annotations: { readOnlyHint: true } },
  );

  const offerSave = tool(
    'offer_save',
    'Show the save choices ("Save and turn on" / "Save as a draft" / "Keep tweaking") as tappable ' +
      'chips. Call it ONLY after a verified green run, say the offer in one warm sentence, then END ' +
      'your turn — the tap comes back as their next message.',
    {},
    () => Promise.resolve(runOfferSave(ctx)),
  );

  const readRun = tool(
    'read_run',
    "Read a run's record: per-step statuses and error details. Use it after a failed run_draft " +
      'to see exactly which step broke and why before fixing it.',
    { run_id: z.string().min(1).describe('The run id run_draft reported') },
    ({ run_id }) => runReadRun(ctx, run_id),
    { annotations: { readOnlyHint: true } },
  );

  const findTrigger = tool(
    'find_trigger',
    'Find the exact trigger "type" for an app event ("a new row in the sheet", "a GitHub push"). ' +
      'Returns matching trigger types with their parameters. You do NOT need this for the two native ' +
      'kinds: "orchestr:webhook" (something sends us a request) and "orchestr:schedule" (every N ' +
      'minutes, or a cron time in a timezone) — use those directly. Once you have a type, SET THE TRIGGER by re-typing the canvas ' +
      'trigger node with apply_ops: {"op":"update_node","node_id":"trigger","node_type":"<type>", ' +
      '"parameters":{...}} — never a separate step.',
    {
      query: z.string().min(2).max(120).describe('The event in plain words, e.g. "new email" or "sheet row"'),
    },
    ({ query }) => runFindTrigger(ctx, query),
    { annotations: { readOnlyHint: true } },
  );

  const needConnection = tool(
    'need_connection',
    'Put a Connect button on a draft step whose app connection is missing. Call it the moment you ' +
      'know (connections_status, or a test failing on auth), say in ONE sentence which account to ' +
      'connect and why, then keep going with what you can.',
    {
      node_id: z.string().min(1).describe('The draft step that needs the connection'),
      provider: z
        .string()
        .min(1)
        .describe('The app key — the part of the action type before the dot, e.g. "slack"'),
      provider_label: z.string().min(1).max(60).describe('The app name as a person says it, e.g. "Slack"'),
    },
    (input) => Promise.resolve(runNeedConnection(ctx, input)),
  );

  const fillParamsTool = tool(
    'fill_params',
    "Fill ONE draft step's parameters from its full schema: say what the step should do (with the " +
      'concrete values you know) and the parameters are generated, checked against the schema, and ' +
      'applied to the canvas. Use it for every catalog action instead of writing parameters by hand. ' +
      'Control steps (orchestr:*) you still set directly via apply_ops.',
    {
      node_id: z.string().min(1).describe('The draft step to fill'),
      intent: z
        .string()
        .min(1)
        .max(500)
        .describe(
          'What the step should do, with concrete values ("post to #expense-review saying an expense of {{trigger.amount}} arrived")',
        ),
    },
    ({ node_id, intent }) => runFillParams(ctx, node_id, intent),
  );

  const tools = [
    searchCatalog,
    readWorkflow,
    getActionSchema,
    applyOps,
    postBrief,
    askUser,
    noteAssumption,
    testStep,
    getSamples,
    runDraft,
    readRun,
    listRuns,
    connectionsStatus,
    offerSave,
    findTrigger,
    needConnection,
    // The param sub-chain is measurable and droppable: no PARAM_MODEL, no tool.
    ...(ctx.paramCompleter ? [fillParamsTool] : []),
  ];

  return createSdkMcpServer({ name: 'composer', version: '0.1.0', tools });
}

interface ToolResult {
  // Index signature matches MCP's CallToolResult so tool() accepts the handler.
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * The apply_ops handler, exported for direct unit testing: a landed batch
 * updates the session draft AND emits op_applied to the canvas; a rejected
 * batch surfaces the validation detail to the agent as a tool error.
 */
export async function runApplyOps(ctx: ToolContext, ops: ComposeOp[]): Promise<ToolResult> {
  try {
    const { ops: settled, notes } = await settleDropdownValues(ctx, ops);
    const result = await ctx.client.applyOps(ctx.session.draftIr, settled, ctx.session.callerToken);
    if (!result.ok) {
      return { content: [{ type: 'text', text: `Batch rejected: ${result.detail}` }], isError: true };
    }
    ctx.session.draftIr = result.ir;
    ctx.emit({ event: 'op_applied', data: { ops: settled, ir: result.ir } });
    const summary = summarizeDraft(result.ir);
    return { content: [{ type: 'text', text: notes.length > 0 ? `${summary}\n${notes.join('\n')}` : summary }] };
  } catch (err) {
    return toolError(err);
  }
}

/** The node type an op writes parameters on — its own for an add, the draft's for an update. */
function opNodeType(ctx: ToolContext, op: ComposeOp): string | null {
  const node = op.node;
  if (op.op === 'add_node' && node && typeof node === 'object') {
    const type = (node as Record<string, unknown>).node_type;
    return typeof type === 'string' ? type : null;
  }
  if (op.op !== 'update_node') return null;
  if (typeof op.node_type === 'string') return op.node_type;
  const nodes = Array.isArray(ctx.session.draftIr?.nodes)
    ? (ctx.session.draftIr.nodes as Array<Record<string, unknown>>)
    : [];
  const current = nodes.find((n) => n.id === op.node_id);
  return typeof current?.node_type === 'string' ? current.node_type : null;
}

/** The account a live option loader fetches with: the step's own, else the caller's for that app. */
async function connectionForNode(
  ctx: ToolContext,
  nodeType: string,
  parameters: Record<string, unknown>,
): Promise<string | null> {
  const own = parameters.connectionId;
  if (typeof own === 'string' && own) return own;
  const provider = nodeType.split('.')[0] ?? '';
  const connections = await ctx.client.listConnections(ctx.session.callerToken);
  return connections.find((c) => c.provider === provider && c.status === 'active')?.id ?? null;
}

/** Resolve every option-backed parameter in the batch to a stored VALUE before it is applied. */
async function settleDropdownValues(
  ctx: ToolContext,
  ops: ComposeOp[],
): Promise<{ ops: ComposeOp[]; notes: string[] }> {
  const settled: ComposeOp[] = [];
  const notes: string[] = [];
  for (const op of ops) {
    const parameters = op.parameters ?? (op.node as Record<string, unknown> | undefined)?.parameters;
    const nodeType = opNodeType(ctx, op);
    if (!nodeType || !parameters || typeof parameters !== 'object') {
      settled.push(op);
      continue;
    }
    const params = parameters as Record<string, unknown>;
    const entry = await ctx.client.getActionSchema(nodeType, ctx.session.callerToken);
    if (!entry) {
      settled.push(op);
      continue;
    }
    let connectionId: string | null | undefined;
    const resolution = await resolveDropdownParams(entry.parameters ?? {}, params, async (prop) => {
      connectionId ??= await connectionForNode(ctx, nodeType, params);
      return ctx.client.loadOptions(nodeType, prop, connectionId, ctx.session.callerToken);
    });
    notes.push(...resolution.notes);
    settled.push(
      op.op === 'add_node'
        ? { ...op, node: { ...(op.node as Record<string, unknown>), parameters: resolution.parameters } }
        : { ...op, parameters: resolution.parameters },
    );
  }
  return { ops: settled, notes };
}

/** The post_brief handler: emit the (replacing) plan card; chat stays primary, so keep talking too. */
export function runPostBrief(ctx: ToolContext, brief: BriefData): ToolResult {
  ctx.emit({ event: 'brief', data: brief });
  return {
    content: [
      {
        type: 'text',
        text:
          brief.needs.length > 0
            ? 'Brief posted. Say it in a sentence, ask if it sounds right, and END your turn — build only after they confirm.'
            : 'Brief posted. Say it in a sentence; if this is a confirmed or trivial request, go ahead and build.',
      },
    ],
  };
}

export interface AskUserInput {
  question: string;
  options: string[];
  node_id?: string;
  fallback?: string;
}

/**
 * The ask_user handler — the A1 pause: emit the question, then AWAIT the
 * answer registry. The SSE stream idles until POST /api/composer/answer
 * resolves it (either surface: thread chip or canvas chip; first answer
 * wins) or the timeout fires, in which case the agent proceeds with its
 * stated fallback and must record it as an assumption.
 */
export async function runAskUser(
  ctx: ToolContext,
  input: AskUserInput,
  timeoutMs: number = QUESTION_TIMEOUT_MS,
): Promise<ToolResult> {
  let created: { questionId: string; outcome: Promise<import('./pending-answers').AnswerOutcome> };
  try {
    created = ctx.answers.create(ctx.session.id, timeoutMs);
  } catch {
    return {
      content: [
        {
          type: 'text',
          text: 'A question is already waiting for an answer — wait for it to resolve, then ask the next one.',
        },
      ],
      isError: true,
    };
  }
  const { questionId, outcome } = created;
  ctx.emit({
    event: 'question',
    data: {
      question_id: questionId,
      question: input.question,
      options: input.options,
      ...(input.node_id ? { node_id: input.node_id } : {}),
    },
  });
  const result = await outcome;
  if (result.kind === 'answered') {
    ctx.emit({
      event: 'question_resolved',
      data: { question_id: questionId, answer: result.answer },
    });
    return { content: [{ type: 'text', text: `They answered: "${result.answer}"` }] };
  }
  if (result.kind === 'timeout') {
    const fallback = input.fallback?.trim() || input.options[0] || '';
    ctx.emit({
      event: 'question_resolved',
      data: { question_id: questionId, answer: fallback, timed_out: true },
    });
    return {
      content: [
        {
          type: 'text',
          text: `No answer after ${Math.round(timeoutMs / 60_000)} minutes. Proceed with "${fallback}", record it with note_assumption on the step it concerns, and mention it when you wrap up.`,
        },
      ],
    };
  }
  return {
    content: [{ type: 'text', text: 'The conversation ended before an answer arrived. Stop here.' }],
    isError: true,
  };
}

/** The note_assumption handler: badge a draft step; unknown ids bounce back with the survivors. */
export function runNoteAssumption(ctx: ToolContext, input: { node_id: string; text: string }): ToolResult {
  const nodes = Array.isArray(ctx.session.draftIr?.nodes)
    ? (ctx.session.draftIr.nodes as Array<Record<string, unknown>>)
    : [];
  if (!nodes.some((n) => n.id === input.node_id)) {
    const ids = nodes.map((n) => String(n.id)).join(', ') || '(none)';
    return {
      content: [
        {
          type: 'text',
          text: `note_assumption: no draft step with id "${input.node_id}" — existing step ids: ${ids}. Add the step first.`,
        },
      ],
      isError: true,
    };
  }
  ctx.emit({ event: 'assumption', data: { node_id: input.node_id, text: input.text } });
  return { content: [{ type: 'text', text: 'Noted — the badge is on the step.' }] };
}

/** The get_action_schema handler: the FULL parameter schema for one exact type. */
export async function runGetActionSchema(ctx: ToolContext, type: string): Promise<ToolResult> {
  try {
    const entry = await ctx.client.getActionSchema(type.trim(), ctx.session.callerToken);
    if (!entry) {
      return {
        content: [
          {
            type: 'text',
            text: `Unknown action type "${type}" — use search_catalog and copy the exact "type" value.`,
          },
        ],
        isError: true,
      };
    }
    const text = [
      `type: ${entry.type}`,
      `name: ${entry.name}`,
      `description: ${entry.description}`,
      `auth: ${entry.auth}`,
      `parameters (full schema):\n${JSON.stringify(entry.parameters ?? {}, null, 1)}`,
    ].join('\n');
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return toolError(err);
  }
}

/** Cap serialized outputs so a verbose HTTP response doesn't flood the agent's context. */
function capJson(value: unknown, max = 1_800): string {
  const json = JSON.stringify(value);
  if (json === undefined) return 'null';
  return json.length <= max ? json : `${json.slice(0, max)}… (truncated, ${json.length} chars total)`;
}

/**
 * The test_step handler: run one draft step in isolation, drop a bead, and
 * hand the agent the outcome. A failing test is a NORMAL tool result (the
 * loop acts on it) — isError is reserved for "the tool itself broke".
 */
export async function runTestStep(
  ctx: ToolContext,
  nodeId: string,
  sampleScope: Record<string, unknown>,
): Promise<ToolResult> {
  const nodes = Array.isArray(ctx.session.draftIr?.nodes)
    ? (ctx.session.draftIr.nodes as Array<Record<string, unknown>>)
    : [];
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) {
    const ids = nodes.map((n) => String(n.id)).join(', ') || '(none)';
    return {
      content: [{ type: 'text', text: `test_step: no draft step with id "${nodeId}" — existing: ${ids}` }],
      isError: true,
    };
  }
  if ((ctx.session.fixAttempts.get(nodeId) ?? 0) >= MAX_FIX_ATTEMPTS) {
    return {
      content: [
        {
          type: 'text',
          text: `You've already fixed and re-tested "${nodeId}" ${MAX_FIX_ATTEMPTS} times this turn — stop here. Tell them plainly what keeps failing, what you tried, and what you need from them.`,
        },
      ],
      isError: true,
    };
  }
  try {
    const outcome = await ctx.client.testStep(
      {
        id: String(node.id),
        node_type: String(node.node_type),
        name: typeof node.name === 'string' ? node.name : undefined,
        parameters:
          node.parameters && typeof node.parameters === 'object'
            ? (node.parameters as Record<string, unknown>)
            : {},
      },
      sampleScope,
      ctx.session.callerToken,
    );
    if (outcome.ok) {
      ctx.emit({ event: 'step_result', data: { node_id: nodeId, status: 'passed' } });
      return {
        content: [
          { type: 'text', text: `Step "${nodeId}" passed. Output: ${capJson(outcome.outputs[nodeId])}` },
        ],
      };
    }
    ctx.session.fixAttempts.set(nodeId, (ctx.session.fixAttempts.get(nodeId) ?? 0) + 1);
    ctx.emit({
      event: 'step_result',
      data: { node_id: nodeId, status: 'failed', summary: outcome.detail.slice(0, 200) },
    });
    const attempts = ctx.session.fixAttempts.get(nodeId) ?? 0;
    const strikeNote =
      attempts >= MAX_FIX_ATTEMPTS
        ? ` That's failure ${attempts} on this step — if your next fix doesn't feel certain, stop and tell them honestly instead of trying again.`
        : '';
    return { content: [{ type: 'text', text: `Step "${nodeId}" failed: ${outcome.detail}${strikeNote}` }] };
  } catch (err) {
    return toolError(err);
  }
}

/**
 * The run_draft handler: run the whole draft uncommitted. We mint the run id
 * so the record is readable either way; after the run, beads land per step
 * from the record (failures) or the outputs (successes), then one run_result.
 */
export async function runRunDraft(
  ctx: ToolContext,
  triggerPayload: Record<string, unknown>,
): Promise<ToolResult> {
  const draft = ctx.session.draftIr;
  if (!draft || !Array.isArray(draft.nodes) || draft.nodes.length === 0) {
    return {
      content: [{ type: 'text', text: 'run_draft: the canvas is empty — nothing to run.' }],
      isError: true,
    };
  }
  const repeat = ctx.session.lastFailedNodeId;
  if (repeat && (ctx.session.fixAttempts.get(repeat) ?? 0) >= MAX_FIX_ATTEMPTS) {
    return {
      content: [
        {
          type: 'text',
          text: `"${repeat}" has already failed ${MAX_FIX_ATTEMPTS} fix attempts this turn — don't run again. Stop and tell them plainly what keeps failing, what you tried, and what you need.`,
        },
      ],
      isError: true,
    };
  }
  const runId = randomUUID();
  try {
    const outcome = await ctx.client.runFromIr(
      { ir: draft, runId, workflowId: ctx.session.workflowId, triggerPayload },
      ctx.session.callerToken,
    );
    if (outcome.ok) {
      for (const nodeId of Object.keys(outcome.outputs)) {
        if (nodeId === 'trigger') continue;
        ctx.emit({ event: 'step_result', data: { node_id: nodeId, status: 'passed' } });
      }
      ctx.session.lastFailedNodeId = null;
      ctx.emit({ event: 'run_result', data: { status: 'passed', run_id: runId } });
      return {
        content: [
          {
            type: 'text',
            text: `The whole draft ran clean (run ${runId}). Outputs: ${capJson(outcome.outputs)}. If this verifies a build or a fix, show the save choices with offer_save — asking in words alone gives them nothing to tap.`,
          },
        ],
      };
    }
    // A step failed — pull the record so beads reflect per-step reality.
    let failedNodeId: string | undefined;
    let stepLines = '';
    try {
      const record = await ctx.client.readRun(runId, ctx.session.callerToken);
      for (const step of record.steps) {
        if (!step.node_id) continue;
        const failed = step.status === 'error';
        if (failed && !failedNodeId) failedNodeId = step.node_id;
        ctx.emit({
          event: 'step_result',
          data: {
            node_id: step.node_id,
            status: failed ? 'failed' : 'passed',
            ...(failed && step.error ? { summary: step.error.slice(0, 200) } : {}),
          },
        });
      }
      stepLines = formatRunRecord(record);
    } catch {
      stepLines = '(run record not readable)';
    }
    if (failedNodeId) {
      ctx.session.fixAttempts.set(failedNodeId, (ctx.session.fixAttempts.get(failedNodeId) ?? 0) + 1);
      ctx.session.lastFailedNodeId = failedNodeId;
    }
    ctx.emit({
      event: 'run_result',
      data: { status: 'failed', run_id: runId, ...(failedNodeId ? { failed_node_id: failedNodeId } : {}) },
    });
    return {
      content: [
        {
          type: 'text',
          text: `The draft run failed (run ${runId}): ${outcome.detail}\n${stepLines}`,
        },
      ],
    };
  } catch (err) {
    return toolError(err);
  }
}

/** The offer_save handler: the accept chips (fixed set, client-rendered). */
export function runOfferSave(ctx: ToolContext): ToolResult {
  ctx.emit({ event: 'offer', data: { offer_id: randomUUID() } });
  return {
    content: [
      {
        type: 'text',
        text: 'Save choices are showing. Say the offer in one warm sentence and end your turn — their tap arrives as the next message.',
      },
    ],
  };
}

/** The list_runs handler: workflow-scoped history, newest first. */
const SAMPLES_CHAR_CAP = 3500;
const SECRET_KEY = /token|secret|password|api[_-]?key|authorization|credential/i;

/** Hide secret-shaped values and stringify within a size cap — samples pass through chat. */
function renderSamples(outputs: Record<string, unknown>): string {
  const scrub = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(scrub);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[hidden]' : scrub(v);
      return out;
    }
    return value;
  };
  const text = JSON.stringify(scrub(outputs), null, 1) ?? '{}';
  return text.length > SAMPLES_CHAR_CAP
    ? `${text.slice(0, SAMPLES_CHAR_CAP)}\n… (truncated — big values cut, structure above is complete enough to wire refs)`
    : text;
}

export async function runGetSamples(ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.session.workflowId) {
    return {
      content: [
        {
          type: 'text',
          text: 'get_samples: this canvas is unsaved — no run history exists yet. Use clearly-labeled example values and SAY they are examples.',
        },
      ],
    };
  }
  try {
    const outputs = await ctx.client.latestRunSamples(ctx.session.workflowId, ctx.session.callerToken);
    if (!outputs) {
      return {
        content: [
          {
            type: 'text',
            text: 'No completed runs yet — any values you test with are examples; say so plainly.',
          },
        ],
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: `Last completed run, keyed by ref root ({{<key>.path}}):\n${renderSamples(outputs)}`,
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        { type: 'text', text: `get_samples failed: ${err instanceof Error ? err.message : String(err)}` },
      ],
      isError: true,
    };
  }
}

export async function runListRuns(ctx: ToolContext, limit: number): Promise<ToolResult> {
  if (!ctx.session.workflowId) {
    return {
      content: [
        {
          type: 'text',
          text: 'list_runs: this session has no workflow — run history lives on saved workflows.',
        },
      ],
      isError: true,
    };
  }
  try {
    const runs = await ctx.client.listRuns(ctx.session.workflowId, limit, ctx.session.callerToken);
    if (runs.length === 0) {
      return { content: [{ type: 'text', text: 'No runs recorded for this workflow yet.' }] };
    }
    const lines = runs.map(
      (r) =>
        `- ${r.run_id} · ${r.status}${r.started_at ? ` · ${r.started_at}` : ''}${r.error ? ` — ${r.error.slice(0, 200)}` : ''}`,
    );
    return { content: [{ type: 'text', text: `Runs (newest first):\n${lines.join('\n')}` }] };
  } catch (err) {
    return toolError(err);
  }
}

/** The connections_status handler: provider + status, read-only. */
export async function runConnectionsStatus(ctx: ToolContext): Promise<ToolResult> {
  try {
    const connections = await ctx.client.listConnections(ctx.session.callerToken);
    if (connections.length === 0) {
      return {
        content: [{ type: 'text', text: 'No app connections yet — steps that need one will say so.' }],
      };
    }
    const lines = connections.map(
      (c) =>
        `- ${c.provider}${c.display_name ? ` (${c.display_name})` : ''}: ${c.status} [connection_id: ${c.id}]`,
    );
    return {
      content: [
        {
          type: 'text',
          text:
            `Connections:\n${lines.join('\n')}\n\n` +
            'A step uses a connection via its `connectionId` parameter — if a run fails with ' +
            '"requires a <app> connection", set that step\'s connectionId to the matching id above ' +
            'with update_node (never ask the person to reconnect an account that is already active).',
        },
      ],
    };
  } catch (err) {
    return toolError(err);
  }
}

/** The read_run handler: the per-step record, formatted for the fix loop. */
export async function runReadRun(ctx: ToolContext, runId: string): Promise<ToolResult> {
  try {
    const record = await ctx.client.readRun(runId, ctx.session.callerToken);
    return { content: [{ type: 'text', text: formatRunRecord(record) }] };
  } catch (err) {
    return toolError(err);
  }
}

function formatRunRecord(record: RunRecord): string {
  const steps = record.steps
    .map((s) => `  - ${s.node_id ?? '(unknown)'}: ${s.status}${s.error ? ` — ${s.error.slice(0, 300)}` : ''}`)
    .join('\n');
  return [
    `run ${record.run_id}: ${record.status}${record.error ? ` — ${record.error.slice(0, 300)}` : ''}`,
    steps || '  (no step records)',
  ].join('\n');
}

/**
 * The find_trigger handler (ADR 0018): search the trigger catalog for an app
 * event and return exact types + params. The agent then re-types the canvas
 * trigger node with apply_ops — there is no separate trigger row. The two native
 * kinds (orchestr:webhook / orchestr:schedule) need no lookup.
 */
export async function runFindTrigger(ctx: ToolContext, query: string): Promise<ToolResult> {
  try {
    const catalog = await ctx.client.listTriggerCatalog(ctx.session.callerToken);
    const tokens = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2);
    const scored = catalog
      // App/polling triggers only — the two native kinds are used directly.
      .filter((e) => e.type.includes('.'))
      .map((e) => {
        const hay = `${e.type} ${e.name} ${e.description}`.toLowerCase();
        const score = tokens.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
        return { e, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    if (scored.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No app trigger matches "${query}". If they want a timed run use orchestr:schedule (parameters:{interval_minutes:N}); for "something sends us a request" use orchestr:webhook. Re-type the trigger node with apply_ops.`,
          },
        ],
      };
    }
    const lines = scored.map(({ e }) => {
      const params = Object.keys(e.parameters ?? {});
      const paramNote = params.length ? ` (parameters: ${params.join(', ')})` : '';
      return `- ${e.type} — ${e.name}${e.description ? `: ${e.description}` : ''}${paramNote}`;
    });
    return {
      content: [
        {
          type: 'text',
          text: `Trigger types for "${query}":\n${lines.join('\n')}\n\nSet one by re-typing the trigger node: apply_ops {"op":"update_node","node_id":"trigger","node_type":"<type>","parameters":{...}}.`,
        },
      ],
    };
  } catch (err) {
    return toolError(err);
  }
}

/** The need_connection handler: pin a Connect chip on a draft step (cleared by a green re-test). */
export function runNeedConnection(
  ctx: ToolContext,
  input: { node_id: string; provider: string; provider_label: string },
): ToolResult {
  const nodes = Array.isArray(ctx.session.draftIr?.nodes)
    ? (ctx.session.draftIr.nodes as Array<Record<string, unknown>>)
    : [];
  if (!nodes.some((n) => n.id === input.node_id)) {
    const ids = nodes.map((n) => String(n.id)).join(', ') || '(none)';
    return {
      content: [
        {
          type: 'text',
          text: `need_connection: no draft step with id "${input.node_id}" — existing step ids: ${ids}.`,
        },
      ],
      isError: true,
    };
  }
  ctx.emit({
    event: 'connection_needed',
    data: {
      node_id: input.node_id,
      provider: input.provider.trim().toLowerCase(),
      provider_label: input.provider_label.trim(),
    },
  });
  return {
    content: [
      {
        type: 'text',
        text: 'The Connect button is on the step. Say in one sentence which account and why, keep going with what you can, and re-test that step when a note says the connection landed.',
      },
    ],
  };
}

/**
 * The fill_params handler (A4): a focused secondary completion fills ONE
 * step's parameters from its real schema, validated in code, then applied
 * through the same apply_ops path (canvas updates + server-side validation).
 */
export async function runFillParams(ctx: ToolContext, nodeId: string, intent: string): Promise<ToolResult> {
  if (!ctx.paramCompleter) {
    return {
      content: [
        {
          type: 'text',
          text: 'fill_params is not enabled — use get_action_schema and set the parameters yourself.',
        },
      ],
      isError: true,
    };
  }
  const nodes = Array.isArray(ctx.session.draftIr?.nodes)
    ? (ctx.session.draftIr.nodes as Array<Record<string, unknown>>)
    : [];
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) {
    const ids = nodes.map((n) => String(n.id)).join(', ') || '(none)';
    return {
      content: [{ type: 'text', text: `fill_params: no draft step with id "${nodeId}" — existing: ${ids}` }],
      isError: true,
    };
  }
  const type = String(node.node_type);
  if (type.startsWith('orchestr:')) {
    return {
      content: [
        {
          type: 'text',
          text: `fill_params: "${type}" is a control step — set its parameters directly with apply_ops.`,
        },
      ],
      isError: true,
    };
  }
  try {
    const entry = await ctx.client.getActionSchema(type, ctx.session.callerToken);
    if (!entry) {
      return {
        content: [{ type: 'text', text: `fill_params: unknown action type "${type}".` }],
        isError: true,
      };
    }
    const current =
      node.parameters && typeof node.parameters === 'object'
        ? (node.parameters as Record<string, unknown>)
        : {};
    const filled = await fillParams(ctx.paramCompleter, entry, intent, current);
    if (!filled.ok) {
      return {
        content: [
          {
            type: 'text',
            text: `fill_params: ${filled.detail}. Fall back to get_action_schema and set the parameters yourself.`,
          },
        ],
        isError: true,
      };
    }
    const applied = await runApplyOps(ctx, [
      { op: 'update_node', node_id: nodeId, parameters: filled.params },
    ]);
    if (applied.isError) return applied;
    return {
      content: [{ type: 'text', text: `Parameters set on "${nodeId}": ${capJson(filled.params)}` }],
    };
  } catch (err) {
    return toolError(err);
  }
}

/** Compact post-apply summary so the agent tracks canvas state without re-reading it. */
export function summarizeDraft(ir: Record<string, unknown>): string {
  const nodes = Array.isArray(ir.nodes) ? (ir.nodes as Array<Record<string, unknown>>) : [];
  const edges = Array.isArray(ir.edges) ? (ir.edges as Array<Record<string, unknown>>) : [];
  const nodeList = nodes.map((n) => `${String(n.id)} (${String(n.node_type)})`).join(', ');
  const edgeList = edges
    .map((e) => `${String(e.source_node_id)}:${String(e.source_port)}→${String(e.target_node_id)}`)
    .join(', ');
  return `Applied. Canvas now has ${nodes.length} step(s): ${nodeList || '(none)'}${
    edges.length > 0 ? ` — wired: ${edgeList}` : ''
  }`;
}

function formatEntry(e: CatalogEntry): string {
  const params = Object.entries(e.parameters ?? {})
    .filter(([, v]) => v && typeof v === 'object')
    .map(([key, v]) => {
      const p = v as { type?: unknown; required?: unknown; description?: unknown };
      const req = p.required === true ? 'required' : 'optional';
      const desc = typeof p.description === 'string' ? ` — ${p.description.slice(0, 120)}` : '';
      const kind = typeof p.type === 'string' ? p.type : 'unknown';
      return `  - ${key} (${kind}, ${req})${desc}`;
    })
    .join('\n');
  return [
    `type: ${e.type}`,
    `name: ${e.name}${e.category ? ` [${e.category}]` : ''}`,
    `description: ${e.description.slice(0, 240)}`,
    params ? `parameters:\n${params}` : 'parameters: (none)',
  ].join('\n');
}

function toolError(err: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
    isError: true,
  };
}
