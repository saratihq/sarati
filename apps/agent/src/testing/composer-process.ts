import { Test } from '@nestjs/testing';
import type { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

import { AppModule } from '../app.module';
import { QUERY_FN } from '../composer/composer.service';
import { SCRIPT_ROUTE, TURN_SCRIPT } from './turn-script';

type ComposerServer = ReturnType<typeof createSdkMcpServer>;
type Transport = Parameters<ComposerServer['instance']['connect']>[0];
type Reply = Parameters<Transport['send']>[0];

const service = (route: string): Promise<Response> => fetch(`${process.env.WORKFLOW_SERVICE_URL}${route}`);

const text = (words: string): Record<string, unknown> => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: words } },
});

// Tool calls as the Agent SDK makes them: JSON-RPC over a transport into the in-process MCP server.
async function toolCaller(server: ComposerServer): Promise<(name: string, args: object) => Promise<Reply>> {
  const replies = new Map<unknown, (reply: Reply) => void>();
  const transport: Transport = {
    start: () => Promise.resolve(),
    close: () => Promise.resolve(),
    send: (reply) => {
      if ('id' in reply) replies.get(reply.id)?.(reply);
      return Promise.resolve();
    },
  };
  await server.instance.connect(transport);
  let id = 0;
  const ask = (method: string, params: Record<string, unknown>): Promise<Reply> =>
    new Promise((resolve) => {
      id += 1;
      replies.set(id, resolve);
      transport.onmessage?.({ jsonrpc: '2.0', id, method, params });
    });
  await ask('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'scripted-turn', version: '0' },
  });
  return (name, args) => ask('tools/call', { name, arguments: args });
}

function scriptedQuery({
  prompt,
  options,
}: {
  prompt: unknown;
  options: { mcpServers: { composer: ComposerServer } };
}): AsyncGenerator<unknown> & { close(): void } {
  const said = String(prompt);
  if (said.endsWith(TURN_SCRIPT.refuse)) {
    throw new Error('Claude Code executable not found at /nowhere/claude');
  }
  const turn = (async function* () {
    await service(SCRIPT_ROUTE.started);
    yield { type: 'system', subtype: 'init', session_id: 'sdk-session-scripted' };
    if (said.endsWith(TURN_SCRIPT.hold)) {
      yield text('holding');
      await service(SCRIPT_ROUTE.release);
    }
    if (said.endsWith(TURN_SCRIPT.assume)) {
      const call = await toolCaller(options.mcpServers.composer);
      for (const node_id of ['n1', 'n2']) {
        const reply = await call('note_assumption', { node_id, text: 'assumed: #general' });
        yield text(JSON.stringify('result' in reply ? reply.result : reply));
      }
    }
    yield text(said);
    yield { type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0 };
  })();
  return Object.assign(turn, { close: (): void => undefined });
}

// The agent's AppModule in a process of its own, with a scripted Agent SDK; it sends its URL once it listens.
async function boot(): Promise<void> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(QUERY_FN)
    .useValue(scriptedQuery)
    .compile();
  const app = moduleRef.createNestApplication();
  await app.listen(0, '127.0.0.1');
  process.send?.({ url: await app.getUrl() });
}

if (require.main === module) void boot();
