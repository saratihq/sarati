import type { ConfigService } from '@nestjs/config';
import type { FetchLike, FetchLikeResponse } from '@sarati/actions-sdk';

import { DomainError } from '../common/domain-error';
import type { ConnectionsService, ManagedConnectionRef } from '../connections/connections.service';
import type { EnvConfig } from '../config/env.config';
import type { AgentModelAuth, AgentProvider } from '../runtime/agent';
import { AgentModelCallProvider } from './agent-model-call.provider';
import { PlatformKeysService } from '../platform/platform-keys.service';

/** A fake `fetch` returning a canned JSON response and recording each call's url/headers/body. */
function fakeFetch(handler: (url: string) => { status: number; body: unknown }): {
  impl: FetchLike;
  calls: Array<{ url: string; headers: Record<string, string>; body: unknown }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  const impl: FetchLike = (input, init) => {
    const url = String(input);
    const rawHeaders = init?.headers ?? {};
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = String(v);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body;
    calls.push({ url, headers, body });
    const { status, body: resBody } = handler(url);
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

function config(): ConfigService<{ env: EnvConfig }, true> {
  const env = { composioBaseUrl: 'https://backend.composio.dev' };
  return { get: () => env } as unknown as ConfigService<{ env: EnvConfig }, true>;
}

/** The stored Composio key — the managed rail's only source now that it is not an env var. */
function platformKeys(apiKey = 'ak_test'): PlatformKeysService {
  return {
    scopeFor: (userId: string) => Promise.resolve({ kind: 'user' as const, userId }),
    composioApiKey: () => Promise.resolve(apiKey),
  } as unknown as PlatformKeysService;
}

function connections(over: {
  ref?: ManagedConnectionRef | null;
  credential?: unknown;
  /** The runner's own accounts for the model's provider. */
  own?: string[];
  /** The app the chosen connection is for. */
  provider?: string;
}): ConnectionsService {
  const own = over.ref ? { provider: over.provider ?? 'openai', status: over.ref.status } : null;
  return {
    managedRef: jest.fn().mockResolvedValue(over.ref ?? null),
    getCredential: jest.fn().mockResolvedValue(over.credential ?? null),
    ownConnections: jest.fn((_userId: string, ids: string[]) =>
      Promise.resolve(new Map(own ? ids.map((id) => [id, own]) : [])),
    ),
    accountsServing: jest.fn((_userId: string, apps: readonly string[]) =>
      Promise.resolve((over.own ?? []).map((id) => ({ id, provider: apps[0], managed: false }))),
    ),
  } as unknown as ConnectionsService;
}

const byoRef: ManagedConnectionRef = {
  id: 'c1',
  authType: 'token',
  status: 'active',
  connectedAccountId: null,
};
const managedRef: ManagedConnectionRef = {
  id: 'c1',
  authType: 'managed',
  status: 'active',
  connectedAccountId: 'ca__test',
};

/** A one-turn request (system + a single user message, no tools). */
function req(provider: AgentProvider, model: string) {
  return { provider, model, system: 'hi', messages: [{ role: 'user' as const, content: 'go' }], tools: [] };
}

const authFor = (connection: unknown): AgentModelAuth => ({ connection, externalUserId: 'u' });

describe('AgentModelCallProvider', () => {
  it('routes an OpenAI model to chat-completions with a BYO bearer key in Authorization', async () => {
    const { impl, calls } = fakeFetch(() => ({
      status: 200,
      body: { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } },
    }));
    const provider = new AgentModelCallProvider(
      config(),
      connections({ ref: byoRef, credential: { api_key: 'sk-openai' } }),
      impl,
    );

    const turn = await provider.call(req('openai', 'gpt-4o'), authFor({ connectionId: 'c1' }));

    expect(turn.text).toBe('ok');
    expect(turn.usage).toEqual({ inputTokens: 4, outputTokens: 2, totalTokens: 6 });
    expect(calls[0]!.url).toContain('api.openai.com');
    expect(calls[0]!.headers['authorization']).toBe('Bearer sk-openai');
  });

  it('routes a Gemini model with the BYO key as a `?key=` query param (its scheme)', async () => {
    const { impl, calls } = fakeFetch(() => ({
      status: 200,
      body: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] },
    }));
    const provider = new AgentModelCallProvider(
      config(),
      connections({ ref: byoRef, credential: { api_key: 'g-key' }, provider: 'gemini' }),
      impl,
    );

    const turn = await provider.call(req('gemini', 'gemini-2.0-flash'), authFor({ connectionId: 'c1' }));

    expect(turn.text).toBe('ok');
    expect(calls[0]!.url).toContain('generativelanguage.googleapis.com');
    expect(calls[0]!.url).toContain('key=g-key'); // in the query string, not a header
    expect(calls[0]!.headers['authorization']).toBeUndefined();
  });

  it('runs a MANAGED Claude connection through the Composio proxy transport (SDK holds no key)', async () => {
    const { impl, calls } = fakeFetch((url) => {
      expect(url).toContain('/api/v3/tools/execute/proxy');
      return {
        status: 200,
        body: { data: { content: [{ type: 'text', text: 'ok' }] }, status: 200, headers: {} },
      };
    });
    const provider = new AgentModelCallProvider(
      config(),
      connections({ ref: managedRef, provider: 'claude' }),
      impl,
      platformKeys(),
    );

    const turn = await provider.call(req('claude', 'claude-opus-4-8'), authFor({ connectionId: 'c1' }));

    expect(turn.text).toBe('ok');
    // The proxy carried the managed account id — never a raw token.
    expect(calls[0]!.body).toMatchObject({ connected_account_id: 'ca__test' });
  });

  it('runs a step with no account chosen as the runner’s only account for the provider', async () => {
    const { impl, calls } = fakeFetch(() => ({
      status: 200,
      body: { choices: [{ message: { content: 'ok' } }] },
    }));
    const store = connections({ ref: byoRef, credential: { api_key: 'sk-only' }, own: ['only-openai'] });
    const provider = new AgentModelCallProvider(config(), store, impl);

    const turn = await provider.call(req('openai', 'gpt-4o'), authFor(undefined));

    expect(turn.text).toBe('ok');
    expect(calls[0]!.headers['authorization']).toBe('Bearer sk-only');
    expect(store.getCredential).toHaveBeenCalledWith('u', 'only-openai');
  });

  it('fails with NO account as a 422 naming the step, the provider AND where the credential goes', async () => {
    const provider = new AgentModelCallProvider(config(), connections({ ref: null }));
    const err = await provider
      .call(req('claude', 'claude-opus-4-8'), { ...authFor(undefined), stepName: 'Think it over' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).status).toBe(422);
    const message = (err as DomainError).message;
    expect(message).toContain('Step "Think it over" has no Claude account to run as');
    // The reason the platform key does not cover this is part of the message, or it reads as a bug.
    expect(message).toContain('Integrations');
    expect(message).toContain('AI composer only');
  });

  it("names the right app for a provider whose platform key isn't ours to explain", async () => {
    const provider = new AgentModelCallProvider(config(), connections({ ref: null }));
    const err = await provider.call(req('openai', 'gpt-5'), authFor(undefined)).catch((e: unknown) => e);
    const message = (err as DomainError).message;
    expect(message).toContain('no OpenAI account to run as');
    expect(message).not.toContain('AI composer');
  });

  // The run-as rule decided an active account, which went inactive before the model call asked for it.
  it.each([
    [
      'on Default',
      {},
      'Step "Think it over" runs as a Claude account that isn\'t active — pick another of your Claude accounts on the step',
    ],
    [
      'under an environment, by its current name',
      { environmentId: 'env-1', environment: 'staging-before-rename' },
      "staging's Claude account isn't active, so \"Think it over\" can't run there — its owner reconnects it under Integrations, or an owner reassigns the slot under Integrations → Environments",
    ],
  ])(
    'an account lost after the decision is worded as the decision would (%s)',
    async (_name, where, expected) => {
      const lapsed: ManagedConnectionRef = { ...managedRef, status: 'pending' };
      const store = {
        ...connections({ ref: lapsed }),
        ownConnections: jest.fn((_userId: string, ids: string[]) =>
          Promise.resolve(
            new Map(ids.map((id) => [id, { provider: 'claude', status: 'active', managed: true }])),
          ),
        ),
        resolveSlotConnection: jest.fn().mockResolvedValue({
          id: 'c1',
          ownerUserId: 'owner',
          provider: 'claude',
          status: 'active',
          managed: true,
        }),
        environmentNameOf: jest.fn().mockResolvedValue('staging'),
      } as unknown as ConnectionsService;
      const provider = new AgentModelCallProvider(config(), store, undefined, platformKeys());

      const err = await provider
        .call(req('claude', 'claude-opus-4-8'), {
          ...authFor({ connectionId: 'c1' }),
          stepName: 'Think it over',
          ...where,
        })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).message).toBe(expected);
    },
  );

  it.each([
    ['Default, with an only account', {}],
    ['an environment, with a slot', { environmentId: 'env-1' }],
  ])(
    'a credential handed inline calls the model as handed on %s — never swapped for an account',
    async (_label, where) => {
      const { impl, calls } = fakeFetch(() => ({
        status: 200,
        body: { choices: [{ message: { content: 'ok' } }] },
      }));
      const store = {
        ...connections({ ref: byoRef, credential: { api_key: 'sk-stored' }, own: ['only-openai'] }),
        resolveSlotConnection: jest.fn().mockResolvedValue({
          id: 'slot-openai',
          ownerUserId: 'owner',
          provider: 'openai',
          status: 'active',
          managed: false,
        }),
      } as unknown as ConnectionsService;
      const provider = new AgentModelCallProvider(config(), store, impl);

      await provider.call(req('openai', 'gpt-4o'), { ...authFor({ api_key: 'sk-inline' }), ...where });

      expect(calls[0]!.headers['authorization']).toBe('Bearer sk-inline');
      expect(store.getCredential).not.toHaveBeenCalled();
      expect(store.resolveSlotConnection).not.toHaveBeenCalled();
      expect(store.accountsServing).not.toHaveBeenCalled();
    },
  );

  it('throws on an unsupported provider', async () => {
    const provider = new AgentModelCallProvider(config(), connections({ ref: byoRef, provider: 'grok' }));
    const err = await provider
      .call(req('grok' as AgentProvider, 'x'), authFor({ connectionId: 'c1' }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('unsupported provider');
  });
});
