import { createHmac } from 'node:crypto';

import type {
  ComposioProvider,
  ComposioToolkit,
  ComposioTriggerType,
} from '../connections/composio.provider';
import { PlatformKeysService } from '../platform/platform-keys.service';
import { ComposioTriggerProvider } from './composio-trigger.provider';

/** Any scope will do here — the tests are about behaviour, not about whose key it is. */
const SCOPE = { kind: 'user', userId: '11111111-1111-1111-1111-111111111111' } as const;

/**
 * The Composio TRIGGER rail façade: projection, public-type↔slug mapping, verify + subscribe delegation,
 * over a FAKE ComposioProvider. The exact HTTP endpoints/bodies are covered in composio.provider.triggers.spec.
 */

const SAMPLE_TYPES: ComposioTriggerType[] = [
  {
    slug: 'GMAIL_NEW_GMAIL_MESSAGE',
    name: 'New message',
    description: 'Fires on a new Gmail message',
    toolkitSlug: 'gmail',
    type: 'poll',
    config: {
      properties: {
        interval: { type: 'number', default: 2, description: 'poll interval' },
        labelIds: { type: 'string', default: 'INBOX', description: 'labels' },
        query: { type: 'string', description: 'search query' },
      },
      required: [],
    },
  },
  {
    slug: 'GITHUB_COMMIT_EVENT',
    name: 'Commit',
    description: 'Fires on a commit',
    toolkitSlug: 'github',
    type: 'webhook',
    config: {
      properties: {
        owner: { type: 'string', description: 'repo owner' },
        repo: { type: 'string', description: 'repo name' },
      },
      required: ['owner', 'repo'],
    },
  },
  // Composio toolkit `googlecalendar` must project under OUR slug `calendar`.
  {
    slug: 'GOOGLECALENDAR_EVENT',
    name: 'Calendar event',
    description: '',
    toolkitSlug: 'googlecalendar',
    type: 'poll',
    config: { properties: {}, required: [] },
  },
];

/** The managed toolkits every SAMPLE_TYPES toolkit belongs to — so the filter keeps them all by default. */
const SAMPLE_MANAGED_TOOLKITS: ComposioToolkit[] = [
  { slug: 'gmail', name: 'Gmail' },
  { slug: 'github', name: 'GitHub' },
  { slug: 'googlecalendar', name: 'Google Calendar' },
];

interface FakeComposio {
  isConfigured: jest.Mock<Promise<boolean>, []>;
  listTriggerTypes: jest.Mock<Promise<ComposioTriggerType[]>, []>;
  listManagedToolkits: jest.Mock<Promise<ComposioToolkit[]>, []>;
  createTriggerInstance: jest.Mock;
  deleteTriggerInstance: jest.Mock;
  listActiveTriggerInstanceIds: jest.Mock<Promise<string[]>, []>;
}

function makeProvider(opts?: {
  configured?: boolean;
  types?: ComposioTriggerType[] | Error;
  managed?: ComposioToolkit[] | Error;
  secret?: string;
}): { provider: ComposioTriggerProvider; fake: FakeComposio } {
  const types = opts?.types ?? SAMPLE_TYPES;
  const managed = opts?.managed ?? SAMPLE_MANAGED_TOOLKITS;
  const fake: FakeComposio = {
    isConfigured: jest.fn(() => Promise.resolve(opts?.configured ?? true)),
    listTriggerTypes: jest.fn(() =>
      types instanceof Error ? Promise.reject(types) : Promise.resolve(types),
    ),
    listManagedToolkits: jest.fn(() =>
      managed instanceof Error ? Promise.reject(managed) : Promise.resolve(managed),
    ),
    createTriggerInstance: jest.fn(() => Promise.resolve('ti_created')),
    deleteTriggerInstance: jest.fn(() => Promise.resolve()),
    listActiveTriggerInstanceIds: jest.fn(() => Promise.resolve<string[]>(['ti_live'])),
  };
  // The webhook secret is stored per scope now, not read from env.
  const keys = {
    get: (_scope: unknown, name: string) =>
      Promise.resolve(name === 'composio_webhook_secret' ? (opts?.secret ?? '') : ''),
  } as unknown as PlatformKeysService;
  const provider = new ComposioTriggerProvider(fake as unknown as ComposioProvider, keys);
  return { provider, fake };
}

describe('ComposioTriggerProvider', () => {
  describe('catalog projection', () => {
    it('maps a triggers_types response to picker rows (type, category, auth, parameters)', async () => {
      const { provider } = makeProvider();
      const entries = await provider.catalog(SCOPE);
      expect(entries).toHaveLength(3);

      const gmail = entries.find((e) => e.type === 'gmail.gmail_new_gmail_message');
      expect(gmail).toMatchObject({
        name: 'New message',
        type: 'gmail.gmail_new_gmail_message',
        category: 'gmail',
        description: 'Fires on a new Gmail message',
        auth: 'connection',
      });
      expect(gmail?.parameters).toEqual({
        interval: { type: 'NUMBER', description: 'poll interval', required: false, default: 2 },
        labelIds: { type: 'SHORT_TEXT', description: 'labels', required: false, default: 'INBOX' },
        query: { type: 'SHORT_TEXT', description: 'search query', required: false },
      });
    });

    it('carries required fields through from the config `required` array', async () => {
      const { provider } = makeProvider();
      const github = (await provider.catalog(SCOPE)).find((e) => e.type === 'github.github_commit_event');
      expect(github?.parameters).toEqual({
        owner: { type: 'SHORT_TEXT', description: 'repo owner', required: true },
        repo: { type: 'SHORT_TEXT', description: 'repo name', required: true },
      });
    });

    it('namespaces the public type under OUR app slug (googlecalendar → calendar)', async () => {
      const { provider } = makeProvider();
      const cal = (await provider.catalog(SCOPE)).find((e) => e.category === 'calendar');
      expect(cal?.type).toBe('calendar.googlecalendar_event');
    });

    it('is inert (empty) when the key is unset — edition gate', async () => {
      const { provider, fake } = makeProvider({ configured: false });
      expect(await provider.catalog(SCOPE)).toEqual([]);
      expect(fake.listTriggerTypes).not.toHaveBeenCalled();
    });

    it('caches — a second call does not re-list', async () => {
      const { provider, fake } = makeProvider();
      await provider.catalog(SCOPE);
      await provider.catalog(SCOPE);
      expect(fake.listTriggerTypes).toHaveBeenCalledTimes(1);
    });

    it('degrades to [] (never throws) when the catalog fetch fails', async () => {
      const { provider } = makeProvider({ types: new Error('composio 502') });
      expect(await provider.catalog(SCOPE)).toEqual([]);
    });
  });

  // The picker must offer ONLY triggers on a MANAGED toolkit — no BYO path can subscribe,
  // so a non-managed toolkit's trigger could never fire.
  describe('managed-toolkit filter (P1.1)', () => {
    // A trigger on a toolkit with NO shared managed OAuth app — nothing can subscribe it.
    const SPOTIFY_TRIGGER: ComposioTriggerType = {
      slug: 'SPOTIFY_NEW_SAVED_TRACK',
      name: 'New saved track',
      description: 'Fires on a new saved track',
      toolkitSlug: 'spotify',
      type: 'poll',
      config: { properties: {}, required: [] },
    };

    it('drops triggers whose toolkit is not managed, keeps the managed ones', async () => {
      const { provider } = makeProvider({
        types: [...SAMPLE_TYPES, SPOTIFY_TRIGGER],
        managed: SAMPLE_MANAGED_TOOLKITS, // gmail + github + googlecalendar, NOT spotify
      });
      const entries = await provider.catalog(SCOPE);
      // The 3 managed-toolkit triggers survive; the spotify one is dropped.
      expect(entries).toHaveLength(3);
      expect(entries.some((e) => e.category === 'spotify')).toBe(false);
      expect(entries.some((e) => e.type === 'gmail.gmail_new_gmail_message')).toBe(true);
      expect(entries.some((e) => e.type === 'github.github_commit_event')).toBe(true);
    });

    it('FAILS OPEN — an EMPTY managed set drops nothing (a blip must never gut the picker)', async () => {
      const { provider } = makeProvider({
        types: [...SAMPLE_TYPES, SPOTIFY_TRIGGER],
        managed: [], // undetermined → keep every trigger
      });
      const entries = await provider.catalog(SCOPE);
      expect(entries).toHaveLength(4); // all kept, spotify included
      expect(entries.some((e) => e.category === 'spotify')).toBe(true);
    });

    it('FAILS OPEN — a managed-toolkit FETCH ERROR drops nothing', async () => {
      const { provider } = makeProvider({
        types: [...SAMPLE_TYPES, SPOTIFY_TRIGGER],
        managed: new Error('composio 502'),
      });
      const entries = await provider.catalog(SCOPE);
      expect(entries).toHaveLength(4); // fail-open: every trigger kept
      expect(entries.some((e) => e.category === 'spotify')).toBe(true);
    });
  });

  // The cache must back off on failure (short negative TTL) and never let a transient
  // empty 200 clobber a warm non-empty catalog.
  describe('catalog cache resilience (F4)', () => {
    afterEach(() => jest.restoreAllMocks());

    it('an empty 200 refresh does NOT clobber a warm non-empty cache', async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      const { provider, fake } = makeProvider();
      expect(await provider.catalog(SCOPE)).toHaveLength(3); // warm from SAMPLE_TYPES
      fake.listTriggerTypes.mockResolvedValueOnce([]); // upstream blips to empty
      nowSpy.mockReturnValue(1_000_000 + 11 * 60_000); // past the 10-min TTL → forces a refresh
      expect(await provider.catalog(SCOPE)).toHaveLength(3); // prior good entries kept, not clobbered
    });

    it('negative-caches a failed refresh so it backs off (no re-pagination on every hit)', async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(2_000_000);
      const { provider, fake } = makeProvider({ types: new Error('composio down') });
      expect(await provider.catalog(SCOPE)).toEqual([]); // fails → []
      await provider.catalog(SCOPE); // still inside the negative TTL → served from cache, no re-list
      expect(fake.listTriggerTypes).toHaveBeenCalledTimes(1);
      nowSpy.mockReturnValue(2_000_000 + 60_000); // past the ~45s negative TTL → retries once
      await provider.catalog(SCOPE);
      expect(fake.listTriggerTypes).toHaveBeenCalledTimes(2);
    });
  });

  describe('slugForPublicType', () => {
    it('prefers the EXACT recorded slug once the catalog is warm', async () => {
      const { provider } = makeProvider();
      await provider.catalog(SCOPE);
      expect(provider.slugForPublicType('calendar.googlecalendar_event')).toBe('GOOGLECALENDAR_EVENT');
      expect(provider.slugForPublicType('gmail.gmail_new_gmail_message')).toBe('GMAIL_NEW_GMAIL_MESSAGE');
    });

    it('falls back to deterministic uppercase reversal when uncached', () => {
      const { provider } = makeProvider();
      expect(provider.slugForPublicType('github.github_commit_event')).toBe('GITHUB_COMMIT_EVENT');
      expect(provider.slugForPublicType('malformed')).toBeNull();
    });
  });

  describe('subscribe / unsubscribe delegation', () => {
    it('delegates createTriggerInstance to the v3 client verbatim', async () => {
      const { provider, fake } = makeProvider();
      const params = {
        slug: 'GMAIL_NEW_GMAIL_MESSAGE',
        connectedAccountId: 'ca_abc',
        userId: 'user-1',
        triggerConfig: { labelIds: 'INBOX' },
      };
      await provider.createTriggerInstance(SCOPE, params);
      expect(fake.createTriggerInstance).toHaveBeenCalledWith(SCOPE, params);
    });

    it('delegates deleteTriggerInstance to the v3 client', async () => {
      const { provider, fake } = makeProvider();
      await provider.deleteTriggerInstance(SCOPE, 'ti_xyz');
      expect(fake.deleteTriggerInstance).toHaveBeenCalledWith(SCOPE, 'ti_xyz');
    });
  });

  // The orphan reaper's live-instance source — managed-gated + best-effort.
  describe('listActiveInstanceIds', () => {
    it('delegates to the v3 client when configured', async () => {
      const { provider, fake } = makeProvider();
      expect(await provider.listActiveInstanceIds(SCOPE)).toEqual(['ti_live']);
      expect(fake.listActiveTriggerInstanceIds).toHaveBeenCalledTimes(1);
    });

    it('is inert ([]) when the key is unset — never lists', async () => {
      const { provider, fake } = makeProvider({ configured: false });
      expect(await provider.listActiveInstanceIds(SCOPE)).toEqual([]);
      expect(fake.listActiveTriggerInstanceIds).not.toHaveBeenCalled();
    });

    it('degrades to [] (never throws) on a listing failure — no false "all orphaned"', async () => {
      const { provider, fake } = makeProvider();
      fake.listActiveTriggerInstanceIds.mockRejectedValueOnce(new Error('composio 502'));
      expect(await provider.listActiveInstanceIds(SCOPE)).toEqual([]);
    });
  });

  describe('verifyWebhook', () => {
    it("verifies against the scope's stored project webhook secret", async () => {
      const secret = 'whsec_project_secret';
      const { provider } = makeProvider({ secret });
      const raw = JSON.stringify({ metadata: { trigger_id: 'ti_1' } });
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = 'v1,' + createHmac('sha256', secret).update(`id1.${ts}.${raw}`).digest('base64');
      const ok = await provider.verifyWebhook(SCOPE, raw, {
        'webhook-id': 'id1',
        'webhook-timestamp': ts,
        'webhook-signature': sig,
      });
      expect(ok.ok).toBe(true);
    });

    it('fails closed when the scope has no secret stored', async () => {
      const { provider } = makeProvider({ secret: '' });
      expect((await provider.verifyWebhook(SCOPE, '{}', {})).ok).toBe(false);
    });
  });
});
