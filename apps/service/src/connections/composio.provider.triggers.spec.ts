import { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { fetch } from 'undici';

import type { EnvConfig } from '../config/env.config';
import { ComposioProvider } from './composio.provider';
import { PlatformKeysService } from '../platform/platform-keys.service';

/** Any scope will do here — the tests are about behaviour, not about whose key it is. */
const SCOPE = { kind: 'user', userId: '11111111-1111-1111-1111-111111111111' } as const;

jest.mock('undici', () => ({ fetch: jest.fn() }));

/** The Composio v3 client's TRIGGER-INSTANCE leg — asserts the exact endpoints + bodies, `undici`'s fetch mocked. */
const mockFetch = fetch as unknown as jest.Mock;

interface FakeResponse {
  status: number;
  headers: { forEach: () => void };
  text: () => Promise<string>;
}

function response(status: number, body: unknown): FakeResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status, headers: { forEach: () => undefined }, text: () => Promise.resolve(text) };
}

function jsonResponse(body: unknown): FakeResponse {
  return response(200, body);
}

function makeProvider(): ComposioProvider {
  const config = {
    get: () => ({ composioBaseUrl: 'https://backend.composio.dev' }),
  } as unknown as ConfigService<{ env: EnvConfig }, true>;
  const keys = { composioApiKey: () => Promise.resolve('test-key') } as unknown as PlatformKeysService;
  return new ComposioProvider({} as DataSource, config, keys);
}

describe('ComposioProvider — trigger instances (v3, fetch mocked)', () => {
  beforeEach(() => mockFetch.mockReset());

  it('listTriggerTypes GETs /api/v3/triggers_types and paginates by next_cursor', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              slug: 'GMAIL_NEW_GMAIL_MESSAGE',
              name: 'New message',
              description: 'gmail',
              type: 'poll',
              toolkit: { slug: 'gmail', name: 'Gmail' },
              config: { properties: { query: { type: 'string' } }, required: [] },
            },
          ],
          next_cursor: 'CURSOR2',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              slug: 'GITHUB_COMMIT_EVENT',
              name: 'Commit',
              type: 'webhook',
              toolkit: { slug: 'github' },
              config: {},
            },
          ],
          next_cursor: null,
        }),
      );

    const types = await makeProvider().listTriggerTypes(SCOPE);

    expect(types.map((t) => t.slug)).toEqual(['GMAIL_NEW_GMAIL_MESSAGE', 'GITHUB_COMMIT_EVENT']);
    expect(types[0]).toMatchObject({ toolkitSlug: 'gmail', type: 'poll' });
    // page 1
    const [url1, opts1] = mockFetch.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string> },
    ];
    expect(url1).toBe('https://backend.composio.dev/api/v3/triggers_types?limit=100');
    expect(opts1.method).toBe('GET');
    expect(opts1.headers['x-api-key']).toBe('test-key');
    // page 2 threads the cursor
    const [url2] = mockFetch.mock.calls[1] as [string];
    expect(url2).toBe('https://backend.composio.dev/api/v3/triggers_types?limit=100&cursor=CURSOR2');
  });

  it('createTriggerInstance POSTs {slug}/upsert with the confirmed body and returns trigger_id', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ trigger_id: 'ti_Q58v' }));

    const id = await makeProvider().createTriggerInstance(SCOPE, {
      slug: 'GMAIL_NEW_GMAIL_MESSAGE',
      connectedAccountId: 'ca_abc',
      userId: 'user-1',
      triggerConfig: { labelIds: 'INBOX', interval: 2 },
    });

    expect(id).toBe('ti_Q58v');
    const [url, opts] = mockFetch.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe('https://backend.composio.dev/api/v3/trigger_instances/GMAIL_NEW_GMAIL_MESSAGE/upsert');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({
      connected_account_id: 'ca_abc',
      user_id: 'user-1',
      trigger_config: { labelIds: 'INBOX', interval: 2 },
    });
  });

  it('throws an upstream error when upsert returns no trigger_id', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await expect(
      makeProvider().createTriggerInstance(SCOPE, {
        slug: 'X_Y',
        connectedAccountId: 'ca',
        userId: 'u',
        triggerConfig: {},
      }),
    ).rejects.toThrow(/trigger_id/);
  });

  it('deleteTriggerInstance DELETEs /manage/{triggerId}', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ trigger_id: 'ti_x' }));
    await makeProvider().deleteTriggerInstance(SCOPE, 'ti_x');
    const [url, opts] = mockFetch.mock.calls[0] as [string, { method: string }];
    expect(url).toBe('https://backend.composio.dev/api/v3/trigger_instances/manage/ti_x');
    expect(opts.method).toBe('DELETE');
  });

  // An already-gone instance must not wedge teardown — a refcounted delete can legitimately
  // race a sibling that already removed the shared instance, and Composio answers 404/410.
  it('deleteTriggerInstance treats an already-gone 404 as success (no throw)', async () => {
    mockFetch.mockResolvedValueOnce(response(404, { error: 'trigger instance not found' }));
    await expect(makeProvider().deleteTriggerInstance(SCOPE, 'ti_gone')).resolves.toBeUndefined();
  });

  it('deleteTriggerInstance treats a 410 gone as success (no throw)', async () => {
    mockFetch.mockResolvedValueOnce(response(410, ''));
    await expect(makeProvider().deleteTriggerInstance(SCOPE, 'ti_gone')).resolves.toBeUndefined();
  });

  it('deleteTriggerInstance PROPAGATES a non-gone 4xx (e.g. 403)', async () => {
    mockFetch.mockResolvedValueOnce(response(403, { error: 'forbidden' }));
    await expect(makeProvider().deleteTriggerInstance(SCOPE, 'ti_x')).rejects.toThrow(/403/);
  });

  // The orphan reaper lists live instances via GET /trigger_instances/active.
  it("listActiveTriggerInstances GETs /trigger_instances/active, paginates, and names each one's account", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({ items: [{ id: 'ti_aaa', connected_account_id: 'ca_1' }], next_cursor: 'C2' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ items: [{ id: 'ti_bbb', connectedAccountId: 'ca_2' }], next_cursor: null }),
      );

    const instances = await makeProvider().listActiveTriggerInstances(SCOPE);

    expect(instances).toEqual([
      { id: 'ti_aaa', connectedAccountId: 'ca_1' },
      { id: 'ti_bbb', connectedAccountId: 'ca_2' },
    ]);
    const [url1] = mockFetch.mock.calls[0] as [string, { method: string }];
    expect(url1).toBe('https://backend.composio.dev/api/v3/trigger_instances/active?limit=100');
    const [url2] = mockFetch.mock.calls[1] as [string];
    expect(url2).toBe('https://backend.composio.dev/api/v3/trigger_instances/active?limit=100&cursor=C2');
  });

  it('listActiveTriggerInstances reads the id under alternate keys but REQUIRES the ti_ prefix', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        items: [
          { trigger_id: 'ti_from_trigger_id' }, // alternate key
          { nanoId: 'ti_from_nano' }, // alternate key
          { id: 'not_an_instance', uuid: '11111111-2222-3333-4444-555555555555' }, // no ti_ → skipped
        ],
        next_cursor: null,
      }),
    );
    const instances = await makeProvider().listActiveTriggerInstances(SCOPE);
    // The non-ti_ item contributes nothing, and an item naming no account says so rather than guessing one.
    expect(instances).toEqual([
      { id: 'ti_from_trigger_id', connectedAccountId: null },
      { id: 'ti_from_nano', connectedAccountId: null },
    ]);
  });

  it('listActiveTriggerInstances throws on an unexpected shape (no items array)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ oops: true }));
    await expect(makeProvider().listActiveTriggerInstances(SCOPE)).rejects.toThrow(/unexpected shape/);
  });
});
