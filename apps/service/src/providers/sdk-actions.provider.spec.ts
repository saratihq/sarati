import type { ConfigService } from '@nestjs/config';
import type { FetchLike, FetchLikeResponse } from '@sarati/actions-sdk';

import { DomainError } from '../common/domain-error';
import type { ConnectionsService, ManagedConnectionRef } from '../connections/connections.service';
import type { EnvConfig } from '../config/env.config';
import { SdkActionsProvider } from './sdk-actions.provider';

/** A one-shot fake `fetch` returning a canned JSON response and recording the last call. */
function fakeFetch(
  handler: (url: string, init: { body?: unknown } | undefined) => { status: number; body: unknown },
): { impl: FetchLike; calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  const impl: FetchLike = (input, init) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body;
    calls.push({ url, body });
    const { status, body: resBody } = handler(url, { body });
    const res: FetchLikeResponse = {
      status,
      headers: { forEach: (cb) => cb('application/json', 'content-type') },
      text: () => Promise.resolve(JSON.stringify(resBody)),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    };
    return Promise.resolve(res);
  };
  return { impl, calls };
}

function config(over: Partial<EnvConfig> = {}): ConfigService<{ env: EnvConfig }, true> {
  const env = { composioApiKey: 'ak_test', composioBaseUrl: 'https://backend.composio.dev', ...over };
  return { get: () => env } as unknown as ConfigService<{ env: EnvConfig }, true>;
}

function connections(over: { ref?: ManagedConnectionRef | null; credential?: unknown }): ConnectionsService {
  return {
    managedRef: jest.fn().mockResolvedValue(over.ref ?? null),
    getCredential: jest.fn().mockResolvedValue(over.credential ?? null),
  } as unknown as ConnectionsService;
}

const managedRef: ManagedConnectionRef = {
  id: 'conn-1',
  authType: 'managed',
  status: 'active',
  connectedAccountId: 'ca__test',
};

const GMAIL_PROFILE = {
  emailAddress: 'owner@example.com',
  messagesTotal: 42,
  threadsTotal: 10,
  historyId: '9001',
};

describe('SdkActionsProvider', () => {
  it('has() recognises our SDK action types and rejects others', () => {
    const provider = new SdkActionsProvider(config());
    expect(provider.has('gmail.get_profile')).toBe(true);
    expect(provider.has('gmail.send_email')).toBe(true);
    expect(provider.has('sheets.insert_row')).toBe(true);
    expect(provider.has('http.send_request')).toBe(true); // http runs on our SDK
    expect(provider.has('slack.listUsers')).toBe(false); // not ours — camelCase, not our snake_case type form
    expect(provider.has('pipedrive.create_deal')).toBe(false); // no such action in our SDK catalog
  });

  it('runs a MANAGED Gmail action through the Composio proxy transport (the defect fix)', async () => {
    // The managed proxy envelope: provider data wrapped as { data, status }.
    const { impl, calls } = fakeFetch((url) => {
      expect(url).toContain('/api/v3/tools/execute/proxy');
      return { status: 200, body: { data: GMAIL_PROFILE, status: 200, headers: {} } };
    });
    const provider = new SdkActionsProvider(config(), connections({ ref: managedRef }), impl);

    const result = await provider.runAction({
      externalUserId: 'user-1',
      actionId: 'gmail.get_profile',
      props: {},
      auth: { connectionId: 'conn-1' },
    });

    expect(result.output).toEqual(GMAIL_PROFILE);
    // The proxy carried the managed account id — the SDK never saw a token.
    expect(calls[0]!.body).toMatchObject({ connected_account_id: 'ca__test' });
  });

  it('runs a DIRECT/BYO connection straight to the provider with a bearer token', async () => {
    const { impl, calls } = fakeFetch((url) => {
      expect(url).toContain('gmail.googleapis.com');
      return { status: 200, body: GMAIL_PROFILE };
    });
    const provider = new SdkActionsProvider(
      config(),
      connections({
        ref: { id: 'conn-2', authType: 'oauth2', status: 'active', connectedAccountId: null },
        credential: { access_token: 'tok_direct' },
      }),
      impl,
    );

    const result = await provider.runAction({
      externalUserId: 'user-1',
      actionId: 'gmail.get_profile',
      props: {},
      auth: { connectionId: 'conn-2' },
    });

    expect(result.output).toEqual(GMAIL_PROFILE);
    // Direct rail hit the real provider host, not the Composio proxy.
    expect(calls[0]!.url).toContain('gmail.googleapis.com');
  });

  it('maps a run-but-fails outcome to a structured 422, never a 500', async () => {
    // Provider status 401 inside the proxy envelope → SDK throws → 422 step error.
    const { impl } = fakeFetch(() => ({
      status: 200,
      body: { data: { error: 'Expected OAuth 2 access token' }, status: 401, headers: {} },
    }));
    const provider = new SdkActionsProvider(config(), connections({ ref: managedRef }), impl);

    const err = await provider
      .runAction({
        externalUserId: 'user-1',
        actionId: 'gmail.get_profile',
        props: {},
        auth: { connectionId: 'conn-1' },
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).status).toBe(422);
  });

  it('errors 404 when the referenced connection does not exist', async () => {
    const provider = new SdkActionsProvider(config(), connections({ ref: null }));
    const err = await provider
      .runAction({
        externalUserId: 'user-1',
        actionId: 'gmail.get_profile',
        props: {},
        auth: { connectionId: 'missing' },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).status).toBe(404);
  });

  it('fails a step with NO connection as a 422 that names the app', async () => {
    const provider = new SdkActionsProvider(config(), connections({ ref: null }));
    const err = await provider
      .runAction({
        externalUserId: 'user-1',
        actionId: 'slack.send_channel_message',
        props: { channel: 'general', text: 'hi' },
        auth: undefined, // no connection attached
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).status).toBe(422);
    expect((err as DomainError).message).toContain('requires a slack connection');
  });

  it('loadOptions returns the SDK picker options for a managed connection', async () => {
    const { impl } = fakeFetch(() => ({
      status: 200,
      body: {
        data: {
          labels: [
            { id: 'INBOX', name: 'INBOX' },
            { id: 'SENT', name: 'SENT' },
          ],
        },
        status: 200,
        headers: {},
      },
    }));
    const provider = new SdkActionsProvider(config(), connections({ ref: managedRef }), impl);
    const result = await provider.loadOptions('gmail.list_messages', 'labelIds', {
      externalUserId: 'user-1',
      connectionId: 'conn-1',
    });
    expect(result.disabled).toBe(false);
    expect(result.options).toEqual([
      { label: 'INBOX', value: 'INBOX' },
      { label: 'SENT', value: 'SENT' },
    ]);
  });

  it('loadOptions degrades to a disabled result when the loader cannot run', async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: { data: {}, status: 500, headers: {} } }));
    const provider = new SdkActionsProvider(config(), connections({ ref: managedRef }), impl);
    const result = await provider.loadOptions('gmail.list_messages', 'labelIds', {
      externalUserId: 'user-1',
      connectionId: 'conn-1',
    });
    expect(result.disabled).toBe(true);
  });
});
