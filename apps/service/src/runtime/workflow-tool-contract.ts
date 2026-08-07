import { isRecord } from '../common/json-util';
import type { JsonSchema } from './agent';

/** Platform tools own this prefix, so a workflow can never shadow one. */
const RESERVED_PREFIX = 'orchestr_';

const TYPES = new Set(['string', 'number', 'boolean', 'object']);

/** One declared parameter of a workflow offered as a tool (ADR 0053 §1). */
export interface WorkflowToolInput {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object';
  description: string;
  required: boolean;
}

/** What a workflow's `orchestr:tool_trigger` declares about calling it. */
export interface WorkflowToolContract {
  name: string;
  description: string;
  inputs: WorkflowToolInput[];
}

/** A tool name an agent can actually call: lowercase, underscore-joined, never shadowing a platform tool. */
export function toolNameOf(raw: unknown, fallback: string): string | null {
  const source = typeof raw === 'string' && raw.trim() ? raw : fallback;
  const name = source
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  if (!name || /^\d/.test(name)) return null;
  // Refused rather than silently renamed: an author who picks a reserved name should find out,
  // not discover their tool answering to something else.
  return name.startsWith(RESERVED_PREFIX.replace(/_$/, '')) ? null : name;
}

function parseJson(raw: unknown): unknown[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** The declared arguments; anything malformed is dropped rather than published as a broken schema. */
export function inputsOf(raw: unknown): WorkflowToolInput[] {
  const declared = Array.isArray(raw) ? raw : parseJson(raw);
  return declared.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name.trim()) return [];
    const type = typeof entry.type === 'string' ? entry.type.toLowerCase() : 'string';
    return [
      {
        name: entry.name.trim(),
        type: (TYPES.has(type) ? type : 'string') as WorkflowToolInput['type'],
        description: typeof entry.description === 'string' ? entry.description : '',
        required: entry.required === true,
      },
    ];
  });
}

/**
 * The contract a `tool_trigger` node's parameters declare, or null when it declares too little to
 * offer: a model picks a tool on its description alone, so an undescribed one is withheld (ADR 0053 §1).
 */
export function contractOf(triggerParameters: unknown, fallbackName: string): WorkflowToolContract | null {
  const parameters = isRecord(triggerParameters) ? triggerParameters : {};
  const name = toolNameOf(parameters.tool_name, fallbackName);
  const description = typeof parameters.description === 'string' ? parameters.description.trim() : '';
  if (!name || !description) return null;
  return { name, description, inputs: inputsOf(parameters.inputs) };
}

/** The declared inputs as the JSON schema a model call is handed. */
export function schemaOf(inputs: WorkflowToolInput[]): JsonSchema {
  const properties: Record<string, unknown> = {};
  for (const input of inputs) {
    properties[input.name] = input.description
      ? { type: input.type, description: input.description }
      : { type: input.type };
  }
  return {
    type: 'object',
    properties,
    required: inputs.filter((i) => i.required).map((i) => i.name),
    // The arguments ARE the firing event (ADR 0053 §1), which carries whatever the caller sends.
    additionalProperties: true,
  };
}
