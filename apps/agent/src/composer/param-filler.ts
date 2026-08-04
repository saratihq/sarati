import Anthropic from '@anthropic-ai/sdk';

import type { CatalogEntry } from './workflow-client';

/**
 * The param sub-chain (A4, the focused-subcall pattern): a FOCUSED secondary LLM call whose
 * entire context is ONE action's full schema + the step's intent, returning
 * parameters that are then validated IN CODE against that schema — unknown
 * keys rejected, required keys enforced, basic type sanity. The main agent
 * never hand-writes catalog-action parameter JSON.
 */

export type ParamFillResult = { ok: true; params: Record<string, unknown> } | { ok: false; detail: string };

/** Injectable completion seam (tests script it; prod wraps the Anthropic SDK). */
export type ParamCompleteFn = (system: string, user: string) => Promise<string>;

export function anthropicParamCompleter(apiKey: string, model: string): ParamCompleteFn {
  const client = new Anthropic({ apiKey });
  return async (system, user) => {
    const response = await client.messages.create({
      model,
      max_tokens: 2_000,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const block = response.content.find((b) => b.type === 'text');
    return block && block.type === 'text' ? block.text : '';
  };
}

interface SchemaParam {
  type?: unknown;
  required?: unknown;
  description?: unknown;
}

/** Keys that describe the form, not data the runner reads. */
const NON_SETTABLE_TYPES = new Set(['MARKDOWN']);

/** A {{step.path}} reference is legal anywhere a scalar goes. */
const isRef = (v: unknown): boolean => typeof v === 'string' && /\{\{.+\}\}/.test(v);

export function validateParams(
  schema: Record<string, unknown>,
  params: Record<string, unknown>,
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const fields = new Map<string, SchemaParam>();
  for (const [key, def] of Object.entries(schema)) {
    if (def && typeof def === 'object') fields.set(key, def);
  }

  for (const key of Object.keys(params)) {
    const def = fields.get(key);
    if (!def) {
      errors.push(`unknown parameter "${key}" — not in this action's schema`);
      continue;
    }
    if (typeof def.type === 'string' && NON_SETTABLE_TYPES.has(def.type)) {
      errors.push(`parameter "${key}" is informational (${def.type}) — do not set it`);
      continue;
    }
    const value = params[key];
    if (typeof def.type === 'string' && !isRef(value) && value !== null && value !== undefined) {
      if (def.type === 'NUMBER' && typeof value !== 'number') {
        errors.push(`parameter "${key}" must be a number (or a {{ref}})`);
      }
      if (def.type === 'CHECKBOX' && typeof value !== 'boolean') {
        errors.push(`parameter "${key}" must be true or false`);
      }
    }
  }

  for (const [key, def] of fields) {
    if (def.required !== true) continue;
    if (typeof def.type === 'string' && NON_SETTABLE_TYPES.has(def.type)) continue;
    const value = params[key];
    if (value === undefined || value === null || value === '') {
      errors.push(`required parameter "${key}" is missing`);
    }
  }

  return { ok: errors.length === 0, errors };
}

const FILLER_SYSTEM = `You fill in ONE automation action's parameters. You receive the action's full parameter schema, what the step should do, and any current values. Reply with ONLY a JSON object of parameter values — no prose, no markdown fences.
Rules: use ONLY parameter names from the schema; include every required parameter; reference upstream data as "{{step_id.path}}" or "{{trigger.path}}" inside string values; keep values realistic and minimal; never invent credentials or ids you don't have — leave optional unknowns out.`;

export async function fillParams(
  complete: ParamCompleteFn,
  entry: CatalogEntry,
  intent: string,
  currentParams: Record<string, unknown>,
): Promise<ParamFillResult> {
  const schema = entry.parameters && typeof entry.parameters === 'object' ? entry.parameters : {};
  const prompt = [
    `Action: ${entry.type} — ${entry.name}`,
    `Schema:\n${JSON.stringify(schema, null, 1)}`,
    `The step should: ${intent}`,
    Object.keys(currentParams).length > 0 ? `Current values:\n${JSON.stringify(currentParams)}` : '',
    'Return the JSON object of parameters now.',
  ]
    .filter(Boolean)
    .join('\n\n');

  let lastErrors: string[] = [];
  let lastRaw = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ask =
      attempt === 0
        ? prompt
        : `${prompt}\n\nYour previous reply:\n${lastRaw.slice(0, 2_000)}\n\nIt was rejected:\n- ${lastErrors.join('\n- ')}\n\nFix those problems and return the corrected JSON object.`;
    lastRaw = await complete(FILLER_SYSTEM, ask);
    const parsed = parseJsonObject(lastRaw);
    if (!parsed) {
      lastErrors = ['the reply was not a parseable JSON object'];
      continue;
    }
    const verdict = validateParams(schema, parsed);
    if (verdict.ok) return { ok: true, params: parsed };
    lastErrors = verdict.errors;
  }
  return { ok: false, detail: `param filling failed validation: ${lastErrors.join('; ')}` };
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
