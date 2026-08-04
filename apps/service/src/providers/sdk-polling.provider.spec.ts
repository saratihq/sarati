import type { FetchLike, FetchLikeResponse } from '@sarati/actions-sdk';

import type { ConnectionsService } from '../connections/connections.service';
import { InMemoryStore } from './provider-store';
import { SdkPollingProvider } from './sdk-polling.provider';

/** A minimal JSON FetchLikeResponse. */
function res(status: number, body: unknown): FetchLikeResponse {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    status,
    headers: { forEach: (cb) => cb('application/json', 'content-type') },
    text: () => Promise.resolve(text),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  };
}

/** A fetch stub that returns queued responses in order and records every request URL. */
function queuedFetch(bodies: unknown[]): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const fn: FetchLike = (input) => {
    calls.push(String(input));
    const body = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    return Promise.resolve(res(200, body));
  };
  return Object.assign(fn, { calls });
}

const HTTP_URL = 'https://api.example.com/items';
const HTTP_PROPS = { url: HTTP_URL };

describe('SdkPollingProvider', () => {
  it('knows which types are SDK polling triggers', () => {
    const provider = new SdkPollingProvider();
    expect(provider.isPollingTrigger('rss.new_item')).toBe(true);
    expect(provider.isPollingTrigger('hackernews.new_story')).toBe(true);
    expect(provider.isPollingTrigger('http.new_item')).toBe(true);
    expect(provider.isPollingTrigger('slack.new_channel')).toBe(true);
    expect(provider.isPollingTrigger('github.new_push')).toBe(false);
    expect(provider.isPollingTrigger('gmail.gmail_new_email_received')).toBe(false);
  });

  it('reports which triggers need a connection (none-scheme vs oauth)', () => {
    const provider = new SdkPollingProvider();
    // rss/hackernews/http are no-auth — they fire with NO connection.
    expect(provider.needsConnection('rss.new_item')).toBe(false);
    expect(provider.needsConnection('hackernews.new_story')).toBe(false);
    expect(provider.needsConnection('http.new_item')).toBe(false);
    // slack.new_channel authenticates with a connection.
    expect(provider.needsConnection('slack.new_channel')).toBe(true);
  });

  it('exposes the four polling triggers in the catalog with the right auth flag', () => {
    const catalog = new SdkPollingProvider().catalog();
    const byType = new Map(catalog.map((e) => [e.type as string, e]));
    expect(byType.get('rss.new_item')).toMatchObject({ category: 'rss', auth: 'none' });
    expect(byType.get('hackernews.new_story')).toMatchObject({ category: 'hackernews', auth: 'none' });
    expect(byType.get('http.new_item')).toMatchObject({ category: 'http', auth: 'none' });
    expect(byType.get('slack.new_channel')).toMatchObject({ category: 'slack', auth: 'connection' });
    // http.new_item's props project through.
    expect(Object.keys((byType.get('http.new_item')?.parameters as object) ?? {}).sort()).toEqual([
      'itemsPath',
      'url',
    ]);
  });

  it('polls a no-auth trigger (http.new_item) with NO connection and returns fresh events', async () => {
    const fetch = queuedFetch([[{ id: 1 }, { id: 2 }]]);
    const provider = new SdkPollingProvider(undefined, fetch);
    const events = await provider.pollOne('http.new_item', {
      externalUserId: 'u1',
      props: HTTP_PROPS,
      auth: null, // no connection — the OSS rail
      store: new InMemoryStore(),
    });
    expect(events).toEqual([{ payload: { id: 1 } }, { payload: { id: 2 } }]);
    expect(fetch.calls).toEqual([`${HTTP_URL}`]);
  });

  it('dedupes across polls — only items unseen since the stored cursor fire', async () => {
    const fetch = queuedFetch([
      [{ id: 1 }, { id: 2 }],
      [{ id: 1 }, { id: 2 }, { id: 3 }],
    ]);
    const provider = new SdkPollingProvider(undefined, fetch);
    const store = new InMemoryStore();
    const first = await provider.pollOne('http.new_item', {
      externalUserId: 'u1',
      props: HTTP_PROPS,
      auth: null,
      store,
    });
    const second = await provider.pollOne('http.new_item', {
      externalUserId: 'u1',
      props: HTTP_PROPS,
      auth: null,
      store,
    });
    expect(first).toEqual([{ payload: { id: 1 } }, { payload: { id: 2 } }]);
    expect(second).toEqual([{ payload: { id: 3 } }]); // 1 + 2 already seen
  });

  it('enable primes the watermark so pre-activation items never fire on the first poll', async () => {
    const fetch = queuedFetch([
      [{ id: 1 }, { id: 2 }], // enable (priming): discarded, seeds `seen`
      [{ id: 1 }, { id: 2 }, { id: 3 }], // first real poll: only id 3 is new
    ]);
    const provider = new SdkPollingProvider(undefined, fetch);
    const store = new InMemoryStore();
    await provider.enable('http.new_item', {
      externalUserId: 'u1',
      props: HTTP_PROPS,
      auth: null,
      store,
    });
    const events = await provider.pollOne('http.new_item', {
      externalUserId: 'u1',
      props: HTTP_PROPS,
      auth: null,
      store,
    });
    expect(events).toEqual([{ payload: { id: 3 } }]);
  });

  it('resolves a {connectionId} reference through ConnectionsService for a connection trigger (slack)', async () => {
    // A full-enumeration trigger: the FIRST poll baselines and fires nothing (activation must not
    // replay history); the SECOND surfaces only a genuinely-new channel.
    const fetch = queuedFetch([
      { ok: true, channels: [{ id: 'C1', name: 'general' }], response_metadata: { next_cursor: '' } },
      {
        ok: true,
        channels: [
          { id: 'C1', name: 'general' },
          { id: 'C2', name: 'random' },
        ],
        response_metadata: { next_cursor: '' },
      },
    ]);
    const getCredential = jest.fn().mockResolvedValue({ access_token: 'xoxb-real-token' });
    const connections = { getCredential } as unknown as ConnectionsService;
    const provider = new SdkPollingProvider(connections, fetch);
    const store = new InMemoryStore();

    const baseline = await provider.pollOne('slack.new_channel', {
      externalUserId: 'user-9',
      props: {},
      auth: { connectionId: 'conn-1' },
      store,
    });
    expect(baseline).toEqual([]); // first poll baselines the workspace, fires nothing

    const events = await provider.pollOne('slack.new_channel', {
      externalUserId: 'user-9',
      props: {},
      auth: { connectionId: 'conn-1' },
      store,
    });
    expect(getCredential).toHaveBeenCalledWith('user-9', 'conn-1');
    expect(events).toEqual([{ payload: { id: 'C2', name: 'random' } }]);
  });

  it('rejects a managed (Composio) connection — never sends the sentinel to the provider', async () => {
    const fetch = queuedFetch([{ ok: true, channels: [] }]);
    // getCredential returns the masked sentinel for a managed row.
    const getCredential = jest.fn().mockResolvedValue({ access_token: '__ORCHESTR_MANAGED__:acct_123' });
    const connections = { getCredential } as unknown as ConnectionsService;
    const provider = new SdkPollingProvider(connections, fetch);

    await expect(
      provider.pollOne('slack.new_channel', {
        externalUserId: 'user-9',
        props: {},
        auth: { connectionId: 'conn-managed' },
        store: new InMemoryStore(),
      }),
    ).rejects.toThrow(/managed .*connection cannot be used/i);
    // The sentinel must never have left the process as an outbound call.
    expect(fetch.calls).toHaveLength(0);
  });

  it('fails loudly for an unknown polling trigger type', async () => {
    const provider = new SdkPollingProvider();
    await expect(
      provider.pollOne('github.new_push', {
        externalUserId: 'u1',
        props: {},
        auth: null,
        store: new InMemoryStore(),
      }),
    ).rejects.toThrow(/No SDK polling trigger registered/i);
  });

  // ─── catalog projection + trigger option loading ───

  it('projects the full authoring surface: labels, static options, defaults, and the sample event', () => {
    const catalog = new SdkPollingProvider().catalog();
    const byType = new Map(catalog.map((e) => [e.type as string, e]));

    // A static dropdown's choices and default must reach the picker, or the field degrades to a text box.
    const types = (byType.get('slack.new_channel')?.parameters as Record<string, Record<string, unknown>>)
      .types!;
    expect(types.label).toBe('Channel types');
    expect(types.defaultValue).toBe('public_channel');
    expect(types.options).toEqual([
      { label: 'Public channels', value: 'public_channel' },
      { label: 'Public and private', value: 'public_channel,private_channel' },
    ]);

    // The authored sample event rides the row — provider-shaped, seedable.
    const airtable = byType.get('airtable.new_record')!;
    expect((airtable.sample as Record<string, unknown>).id).toBe('rec560UJdUtocSouk');
  });

  it('loadOptions resolves a STATIC dropdown with no connection at all', async () => {
    const provider = new SdkPollingProvider();
    const result = await provider.loadOptions('slack.new_channel', 'types', { externalUserId: 'u1' });
    expect(result.disabled).toBe(false);
    expect(result.options.map((o) => o.value)).toEqual(['public_channel', 'public_channel,private_channel']);
  });

  it('loadOptions degrades a DYNAMIC dropdown to disabled when no connection is picked', async () => {
    const provider = new SdkPollingProvider();
    const result = await provider.loadOptions('airtable.new_record', 'baseId', { externalUserId: 'u1' });
    expect(result.disabled).toBe(true);
    expect(result.options).toEqual([]);
    expect(result.placeholder).toMatch(/connect an account/i);
  });

  it('loadOptions runs a DYNAMIC loader against the connection and returns name-not-ID choices', async () => {
    const fetch = queuedFetch([
      {
        bases: [
          { id: 'appX1', name: 'CRM' },
          { id: 'appX2', name: 'Roadmap' },
        ],
      },
    ]);
    const getCredential = jest.fn().mockResolvedValue('pat_airtable_token');
    const connections = { getCredential } as unknown as ConnectionsService;
    const provider = new SdkPollingProvider(connections, fetch);

    const result = await provider.loadOptions('airtable.new_record', 'baseId', {
      externalUserId: 'user-9',
      connectionId: 'conn-air',
    });
    expect(getCredential).toHaveBeenCalledWith('user-9', 'conn-air');
    expect(result.disabled).toBe(false);
    expect(result.options).toEqual([
      { label: 'CRM', value: 'appX1' },
      { label: 'Roadmap', value: 'appX2' },
    ]);
  });

  it('loadOptions degrades (never throws) when the credential is unusable — e.g. managed on the direct rail', async () => {
    const getCredential = jest.fn().mockResolvedValue({ access_token: '__ORCHESTR_MANAGED__:acct_123' });
    const connections = { getCredential } as unknown as ConnectionsService;
    const fetch = queuedFetch([{}]);
    const provider = new SdkPollingProvider(connections, fetch);

    const result = await provider.loadOptions('airtable.new_record', 'baseId', {
      externalUserId: 'user-9',
      connectionId: 'conn-managed',
    });
    expect(result.disabled).toBe(true);
    expect(result.placeholder).toMatch(/directly-authenticated/i);
    expect(fetch.calls).toHaveLength(0); // the sentinel never left the process
  });

  it('loadOptions rejects a prop that is not a dropdown (caller bug, 400)', async () => {
    const provider = new SdkPollingProvider();
    await expect(
      provider.loadOptions('airtable.new_record', 'tableId', { externalUserId: 'u1' }),
    ).rejects.toThrow(/not a dropdown/i);
  });
});
