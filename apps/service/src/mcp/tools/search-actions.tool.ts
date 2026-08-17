import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { ApiScope } from '../../auth/scopes';
import { ComposeCatalogService } from '../../compose/compose-catalog.service';
import type { McpCallContext, McpTool } from '../mcp-tool';
import { PlatformKeysService } from '../../platform/platform-keys.service';

const DEFAULT_LIMIT = 8;

const Input = z.object({
  query: z.string().min(1).describe("What the step should do, in the user's words."),
  kind: z
    .enum(['action', 'trigger', 'any'])
    .default('any')
    .describe('`trigger` for what STARTS a workflow, `action` for a step it runs.'),
  limit: z.number().int().min(1).max(25).default(DEFAULT_LIMIT),
  cursor: z.string().optional().describe('Opaque page token from a previous call with the same query.'),
});

const Result = z.object({
  type: z.string().describe("The exact string a node's `node_type` must carry."),
  name: z.string(),
  kind: z.enum(['action', 'trigger', 'control']),
  category: z.string(),
  description: z.string(),
  rail: z.enum(['sdk', 'composio', 'control', 'native']),
  requires_connection: z.boolean(),
});

const Output = z.object({
  results: z.array(Result),
  next_cursor: z.string().optional(),
});

@Injectable()
export class SearchActionsTool implements McpTool {
  readonly name = 'orchestr_search_actions';
  readonly scope: ApiScope = 'workflow:read';
  readonly title = 'Search actions and triggers';
  readonly description =
    'Intent to candidate action or trigger types. Returns the exact `type` strings a node must carry. Pass kind:"trigger" to find what starts a workflow — an app trigger type looks like an action type, so it can only be found this way.';
  readonly inputSchema = Input;
  readonly outputSchema = Output;
  readonly annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  constructor(
    private readonly catalog: ComposeCatalogService,
    private readonly platformKeys: PlatformKeysService,
  ) {}

  async run(input: unknown, ctx: McpCallContext): Promise<z.infer<typeof Output>> {
    const { query, kind, limit, cursor } = Input.parse(input);
    const page = await this.catalog.search({
      scope: await this.platformKeys.scopeFor(ctx.principal.user.id, ctx.principal.activeOrgId),
      query,
      kind,
      limit,
      ...(cursor ? { cursor } : {}),
    });
    return {
      results: page.results.map((entry) => ({
        type: entry.type,
        name: entry.name,
        kind: entry.kind,
        category: entry.category,
        description: entry.description,
        rail: entry.rail,
        requires_connection: entry.auth === 'connection',
      })),
      ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
    };
  }
}
