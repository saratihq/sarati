import type { ComposioProvider } from './composio.provider';
import type { ConnectionsService } from './connections.service';
import { ManagedConnectionsService, toComposioSlug, toOurSlug } from './managed-connections.service';

/** Any scope will do here — the tests are about behaviour, not about whose key it is. */
const SCOPE = { kind: 'user', userId: '11111111-1111-1111-1111-111111111111' } as const;

describe('COMPOSIO_TOOLKIT_ALIASES', () => {
  // Each pair must name a real toolkit with a non-empty composio_managed_auth_schemes.
  it.each([
    ['sheets', 'googlesheets'],
    ['calendar', 'googlecalendar'],
    ['bigquery', 'googlebigquery'],
    ['slides', 'googleslides'],
    ['tasks', 'googletasks'],
    ['teams', 'microsoft_teams'],
    ['onedrive', 'one_drive'],
    ['sharepoint', 'share_point'],
    ['outlook-calendar', 'outlook'],
    ['convertkit', 'kit'],
    ['facebook-pages', 'facebook'],
    ['zoho-crm', 'zoho'],
  ])('maps our slug %s to Composio toolkit %s', (app, toolkit) => {
    expect(toComposioSlug(app)).toBe(toolkit);
  });

  it('passes unaliased slugs through unchanged', () => {
    expect(toComposioSlug('github')).toBe('github');
    expect(toComposioSlug('outlook')).toBe('outlook');
  });
});

describe('toOurSlug (Composio toolkit → our canonical app slug)', () => {
  it.each([
    ['googlesheets', 'sheets'],
    ['googlecalendar', 'calendar'],
    ['googlebigquery', 'bigquery'],
    ['kit', 'convertkit'],
    ['facebook', 'facebook-pages'],
    ['microsoft_teams', 'teams'],
    ['zoho', 'zoho-crm'],
  ])('maps toolkit %s to our slug %s', (toolkit, app) => {
    expect(toOurSlug(toolkit)).toBe(app);
  });

  it('keeps the outlook toolkit as outlook, not outlook-calendar', () => {
    // Both our slugs resolve to the outlook toolkit; the catalog keys it under
    // outlook, and an outlook connection serves outlook-calendar.* via family match.
    expect(toOurSlug('outlook')).toBe('outlook');
  });

  it('passes un-aliased toolkits through unchanged', () => {
    expect(toOurSlug('github')).toBe('github');
    expect(toOurSlug('slack')).toBe('slack');
    expect(toOurSlug('notion')).toBe('notion');
  });

  it('round-trips with toComposioSlug for aliased apps', () => {
    for (const app of ['sheets', 'calendar', 'convertkit', 'facebook-pages', 'zoho-crm']) {
      expect(toOurSlug(toComposioSlug(app))).toBe(app);
    }
  });
});

describe('ManagedConnectionsService.listApps', () => {
  const composio = {
    listManagedToolkits: jest.fn().mockResolvedValue([
      { slug: 'googlesheets', name: 'Google Sheets' }, // aliased → sheets
      { slug: 'outlook', name: 'Outlook' }, // identity, not outlook-calendar
      { slug: 'kit', name: 'Kit' }, // aliased → convertkit
      { slug: 'discord', name: 'Discord' }, // formerly blocked, now executable
      { slug: 'supabase', name: 'Supabase' }, // formerly blocked, now executable
      { slug: 'notion', name: 'Notion' }, // un-aliased — offered with NO manifest gate
      { slug: '9bad', name: 'Bad Slug' }, // not addressable as a public action type → skipped
    ]),
  } as unknown as ComposioProvider;
  const service = new ManagedConnectionsService(composio, {} as ConnectionsService);

  it('offers every managed toolkit under OUR slug (aliases resolved), with no manifest gate', async () => {
    const apps = await service.listApps(SCOPE);
    // Sorted by display name; `notion` is offered purely because Composio brokers a managed connection for it.
    expect(apps).toEqual([
      { slug: 'discord', name: 'Discord', executable: true },
      { slug: 'sheets', name: 'Google Sheets', executable: true },
      { slug: 'convertkit', name: 'Kit', executable: true },
      { slug: 'notion', name: 'Notion', executable: true },
      { slug: 'outlook', name: 'Outlook', executable: true },
      { slug: 'supabase', name: 'Supabase', executable: true },
    ]);
  });

  it('offers formerly-blocked Discord and Supabase (NON_EXECUTABLE_MANAGED_APPS is now empty)', async () => {
    const apps = await service.listApps(SCOPE);
    const bySlug = Object.fromEntries(apps.map((a) => [a.slug, a.executable]));
    expect(bySlug.discord).toBe(true);
    expect(bySlug.supabase).toBe(true);
    // ConvertKit is a TRANSPORT-GAP app but the Composio fallback still runs it.
    expect(bySlug.convertkit).toBe(true);
  });

  it('skips toolkits whose slug is not addressable as a public action type', async () => {
    const apps = await service.listApps(SCOPE);
    expect(apps.map((a) => a.slug)).not.toContain('9bad');
  });

  it('never leaks a raw aliased toolkit slug — googlesheets surfaces as sheets', async () => {
    const apps = await service.listApps(SCOPE);
    expect(apps.map((a) => a.slug)).not.toContain('googlesheets');
    expect(apps.map((a) => a.slug)).toContain('sheets');
  });

  it('filters by query against slug or display name', async () => {
    expect((await service.listApps(SCOPE, 'sheet')).map((a) => a.slug)).toEqual(['sheets']);
    expect((await service.listApps(SCOPE, 'discord')).map((a) => a.slug)).toEqual(['discord']);
    expect(await service.listApps(SCOPE, 'no-such-app')).toEqual([]);
  });
});
