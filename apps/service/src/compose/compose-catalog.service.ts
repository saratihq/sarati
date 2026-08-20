import { Injectable } from '@nestjs/common';

import { DomainError } from '../common/domain-error';
import type { CatalogFacts } from './author-validation';
import { CONTROL_NODE_SCHEMAS } from '../generation/control-node-types';
import { VectorStore } from '../generation/vector-store';
import { MANUAL_TRIGGER, TriggerCatalogService } from '../triggers/trigger-catalog.service';
import type { PlatformKeyScope } from '../platform/platform-keys.service';

import {
  toCatalogEntry,
  toDetailedEntry,
  type CatalogEntry,
  type DetailedCatalogEntry,
} from './catalog-entry';

/**
 * The author-time view of the catalog: retrieval for the composer's search tool and MCP, and the
 * allow-lists apply-ops validates node_type against. Actions come from the same VectorStore the
 * generation pipeline uses and triggers from the one trigger catalog — one source per kind.
 */

const COLLECTION = 'orchestr_actions';

/**
 * Agent-facing node copy projected over `CONTROL_NODE_SCHEMAS` — the parameter SCHEMA is
 * single-sourced there and must not be re-declared here; a missing entry falls back to it.
 */
const COMPOSER_NODE_DESCRIPTIONS: Record<string, string> = {
  'orchestr:if':
    'Branch the flow: connect source_port 0 for when the condition holds (then), source_port 1 for when it does not (else). Parameters: left, op (eq|ne|gt|gte|lt|lte|contains|truthy|falsy), right.',
  'orchestr:switch':
    'Route by condition, N ways — If generalized. Wire each case output in order: source_port 0 for case 0, source_port 1 for case 1, …, and source_port cases.length for the default/fallback (taken when no case matches). Cases are evaluated in order and the FIRST match wins. Parameters: cases — an ordered array of conditions, each {left, op (eq|ne|gt|gte|lt|lte|contains|truthy|falsy), right}.',
  'orchestr:code':
    'Run a code snippet in a secure sandbox to transform the run data — for logic the catalog actions can\'t express (reshaping, math, string work, filtering). The snippet is an (async) function body that receives the run so far as `steps` (prior nodes keyed by id, e.g. `steps.<nodeId>.body.<field>`) plus a `trigger` alias, may `await`, and returns a value that becomes this node\'s output. No network/filesystem/host access; 5s + 128MB bounds. Parameters: language ("js" or "ts", default "js"), code (the snippet).',
  'orchestr:loop':
    'Repeat a body sub-flow. Wire the body from source_port 0 (runs each round) and any after-loop steps from source_port 1 (runs once, after the loop); steps after the loop read the per-round results as {{<loop node id>}}. Two modes via the "mode" param: "items" (default) runs the body once per element of a collection — the body reads {{item}}/{{itemIndex}} (params: items = an expression resolving to an array, item_var default "item"); "while" repeats the body do-while a condition holds (it always runs at least once) bounded by a required max_iterations cap — the body reads the round index as {{loopRound}} and the previous round\'s outputs as {{loopPrev}} (params: condition = a {left, op, right} shape like IF, max_iterations = a positive integer).',
  'orchestr:agent':
    'A durable tool-calling agent — for open-ended work no single action expresses. It runs a model in a loop, calling the tools you wire to its "tools" handle (edges with port_type "tool") until it produces a final answer; that answer becomes this node\'s output (downstream refs read it as {{<agent node id>}}). Wire action nodes (or an orchestr:call_workflow node) to the tools port to give it capabilities. Parameters: system_prompt (how the agent should behave and use its tools), input (the task/user message it works on — usually a trigger field like {{trigger.message}}; defaults to the whole trigger payload if empty), model ({ provider, model } where provider is openai|claude|gemini|mistral and model is that provider\'s model id; default { provider: "claude", model: "claude-opus-4-8" }), max_steps (a positive integer hard cap on model + tool rounds before it must answer — the infinite-loop guard, default 25). No connection is needed — a promoted/environment run resolves the model from that environment\'s connection slot for the provider.',
  'orchestr:call_workflow':
    'Run another workflow and use its result — how reusable sub-workflows are composed. Place it in the flow like any other step (connect it with main edges; later steps read its result as {{<node id>}}) and set "input" to what the target should receive as its trigger event, read inside it as {{trigger.<key>}}. Alternatively wire it to an agent with a tool edge (port_type "tool") and the agent decides when to call it, producing the input itself — set tool_name / tool_description then. The target must DECLARE itself callable (an orchestr:tool_trigger trigger with a name and description) or the call is refused; it runs its LIVE version for the current environment, AS the caller (its steps resolve connections through the same environment slots), and its terminal step\'s output is the result. A workflow cannot call itself (compile error) and nesting depth is capped. Parameters: workflow_id (required — the id of the workflow to run), input (an object; omit when used as an agent tool).',
};

/** The presentational trigger head node — composer-only, since it has no catalog row. */
const TRIGGER_HEAD: Record<string, unknown> = {
  name: 'Trigger',
  type: MANUAL_TRIGGER,
  category: 'control',
  description:
    'The workflow entry point — the run starts here and the triggering event payload is referenced as {{trigger.path}}. Every workflow needs exactly one.',
  auth: 'none',
  parameters: {},
};

/** Runtime control constructs — the shared schemas with agent copy, plus the trigger head. */
const CONTROL_TYPES: Array<Record<string, unknown>> = [
  TRIGGER_HEAD,
  ...CONTROL_NODE_SCHEMAS.map((schema) => ({
    ...schema,
    description: COMPOSER_NODE_DESCRIPTIONS[schema.type] ?? schema.description,
  })),
];

/** Which half of the catalog a search covers. */
export type CatalogSearchKind = 'action' | 'trigger' | 'any';

/** One page of catalog hits; `next_cursor` is opaque and only valid for the same query + kind. */
export interface CatalogSearchPage {
  results: CatalogEntry[];
  next_cursor?: string;
}

@Injectable()
export class ComposeCatalogService {
  private allowed: Set<string> | null = null;
  private controls: Set<string> | null = null;

  constructor(
    private readonly vectorStore: VectorStore,
    private readonly triggerCatalog: TriggerCatalogService,
  ) {}

  /**
   * The control-construct node types, which the runtime compiles itself rather than routing to an
   * action rail — the commit gate skips them before its routability check. Single-sourced from
   * {@link CONTROL_TYPES}; never keep a parallel list.
   */
  controlTypes(): ReadonlySet<string> {
    this.controls ??= new Set(CONTROL_TYPES.map((c) => c.type as string));
    return this.controls;
  }

  /**
   * The catalog facts document validation needs, resolved synchronously: only ACTION nodes carry a
   * step credential, and actions live in the vector store, so no await is needed to answer this.
   */
  facts(): CatalogFacts {
    const auth = new Map(
      this.vectorStore
        .entries(COLLECTION)
        .map((e) => [String(e.type), typeof e.auth === 'string' ? e.auth : 'none'] as const),
    );
    return {
      controlTypes: this.controlTypes(),
      authOf: (nodeType: string) => auth.get(nodeType) ?? 'none',
      isTriggerType: (nodeType: string) => this.triggerCatalog.isKnownTriggerType(nodeType),
    };
  }

  /** Paged retrieval over actions, triggers, or both — the composer's and MCP's one search. */
  async search(input: {
    scope: PlatformKeyScope;
    query: string;
    kind: CatalogSearchKind;
    limit: number;
    cursor?: string;
  }): Promise<CatalogSearchPage> {
    const offset = decodeCursor(input.cursor, input.query, input.kind);
    // One past the page tells us whether another page exists without a second ranking pass.
    const want = offset + input.limit + 1;
    const actions = input.kind === 'trigger' ? [] : this.rankedActions(input.query, want);
    const triggers = input.kind === 'action' ? [] : await this.rankedTriggers(input.scope, input.query, want);
    const ranked =
      input.kind === 'any' ? interleave(actions, triggers) : [...actions, ...triggers].slice(0, want);
    const results = ranked.slice(offset, offset + input.limit);
    const more = ranked.length > offset + results.length;
    return {
      results,
      ...(more ? { next_cursor: encodeCursor(input.query, input.kind, offset + results.length) } : {}),
    };
  }

  /** Exact-type lookup with the FULL parameter schema and auth detail — search results are trimmed. */
  async byType(scope: PlatformKeyScope, type: string): Promise<DetailedCatalogEntry | null> {
    const control = CONTROL_TYPES.find((c) => c.type === type);
    if (control) return toDetailedEntry(control, 'control');
    const action = this.vectorStore.entries(COLLECTION).find((e) => e.type === type);
    if (action) return toDetailedEntry(action, 'action');
    const trigger = (await this.triggerCatalog.list(scope)).find((row) => row.entry.type === type);
    return trigger ? toDetailedEntry(trigger.entry, 'trigger', trigger.rail) : null;
  }

  /** Every node_type apply-ops accepts as a STEP: runnable catalog actions + control constructs. */
  allowedTypes(): ReadonlySet<string> {
    if (!this.allowed) {
      const types = this.vectorStore
        .entries(COLLECTION)
        .map((e) => e.type)
        .filter((t): t is string => typeof t === 'string' && t.length > 0);
      this.allowed = new Set([...types, ...CONTROL_TYPES.map((c) => c.type as string)]);
    }
    return this.allowed;
  }

  /**
   * Trigger types the agent may re-type the canvas trigger node to — the SAME rows the
   * picker offers, so a trigger a human can place is a trigger an agent can author. Uncached: the
   * Composio projection behind it refreshes on its own TTL.
   */
  async allowedTriggerTypes(scope: PlatformKeyScope): Promise<ReadonlySet<string>> {
    const rows = await this.triggerCatalog.list(scope);
    return new Set([MANUAL_TRIGGER, ...rows.map((row) => String(row.entry.type))]);
  }

  /** Vector hits over the action collection, with control constructs pinned by intent. */
  private rankedActions(query: string, want: number): CatalogEntry[] {
    const hits = this.vectorStore.search(query, want, COLLECTION).map((e) => toCatalogEntry(e, 'action'));
    const pinned = pinnedControlTypes(query).map((c) => toCatalogEntry(c, 'control'));
    const seen = new Set(pinned.map((e) => e.type));
    return [...pinned, ...hits.filter((e) => !seen.has(e.type))].slice(0, want);
  }

  /** Trigger rows scored lexically — they come from a live async catalog, not the static index. */
  private async rankedTriggers(
    scope: PlatformKeyScope,
    query: string,
    want: number,
  ): Promise<CatalogEntry[]> {
    const rows = (await this.triggerCatalog.list(scope)).map((row) =>
      toCatalogEntry(row.entry, 'trigger', row.rail),
    );
    const terms = searchTerms(query);
    if (terms.length === 0) return rows.slice(0, want);
    return rows
      .map((entry) => ({ entry, score: lexicalScore(entry, terms) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.type.localeCompare(b.entry.type))
      .slice(0, want)
      .map((hit) => hit.entry);
  }
}

/**
 * Control constructs aren't catalog rows, so pin them by intent — otherwise the agent could never
 * find orchestr:if.
 */
function pinnedControlTypes(query: string): Array<Record<string, unknown>> {
  const q = query.toLowerCase();
  return CONTROL_TYPES.filter((c) => {
    const type = c.type as string;
    if (type === 'orchestr:if') return /\b(if|branch|condition|else|compare|threshold)\b/.test(q);
    if (type === 'orchestr:switch')
      return /\b(switch|route|router|case|cases|multi-?way|dispatch|by (status|type|value))\b/.test(q);
    if (type === 'orchestr:wait_for_duration')
      return /\b(wait|delay|pause|later|follow.?up|drip|days?|hours?|minutes?|sleep)\b/.test(q);
    if (type === 'orchestr:wait_for_event') return /\b(wait|approval|approve|pause|event)\b/.test(q);
    if (type === 'orchestr:loop')
      return /\b(loop|for ?each|iterate|repeat|per item|each item|while|until|poll)\b/.test(q);
    if (type === 'orchestr:code')
      return /\b(code|script|javascript|js|typescript|ts|transform|compute|custom logic|function|snippet|reshape|parse)\b/.test(
        q,
      );
    if (type === 'orchestr:agent')
      return /\b(agent|ai agent|autonomous|tool[- ]?call(ing)?|reason(ing)?|llm agent|assistant|chatbot)\b/.test(
        q,
      );
    if (type === 'orchestr:call_workflow')
      return /\b(sub-?workflow|call (a |another )?workflow|another workflow|nested workflow|reusable workflow|workflow as (a )?tool)\b/.test(
        q,
      );
    return false;
  });
}

function searchTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2),
    ),
  ];
}

/** Fraction of the query's terms the row mentions — deterministic, and ties break on `type`. */
function lexicalScore(entry: CatalogEntry, terms: readonly string[]): number {
  const haystack = `${entry.name} ${entry.type} ${entry.category} ${entry.description}`.toLowerCase();
  let hits = 0;
  for (const term of terms) if (haystack.includes(term)) hits += 1;
  return hits / terms.length;
}

/** Alternate the two ranked lists so neither kind is crowded out of an unfiltered search. */
function interleave(actions: readonly CatalogEntry[], triggers: readonly CatalogEntry[]): CatalogEntry[] {
  const merged: CatalogEntry[] = [];
  for (let i = 0; i < Math.max(actions.length, triggers.length); i += 1) {
    const action = actions[i];
    const trigger = triggers[i];
    if (action) merged.push(action);
    if (trigger) merged.push(trigger);
  }
  return merged;
}

function encodeCursor(query: string, kind: CatalogSearchKind, offset: number): string {
  return Buffer.from(JSON.stringify({ q: query, k: kind, o: offset }), 'utf8').toString('base64url');
}

/** A cursor is only valid for the search that minted it — paging a different query would skip rows. */
function decodeCursor(cursor: string | undefined, query: string, kind: CatalogSearchKind): number {
  if (cursor === undefined || cursor === '') return 0;
  const invalid = new DomainError(
    'cursor is not valid for this query — re-run the search without a cursor to start again',
    400,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid;
  }
  const state = parsed as { q?: unknown; k?: unknown; o?: unknown };
  if (state.q !== query || state.k !== kind) throw invalid;
  if (typeof state.o !== 'number' || !Number.isInteger(state.o) || state.o < 0) throw invalid;
  return state.o;
}
