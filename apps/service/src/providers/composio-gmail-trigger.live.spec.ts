import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';

import { ComposioProvider } from '../connections/composio.provider';
import { ComposioExecutionProvider } from '../connections/composio-execution.provider';
import type { EnvConfig } from '../config/env.config';
import { composioTriggerSpec } from './composio-trigger.registry';
import { PlatformKeysService } from '../platform/platform-keys.service';

const SCOPE = { kind: 'user', userId: '11111111-1111-1111-1111-111111111111' } as const;

/**
 * LIVE proof of the gmail Composio-poll leg through the SAME production classes, so a shape drift on Composio's side
 * fails HERE rather than silently in production. Skipped unless `COMPOSIO_LIVE=1` plus the account/user/key env vars.
 */
const LIVE =
  process.env.COMPOSIO_LIVE === '1' &&
  !!process.env.COMPOSIO_API_KEY &&
  !!process.env.COMPOSIO_LIVE_GMAIL_ACCOUNT &&
  !!process.env.COMPOSIO_LIVE_GMAIL_USER;

(LIVE ? describe : describe.skip)('Composio gmail trigger poll — live', () => {
  const config = {
    get: () =>
      ({
        composioBaseUrl: process.env.COMPOSIO_BASE_URL || 'https://backend.composio.dev',
      }) as Partial<EnvConfig>,
  } as unknown as ConfigService<{ env: EnvConfig }, true>;
  // The key is stored, not env-supplied — a manual live run hands it over the same seam.
  const keys = {
    composioApiKey: () => Promise.resolve(process.env.COMPOSIO_API_KEY ?? ''),
  } as unknown as PlatformKeysService;
  const provider = new ComposioExecutionProvider(new ComposioProvider({} as DataSource, config, keys));
  const spec = composioTriggerSpec('gmail.gmail_new_email_received')!;

  it('fetches real messages via GMAIL_FETCH_EMAILS and extracts dedupe-able items', async () => {
    const dayAgo = Date.now() - 24 * 60 * 60_000;
    const data = await provider.executeBySlug(SCOPE, spec.toolSlug, {
      connectedAccountId: process.env.COMPOSIO_LIVE_GMAIL_ACCOUNT!,
      userId: process.env.COMPOSIO_LIVE_GMAIL_USER!,
      arguments: spec.buildArguments({}, dayAgo),
    });
    const items = spec.extractItems(data);
    // Every item must carry a usable epoch, sorted oldest-first and strictly newer than the cursor window.
    expect(items.length).toBeGreaterThan(0);
    for (let i = 0; i < items.length; i++) {
      expect(items[i]!.epochMilliSeconds).toBeGreaterThan(dayAgo - 60_000);
      if (i > 0) expect(items[i]!.epochMilliSeconds).toBeGreaterThanOrEqual(items[i - 1]!.epochMilliSeconds);
    }
    console.log(
      `live gmail poll: ${items.length} message(s) extracted, newest ${new Date(items.at(-1)!.epochMilliSeconds).toISOString()}`,
    );
  }, 30_000);
});
