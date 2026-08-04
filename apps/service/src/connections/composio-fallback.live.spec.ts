import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';

import type { EnvConfig } from '../config/env.config';
import { ComposioProvider } from './composio.provider';
import { ComposioExecutionProvider } from './composio-execution.provider';

/**
 * LIVE proof of the Composio execution fallback through the SAME production classes the runtime uses.
 * Skipped by default — run with `COMPOSIO_LIVE=1 COMPOSIO_API_KEY=<key> npx jest composio-fallback.live`.
 */
const LIVE =
  process.env.COMPOSIO_LIVE === '1' &&
  !!process.env.COMPOSIO_API_KEY &&
  !!process.env.COMPOSIO_LIVE_SLACK_ACCOUNT &&
  !!process.env.COMPOSIO_LIVE_SLACK_USER;

// Supplied per-run — a connected account is specific to whoever is running this.
const SLACK_ACCOUNT_ID = process.env.COMPOSIO_LIVE_SLACK_ACCOUNT ?? '';
const SLACK_USER = process.env.COMPOSIO_LIVE_SLACK_USER ?? '';

(LIVE ? describe : describe.skip)('Composio fallback — live Slack', () => {
  const config = {
    get: () =>
      ({
        composioApiKey: process.env.COMPOSIO_API_KEY ?? '',
        composioBaseUrl: process.env.COMPOSIO_BASE_URL || 'https://backend.composio.dev',
      }) as Partial<EnvConfig>,
  } as unknown as ConfigService<{ env: EnvConfig }, true>;
  const provider = new ComposioExecutionProvider(new ComposioProvider({} as DataSource, config));

  it('runs slack.listUsers through the fallback and returns real members', async () => {
    const result = await provider.execute({
      appSlug: 'slack',
      actionName: 'listUsers',
      props: {},
      connectedAccountId: SLACK_ACCOUNT_ID,
      userId: SLACK_USER,
    });
    // The tool output nests Slack's payload under `.data`; assert real members.
    const data = result.output as { data?: { members?: unknown[] } };
    const members = data.data?.members ?? [];
    expect(Array.isArray(members)).toBe(true);
    expect(members.length).toBeGreaterThan(0);
    console.log(`live fallback: slack.listUsers → ${members.length} real member(s)`);
  }, 30_000);
});
