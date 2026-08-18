import { alignComposioOutput, ALIGNED_ACTION_TYPES } from './composio-output-shape';
import { isSdkActionType } from './sdk-actions.registry';

/**
 * The rail a step lands on is invisible to whoever wrote it, so it must not change what the step
 * outputs. Each fixture below is a response captured from Composio on a live managed connection.
 */
describe('Composio output alignment', () => {
  it('only ever maps actions our own SDK also implements — otherwise there is no documented shape to align to', () => {
    for (const type of ALIGNED_ACTION_TYPES) expect(isSdkActionType(type)).toBe(true);
  });

  it("create_spreadsheet: the id survives Composio's envelope and snake_case", () => {
    const live = {
      response_data: {
        spreadsheet_id: '18T4N9Hd-7-mnfYVCldcIyNc7TlAvlJZh73l-BEAcsTw',
        sheets: [{ properties: { title: 'Sheet1' } }],
      },
    };
    expect(alignComposioOutput('sheets.create_spreadsheet', live)).toMatchObject({
      spreadsheetId: '18T4N9Hd-7-mnfYVCldcIyNc7TlAvlJZh73l-BEAcsTw',
    });
  });

  it('read_range: `values` is reachable without knowing about valueRanges', () => {
    const live = {
      spreadsheetId: 'sheet-1',
      valueRanges: [{ range: 'Sheet1!A1:G2', values: [['logged_at'], ['2026-08-18']] }],
    };
    const out = alignComposioOutput('sheets.read_range', live) as { values: unknown[][] };
    expect(out.values).toEqual([['logged_at'], ['2026-08-18']]);
  });

  it('read_range: an already-correct SDK response is left exactly as it is', () => {
    const sdk = { values: [['a']] };
    expect(alignComposioOutput('sheets.read_range', sdk)).toEqual(sdk);
  });

  it('list_sheets: tabs plus a count', () => {
    const live = { response_data: { sheets: [{ properties: { title: 'Sheet1' } }] } };
    expect(alignComposioOutput('sheets.list_sheets', live)).toMatchObject({ count: 1 });
  });

  it('passes an unmapped action through untouched rather than guessing at it', () => {
    const raw = { anything: true };
    expect(alignComposioOutput('slack.send_channel_message', raw)).toBe(raw);
  });

  it('never invents data when the response is not the shape we expected', () => {
    for (const type of ALIGNED_ACTION_TYPES) {
      for (const junk of [null, 'a string', 42, { unexpected: 1 }]) {
        expect(() => alignComposioOutput(type, junk)).not.toThrow();
      }
      // A body with no usable id/values must come back as-is, not as a half-built object.
      expect(alignComposioOutput(type, { unexpected: 1 })).toEqual({ unexpected: 1 });
    }
  });
});
