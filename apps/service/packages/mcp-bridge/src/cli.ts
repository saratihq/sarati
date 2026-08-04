#!/usr/bin/env node
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { JSONRPCMessage } from '@modelcontextprotocol/server';

/** stdout carries protocol frames only — everything the operator reads goes to stderr. */
function fail(message: string): never {
  process.stderr.write(`sarati-mcp: ${message}\n`);
  process.exit(1);
}

function endpoint(baseUrl: string): URL {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return new URL(trimmed.endsWith('/mcp') ? trimmed : `${trimmed}/mcp`);
}

const baseUrl = process.env.SARATI_BASE_URL;
const apiKey = process.env.SARATI_API_KEY;

if (!baseUrl) fail('set SARATI_BASE_URL to your Sarati instance, e.g. http://localhost:8001');
if (!apiKey) fail('set SARATI_API_KEY to a Sarati API key (ork_…) scoped for this agent');

const remote = new StreamableHTTPClientTransport(endpoint(baseUrl), {
  requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
});
const local = new StdioServerTransport();

let closing = false;
async function shutdown(reason?: string): Promise<void> {
  if (closing) return;
  closing = true;
  if (reason) process.stderr.write(`sarati-mcp: ${reason}\n`);
  await Promise.allSettled([remote.close(), local.close()]);
  process.exit(reason ? 1 : 0);
}

const forward = (to: { send: (m: JSONRPCMessage) => Promise<void> }, label: string) => {
  return (message: JSONRPCMessage): void => {
    to.send(message).catch((err: unknown) => {
      void shutdown(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
};

remote.onmessage = forward(local, 'writing to stdout');
local.onmessage = forward(remote, `reaching ${endpoint(baseUrl).href}`);
remote.onerror = (err) => void shutdown(err.message);
local.onerror = (err) => void shutdown(err.message);
remote.onclose = () => void shutdown();
local.onclose = () => void shutdown();

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await local.start();
await remote.start();
