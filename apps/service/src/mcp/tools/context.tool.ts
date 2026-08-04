import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { ApiScope } from '../../auth/scopes';
import { EnvironmentsService } from '../../environments/environments.service';
import { OrgsService } from '../../orgs/orgs.service';
import { MCP_CALLS_PER_MINUTE } from '../limits';
import type { McpCallContext, McpTool } from '../mcp-tool';

const Input = z.object({});

const Output = z.object({
  user: z.object({ id: z.string(), email: z.string().nullable(), name: z.string().nullable() }),
  org: z.object({
    id: z.string().nullable(),
    name: z.string().nullable(),
    role: z.string().nullable(),
    /** True when the credential is bound to this org and cannot address another one. */
    pinned: z.boolean(),
  }),
  capabilities: z.array(z.string()),
  environments: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      is_prod: z.boolean(),
      connected_apps: z.array(z.string()),
    }),
  ),
  limits: z.object({ calls_per_minute: z.number() }),
});

@Injectable()
export class ContextTool implements McpTool {
  readonly name = 'orchestr_context';
  readonly scope: ApiScope = 'workflow:read';
  readonly title = 'Sarati context';
  readonly description =
    'Who this credential is, which organization it is pinned to, which tools it may call, and which environments exist. Call this first — a mis-issued key otherwise looks like an empty account.';
  readonly inputSchema = Input;
  readonly outputSchema = Output;
  readonly annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  constructor(
    private readonly orgs: OrgsService,
    private readonly environments: EnvironmentsService,
  ) {}

  async run(_input: unknown, ctx: McpCallContext): Promise<z.infer<typeof Output>> {
    const { principal } = ctx;
    const orgId = principal.activeOrgId;
    const environments = orgId ? await this.environments.list(orgId) : [];

    return {
      user: {
        id: principal.user.id,
        email: principal.user.email ?? null,
        name: principal.user.name ?? null,
      },
      org: {
        id: orgId,
        name: orgId ? await this.orgs.nameOf(orgId) : null,
        role: principal.activeOrgRole,
        pinned: principal.kind === 'api_key' && principal.keyOrgId !== null,
      },
      capabilities: [...ctx.availableTools],
      environments: environments.map((env) => ({
        id: env.id,
        name: env.name,
        is_prod: env.is_prod,
        connected_apps: env.slots.map((slot) => slot.app),
      })),
      limits: { calls_per_minute: MCP_CALLS_PER_MINUTE },
    };
  }
}
