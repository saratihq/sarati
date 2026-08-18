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
  const UNVERIFIED_APPS = ['calendar', 'docs', 'drive', 'gmail', 'intercom', 'jira', 'mailchimp', 'zendesk'];

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
    expect(apps).toEqual([...UNVERIFIED_APPS, 'sheets'].sort());
  });
});
