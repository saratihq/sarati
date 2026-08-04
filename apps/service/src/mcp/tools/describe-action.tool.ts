import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { ApiScope } from '../../auth/scopes';
import { ComposeCatalogService } from '../../compose/compose-catalog.service';
import { DomainError } from '../../common/domain-error';
import type { McpTool } from '../mcp-tool';

/** Parameter-schema budget, well under the 15 KB result cap so the envelope never trims a list. */
const SCHEMA_BUDGET_BYTES = 6_000;
/** How many omitted names are listed before the count stands in for the rest. */
const MAX_OMITTED_NAMES = 80;

const Input = z.object({
  type: z.string().min(1).describe('The exact `type` from orchestr_search_actions.'),
  include_properties: z
    .array(z.string())
    .optional()
    .describe('Return only these parameters — use it to fetch ones a previous call omitted.'),
});

const Output = z.object({
  type: z.string(),
  name: z.string(),
  kind: z.enum(['action', 'trigger', 'control']),
  rail: z.enum(['sdk', 'composio', 'control', 'native']),
  category: z.string(),
  description: z.string(),
  auth: z.object({ scheme: z.string(), required: z.boolean() }),
  parameters: z.record(z.string(), z.unknown()),
  example_config: z.record(z.string(), z.unknown()),
  one_of_constraints: z.array(z.object({ label: z.string(), oneOf: z.array(z.string()) })),
  honesty_warnings: z.array(z.string()),
  schema_truncated: z
    .object({
      omitted_properties: z.array(z.string()),
      omitted_count: z.number().int(),
      note: z.string(),
    })
    .optional(),
});

/** Required parameters first, then the rest in declaration order (providers list primary args first). */
function orderedNames(parameters: Record<string, unknown>): string[] {
  const names = Object.keys(parameters);
  const isRequired = (name: string): boolean =>
    (parameters[name] as { required?: unknown } | null)?.required === true;
  return [...names.filter(isRequired), ...names.filter((name) => !isRequired(name))];
}

/** Fit as much of the schema as the budget allows; what does not fit is named, never silently dropped. */
function selectProperties(
  parameters: Record<string, unknown>,
  requested: readonly string[] | undefined,
): { properties: Record<string, unknown>; omitted: string[] } {
  const ordered = orderedNames(parameters);
  const candidates =
    requested && requested.length > 0 ? ordered.filter((name) => requested.includes(name)) : ordered;
  const properties: Record<string, unknown> = {};
  let used = 2;
  for (const name of candidates) {
    const size = Buffer.byteLength(JSON.stringify({ [name]: parameters[name] }), 'utf8');
    if (used + size > SCHEMA_BUDGET_BYTES) continue;
    properties[name] = parameters[name];
    used += size;
  }
  return { properties, omitted: ordered.filter((name) => !(name in properties)) };
}

@Injectable()
export class DescribeActionTool implements McpTool {
  readonly name = 'orchestr_describe_action';
  readonly scope: ApiScope = 'workflow:read';
  readonly title = 'Describe an action or trigger';
  readonly description =
    'One type to its full parameter schema, auth requirements and example configuration. Resolves triggers as well as actions. A large schema comes back trimmed with the omitted parameter names listed — re-request those by name with include_properties.';
  readonly inputSchema = Input;
  readonly outputSchema = Output;
  readonly annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  constructor(private readonly catalog: ComposeCatalogService) {}

  async run(input: unknown): Promise<z.infer<typeof Output>> {
    const { type, include_properties: requested } = Input.parse(input);
    const entry = await this.catalog.byType(type.trim());
    if (!entry) {
      throw new DomainError(
        `Unknown type '${type.trim()}' — call orchestr_search_actions and copy an exact \`type\` value`,
        404,
      );
    }

    const { properties, omitted } = selectProperties(entry.parameters, requested);
    return {
      type: entry.type,
      name: entry.name,
      kind: entry.kind,
      rail: entry.rail,
      category: entry.category,
      description: entry.description,
      auth: { scheme: entry.auth_scheme, required: entry.auth === 'connection' },
      parameters: properties,
      example_config: entry.example_config,
      one_of_constraints: entry.one_of_constraints,
      honesty_warnings: entry.honesty_warnings,
      ...(omitted.length > 0
        ? {
            schema_truncated: {
              omitted_properties: omitted.slice(0, MAX_OMITTED_NAMES),
              omitted_count: omitted.length,
              note: `${omitted.length} of ${Object.keys(entry.parameters).length} parameters were omitted to stay within the result size cap — request the ones you need by name with include_properties.`,
            },
          }
        : {}),
    };
  }
}
