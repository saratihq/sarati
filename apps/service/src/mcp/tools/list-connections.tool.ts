import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { ApiScope } from '../../auth/scopes';
import { ConnectionsService } from '../../connections/connections.service';
import type { McpCallContext, McpTool } from '../mcp-tool';
import { decodeOffsetCursor, encodeOffsetCursor } from '../offsetCursor';

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;

const Input = z.object({
  query: z.string().trim().optional().describe('Filter by app, e.g. `slack` — substring, case-insensitive.'),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().optional().describe('The `next_cursor` from a previous call; omit for the first page.'),
});

const Output = z.object({
  connections: z.array(
    z.object({
      /** Put this on a node as `parameters.connectionId` — it is the only thing that becomes step auth. */
      id: z.string(),
      provider: z.string(),
      /** The `<app>` half of the action ids this connection can serve; null when it can serve none. */
      app_slug: z.string().nullable(),
      kind: z.enum(['managed', 'byo']),
      /** `active` is runnable; `pending`/`expired`/`failed` need the owner to finish or redo the connect flow. */
      status: z.string(),
      host: z.string().optional(),
    }),
  ),
  next_cursor: z.string().nullable(),
});

@Injectable()
export class ListConnectionsTool implements McpTool {
  readonly name = 'orchestr_list_connections';
  readonly scope: ApiScope = 'connection:read';
  readonly title = 'List connections';
  readonly description =
    'The connections available to this account — ids and status only, never credential material. A node that needs auth carries one of these ids as `connectionId`.';
  readonly inputSchema = Input;
  readonly outputSchema = Output;
  readonly annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  constructor(private readonly connections: ConnectionsService) {}

  async run(input: unknown, ctx: McpCallContext): Promise<z.infer<typeof Output>> {
    const { query, limit, cursor } = Input.parse(input);
    const offset = decodeOffsetCursor(cursor);
    const page = await this.connections.listChoices(ctx.principal.user.id, {
      ...(query ? { query } : {}),
      limit,
      offset,
    });
    return {
      connections: page.items,
      next_cursor: page.hasMore ? encodeOffsetCursor(offset + page.items.length) : null,
    };
  }
}
