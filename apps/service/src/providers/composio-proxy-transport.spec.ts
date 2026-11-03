import {
  ActionError,
  buildForm,
  buildMultipart,
  createAuth,
  DEFAULT_RETRY_POLICY,
  type FetchLike,
  type FetchLikeResponse,
  HttpClient,
  type NormalizedRequest,
} from '@sarati/actions-sdk';

import { ComposioCapReached, monthlyLimitOf } from '../platform/composio-usage.service';
import { ComposioProxyTransport } from './composio-proxy-transport';

const charge = (): Promise<void> => Promise.resolve();

/** Behavioural coverage for the managed Composio proxy transport, over the SDK's {@link FetchLike} seam — no network. */

function fakeResponse(status: number, body: string, headers: Record<string, string> = {}): FetchLikeResponse {
  const bytes = Buffer.from(body, 'utf8');
  return {
    status,
    headers: {
      forEach(cb: (value: string, key: string) => void): void {
        for (const [key, value] of Object.entries(headers)) cb(value, key);
      },
    },
    text: () => Promise.resolve(bytes.toString('utf8')),
    arrayBuffer: () => Promise.resolve(new Uint8Array(bytes).buffer),
  };
}

function fakeFetch(
  handler: (input: string | URL, init: Parameters<FetchLike>[1]) => FetchLikeResponse,
): FetchLike & { calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> } {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
  const fn = ((input, init) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(handler(input, init));
  }) as FetchLike & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

describe('ComposioProxyTransport — construction', () => {
  it('rejects a missing apiKey', () => {
    expect(() => new ComposioProxyTransport({ apiKey: '', connectedAccountId: 'ca_1', charge })).toThrow(
      /apiKey/,
    );
  });

  it('rejects a missing connectedAccountId', () => {
    expect(() => new ComposioProxyTransport({ apiKey: 'K', connectedAccountId: '', charge })).toThrow(
      /connectedAccountId/,
    );
  });
});

describe('ComposioProxyTransport — every request is charged before it is sent', () => {
  const reply = (): FetchLikeResponse =>
    fakeResponse(200, JSON.stringify({ data: { ok: true }, status: 200 }));

  it('charges once per request, before the request leaves', async () => {
    const order: string[] = [];
    const fetchImpl = fakeFetch(() => {
      order.push('sent');
      return reply();
    });
    const t = new ComposioProxyTransport({
      apiKey: 'K',
      connectedAccountId: 'ca_1',
      charge: () => {
        order.push('charged');
        return Promise.resolve();
      },
      fetchImpl,
    });
    await t.send({ method: 'GET', url: 'https://slack.com/api/a', headers: {} });
    await t.send({ method: 'GET', url: 'https://slack.com/api/b', headers: {} });
    expect(order).toEqual(['charged', 'sent', 'charged', 'sent']);
  });

  it('a refused charge fails the request unsent, keeps what the refusal says, and the SDK never retries it', async () => {
    const fetchImpl = fakeFetch(() => reply());
    let charges = 0;
    const t = new ComposioProxyTransport({
      apiKey: 'K',
      connectedAccountId: 'ca_1',
      charge: () => {
        charges += 1;
        return Promise.reject(new ComposioCapReached(500, '2026-12-01'));
      },
      fetchImpl,
    });
    const http = new HttpClient({
      retry: { ...DEFAULT_RETRY_POLICY, retries: 3, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const err = await http
      .get('https://slack.com/api/a', { auth: createAuth({ type: 'none' }, t) })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ActionError);
    expect(err).toMatchObject({ code: 'provider_error', status: 429, retryable: false });
    expect((err as Error).message).toBe(
      'The monthly limit of 500 app actions per person on this instance is used up for the account this runs as — it resets on December 1, 2026 (UTC)',
    );
    expect(monthlyLimitOf(err)).toEqual({
      details: { code: 'composio_monthly_limit', limit: 500, resets_at: '2026-12-01T00:00:00.000Z' },
      resetsOn: 'December 1, 2026',
    });
    expect(charges).toBe(1);
    expect(fetchImpl.calls).toEqual([]);
  });

  it('a refusal an app helper wraps in an error of its own is still read as the limit', () => {
    const refusal = new ComposioCapReached(500, '2026-12-01');
    const wrapped = new ActionError({
      code: 'http_error',
      message: `Jira's site lookup failed: ${refusal.message}`,
      status: 429,
      detail: { provider: 'jira', status: 429 },
      cause: new ActionError({
        code: 'provider_error',
        message: refusal.message,
        status: 429,
        retryable: false,
        detail: refusal.details,
      }),
    });
    expect(monthlyLimitOf(wrapped)).toEqual({
      details: { code: 'composio_monthly_limit', limit: 500, resets_at: '2026-12-01T00:00:00.000Z' },
      resetsOn: 'December 1, 2026',
    });
    expect(
      monthlyLimitOf(new ActionError({ code: 'http_error', message: 'x', cause: new Error('y') })),
    ).toBeNull();
  });
});

describe('ComposioProxyTransport — proxy rewrite', () => {
  const envelope = JSON.stringify({
    data: { ok: true, channels: [] },
    status: 200,
    headers: { 'x-foo': 'bar' },
  });

  it('rewrites into the proxy payload and parses the envelope', async () => {
    const fetchImpl = fakeFetch(() => fakeResponse(200, envelope, { 'content-type': 'application/json' }));
    const t = new ComposioProxyTransport({ apiKey: 'K', connectedAccountId: 'ca_1', charge, fetchImpl });
    const res = await t.send({
      method: 'POST',
      url: 'https://slack.com/api/chat.postMessage',
      headers: { authorization: 'Bearer leak', 'content-type': 'application/json', 'x-keep': 'yes' },
      body: { channel: 'C1', text: 'hi' },
    });

    expect(res).toEqual({ status: 200, headers: { 'x-foo': 'bar' }, data: { ok: true, channels: [] } });

    const sent = JSON.parse(String(fetchImpl.calls[0]?.init?.body)) as {
      connected_account_id: string;
      endpoint: string;
      method: string;
      parameters?: Array<{ name: string; value: string; type: string }>;
      body?: unknown;
    };
    expect(sent.connected_account_id).toBe('ca_1');
    expect(sent.endpoint).toBe('https://slack.com/api/chat.postMessage');
    expect(sent.method).toBe('POST');
    expect(sent.body).toEqual({ channel: 'C1', text: 'hi' });
    // The sentinel/auth and content-type headers must NOT ride to the proxy.
    const paramNames = (sent.parameters ?? []).map((p) => p.name);
    expect(paramNames).toContain('x-keep');
    expect(paramNames).not.toContain('authorization');
    expect(paramNames).not.toContain('content-type');
    // The proxy is authed with x-api-key.
    expect(fetchImpl.calls[0]?.init?.headers?.['x-api-key']).toBe('K');
  });

  it('surfaces the provider status from the envelope', async () => {
    const fetchImpl = fakeFetch(() =>
      fakeResponse(200, JSON.stringify({ data: { ok: false }, status: 429 }), {
        'content-type': 'application/json',
      }),
    );
    const t = new ComposioProxyTransport({ apiKey: 'K', connectedAccountId: 'ca_1', charge, fetchImpl });
    const res = await t.send({ method: 'GET', url: 'https://slack.com/api/x', headers: {} });
    expect(res.status).toBe(429);
  });

  it('throws a retryable transport error when the proxy itself fails', async () => {
    const fetchImpl = fakeFetch(() => fakeResponse(500, 'gateway down'));
    const t = new ComposioProxyTransport({ apiKey: 'K', connectedAccountId: 'ca_1', charge, fetchImpl });
    await expect(
      t.send({ method: 'GET', url: 'https://slack.com/api/x', headers: {} }),
    ).rejects.toMatchObject({ code: 'transport_unreachable', retryable: true });
  });

  it('rejects a non-object body it cannot carry', async () => {
    const fetchImpl = fakeFetch(() => fakeResponse(200, envelope, { 'content-type': 'application/json' }));
    const t = new ComposioProxyTransport({ apiKey: 'K', connectedAccountId: 'ca_1', charge, fetchImpl });
    await expect(
      t.send({ method: 'POST', url: 'https://slack.com/api/x', headers: {}, body: [1, 2, 3] }),
    ).rejects.toMatchObject({ code: 'unsupported_body' });
  });
});

describe('ComposioProxyTransport — files/forms rejected loudly (JSON-only transport)', () => {
  const proxy = (): ComposioProxyTransport =>
    new ComposioProxyTransport({
      apiKey: 'k',
      connectedAccountId: 'ca_1',
      charge,
      fetchImpl: fakeFetch(() => fakeResponse(200, '{"data":{}}', { 'content-type': 'application/json' })),
    });

  it('rejects a multipart upload with an actionable, non-retryable error', async () => {
    await expect(
      proxy().send({
        method: 'POST',
        url: 'https://api.test/x',
        headers: {},
        body: buildMultipart({ files: { file: { filename: 'a', data: Buffer.from('x') } } }),
      }),
    ).rejects.toMatchObject({ code: 'unsupported_body', retryable: false });
  });

  it('rejects a url-encoded form body', async () => {
    const request: NormalizedRequest = {
      method: 'POST',
      url: 'https://api.stripe.com/v1/webhook_endpoints',
      headers: {},
      body: buildForm({ url: 'https://x/hook' }),
    };
    await expect(proxy().send(request)).rejects.toMatchObject({ code: 'unsupported_body' });
  });

  it('rejects a binary download request', async () => {
    await expect(
      proxy().send({ method: 'GET', url: 'https://api.test/x', headers: {}, responseType: 'binary' }),
    ).rejects.toMatchObject({ code: 'unsupported_body' });
  });
});
