import { Injectable } from '@nestjs/common';

import type { AgentToolCatalog, JsonSchema } from '../runtime/agent';
import { loadComposioCatalog, sdkAction } from './sdk-actions.registry';

/**
 * The registry-backed {@link AgentToolCatalog}: derives a tool's schema + description from the action's
 * EXISTING prop schema, so there is no second metadata surface. Unknown action → `undefined` (the loop opens up).
 */
@Injectable()
export class RegistryAgentToolCatalog implements AgentToolCatalog {
  describeAction(actionId: string): { description: string; parameters: JsonSchema } | undefined {
    // Our SDK action is the precise source — the inspector's own schema.
    const sdk = sdkAction(actionId);
    if (sdk) {
      const manifest = sdk.toManifest();
      return { description: manifest.description, parameters: propsToJsonSchema(manifest.props) };
    }
    // Otherwise, best-effort from the projected Composio catalog row.
    const composio = loadComposioCatalog().find((row) => String(row.type) === actionId);
    if (composio) {
      const parameters =
        composio.parameters && typeof composio.parameters === 'object'
          ? (composio.parameters as Record<string, unknown>)
          : {};
      return {
        description: typeof composio.description === 'string' ? composio.description : '',
        parameters: catalogParamsToJsonSchema(parameters),
      };
    }
    return undefined;
  }
}

/** UPPERCASE inspector prop type → JSON-schema primitive type. */
function jsonTypeOf(rawType: unknown): string {
  switch (String(rawType)) {
    case 'NUMBER':
      return 'number';
    case 'CHECKBOX':
      return 'boolean';
    case 'JSON':
      return 'object';
    case 'MULTI_SELECT_DROPDOWN':
    case 'STATIC_MULTI_SELECT_DROPDOWN':
      return 'array';
    default:
      return 'string';
  }
}

/** SDK manifest props (`Record<name, ManifestProp>`) → a JSON-schema object. */
function propsToJsonSchema(
  props: Record<string, { type: unknown; description?: string; required: boolean }>,
): JsonSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, prop] of Object.entries(props)) {
    properties[name] = {
      type: jsonTypeOf(prop.type),
      ...(prop.description ? { description: prop.description } : {}),
    };
    if (prop.required) required.push(name);
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

/** Projected catalog-row `parameters` (`{ [name]: { type, description, required } }`) → a JSON-schema object. */
function catalogParamsToJsonSchema(params: Record<string, unknown>): JsonSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, raw] of Object.entries(params)) {
    const prop = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    properties[name] = {
      type: jsonTypeOf(prop.type),
      ...(typeof prop.description === 'string' && prop.description ? { description: prop.description } : {}),
    };
    if (prop.required === true) required.push(name);
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}
