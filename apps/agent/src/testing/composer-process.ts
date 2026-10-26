import { Test } from '@nestjs/testing';

import { AppModule } from '../app.module';
import { QUERY_FN } from '../composer/composer.service';

/** The messages a scripted turn acts on; any other finishes at once, echoing its prompt. */
export const TURN_SCRIPT = {
  /** Parks after its first words until GET {WORKFLOW_SERVICE_URL}/release answers. */
  hold: 'hold',
  /** Throws as the Agent SDK does when it cannot start its subprocess. */
  refuse: 'refuse',
} as const;

const text = (words: string): Record<string, unknown> => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: words } },
});

function scriptedQuery({ prompt }: { prompt: unknown }): AsyncGenerator<unknown> & { close(): void } {
  const said = String(prompt);
  if (said.endsWith(TURN_SCRIPT.refuse)) {
    throw new Error('Claude Code executable not found at /nowhere/claude');
  }
  const turn = (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'sdk-session-scripted' };
    if (said.endsWith(TURN_SCRIPT.hold)) {
      yield text('holding');
      await fetch(`${process.env.WORKFLOW_SERVICE_URL}/release`);
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
