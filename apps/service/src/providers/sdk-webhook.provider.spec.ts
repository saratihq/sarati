import { createHmac } from 'node:crypto';

import type { FetchLike, FetchLikeResponse, WebhookRegistration } from '@sarati/actions-sdk';

import type { ConnectionsService } from '../connections/connections.service';
import { InMemoryStore } from './provider-store';
import { SdkWebhookProvider } from './sdk-webhook.provider';

function res(status: number, body: unknown): FetchLikeResponse {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    status,
    headers: {
      forEach: (cb) => cb('application/json', 'content-type'),
    },
    text: () => Promise.resolve(text),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  };
}

/** A fetch stub that records calls and answers GitHub's hook create/delete. */
function stubFetch(): FetchLike & { calls: Array<{ url: string; method: string; body?: string }> } {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fn: FetchLike = (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
    if (method === 'POST') return Promise.resolve(res(201, { id: 555 }));
    return Promise.resolve(res(204, undefined));
  };
  return Object.assign(fn, { calls });
}

const PROPS = { owner: 'octocat', repo: 'hello-world' };
const BASE = { type: 'github.new_push', props: PROPS, webhookUrl: 'https://x/api/hooks/t1', secret: 'sek' };

describe('SdkWebhookProvider', () => {
  it('knows which types are registered webhooks', () => {
    const provider = new SdkWebhookProvider();
    expect(provider.isRegisteredWebhook('github.new_push')).toBe(true);
    expect(provider.isRegisteredWebhook('rss.new-item')).toBe(false);
    expect(provider.isRegisteredWebhook('orchestr:webhook')).toBe(false);
  });

  it('exposes github.new_push in the catalog with a connection auth and its props', () => {
    const entry = new SdkWebhookProvider().catalog()[0] ?? {};
    expect(entry).toMatchObject({ type: 'github.new_push', auth: 'connection', category: 'github' });
    expect(Object.keys(entry.parameters as Record<string, unknown>).sort()).toEqual(['owner', 'repo']);
  });

  it('registers with an INLINE credential (no connection needed), signing with our secret', async () => {
    const fetch = stubFetch();
    const provider = new SdkWebhookProvider(undefined, fetch);
    const registration = await provider.enable({
      externalUserId: 'u1',
      auth: { token: 'ghp_inline' },
      store: new InMemoryStore(),
      ...BASE,
    });
    expect(registration).toEqual({ subscriptionId: '555' });
    const post = fetch.calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('https://api.github.com/repos/octocat/hello-world/hooks');
    const sent = JSON.parse(post?.body ?? '{}') as { config: { secret: string; url: string } };
    expect(sent.config.secret).toBe('sek');
    expect(sent.config.url).toBe('https://x/api/hooks/t1');
  });

  it('resolves a {connectionId} reference through ConnectionsService', async () => {
    const fetch = stubFetch();
    const getCredential = jest.fn().mockResolvedValue({ access_token: 'ghp_from_connection' });
    const connections = { getCredential } as unknown as ConnectionsService;
    const provider = new SdkWebhookProvider(connections, fetch);

    await provider.enable({
      externalUserId: 'user-9',
      auth: { connectionId: 'conn-1' },
      store: new InMemoryStore(),
      ...BASE,
    });
    expect(getCredential).toHaveBeenCalledWith('user-9', 'conn-1');
    expect(fetch.calls.some((c) => c.method === 'POST')).toBe(true);
  });

  it('rejects a managed (Composio) connection — never sends the sentinel to the provider as a bearer', async () => {
    const fetch = stubFetch();
    // getCredential returns the masked sentinel for a managed row (MANAGED_TOKEN_PREFIX).
    const getCredential = jest.fn().mockResolvedValue({ access_token: '__ORCHESTR_MANAGED__:acct_123' });
    const connections = { getCredential } as unknown as ConnectionsService;
    const provider = new SdkWebhookProvider(connections, fetch);

    await expect(
      provider.enable({
        externalUserId: 'user-9',
        auth: { connectionId: 'conn-managed' },
        store: new InMemoryStore(),
        ...BASE,
      }),
    ).rejects.toThrow(/managed .*connection cannot be used/i);
    // The sentinel must never have left the process as an outbound provider call.
    expect(fetch.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('fails loudly when the credential carries no usable token', async () => {
    const provider = new SdkWebhookProvider(undefined, stubFetch());
    await expect(
      provider.enable({ externalUserId: 'u1', auth: {}, store: new InMemoryStore(), ...BASE }),
    ).rejects.toThrow(/needs a connected account/i);
  });

  describe('handleRequest — verify + transform + secret plumbing', () => {
    const stripeBody = {
      id: 'evt_1',
      object: 'event',
      type: 'customer.created',
      created: 123,
      livemode: false,
      data: { object: { id: 'cus_1', email: 'jane@example.com' } },
    };
    const stripeRaw = JSON.stringify(stripeBody);
    const ts = '1700000000';
    const stripeSig = (secret: string): string =>
      `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${stripeRaw}`).digest('hex')}`;

    const stripeCtx = (secret: string, registration?: WebhookRegistration, sigSecret?: string) => ({
      externalUserId: 'u1',
      type: 'stripe.new_customer',
      props: {},
      auth: { token: 'sk_test' } as Record<string, unknown>,
      store: new InMemoryStore(),
      webhookUrl: '',
      secret,
      ...(registration ? { registration } : {}),
      request: {
        headers: { 'stripe-signature': stripeSig(sigSecret ?? secret) },
        body: stripeBody,
        rawBody: stripeRaw,
      },
    });

    it('verifies against the PROVIDER-minted registration secret (not the generated one) and normalises', async () => {
      const provider = new SdkWebhookProvider(undefined, stubFetch());
      // Stripe signs with the whsec_ it minted; the random secret we generated must NOT be what verify uses.
      const events = await provider.handleRequest(
        stripeCtx(
          'generated-not-used',
          { subscriptionId: 'we_1', signingSecret: 'whsec_minted' },
          'whsec_minted',
        ),
      );
      expect(events).toEqual([
        { eventId: 'evt_1', customerId: 'cus_1', email: 'jane@example.com', created: 123, livemode: false },
      ]);
    });

    it('401s a delivery signed with the generated secret when a provider secret is registered', async () => {
      const provider = new SdkWebhookProvider(undefined, stubFetch());
      await expect(
        provider.handleRequest(
          stripeCtx('generated', { subscriptionId: 'we_1', signingSecret: 'whsec_minted' }, 'generated'),
        ),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('401s a forged signature (unsigned/spoofed delivery never fires)', async () => {
      const provider = new SdkWebhookProvider(undefined, stubFetch());
      const ctx = stripeCtx('whsec_minted', { subscriptionId: 'we_1', signingSecret: 'whsec_minted' });
      ctx.request.headers['stripe-signature'] = `t=${ts},v1=deadbeef`;
      await expect(provider.handleRequest(ctx)).rejects.toMatchObject({ status: 401 });
    });

    it('falls back to the generated secret when the registration carries none (we-supply-secret family)', async () => {
      const provider = new SdkWebhookProvider(undefined, stubFetch());
      const pushBody = { ref: 'refs/heads/main', after: 'abc123', repository: { full_name: 'octo/hello' } };
      const raw = JSON.stringify(pushBody);
      const events = await provider.handleRequest({
        externalUserId: 'u1',
        type: 'github.new_push',
        props: PROPS,
        auth: { token: 'ghp_inline' },
        store: new InMemoryStore(),
        webhookUrl: '',
        secret: 'our-secret',
        // No registration.signingSecret → verify must use `secret` (GitHub: we supply it).
        request: {
          headers: {
            'x-github-event': 'push',
            'x-hub-signature-256': `sha256=${createHmac('sha256', 'our-secret').update(raw).digest('hex')}`,
          },
          body: pushBody,
          rawBody: raw,
        },
      });
      expect(events).toEqual([
        { repo: 'octo/hello', ref: 'refs/heads/main', before: '', after: 'abc123', commits: [] },
      ]);
    });
  });

  it('deletes exactly the persisted subscription on disable', async () => {
    const fetch = stubFetch();
    const provider = new SdkWebhookProvider(undefined, fetch);
    await provider.disable({
      externalUserId: 'u1',
      auth: { token: 'ghp_inline' },
      store: new InMemoryStore(),
      registration: { subscriptionId: '555' },
      ...BASE,
    });
    const del = fetch.calls.find((c) => c.method === 'DELETE');
    expect(del?.url).toBe('https://api.github.com/repos/octocat/hello-world/hooks/555');
  });
});
