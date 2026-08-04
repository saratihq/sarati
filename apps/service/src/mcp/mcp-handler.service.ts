import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  createMcpHandler,
  McpServer,
  TRACEPARENT_META_KEY,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import { HttpException } from '@nestjs/common';

import type { Principal } from '../auth/principal';
import { scopeSatisfied } from '../auth/scopes';
import { DomainError } from '../common/domain-error';
import { errorMessage } from '../common/error-message';
import { MCP_TOOLS, type McpTool } from './mcp-tool';
import { toToolError, toToolResult } from './presentation/result';
import { WorkflowInvokeTool } from './workflow-invoke.tool';
import { WorkflowToolsService, type WorkflowTool } from './workflow-tools.service';

const SERVER_INFO = { name: 'orchestr', version: '1.0.0' };

/** The principal for the request being served; keyed by the Request the controller built for it. */
const principals = new WeakMap<Request, Principal>();

/** Sessions carry their owner's full authority; a key is held to the scopes it was issued with. */
function allowedFor(principal: Principal, tool: McpTool): boolean {
  return principal.kind !== 'api_key' || scopeSatisfied(principal.scopes, tool.scope);
}

function messageOf(err: unknown): string {
  if (err instanceof DomainError || err instanceof HttpException) return err.message;
  return errorMessage(err);
}

/** A DomainError's machine-readable fields, so a failure reaches the agent as data, not prose. */
function detailsOf(err: unknown): { code?: string; details?: Record<string, unknown> } {
  if (!(err instanceof DomainError) || !err.details) return {};
  const { code, ...rest } = err.details;
  return {
    ...(typeof code === 'string' ? { code } : {}),
    ...(Object.keys(rest).length > 0 ? { details: rest } : {}),
  };
}

@Injectable()
export class McpHandlerService implements OnModuleDestroy {
  private readonly logger = new Logger(McpHandlerService.name);
  private readonly handler: McpHttpHandler;

  constructor(
    @Inject(MCP_TOOLS) private readonly tools: readonly McpTool[],
    private readonly workflowTools: WorkflowToolsService,
    private readonly invoker: WorkflowInvokeTool,
  ) {
    this.handler = createMcpHandler((ctx) => this.buildServer(ctx.requestInfo), {
      onerror: (err) => this.logger.error(`MCP transport error: ${err.message}`),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.handler.close();
  }

  /** Tool order is the registry's, sorted by name, so `tools/list` is byte-identical across connections. */
  ordered(): readonly McpTool[] {
    return [...this.tools].sort((a, b) => a.name.localeCompare(b.name));
  }

  toolsFor(principal: Principal): readonly McpTool[] {
    return this.ordered().filter((tool) => allowedFor(principal, tool));
  }

  serve(request: Request, principal: Principal, parsedBody: unknown): Promise<Response> {
    principals.set(request, principal);
    return this.handler.fetch(request, { parsedBody });
  }

  private async buildServer(request: Request | undefined): Promise<McpServer> {
    const server = new McpServer(SERVER_INFO);
    const principal = request ? principals.get(request) : undefined;
    // A discover probe carries no request; it advertises the surface without listing scoped tools.
    if (!principal) return server;

    const allowed = this.toolsFor(principal);
    const published = await this.publishedToolsFor(principal);
    const availableTools = [...allowed.map((tool) => tool.name), ...published.map((t) => t.name)];

    for (const tool of allowed) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          annotations: tool.annotations,
        },
        async (input: unknown, ctx) => {
          const traceparent = ctx.mcpReq._meta?.[TRACEPARENT_META_KEY];
          try {
            return toToolResult(
              await tool.run(input, {
                principal,
                availableTools,
                traceparent: typeof traceparent === 'string' ? traceparent : undefined,
              }),
            );
          } catch (err) {
            this.logger.warn(`${tool.name} failed: ${messageOf(err)}`);
            const { code, details } = detailsOf(err);
            return toToolError(messageOf(err), code, details);
          }
        },
      );
    }

    for (const tool of published) this.invoker.register(server, tool, principal);
    return server;
  }

  /** A tenant's own published workflows (ADR 0053) — visible only to a key that may invoke them. */
  private async publishedToolsFor(principal: Principal): Promise<WorkflowTool[]> {
    const holds = principal.kind !== 'api_key' || scopeSatisfied(principal.scopes, 'workflow:invoke');
    if (!holds) return [];
    return this.workflowTools.listFor(principal.activeOrgId);
  }
}
