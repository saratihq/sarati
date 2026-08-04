import { HashingEmbedder, VectorStore } from './vector-store';

describe('VectorStore retrieval', () => {
  const embedder = new HashingEmbedder();

  it('folds plurals so query and entry vocabulary agree', () => {
    expect(embedder.embed('channels')).toEqual(embedder.embed('channel'));
    expect(embedder.embed('categories')).toEqual(embedder.embed('category'));
    expect(embedder.embed('messages')).toEqual(embedder.embed('message'));
    // Guards: these must NOT be folded into different words.
    expect(embedder.embed('status')).not.toEqual(embedder.embed('statu'));
    expect(embedder.embed('address')).not.toEqual(embedder.embed('addres'));
  });

  it('surfaces a relevant SDK action from a natural query', () => {
    const store = new VectorStore();
    const hits = store.search('send a message to a slack channel', 8, 'orchestr_actions');
    expect(hits.map((h) => h.type)).toContain('slack.send_channel_message');
  });

  // For the googleapis apps, "offered = works": only SDK actions surface, Composio rows are suppressed.
  describe('googleapis-app dedup over the built-in (orchestr) catalog', () => {
    const store = new VectorStore();
    const types = new Set(store.entries('orchestr_actions').map((e) => String(e.type)));

    it('offers OUR Google SDK actions', () => {
      for (const t of [
        'gmail.send_email',
        'gmail.gmail_search_mail',
        'gmail.gmail_get_mail',
        'sheets.insert_row',
        'sheets.read_range',
        'docs.create_document',
        'drive.list_files',
        'slides.get_presentation',
        'calendar.create_google_calendar_event',
        'calendar.list_calendars',
      ]) {
        expect(types.has(t)).toBe(true);
      }
    });

    it('offers NO Composio rows for the googleapis apps (offered = works)', () => {
      const entries = store.entries('orchestr_actions');
      for (const slug of ['gmail', 'sheets', 'docs', 'drive', 'slides', 'calendar']) {
        expect(entries.some((e) => e.source === 'composio' && e.category === slug)).toBe(false);
      }
      // Concretely: ids we never reimplemented as SDK actions are simply absent.
      expect(types.has('gmail.reply_to_email')).toBe(false);
      expect(types.has('sheets.delete_row')).toBe(false);
      expect(types.has('drive.upload_gdrive_file')).toBe(false);
    });

    it('EVERY surfaced calendar action is one of ours', () => {
      const sdkCalendar = new Set([
        'calendar.create_google_calendar_event',
        'calendar.google_calendar_get_events',
        'calendar.google_calendar_get_event_by_id',
        'calendar.update_event',
        'calendar.delete_event',
        'calendar.list_calendars',
      ]);
      const calendarRows = store
        .entries('orchestr_actions')
        .filter((e) => String(e.type).startsWith('calendar.'));
      expect(calendarRows.length).toBeGreaterThan(0);
      for (const row of calendarRows) expect(sdkCalendar.has(String(row.type))).toBe(true);
    });
  });

  // Composio rows stay retrievable so gap apps surface, but rank below SDK rows via the penalty.
  describe('Composio universal fallback ranking (over the real merged catalog)', () => {
    const store = new VectorStore();

    it('surfaces a Composio-only action when no SDK action fits (asana read gap)', () => {
      // asana has no SDK action — get_current_user is a Composio read gap.
      const hits = store.search('asana get the current authenticated user record', 10, 'orchestr_actions');
      const hit = hits.find((h) => h.type === 'asana.get_current_user');
      expect(hit).toBeDefined();
      expect(hit!.source).toBe('composio');
    });

    it('ranks an SDK row above the Composio rows for the same app', () => {
      const hits = store.search('slack send a message to a channel', 8, 'orchestr_actions');
      const sdkIdx = hits.findIndex((h) => h.type === 'slack.send_channel_message');
      const firstComposioIdx = hits.findIndex((h) => h.source === 'composio');
      expect(sdkIdx).toBeGreaterThanOrEqual(0); // the SDK action is retrieved…
      // …and any Composio row in the results ranks strictly below it.
      if (firstComposioIdx >= 0) expect(sdkIdx).toBeLessThan(firstComposioIdx);
    });

    it('never surfaces a suppressed googleapis-app Composio row', () => {
      const entries = store.entries('orchestr_actions');
      expect(entries.some((e) => e.source === 'composio')).toBe(true); // fallback rows ARE present
      // calendar/gmail are googleapis → no Composio rows for them.
      expect(entries.some((e) => e.source === 'composio' && e.category === 'calendar')).toBe(false);
      expect(entries.some((e) => e.source === 'composio' && e.category === 'gmail')).toBe(false);
      // A non-googleapis app (asana) keeps its Composio rows.
      expect(entries.some((e) => e.source === 'composio' && e.category === 'asana')).toBe(true);
    });
  });
});
