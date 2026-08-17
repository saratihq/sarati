import { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { request } from 'undici';

import type { EnvConfig } from '../config/env.config';
import { ComposioProvider } from './composio.provider';
import { PlatformKeysService } from '../platform/platform-keys.service';

/** Any scope will do here — the tests are about behaviour, not about whose key it is. */
const SCOPE = { kind: 'user', userId: '11111111-1111-1111-1111-111111111111' } as const;

jest.mock('undici', () => ({ request: jest.fn() }));

/** The Composio v3 client's TRIGGER-INSTANCE leg (ADR 0046) — asserts the exact endpoints + bodies, `undici` mocked. */
const mockRequest = request as unknown as jest.Mock;

function jsonResponse(body: unknown): { statusCode: number; body: { text: () => Promise<string> } } {
  return { statusCode: 200, body: { text: () => Promise.resolve(JSON.stringify(body)) } };
}

function response(
  statusCode: number,
  body: unknown,
): { statusCode: number; body: { text: () => Promise<string> } } {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { statusCode, body: { text: () => Promise.resolve(text) } };
}

function makeProvider(): ComposioProvider {
  const config = {
    get: () => ({ composioBaseUrl: 'https://backend.composio.dev' }),
  } as unknown as ConfigService<{ env: EnvConfig }, true>;
  const keys = { composioApiKey: () => Promise.resolve('test-key') } as unknown as PlatformKeysService;
  return new ComposioProvider({} as DataSource, config, keys);
}

describe('ComposioProvider — trigger instances (v3, undici mocked)', () => {
  beforeEach(() => mockRequest.mockReset());

  it('listTriggerTypes GETs /api/v3/triggers_types and paginates by next_cursor', async () => {
    mockRequest
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
    const [url1, opts1] = mockRequest.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string> },
    ];
    expect(url1).toBe('https://backend.composio.dev/api/v3/triggers_types?limit=100');
    expect(opts1.method).toBe('GET');
    expect(opts1.headers['x-api-key']).toBe('test-key');
    // page 2 threads the cursor
    const [url2] = mockRequest.mock.calls[1] as [string];
    expect(url2).toBe('https://backend.composio.dev/api/v3/triggers_types?limit=100&cursor=CURSOR2');
  });

  it('createTriggerInstance POSTs {slug}/upsert with the confirmed body and returns trigger_id', async () => {
    mockRequest.mockResolvedValueOnce(jsonResponse({ trigger_id: 'ti_Q58v' }));

    const id = await makeProvider().createTriggerInstance(SCOPE, {
      slug: 'GMAIL_NEW_GMAIL_MESSAGE',
      connectedAccountId: 'ca_abc',
      userId: 'user-1',
      triggerConfig: { labelIds: 'INBOX', interval: 2 },
    });

    expect(id).toBe('ti_Q58v');
    const [url, opts] = mockRequest.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe('https://backend.composio.dev/api/v3/trigger_instances/GMAIL_NEW_GMAIL_MESSAGE/upsert');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({
      connected_account_id: 'ca_abc',
      user_id: 'user-1',
      trigger_config: { labelIds: 'INBOX', interval: 2 },
    });
  });

  it('throws an upstream error when upsert returns no trigger_id', async () => {
    mockRequest.mockResolvedValueOnce(jsonResponse({ ok: true }));
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
    mockRequest.mockResolvedValueOnce(jsonResponse({ trigger_id: 'ti_x' }));
    await makeProvider().deleteTriggerInstance(SCOPE, 'ti_x');
    const [url, opts] = mockRequest.mock.calls[0] as [string, { method: string }];
    expect(url).toBe('https://backend.composio.dev/api/v3/trigger_instances/manage/ti_x');
    expect(opts.method).toBe('DELETE');
  });

  // An already-gone instance must not wedge teardown — a refcounted delete can legitimately
  // race a sibling that already removed the shared instance, and Composio answers 404/410.
  it('deleteTriggerInstance treats an already-gone 404 as success (no throw)', async () => {
    mockRequest.mockResolvedValueOnce(response(404, { error: 'trigger instance not found' }));
    await expect(makeProvider().deleteTriggerInstance(SCOPE, 'ti_gone')).resolves.toBeUndefined();
  });

  it('deleteTriggerInstance treats a 410 gone as success (no throw)', async () => {
    mockRequest.mockResolvedValueOnce(response(410, ''));
    await expect(makeProvider().deleteTriggerInstance(SCOPE, 'ti_gone')).resolves.toBeUndefined();
  });

  it('deleteTriggerInstance PROPAGATES a non-gone 4xx (e.g. 403)', async () => {
    mockRequest.mockResolvedValueOnce(response(403, { error: 'forbidden' }));
    await expect(makeProvider().deleteTriggerInstance(SCOPE, 'ti_x')).rejects.toThrow(/403/);
  });

  // The orphan reaper lists live instances via GET /trigger_instances/active.
  it('listActiveTriggerInstanceIds GETs /trigger_instances/active, paginates, and returns ti_ ids', async () => {
    mockRequest
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'ti_aaa' }], next_cursor: 'C2' }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'ti_bbb' }], next_cursor: null }));

    const ids = await makeProvider().listActiveTriggerInstanceIds(SCOPE);

    expect(ids).toEqual(['ti_aaa', 'ti_bbb']);
    const [url1] = mockRequest.mock.calls[0] as [string, { method: string }];
    expect(url1).toBe('https://backend.composio.dev/api/v3/trigger_instances/active?limit=100');
    const [url2] = mockRequest.mock.calls[1] as [string];
    expect(url2).toBe('https://backend.composio.dev/api/v3/trigger_instances/active?limit=100&cursor=C2');
  });

  it('listActiveTriggerInstanceIds reads the id under alternate keys but REQUIRES the ti_ prefix', async () => {
    mockRequest.mockResolvedValueOnce(
      jsonResponse({
        items: [
          { trigger_id: 'ti_from_trigger_id' }, // alternate key
          { nanoId: 'ti_from_nano' }, // alternate key
          { id: 'not_an_instance', uuid: '11111111-2222-3333-4444-555555555555' }, // no ti_ → skipped
        ],
        next_cursor: null,
      }),
    );
    const ids = await makeProvider().listActiveTriggerInstanceIds(SCOPE);
    expect(ids).toEqual(['ti_from_trigger_id', 'ti_from_nano']); // the non-ti_ item contributes nothing
  });

  it('listActiveTriggerInstanceIds throws on an unexpected shape (no items array)', async () => {
    mockRequest.mockResolvedValueOnce(jsonResponse({ oops: true }));
    await expect(makeProvider().listActiveTriggerInstanceIds(SCOPE)).rejects.toThrow(/unexpected shape/);
  });
});
