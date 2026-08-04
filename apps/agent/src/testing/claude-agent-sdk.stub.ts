/**
 * Jest-only stand-in for @anthropic-ai/claude-agent-sdk. The real package is
 * ESM-only; Node ≥22 require()s it fine at runtime, but Jest's CJS module
 * registry cannot. Unit tests script the SDK stream through QUERY_FN anyway —
 * this stub only has to satisfy the value imports (tool/createSdkMcpServer)
 * that agent-tools.ts constructs its server with.
 */

export function tool(
  name: string,
  description: string,
  inputSchema: unknown,
  handler: unknown,
  extras?: unknown,
): Record<string, unknown> {
  return { name, description, inputSchema, handler, extras };
}

export function createSdkMcpServer(options: {
  name: string;
  version?: string;
  tools?: unknown[];
}): Record<string, unknown> {
  return { type: 'sdk', name: options.name, instance: { options } };
}

export function query(): never {
  throw new Error('the real Agent SDK is not available under Jest — inject a scripted QUERY_FN');
}
