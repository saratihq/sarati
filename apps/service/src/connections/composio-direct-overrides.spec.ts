import { readFileSync } from 'node:fs';

import { actions, createDirectAuth, HttpClient } from '@sarati/actions-sdk';
import type { HttpMethod, HttpResponse, RequestOptions } from '@sarati/actions-sdk';

import { dataFile } from '../generation/data-dir';
import { frozenClockArguments, sdkAction } from '../providers/sdk-actions.registry';
import { directOverride, directOverrideTypes } from './composio-direct-overrides';
import { COMPOSIO_DIRECT_APPS } from './managed-app-rails';
import { toComposioSlug } from './managed-connections.service';

interface CatalogTool {
  slug: string;
  params: Record<string, { required?: boolean }>;
}

/** The prebuilt Composio catalog, re-keyed by TOOL SLUG (the projection's inverse). */
function catalogTools(): Map<string, CatalogTool> {
  const path = dataFile(__dirname, 'composio_catalog.json');
  expect(path).not.toBeNull();
  const rows = JSON.parse(readFileSync(path!, 'utf8')) as Array<Record<string, unknown>>;
  const tools = new Map<string, CatalogTool>();
  for (const row of rows) {
    const type = String(row.type);
    const dot = type.indexOf('.');
    if (dot <= 0) continue;
    const app = type.slice(0, dot);
    const slug = `${toComposioSlug(app)}_${type.slice(dot + 1)}`.toUpperCase();
    tools.set(slug, { slug, params: (row.parameters ?? {}) as CatalogTool['params'] });
  }
  return tools;
}

/** A plausible sample value per SDK prop type (enough to exercise the mappers). */
function sampleValue(type: string, name: string): unknown {
  if (type === 'NUMBER') return 5;
  if (type === 'DATE_TIME') return '2026-07-12T10:00:00Z';
  if (type === 'JSON') return name === 'values' ? [['a', 'b']] : ['a@example.com'];
  if (name === 'range') return 'Sheet1!A2:C2';
  return 'x';
}

describe('composio-direct-overrides — catalog consistency', () => {
  const tools = catalogTools();

  it('covers only COMPOSIO_DIRECT apps, and only types the SDK actually ships', () => {
    const sdkTypes = new Set(actions.catalogActions.map((a) => a.type));
    for (const type of directOverrideTypes()) {
      expect(COMPOSIO_DIRECT_APPS.has(type.slice(0, type.indexOf('.')))).toBe(true);
      expect(sdkTypes.has(type)).toBe(true);
    }
  });

  it('every override names a real catalog tool, maps only real arguments, and satisfies the required ones', () => {
    for (const type of directOverrideTypes()) {
      const override = directOverride(type);
      if (!override) continue; // null = deliberately unsupported

      const tool = tools.get(override.toolSlug);
      expect(tool).toBeDefined(); // the pinned slug exists in the built catalog

      // Sample props: every prop of OUR action filled with a plausible value.
      const action = actions.catalogActions.find((a) => a.type === type)!;
      const manifest = action.toManifest();
      const props: Record<string, unknown> = {};
      for (const [name, prop] of Object.entries(manifest.props)) {
        props[name] = sampleValue(prop.type, name);
      }

      const args = override.toArguments(props);
      const paramNames = new Set(Object.keys(tool!.params));
      for (const key of Object.keys(args)) {
        expect(paramNames.has(key)).toBe(true); // no invented argument names
      }
      for (const [name, param] of Object.entries(tool!.params)) {
        if (param.required && name !== 'user_id') {
          expect(Object.keys(args)).toContain(name); // required args all covered
        }
      }
    }
  });

  it('no override leaves a frozen-clock default to the tool, even with every optional prop unset', () => {
    for (const type of directOverrideTypes()) {
      const override = directOverride(type);
      if (!override) continue;
      const sent = new Set(Object.keys(override.toArguments({})));
      const leftToTool = frozenClockArguments(override.toolSlug).filter((name) => !sent.has(name));
      expect({ type, leftToTool }).toEqual({ type, leftToTool: [] });
    }
  });

  it("the tool defaults an override relies on are the SDK action's own values", () => {
    const recorded = (slug: string, name: string): unknown =>
      (tools.get(slug)!.params[name] as { default?: unknown } | undefined)?.default;
    // No end time → the tool's default length; the SDK action's is start + 30 minutes.
    expect(recorded('GOOGLECALENDAR_CREATE_EVENT', 'event_duration_hour')).toBe(0);
    expect(recorded('GOOGLECALENDAR_CREATE_EVENT', 'event_duration_minutes')).toBe(30);
    // Gmail's own default, which the SDK action never overrides.
    expect(recorded('GMAIL_FETCH_EMAILS', 'include_spam_trash')).toBe(false);
  });

  it('marks the known-unmappable actions as unsupported (never a silently wrong tool)', () => {
    expect(directOverride('docs.append_text')).toBeNull();
    expect(directOverride('calendar.google_calendar_get_event_by_id')).toBeNull();
    expect(directOverride('slack.listUsers')).toBeUndefined(); // non-direct apps stay on the matcher
  });
});

describe('composio-direct-overrides — argument mapping', () => {
  it('gmail.send_email: to → recipient_email; comma lists become address arrays', () => {
    const args = directOverride('gmail.send_email')!.toArguments({
      to: 'a@x.com',
      subject: 's',
      body: 'b',
      cc: 'c1@x.com, c2@x.com',
      bcc: '',
    });
    expect(args).toEqual({
      recipient_email: 'a@x.com',
      subject: 's',
      body: 'b',
      cc: ['c1@x.com', 'c2@x.com'],
    });
  });

  it('gmail.gmail_search_mail: composes the SDK query grammar; the label id rides label_ids', () => {
    const args = directOverride('gmail.gmail_search_mail')!.toArguments({
      from: 'boss@corp.com',
      subject: 'quarterly report',
      query: 'is:unread',
      label: 'Label_42',
      max: 10,
    });
    expect(args).toEqual({
      query: 'from:boss@corp.com subject:"quarterly report" is:unread',
      label_ids: ['Label_42'],
      max_results: 10,
      ids_only: true,
    });
  });

  it('gmail.list_messages: labelIds multi-select and limit map to label_ids / max_results', () => {
    expect(
      directOverride('gmail.list_messages')!.toArguments({ labelIds: ['INBOX', 'UNREAD'], limit: 7 }),
    ).toEqual({ label_ids: ['INBOX', 'UNREAD'], max_results: 7, ids_only: true });
  });

  it('sheets.read_range wraps the single range; sheets.update_row parses A1 into sheet + first cell', () => {
    expect(
      directOverride('sheets.read_range')!.toArguments({ spreadsheetId: 'S', range: 'Tab!A1:B2' }),
    ).toEqual({ spreadsheet_id: 'S', ranges: ['Tab!A1:B2'] });
    expect(
      directOverride('sheets.update_row')!.toArguments({
        spreadsheetId: 'S',
        range: "'My Tab'!B2:C3",
        values: ['x', 'y'], // a flat row becomes one-row 2D
      }),
    ).toEqual({
      spreadsheet_id: 'S',
      sheet_name: 'My Tab',
      first_cell_location: 'B2',
      values: [['x', 'y']],
      valueInputOption: 'USER_ENTERED',
    });
  });

  it('calendar.create_google_calendar_event derives the duration args from start/end', () => {
    const args = directOverride('calendar.create_google_calendar_event')!.toArguments({
      calendarId: 'primary',
      title: 'Standup',
      start: '2026-07-12T10:00:00Z',
      end: '2026-07-12T11:30:00Z',
    });
    expect(args).toEqual({
      calendar_id: 'primary',
      summary: 'Standup',
      start_datetime: '2026-07-12T10:00:00Z',
      event_duration_hour: 1,
      event_duration_minutes: 30,
    });
    // No end → no duration args (the tool's default applies).
    const noEnd = directOverride('calendar.create_google_calendar_event')!.toArguments({
      calendarId: 'primary',
      title: 'S',
      start: '2026-07-12T10:00:00Z',
    });
    expect(noEnd).not.toHaveProperty('event_duration_hour');
  });

  it('calendar.google_calendar_get_events sends the SDK request and never leaves a bound to the tool', () => {
    const list = directOverride('calendar.google_calendar_get_events')!;
    expect(list.toArguments({ calendarId: 'primary' })).toEqual({
      calendarId: 'primary',
      timeMin: '1970-01-01T00:00:00Z',
      timeMax: '9999-12-31T23:59:59Z',
      singleEvents: true,
      orderBy: 'startTime',
    });
    expect(
      list.toArguments({
        calendarId: 'team@example.com',
        timeMin: '2026-09-30T00:00:00Z',
        timeMax: '2026-10-07T00:00:00Z',
        query: 'standup',
        limit: 10,
      }),
    ).toEqual({
      calendarId: 'team@example.com',
      timeMin: '2026-09-30T00:00:00Z',
      timeMax: '2026-10-07T00:00:00Z',
      q: 'standup',
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 10,
    });
    // A cleared field is unset, not an empty bound.
    expect(list.toArguments({ calendarId: 'primary', timeMin: '  ', timeMax: '' })).toMatchObject({
      timeMin: '1970-01-01T00:00:00Z',
      timeMax: '9999-12-31T23:59:59Z',
    });
  });

  it('docs.create_document supplies the tool-required empty text', () => {
    expect(directOverride('docs.create_document')!.toArguments({ title: 'T' })).toEqual({
      title: 'T',
      text: '',
    });
  });

  it('drive.list_files asks what the SDK action asks: live files, newest first, shared drives included', () => {
    const list = directOverride('drive.list_files')!;
    const always = {
      orderBy: 'modifiedTime desc',
      fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink,parents)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    };
    expect(list.toArguments({ limit: 3 })).toEqual({ q: 'trashed=false', pageSize: 3, ...always });
    // A query the user wrote is passed through verbatim — it replaces the default filter, as on the SDK rail.
    expect(list.toArguments({ query: "name contains 'x'", limit: 3 })).toEqual({
      q: "name contains 'x'",
      pageSize: 3,
      ...always,
    });
    expect(list.toArguments({ query: '   ' })).toMatchObject({ q: 'trashed=false' });
  });

  it('drive.create_folder: folder name/parent → folder_name/parent_id', () => {
    expect(directOverride('drive.create_folder')!.toArguments({ name: 'Reports', parentId: 'root' })).toEqual(
      { folder_name: 'Reports', parent_id: 'root' },
    );
  });

  it('sheets.insert_row inserts rows instead of writing over what sits below the table, as the SDK action does', async () => {
    const props = { spreadsheetId: 's1', range: 'Sheet1!A1:B3', values: [['c', 3]] };
    const sent = directOverride('sheets.insert_row')!.toArguments(props);
    expect(sent).toEqual({ ...props, valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' });

    // The two choices the SDK action puts on its own request, read off that request rather than copied.
    const recorded = await sdkRequest('sheets.insert_row', props);
    expect(recorded.query).toEqual({
      valueInputOption: sent.valueInputOption,
      insertDataOption: sent.insertDataOption,
    });
  });
});

/** Run an SDK action for real against a transport that records its one request instead of sending it. */
async function sdkRequest(type: string, props: Record<string, unknown>): Promise<RequestOptions> {
  const requests: RequestOptions[] = [];
  class Recorder extends HttpClient {
    override request<T = unknown>(
      _method: HttpMethod,
      _url: string,
      options: RequestOptions,
    ): Promise<HttpResponse<T>> {
      requests.push(options);
      return Promise.resolve({ status: 200, headers: {}, data: { updates: {} } as T });
    }
  }
  const auth = createDirectAuth(sdkAction(type)!.auth, { type: 'bearer', token: 'not-a-real-token' });
  await sdkAction(type)!.execute({ auth, props, http: new Recorder() });
  expect(requests).toHaveLength(1);
  return requests[0]!;
}
