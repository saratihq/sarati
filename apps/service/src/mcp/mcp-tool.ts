import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type { ZodType } from 'zod';

import type { Principal } from '../auth/principal';
import type { ApiScope } from '../auth/scopes';

/** Everything a tool handler is allowed to know about its caller (— no per-connection state). */
export interface McpCallContext {
  readonly principal: Principal;
  /** The tools this token may call — the handler's own scope filter, so the mapping has one home. */
  readonly availableTools: readonly string[];
  readonly traceparent?: string;
}

/** One MCP tool: schema + annotations + a handler that calls in-process services (never HTTP self-calls). */
export interface McpTool {
  readonly name: string;
  /** The API-key scope a caller must hold; also what filters `tools/list` per token. */
  readonly scope: ApiScope;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: ZodType;
  readonly outputSchema: ZodType;
  readonly annotations: ToolAnnotations;
  run(input: unknown, ctx: McpCallContext): Promise<unknown>;
}

export const MCP_TOOLS = Symbol('MCP_TOOLS');
