import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';

import { ComposioProvider } from '../connections/composio.provider';
import { ComposioExecutionProvider } from '../connections/composio-execution.provider';
import type { ConnectionsService, ManagedConnectionRef } from '../connections/connections.service';
import type { EnvConfig } from '../config/env.config';
import { ActionRouterProvider } from './action-router.provider';
import type { SdkActionsProvider } from './sdk-actions.provider';
import { isSdkActionType } from './sdk-actions.registry';

/**
 * LIVE proof of the universal Composio fallback: a real action our SDK doesn't cover, driven through the REAL
 * router. Skipped by default — run with `COMPOSIO_LIVE=1 COMPOSIO_API_KEY=<key> npx jest composio-general-fallback.live`.
 */
const LIVE =
  process.env.COMPOSIO_LIVE === '1' &&
  !!process.env.COMPOSIO_API_KEY &&
  !!process.env.COMPOSIO_LIVE_ASANA_ACCOUNT &&
  !!process.env.COMPOSIO_LIVE_ASANA_USER;

// Supplied per-run — a connected account is specific to whoever is running this.
const ASANA_ACCOUNT_ID = process.env.COMPOSIO_LIVE_ASANA_ACCOUNT ?? '';
const SANDBOX_USER = process.env.COMPOSIO_LIVE_ASANA_USER ?? '';
const ACTION_ID = 'asana.get_current_user';

(LIVE ? describe : describe.skip)('Universal Composio fallback — live asana (router)', () => {
  const config = {
    get: () =>
      ({
        composioApiKey: process.env.COMPOSIO_API_KEY ?? '',
        composioBaseUrl: process.env.COMPOSIO_BASE_URL || 'https://backend.composio.dev',
        composioFallbackApps: '',
      }) as Partial<EnvConfig>,
  } as unknown as ConfigService<{ env: EnvConfig }, true>;

  const composio = new ComposioExecutionProvider(new ComposioProvider({} as DataSource, config));
  // Only the DB lookup is stubbed — everything else is the production class.
  const managedRef: ManagedConnectionRef = {
    id: 'conn-live',
    authType: 'managed',
    status: 'active',
    connectedAccountId: ASANA_ACCOUNT_ID,
  };
  const connections = {
    managedRef: () => Promise.resolve(managedRef),
  } as unknown as ConnectionsService;
  // asana has no SDK action; delegate to the real registry to prove it.
  const orchestrActions = {
    has: (type: string) => isSdkActionType(type),
  } as unknown as SdkActionsProvider;

  const router = new ActionRouterProvider(orchestrActions, composio, connections, config);

  it('routes a Composio-only action through the router and returns real data', async () => {
    // Precondition that makes this rail (c) and not (a)/(b).
    expect(isSdkActionType(ACTION_ID)).toBe(false);

    const result = await router.runAction({
      externalUserId: SANDBOX_USER,
      actionId: ACTION_ID,
      props: {},
      auth: { connectionId: 'conn-live' },
    });

    // Real asana user record (email/gid/name) came back through the fallback.
    const data = result.output as { email?: string; gid?: string; name?: string };
    expect(typeof data.gid).toBe('string');
    expect(data.gid!.length).toBeGreaterThan(0);
    expect(typeof data.name).toBe('string');
    console.log(
      `live universal fallback: ${ACTION_ID} → asana user "${data.name}" (${data.email}), gid ${data.gid}`,
    );
  }, 30_000);
});
