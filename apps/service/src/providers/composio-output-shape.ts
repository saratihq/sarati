import { isRecord } from '../common/json-util';

/**
 * One output shape per action, whichever rail ran it.
 *
 * A Google app on a MANAGED connection executes via Composio ahead of our own SDK action
 * (`COMPOSIO_DIRECT_APPS` — Google rejects the SDK's proxy leg), so the same `sheets.read_range`
 * answers in the SDK's shape for a bring-your-own connection and in Composio's for a managed one.
 * The catalog only ever documented the first, so `{{step.values}}` silently resolved to nothing for
 * half of all users — with no error, because a reference that finds nothing is not a failure.
 *
 * These mappings translate BACK to the documented shape. Every entry is derived from a response
 * observed live; an action with no entry is passed through untouched rather than guessed at, so a
 * wrong mapping can never invent data that was never there.
 */

/** Composio wraps an upstream body in `response_data`; that envelope is theirs, not the API's. */
function unwrapEnvelope(raw: unknown): unknown {
  return isRecord(raw) && isRecord(raw.response_data) ? raw.response_data : raw;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** `sheets.create_spreadsheet` → `{ spreadsheetId, title, spreadsheetUrl? }`. */
function createSpreadsheet(raw: unknown): unknown {
  const body = unwrapEnvelope(raw);
  if (!isRecord(body)) return raw;
  const id = str(body.spreadsheet_id) ?? str(body.spreadsheetId);
  if (!id) return raw;
  const properties = isRecord(body.properties) ? body.properties : {};
  const title = str(body.title) ?? str(properties.title);
  const url = str(body.spreadsheet_url) ?? str(body.spreadsheetUrl);
  return {
    spreadsheetId: id,
    ...(title !== undefined ? { title } : {}),
    ...(url !== undefined ? { spreadsheetUrl: url } : {}),
  };
}

/** `sheets.read_range` → `{ values }`, flattening Composio's `valueRanges` array. */
function readRange(raw: unknown): unknown {
  const body = unwrapEnvelope(raw);
  if (!isRecord(body)) return raw;
  if (Array.isArray(body.values)) return body; // already the documented shape
  const ranges = body.valueRanges ?? body.value_ranges;
  if (!Array.isArray(ranges)) return raw;
  const first = ranges.find(isRecord);
  const values = first && Array.isArray(first.values) ? first.values : [];
  return { ...body, values };
}

/** `sheets.list_sheets` → `{ sheets, count }`. */
function listSheets(raw: unknown): unknown {
  const body = unwrapEnvelope(raw);
  if (!isRecord(body) || !Array.isArray(body.sheets)) return raw;
  return { sheets: body.sheets, count: body.sheets.length };
}

const SHAPES: ReadonlyMap<string, (raw: unknown) => unknown> = new Map([
  ['sheets.create_spreadsheet', createSpreadsheet],
  ['sheets.read_range', readRange],
  ['sheets.list_sheets', listSheets],
]);

/** The action's documented output, from whatever the Composio rail returned. Unknown types pass through. */
export function alignComposioOutput(actionId: string, raw: unknown): unknown {
  const shape = SHAPES.get(actionId);
  return shape ? shape(raw) : raw;
}

/** Action types with a mapping — the spec asserts each is one our own SDK also implements. */
export const ALIGNED_ACTION_TYPES: readonly string[] = [...SHAPES.keys()];
