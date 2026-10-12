import type { ConfigService } from '@nestjs/config';
import type { FetchLike, FetchLikeResponse } from '@sarati/actions-sdk';

import { DomainError } from '../common/domain-error';
import type { ConnectionsService, ManagedConnectionRef } from '../connections/connections.service';
import type { EnvConfig } from '../config/env.config';
import { SdkActionsProvider } from './sdk-actions.provider';
import { sdkCatalogEntries } from './sdk-actions.registry';
import { PlatformKeysService } from '../platform/platform-keys.service';

interface FetchCall {
  url: string;
  body: unknown;
  authorization?: string;
}

/** A one-shot fake `fetch` returning a canned JSON response and recording the last call. */
function fakeFetch(
  handler: (url: string, init: { body?: unknown } | undefined) => { status: number; body: unknown },
): { impl: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl: FetchLike = (input, init) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body;
    calls.push({ url, body, authorization: init?.headers?.authorization });
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
  const env = { composioBaseUrl: 'https://backend.composio.dev', ...over };
  return { get: () => env } as unknown as ConfigService<{ env: EnvConfig }, true>;
}

/** The stored Composio key — the managed rail's only source now that it is not an env var. */
function platformKeys(apiKey = 'ak_test'): PlatformKeysService {
  return {
    scopeFor: (userId: string) => Promise.resolve({ kind: 'user' as const, userId }),
    composioApiKey: () => Promise.resolve(apiKey),
  } as unknown as PlatformKeysService;
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

// Per basic-scheme app, a step and the username a user following that app's form hints types.
const TYPED_BASIC: Record<string, { actionId: string; props: Record<string, unknown>; username: string }> = {
  jira: {
    actionId: 'jira.get_issue',
    props: { instanceUrl: 'https://acme.atlassian.net', issueIdOrKey: 'ENG-1' },
    username: 'me@acme.com',
  },
  mailchimp: { actionId: 'mailchimp.list_audiences', props: { serverPrefix: 'us21' }, username: 'anything' },
  zendesk: { actionId: 'zendesk.list_tickets', props: { subdomain: 'acme' }, username: 'me@acme.com/token' },
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
    const provider = new SdkActionsProvider(config(), connections({ ref: managedRef }), impl, platformKeys());

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
    const provider = new SdkActionsProvider(config(), connections({ ref: managedRef }), impl, platformKeys());

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

  it.each([
    [
      'a basic-scheme step whose connection holds only a token',
      'zendesk.get_ticket',
      { subdomain: 'acme', ticketId: 7 },
      { value: 'just-a-token' },
      'has no username and password — reconnect it with an email or username plus an API token or password',
    ],
    [
      'a token-scheme step whose connection holds a username and password',
      'slack.send_channel_message',
      { channel: 'C1', text: 'hi' },
      { username: 'ada', password: 's3cret' },
      'has no API key or token — reconnect it with one',
    ],
  ])('names what %s needs, not "attach a connection"', async (_case, actionId, props, credential, reason) => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: {} }));
    const provider = new SdkActionsProvider(
      config(),
      connections({
        ref: { id: 'conn-x', authType: 'token', status: 'active', connectedAccountId: null },
        credential,
      }),
      impl,
      platformKeys(),
    );
    const err = await provider
      .runAction({ externalUserId: 'user-1', actionId, props, auth: { connectionId: 'conn-x' } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).status).toBe(422);
    expect((err as DomainError).message).toBe(`Connection conn-x ${reason}`);
    expect(calls).toEqual([]);
  });

  it('checks the wire credential of every basic-scheme app the form gives hints for', () => {
    const basicApps = sdkCatalogEntries()
      .filter((e) => (e.authScheme as { type: string }).type === 'basic')
      .map((e) => String(e.category));
    expect([...new Set(basicApps)].sort()).toEqual(Object.keys(TYPED_BASIC).sort());
  });

  it.each(Object.entries(TYPED_BASIC))(
    'sends a %s username and password exactly as typed, so the form hints stay true',
    async (_app, { actionId, props, username }) => {
      const { impl, calls } = fakeFetch(() => ({
        status: 200,
        body: { id: '1', key: 'ENG-1', fields: {}, lists: [], tickets: [], next_page: null },
      }));
      const provider = new SdkActionsProvider(
        config(),
        connections({
          ref: { id: 'conn-b', authType: 'token', status: 'active', connectedAccountId: null },
          credential: { username, password: 'tok' },
        }),
        impl,
        platformKeys(),
      );
      await provider.runAction({
        externalUserId: 'user-1',
        actionId,
        props,
        auth: { connectionId: 'conn-b' },
      });
      expect(calls[0]?.authorization).toBe(`Basic ${Buffer.from(`${username}:tok`).toString('base64')}`);
    },
  );

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
    const provider = new SdkActionsProvider(config(), connections({ ref: managedRef }), impl, platformKeys());
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
    const provider = new SdkActionsProvider(config(), connections({ ref: managedRef }), impl, platformKeys());
    const result = await provider.loadOptions('gmail.list_messages', 'labelIds', {
      externalUserId: 'user-1',
      connectionId: 'conn-1',
    });
    expect(result.disabled).toBe(true);
  });
});
