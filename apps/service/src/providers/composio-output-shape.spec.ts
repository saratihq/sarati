import { actions } from '@sarati/actions-sdk';

import { COMPOSIO_DIRECT_APPS, FALLBACK_ONLY_APPS } from '../connections/managed-app-rails';
import { alignComposioOutput, ALIGNED_ACTION_TYPES } from './composio-output-shape';

/**
 * The rail a step lands on is invisible to whoever wrote it, so it must not change what the step
 * outputs. Every fixture below is a response captured from Composio on a live managed Google
 * connection — a hand-written one proves the mapping matches itself and nothing else.
 */

const SPREADSHEET = '18T4N9Hd-7-mnfYVCldcIyNc7TlAvlJZh73l-BEAcsTw';

describe('Composio output alignment', () => {
  it("create_spreadsheet: the id survives Composio's envelope and snake_case", () => {
    const live = {
      response_data: {
        spreadsheet_id: SPREADSHEET,
        sheets: [{ properties: { index: 0, sheetId: 0, sheetType: 'GRID', title: 'Sheet1' } }],
      },
    };
    expect(alignComposioOutput('sheets.create_spreadsheet', live, { title: 'Mentions' })).toEqual({
      spreadsheetId: SPREADSHEET,
      title: 'Mentions',
    });
  });

  it('read_range: the batchGet envelope becomes the range itself, with nothing foreign left on it', () => {
    const live = {
      spreadsheetId: SPREADSHEET,
      valueRanges: [
        { majorDimension: 'ROWS', range: 'Sheet1!A1:B2', values: [['logged_at'], ['2026-08-18']] },
      ],
    };
    expect(alignComposioOutput('sheets.read_range', live, { range: 'Sheet1!A1:B2' })).toEqual({
      range: 'Sheet1!A1:B2',
      majorDimension: 'ROWS',
      values: [['logged_at'], ['2026-08-18']],
    });
  });

  it('insert_row: the written-cells block comes out from under `updates`', () => {
    const live = {
      spreadsheetId: SPREADSHEET,
      updates: {
        spreadsheetId: SPREADSHEET,
        updatedCells: 1,
        updatedColumns: 1,
        updatedRange: 'Sheet1!Z1',
        updatedRows: 1,
      },
    };
    expect(alignComposioOutput('sheets.insert_row', live, { range: 'Sheet1!Z1' })).toEqual({
      spreadsheetId: SPREADSHEET,
      updatedRange: 'Sheet1!Z1',
      updatedRows: 1,
      updatedColumns: 1,
      updatedCells: 1,
    });
  });

  it('update_row: batchUpdate nulls the resolved range, so the requested one stands in', () => {
    const live = {
      spreadsheet: {
        responses: [
          {
            spreadsheetId: SPREADSHEET,
            updatedCells: 1,
            updatedColumns: 1,
            updatedRange: null,
            updatedRows: 1,
          },
        ],
        spreadsheetId: SPREADSHEET,
        totalUpdatedCells: 1,
        totalUpdatedColumns: 1,
        totalUpdatedRows: 1,
      },
    };
    expect(alignComposioOutput('sheets.update_row', live, { range: 'Sheet1!Z999' })).toEqual({
      spreadsheetId: SPREADSHEET,
      updatedRange: 'Sheet1!Z999',
      updatedRows: 1,
      updatedColumns: 1,
      updatedCells: 1,
    });
  });

  it('list_sheets: tabs carry the id and index the SDK promises, not raw `properties`', () => {
    const live = {
      response_data: {
        sheets: [
          { properties: { index: 0, sheetId: 0, sheetType: 'GRID', title: 'Sheet1' } },
          { properties: { index: 1, sheetId: 4242, sheetType: 'GRID', title: 'Log' } },
        ],
      },
    };
    expect(alignComposioOutput('sheets.list_sheets', live, {})).toEqual({
      sheets: [
        { sheetId: 0, title: 'Sheet1', index: 0 },
        { sheetId: 4242, title: 'Log', index: 1 },
      ],
      count: 2,
    });
  });

  it('drive list_files: the API envelope becomes the declared metadata plus a count', () => {
    const live = {
      files: [
        {
          id: SPREADSHEET,
          kind: 'drive#file',
          mimeType: 'application/vnd.google-apps.spreadsheet',
          name: 'Sarati — mention monitor log',
        },
      ],
      incompleteSearch: false,
      kind: 'drive#fileList',
    };
    expect(alignComposioOutput('drive.list_files', live, {})).toEqual({
      files: [
        {
          id: SPREADSHEET,
          name: 'Sarati — mention monitor log',
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
      ],
      count: 1,
    });
  });

  it("drive get_file: `kind` is the API's, not the action's", () => {
    const live = {
      id: SPREADSHEET,
      kind: 'drive#file',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      name: 'Sarati — mention monitor log',
    };
    expect(alignComposioOutput('drive.get_file', live, {})).toEqual({
      id: SPREADSHEET,
      name: 'Sarati — mention monitor log',
      mimeType: 'application/vnd.google-apps.spreadsheet',
    });
  });

  it('gmail profile: the envelope comes off and nothing else changes', () => {
    const live = {
      response_data: {
        emailAddress: 'huzefa@sarati.io',
        historyId: '3267',
        messagesTotal: 5,
        threadsTotal: 5,
      },
    };
    expect(alignComposioOutput('gmail.get_profile', live, {})).toEqual({
      emailAddress: 'huzefa@sarati.io',
      historyId: '3267',
      messagesTotal: 5,
      threadsTotal: 5,
    });
  });

  it("gmail labels: the picker's id and name, not Gmail's visibility flags, plus a count", () => {
    const live = {
      labels: [
        {
          id: 'CHAT',
          labelListVisibility: 'labelHide',
          messageListVisibility: 'hide',
          name: 'CHAT',
          type: 'system',
        },
        { id: 'SENT', name: 'SENT', type: 'system' },
      ],
    };
    expect(alignComposioOutput('gmail.list_labels', live, {})).toEqual({
      labels: [
        { id: 'CHAT', name: 'CHAT', type: 'system' },
        { id: 'SENT', name: 'SENT', type: 'system' },
      ],
      count: 2,
    });
  });

  it('gmail messages: `messageId` becomes the declared `id`, and a ref is only id + thread', () => {
    const live = {
      messages: [
        {
          attachmentList: [],
          labelIds: ['UNREAD', 'INBOX'],
          messageId: '1a01e98547b30c3e',
          messageText: 'body text',
          preview: {},
          sender: 'a@b.com',
          subject: 'hi',
          threadId: '1a01e98547b30c3e',
        },
      ],
      nextPageToken: 'x',
      resultSizeEstimate: 1,
    };
    expect(alignComposioOutput('gmail.list_messages', live, {})).toEqual({
      messages: [{ id: '1a01e98547b30c3e', threadId: '1a01e98547b30c3e' }],
      count: 1,
    });
  });

  it("calendar list: the entry the picker reads, without Google's colours and etags", () => {
    const live = {
      calendars: [
        {
          accessRole: 'owner',
          backgroundColor: '#9fe1e7',
          colorId: '14',
          conferenceProperties: { allowedConferenceSolutionTypes: ['hangoutsMeet'] },
          etag: '"abc"',
          id: 'huzefa@sarati.io',
          kind: 'calendar#calendarListEntry',
          primary: true,
          summary: 'huzefa@sarati.io',
          timeZone: 'Asia/Dubai',
        },
      ],
    };
    expect(alignComposioOutput('calendar.list_calendars', live, {})).toEqual({
      calendars: [
        {
          id: 'huzefa@sarati.io',
          summary: 'huzefa@sarati.io',
          primary: true,
          accessRole: 'owner',
          timeZone: 'Asia/Dubai',
        },
      ],
      count: 1,
    });
  });

  it('calendar create: the declared event, with the API envelope and its etag left behind', () => {
    const live = {
      response_data: {
        created: '2026-08-20T21:40:00.000Z',
        end: { dateTime: '2027-01-04T10:15:00Z' },
        etag: '"3521"',
        eventType: 'default',
        htmlLink: 'https://calendar.google.com/event?eid=x',
        iCalUID: 'x@google.com',
        id: '5f9orusra3glg6sa946d6b4rps',
        kind: 'calendar#event',
        organizer: { email: 'huzefa@sarati.io', self: true },
        sequence: 0,
        start: { dateTime: '2027-01-04T10:00:00Z' },
        status: 'confirmed',
        summary: 'Sarati shape probe',
      },
    };
    const shaped = alignComposioOutput('calendar.create_google_calendar_event', live, {}) as Record<
      string,
      unknown
    >;
    expect(shaped).toMatchObject({
      id: '5f9orusra3glg6sa946d6b4rps',
      status: 'confirmed',
      summary: 'Sarati shape probe',
      start: { dateTime: '2027-01-04T10:00:00Z' },
    });
    expect(shaped.etag).toBeUndefined();
    expect(shaped.kind).toBeUndefined();
  });

  it('calendar update answers WITHOUT the envelope, and reads the same either way', () => {
    const live = { id: 'evt-1', status: 'confirmed', summary: 'RENAMED', etag: '"9"' };
    expect(alignComposioOutput('calendar.update_event', live, {})).toEqual({
      id: 'evt-1',
      status: 'confirmed',
      summary: 'RENAMED',
    });
  });

  it('calendar delete: `{status:"success"}` becomes the id that went', () => {
    const live = { response_data: { status: 'success' } };
    expect(alignComposioOutput('calendar.delete_event', live, { eventId: 'evt-1' })).toEqual({
      deleted: true,
      eventId: 'evt-1',
    });
  });

  it("calendar events: Google's `items` becomes the declared `events`", () => {
    const live = { accessRole: 'owner', items: [{ id: 'e1', summary: 'Standup' }], kind: 'calendar#events' };
    expect(alignComposioOutput('calendar.google_calendar_get_events', live, {})).toEqual({
      events: [{ id: 'e1', summary: 'Standup' }],
      count: 1,
    });
  });

  it('passes an unmapped action through untouched rather than guessing at it', () => {
    const raw = { anything: true };
    expect(alignComposioOutput('slack.send_channel_message', raw, {})).toBe(raw);
  });

  it('never half-builds the contract out of a response that cannot satisfy it', () => {
    // The names-only body `list_sheets` used to receive: no id, no index — passing it through beats
    // inventing them, and beats an empty `sheets: []` that reads as "this spreadsheet has no tabs".
    const namesOnly = { response_data: { sheet_names: ['Sheet1'] } };
    expect(alignComposioOutput('sheets.list_sheets', namesOnly, {})).toBe(namesOnly);
    for (const type of ALIGNED_ACTION_TYPES) {
      for (const junk of [null, 'a string', 42, { unexpected: 1 }]) {
        expect(() => alignComposioOutput(type, junk, {})).not.toThrow();
      }
      expect(alignComposioOutput(type, { unexpected: 1 }, {})).toEqual({ unexpected: 1 });
    }
  });
});

/**
 * Only an action BOTH rails can run has two shapes to reconcile. Every one of them is classified
 * here, so adding an SDK action to a dual-rail app forces the same live check rather than shipping
 * a step whose output depends on how the user connected.
 */
describe('dual-rail inventory', () => {
  /** Live-checked: Composio already answers `sheets.clear_sheet` in the SDK's shape, so it needs no mapping. */
  const ALREADY_IN_CONTRACT = ['sheets.clear_sheet'];
  /** Apps whose actions have NOT been run on both rails — no live connection to check them against. */
  const UNVERIFIED_APPS = ['calendar', 'docs', 'gmail', 'intercom', 'jira', 'mailchimp', 'zendesk'];

  const appOf = (type: string): string => type.split('.')[0] ?? type;
  const dualRail = actions.catalogActions
    .map((action) => action.type)
    .filter((type) => COMPOSIO_DIRECT_APPS.has(appOf(type)) || FALLBACK_ONLY_APPS.has(appOf(type)));

  it('every action of a live-verified app is either aligned or checked to need no alignment', () => {
    const verified = dualRail.filter((type) => !UNVERIFIED_APPS.includes(appOf(type)));
    const classified = [...ALIGNED_ACTION_TYPES, ...ALREADY_IN_CONTRACT];
    expect(verified.filter((type) => !classified.includes(type))).toEqual([]);
  });

  it('names the apps still unchecked, so a new dual-rail app cannot be added silently', () => {
    const apps = [...new Set(dualRail.map((type) => type.split('.')[0]))].sort();
    expect(apps).toEqual([...UNVERIFIED_APPS, 'sheets', 'drive'].sort());
  });
});
