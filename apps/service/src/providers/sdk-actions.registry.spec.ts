import {
  composioToolFor,
  isComposioCatalogType,
  isOfferable,
  isRoutableActionType,
  isSdkActionType,
  loadComposioCatalog,
  mergeComposioCatalog,
  sdkAction,
  sdkCatalogEntries,
} from './sdk-actions.registry';

describe('sdk-actions registry', () => {
  it('resolves our public action types and rejects unknown ones', () => {
    expect(isSdkActionType('gmail.get_profile')).toBe(true);
    expect(isSdkActionType('slack.send_channel_message')).toBe(true);
    expect(sdkAction('gmail.get_profile')?.type).toBe('gmail.get_profile');
    expect(isSdkActionType('salesforce.definitely_not_real')).toBe(false);
    expect(sdkAction('nope.nope')).toBeUndefined();
  });

  it('projects every action to the platform catalog shape (name/type/category/parameters/auth)', () => {
    const entries = sdkCatalogEntries();
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(typeof e.name).toBe('string');
      expect(String(e.type)).toMatch(/^[a-z][a-z0-9_]*\.[a-z0-9_]+$/);
      expect(e.category).toBe(String(e.type).split('.')[0]);
      expect(['connection', 'none']).toContain(e.auth);
      expect(e.parameters).toBeDefined();
    }
    // Zero vendor strings leak into the catalog projection.
    expect(JSON.stringify(entries)).not.toMatch(/activepieces|composio/i);
  });

  it('exposes the full BYO-authable auth scheme per row (BYO-auth track)', () => {
    const entries = sdkCatalogEntries();
    // Every row carries a serialized scheme with a recognised type.
    for (const e of entries) {
      const s = e.authScheme as { type?: string } | undefined;
      expect(s).toBeDefined();
      expect(['apiKey', 'oauth2', 'basic', 'custom', 'none']).toContain(s?.type);
    }
    const byType = (t: string) =>
      entries.map((e) => e.authScheme as Record<string, unknown>).find((s) => s.type === t);
    // apiKey rows carry the wire metadata a form needs (in + header/param name).
    const apiKey = byType('apiKey');
    if (apiKey) {
      expect(['header', 'query']).toContain(apiKey.in);
      expect(typeof apiKey.name).toBe('string');
    }
    // oauth2 rows carry scopes (+ optional auth/token URLs) for the BYO-OAuth form.
    const oauth2 = byType('oauth2');
    if (oauth2) expect(Array.isArray(oauth2.scopes)).toBe(true);
    // A `custom` scheme's apply() fn is NOT serialized (stays server-side).
    const custom = byType('custom');
    if (custom) expect(Object.keys(custom)).toEqual(['type']);
  });
});

describe('Composio universal-fallback catalog (data/composio_catalog.json)', () => {
  it('exposes the committed Composio catalog via isComposioCatalogType', () => {
    // A real gap action (no SDK action for asana.get_current_user) IS a Composio
    // catalog entry; our SDK utility actions and pure nonsense are not.
    expect(isComposioCatalogType('asana.get_current_user')).toBe(true);
    expect(isComposioCatalogType('text.concat')).toBe(false); // an SDK utility, no Composio toolkit
    expect(isComposioCatalogType('nope.definitely_not_real')).toBe(false);
    // Permissive by design: EVERY managed-toolkit tool, even rows the SURFACE suppresses.
    expect(isComposioCatalogType('gmail.get_profile')).toBe(true);
  });

  // isRoutableActionType — the router's type gate AND the version-write commit gate: the RUNNABLE
  // union, deliberately broader than the offer set.
  it('isRoutableActionType is the SDK ∪ unfiltered-Composio union (runnable, not offer, set)', () => {
    expect(isRoutableActionType('text.concat')).toBe(true); // an SDK action (rail a)
    expect(isRoutableActionType('asana.get_current_user')).toBe(true); // a Composio-catalog gap (rail c)
    // A de-offered-but-still-runnable Composio action (dropped from the palette) is STILL routable.
    expect(
      isOfferable(loadComposioCatalog().find((e) => String(e.type) === 'box.create_box_sign_request')!),
    ).toBe(false);
    expect(isRoutableActionType('box.create_box_sign_request')).toBe(true);
    // A TRUE phantom — in NEITHER catalog — is not routable (still 422s at commit, 400s at run).
    expect(isRoutableActionType('slack.update_profile')).toBe(false);
    expect(isRoutableActionType('nope.definitely_not_real')).toBe(false);
  });

  it('appends Composio rows for gaps and tags every survivor source:composio', () => {
    const base = [{ type: 'text.concat', name: 'SDK concat', category: 'text' }];
    const merged = mergeComposioCatalog(base);
    // The SDK base is preserved untouched…
    expect(merged.find((e) => e.type === 'text.concat')?.name).toBe('SDK concat');
    // …and a real gap action is added, tagged.
    const gap = merged.find((e) => e.type === 'asana.get_current_user');
    expect(gap).toBeDefined();
    expect(gap!.source).toBe('composio');
    // Every appended row carries the tag; the base rows never gain one.
    const survivors = merged.filter((e) => e.source === 'composio');
    expect(survivors.length).toBeGreaterThan(100); // the universal fallback is broad
    expect(merged.find((e) => e.type === 'text.concat')?.source).toBeUndefined();
  });

  it('the SDK wins on an exact type collision — the Composio row is dropped', () => {
    const base = [{ type: 'asana.get_current_user', name: 'OUR asana', category: 'asana' }];
    const merged = mergeComposioCatalog(base);
    const rows = merged.filter((e) => e.type === 'asana.get_current_user');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('OUR asana'); // the SDK row, not the Composio one
    expect(rows[0]!.source).toBeUndefined();
  });

  it('suppresses Composio rows for the googleapis-family apps, keeps them for other apps', () => {
    const merged = mergeComposioCatalog([]);
    for (const slug of ['gmail', 'sheets', 'docs', 'drive', 'slides', 'calendar']) {
      expect(merged.some((e) => e.source === 'composio' && e.category === slug)).toBe(false);
    }
    // A non-suppressed app (asana) keeps its Composio gap rows.
    expect(merged.some((e) => e.source === 'composio' && e.category === 'asana')).toBe(true);
  });

  // composioToolFor — the EXACT tool a catalog action executes as, carrying the per-param
  // `required` names so the executor can pre-flight a missing input.
  it('carries the tool slug, arg names, declared types, AND the required flags', () => {
    const send = composioToolFor('gmail.send_email');
    expect(send?.slug).toBe('GMAIL_SEND_EMAIL');
    expect(send?.inputProperties).toEqual(expect.arrayContaining(['recipient_email', 'body', 'cc']));
    // `required: true` params surface as names; optional ones do not.
    expect(send?.required).toEqual(expect.arrayContaining(['recipient_email', 'body']));
    expect(send?.required).not.toContain('cc');
    // Declared types ride along for coercion (cc is an array param).
    expect(send?.inputTypes?.cc).toBe('array');
  });

  it('returns an empty required list for a tool with no required params (never undefined)', () => {
    const asana = composioToolFor('asana.get_team_memberships');
    expect(asana?.slug).toBe('ASANA_GET_TEAM_MEMBERSHIPS');
    expect(asana?.required).toEqual([]); // schema under-declares — the one-of table fills the gap
  });

  it('returns undefined for a type with no Composio catalog row', () => {
    expect(composioToolFor('text.concat')).toBeUndefined();
    expect(composioToolFor('nope.definitely_not_real')).toBeUndefined();
  });
});

// The offerability predicate, asserted across the REAL committed catalog so drop/keep is proven on live data.
describe('isOfferable — P1.2 action curation (data/composio_catalog.json)', () => {
  const catalog = loadComposioCatalog();
  const byType = (t: string) => catalog.find((e) => String(e.type) === t);

  it('drops the specific structurally-broken junk rows', () => {
    // A parameterless MUTATION write — nothing to create, dies at runtime.
    const box = byType('box.create_box_sign_request');
    expect(box).toBeDefined();
    expect(isOfferable(box!)).toBe(false);
    // A parameterless create_* on a different app — same class of dead write.
    const pd = byType('pagerduty.create_a_ruleset');
    expect(pd).toBeDefined();
    expect(Object.keys(pd!.parameters as Record<string, unknown>)).toHaveLength(0);
    expect(isOfferable(pd!)).toBe(false);
    // A deprecated row (leading [DEPRECATED] description) — retired, must not be offered.
    const daytona = byType('daytona.download_file_deprecated');
    expect(daytona).toBeDefined();
    expect(isOfferable(daytona!)).toBe(false);
  });

  it('keeps legitimate rows, including parameterless READS and normal writes WITH params', () => {
    // Parameterless reads MUST survive — gate on the verb, never a blanket 0-param drop.
    const listBases = byType('airtable.list_bases');
    const emojis = byType('github.get_emojis');
    expect(listBases).toBeDefined();
    expect(emojis).toBeDefined();
    expect(Object.keys(listBases!.parameters as Record<string, unknown>)).toHaveLength(0);
    expect(Object.keys(emojis!.parameters as Record<string, unknown>)).toHaveLength(0);
    expect(isOfferable(listBases!)).toBe(true);
    expect(isOfferable(emojis!)).toBe(true);
    // A normal create WITH parameters is a real, runnable action — kept.
    const createBase = byType('airtable.create_base');
    expect(createBase).toBeDefined();
    expect(Object.keys(createBase!.parameters as Record<string, unknown>).length).toBeGreaterThan(0);
    expect(isOfferable(createBase!)).toBe(true);
  });

  it('keeps ~6000+ rows and drops only a sane low band, never hundreds', () => {
    const kept = catalog.filter(isOfferable).length;
    const dropped = catalog.length - kept;
    expect(catalog.length).toBeGreaterThan(6000); // sanity: the real file is loaded
    expect(kept).toBeGreaterThan(6000); // the vast majority survive
    expect(dropped).toBeGreaterThan(0); // curation actually does something
    expect(dropped).toBeLessThan(100); // …but never nukes hundreds (over-aggressive filter)
  });

  it('the ~189 legitimate parameterless READS all survive (conservatism guard)', () => {
    const parameterless = catalog.filter(
      (e) => Object.keys((e.parameters as Record<string, unknown>) ?? {}).length === 0,
    );
    const survivingReads = parameterless.filter(isOfferable);
    // A blanket 0-param drop would kill ~189 legit reads; the verb-gated predicate keeps them.
    expect(survivingReads.length).toBeGreaterThan(150);
  });

  it('mergeComposioCatalog no longer surfaces the junk rows', () => {
    const merged = mergeComposioCatalog([]);
    for (const junk of [
      'box.create_box_sign_request',
      'pagerduty.create_a_ruleset',
      'daytona.download_file_deprecated',
    ]) {
      expect(merged.some((e) => String(e.type) === junk)).toBe(false);
    }
    // …while a legit read is still offered.
    expect(merged.some((e) => String(e.type) === 'airtable.list_bases')).toBe(true);
  });
});

// The catalog must carry each param's AUTHORING metadata (options / default / items / format), or an enum param
// renders as free text and only fails at run time. Asserted on the REAL file so a stripping regen fails here.
describe('catalog authoring metadata (data/composio_catalog.json)', () => {
  const catalog = loadComposioCatalog();
  const byType = (t: string) => catalog.find((e) => String(e.type) === t);
  type Param = { type?: string; options?: unknown[]; default?: unknown; items?: unknown; format?: string };
  const paramsOf = (t: string) => (byType(t)?.parameters ?? {}) as Record<string, Param>;

  it('restores enum options + defaults on a well-known action (github.list_repository_issues)', () => {
    const p = paramsOf('github.list_repository_issues');
    expect(p.state?.options).toEqual(['open', 'closed', 'all']);
    expect(p.state?.default).toBe('open');
    expect(p.direction?.options).toEqual(['asc', 'desc']);
    // A non-enum required field stays plain (no options invented).
    expect(p.owner?.options).toBeUndefined();
  });

  it('carries the four field kinds across the catalog at scale (no total strip)', () => {
    let opt = 0;
    let def = 0;
    let items = 0;
    let format = 0;
    for (const row of catalog) {
      for (const raw of Object.values((row.parameters ?? {}) as Record<string, Param>)) {
        if (Array.isArray(raw.options) && raw.options.length > 0) opt += 1;
        if ('default' in raw) def += 1;
        if (raw.items) items += 1;
        if (typeof raw.format === 'string' && raw.format) format += 1;
      }
    }
    // Healthy floors, so a regression that drops the enriched fields is caught.
    expect(opt).toBeGreaterThan(1000);
    expect(def).toBeGreaterThan(4000);
    expect(items).toBeGreaterThan(1000);
    expect(format).toBeGreaterThan(100);
  });

  it('never leaks a vendor string into an option / format / default value', () => {
    for (const row of catalog) {
      for (const raw of Object.values((row.parameters ?? {}) as Record<string, Param>)) {
        for (const opt of raw.options ?? []) {
          if (typeof opt === 'string') expect(opt).not.toMatch(/activepieces|composio/i);
        }
        if (typeof raw.format === 'string') expect(raw.format).not.toMatch(/activepieces|composio/i);
        if (typeof raw.default === 'string') expect(raw.default).not.toMatch(/activepieces|composio/i);
      }
    }
  });

  it('pins the linear list-teams display name (curated override, survives regen)', () => {
    // This tool REQUIRES project_id — a by-project lister, so the override name corrects the misleading slug.
    const listTeams = byType('linear.list_linear_teams');
    expect(listTeams?.name).toBe('Get teams by project');
    expect((listTeams?.parameters as Record<string, Param>)?.project_id?.type).toBe('string');
    // The genuine 0-arg top-level lister is left as-is.
    const allTeams = byType('linear.get_all_linear_teams');
    expect(Object.keys((allTeams?.parameters ?? {}) as Record<string, Param>)).toHaveLength(0);
  });
});
