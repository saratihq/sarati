import type {
  ComposioProjectedCatalogEntry,
  ComposioTriggerProvider,
} from '../providers/composio-trigger.provider';
import type { SdkPollingProvider } from '../providers/sdk-polling.provider';
import type { SdkWebhookProvider } from '../providers/sdk-webhook.provider';
import type { PlatformKeysService } from '../platform/platform-keys.service';
import { TriggerCatalogService } from './trigger-catalog.service';

const SCOPE = { kind: 'user', userId: '11111111-1111-1111-1111-111111111111' } as const;
const OTHER_SCOPE = { kind: 'user', userId: '22222222-2222-2222-2222-222222222222' } as const;
const HAND_POLLED = 'gmail.gmail_new_email_received';

const live = (...types: string[]): ComposioProjectedCatalogEntry[] =>
  types.map((type) => ({
    name: type,
    type,
    category: type.split('.')[0]!,
    description: '',
    parameters: {},
    auth: 'connection',
  }));

function catalogOf(opts: {
  listing: Promise<ComposioProjectedCatalogEntry[] | null>;
  otherListing?: Promise<ComposioProjectedCatalogEntry[] | null>;
  byInstance?: boolean;
  keyed?: boolean;
}): TriggerCatalogService {
  const sdkWebhooks = { catalog: () => [{ type: 'github.star_added' }] } as unknown as SdkWebhookProvider;
  const sdkPolling = { catalog: () => [{ type: 'rss.new_item' }] } as unknown as SdkPollingProvider;
  const composio = {
    knownCatalog: (scope: { userId: string }) =>
      scope.userId === OTHER_SCOPE.userId ? (opts.otherListing ?? opts.listing) : opts.listing,
    catalog: async () => (await opts.listing) ?? [],
    isConfigured: () => Promise.resolve(opts.keyed ?? true),
  } as unknown as ComposioTriggerProvider;
  const keys = {
    composioManagedByInstance: () => opts.byInstance ?? false,
    composioPartition: (scope: { userId: string }) => scope.userId,
  } as unknown as PlatformKeysService;
  return new TriggerCatalogService(sdkWebhooks, sdkPolling, composio, keys);
}

/** What the author gate asks of the one trigger list: the in-process half decided at once, Composio's half only when it can be read in time. */
describe('TriggerCatalogService — what the trigger picker offers, for the author gate', () => {
  it('decides without Composio the manual trigger and every type it offers in-process, and a hand-polled one the instance leaves out', () => {
    const own = catalogOf({ listing: Promise.resolve(null) });
    for (const type of [
      'orchestr:trigger',
      'orchestr:webhook',
      'orchestr:tool_trigger',
      'github.star_added',
      'rss.new_item',
      HAND_POLLED,
    ]) {
      expect(own.offeredWithoutComposio(type)).toBe(true);
    }
    expect(own.offeredWithoutComposio('gmail.new_email')).toBeNull();

    const byInstance = catalogOf({ listing: Promise.resolve(null), byInstance: true });
    expect(byInstance.offeredWithoutComposio('orchestr:trigger')).toBe(true);
    expect(byInstance.offeredWithoutComposio(HAND_POLLED)).toBe(false);
    expect(byInstance.offeredWithoutComposio('rss.new_item')).toBe(true);
  });

  it("lists the types Composio's listing adds to the picker, never one the picker already holds", async () => {
    const catalog = catalogOf({
      listing: Promise.resolve(live('gmail.new_email', 'rss.new_item', HAND_POLLED)),
    });
    expect(await catalog.liveTypes(SCOPE, 1_000)).toEqual(new Set(['gmail.new_email']));
    expect((await catalog.list(SCOPE)).map((row) => row.entry.type)).toContain('gmail.new_email');
  });

  it("is unknown when Composio's listing is, or when it does not answer in time, saying which", async () => {
    expect(await catalogOf({ listing: Promise.resolve(null) }).liveTypes(SCOPE, 1_000)).toBe(
      'listing_unavailable',
    );
    expect(await catalogOf({ listing: Promise.resolve(null), keyed: false }).liveTypes(SCOPE, 1_000)).toBe(
      'no_composio_key',
    );

    const started = Date.now();
    const stalled = catalogOf({ listing: new Promise<never>(() => undefined) });
    expect(await stalled.liveTypes(SCOPE, 50)).toBe('listing_unavailable');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("answers a caller arriving while a listing has already run past one wait at once, never another workspace's, and reads it again once it settles", async () => {
    let settle: (entries: ComposioProjectedCatalogEntry[]) => void = () => undefined;
    const listing = new Promise<ComposioProjectedCatalogEntry[]>((resolve) => {
      settle = resolve;
    });
    const catalog = catalogOf({ listing, otherListing: Promise.resolve(live('slack.new_message')) });
    expect(await catalog.liveTypes(SCOPE, 50)).toBe('listing_unavailable');
    expect(await catalog.liveTypes(OTHER_SCOPE, 1_000)).toEqual(new Set(['slack.new_message']));

    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise((resolve) => {
      timer = setTimeout(() => resolve('waited'), 1_000);
    });
    expect(await Promise.race([catalog.liveTypes(SCOPE, 60_000), waited])).toBe('listing_unavailable');
    clearTimeout(timer);

    settle(live('gmail.new_email'));
    await listing;
    expect(await catalog.liveTypes(SCOPE, 1_000)).toEqual(new Set(['gmail.new_email']));
  });
});
