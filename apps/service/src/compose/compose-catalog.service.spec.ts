import type { VectorStore } from '../generation/vector-store';
import type { PlatformKeysService, PlatformKeyScope } from '../platform/platform-keys.service';
import type { TriggerCatalogService, UnreadListing } from '../triggers/trigger-catalog.service';
import { ComposeCatalogService } from './compose-catalog.service';

const WORKFLOW_SCOPE: PlatformKeyScope = { kind: 'org', orgId: 'org-of-the-workflow' };
const CALLER_SCOPE: PlatformKeyScope = { kind: 'user', userId: 'the-caller' };
const IN_PROCESS = new Set(['orchestr:webhook', 'rss.new_item']);

const docWith = (triggerType: string): Record<string, unknown> => ({
  nodes: [
    { id: 'start', name: 'Start', node_type: triggerType, parameters: {}, metadata: { trigger: true } },
    { id: 'say', name: 'Say', node_type: 'slack.send_channel_message', parameters: {} },
  ],
  edges: [],
});

function catalogListing(live: ReadonlySet<string> | UnreadListing): {
  catalog: ComposeCatalogService;
  asked: PlatformKeyScope[];
} {
  const asked: PlatformKeyScope[] = [];
  const triggers = {
    offeredWithoutComposio: (type: string) =>
      type === 'orchestr:trigger' || IN_PROCESS.has(type) ? true : null,
    liveTypes: (scope: PlatformKeyScope, waitMs: number) => {
      asked.push(scope);
      expect(waitMs).toBe(5_000);
      return Promise.resolve(live);
    },
  } as unknown as TriggerCatalogService;
  const keys = {
    scopeForWorkflow: (id: string) => Promise.resolve(id === 'wf' ? WORKFLOW_SCOPE : null),
    scopeFor: (userId: string) => Promise.resolve(userId === 'the-caller' ? CALLER_SCOPE : null),
  } as unknown as PlatformKeysService;
  const vectors = { entries: () => [], search: () => [] } as unknown as VectorStore;
  return { catalog: new ComposeCatalogService(vectors, triggers, keys), asked };
}

/** The author gate's facts ask Composio only for what nothing in-process decides, so a save that needs no listing never waits on one. */
describe('ComposeCatalogService.authoringFacts', () => {
  it('asks Composio nothing for a document whose trigger is offered in-process, manual, or no app trigger at all', async () => {
    const { catalog, asked } = catalogListing(new Set(['gmail.new_email']));
    for (const type of [
      'orchestr:trigger',
      'orchestr:webhook',
      'rss.new_item',
      'orchestr:webhok',
      'Acme.new_deal',
    ]) {
      const facts = await catalog.authoringFacts(docWith(type), { workflowId: 'wf' });
      expect(facts.offersTrigger(type)).toBe(
        type === 'orchestr:trigger' || IN_PROCESS.has(type) ? true : 'listing_unavailable',
      );
    }
    expect(asked).toEqual([]);
  });

  it("asks the listing of the workflow's own workspace about an app trigger nothing in-process offers, and answers from it", async () => {
    const { catalog, asked } = catalogListing(new Set(['gmail.new_email']));
    const facts = await catalog.authoringFacts(docWith('gmail.new_emial'), { workflowId: 'wf' });
    expect(asked).toEqual([WORKFLOW_SCOPE]);
    expect(facts.offersTrigger('gmail.new_emial')).toBe(false);
    expect(facts.offersTrigger('gmail.new_email')).toBe(true);
    expect(facts.offersTrigger('orchestr:webhook')).toBe(true);
  });

  it("asks the caller's workspace for a document not made yet, and for a list of types only when one of them needs it", async () => {
    const { catalog, asked } = catalogListing(new Set(['gmail.new_email']));
    await catalog.authoringFacts(docWith('gmail.new_email'), { userId: 'the-caller', orgId: null });
    await catalog.authoringFactsFor(['orchestr:chat', 'rss.new_item', 'Acme.new_deal'], { workflowId: 'wf' });
    expect(asked).toEqual([CALLER_SCOPE]);
    const merged = await catalog.authoringFactsFor(['orchestr:webhook', 'gmail.new_email'], {
      workflowId: 'wf',
    });
    expect(asked).toEqual([CALLER_SCOPE, WORKFLOW_SCOPE]);
    expect(merged.offersTrigger('gmail.new_email')).toBe(true);
  });

  it("leaves an app trigger undecided when Composio's listing can't be read, saying why", async () => {
    for (const why of ['listing_unavailable', 'no_composio_key'] as const) {
      const { catalog } = catalogListing(why);
      const facts = await catalog.authoringFacts(docWith('gmail.new_email'), { workflowId: 'wf' });
      expect(facts.offersTrigger('gmail.new_email')).toBe(why);
      expect(facts.offersTrigger('rss.new_item')).toBe(true);
    }
  });

  it('has no Composio key to ask with for a workflow that is gone', async () => {
    const { catalog, asked } = catalogListing(new Set(['gmail.new_email']));
    const facts = await catalog.authoringFacts(docWith('gmail.new_email'), { workflowId: 'gone' });
    expect(asked).toEqual([]);
    expect(facts.offersTrigger('gmail.new_email')).toBe('no_composio_key');
  });
});
