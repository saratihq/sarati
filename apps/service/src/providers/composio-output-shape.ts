import { actions } from '@sarati/actions-sdk';

import { isRecord } from '../common/json-util';

/**
 * One output shape per action, whichever rail ran it.
 *
 * A Google app on a MANAGED connection executes via Composio ahead of our own SDK action
 * (`COMPOSIO_DIRECT_APPS`), and the two rails call DIFFERENT upstream endpoints — `values.get` vs
 * `values.batchGet`, `values.update` vs `values.batchUpdate` — so a step answers in a different
 * shape depending only on how the user connected. The catalog documents the SDK's, so
 * `{{step.values}}` silently resolved to nothing for half of all users.
 *
 * Each shaper's return type IS the SDK action's declared output, so a mapping that drifts from the
 * contract fails the typecheck instead of resolving a `{{ref}}` to nothing. A shaper returns null
 * when the body is not what we observed live, and the raw output passes through untouched — an
 * action Composio answers too thinly to satisfy the contract must never be half-built into it.
 */

type ReadRange = Awaited<ReturnType<typeof actions.sheets.readRange.execute>>;
type Created = Awaited<ReturnType<typeof actions.sheets.createSpreadsheet.execute>>;
type Appended = Awaited<ReturnType<typeof actions.sheets.insertRow.execute>>;
type Updated = Awaited<ReturnType<typeof actions.sheets.updateRow.execute>>;
type Tabs = Awaited<ReturnType<typeof actions.sheets.listSheets.execute>>;
type Tab = Tabs['sheets'][number];
type Listing = Awaited<ReturnType<typeof actions.drive.listFiles.execute>>;
type DriveFile = Awaited<ReturnType<typeof actions.drive.getFile.execute>>;
type Rows = NonNullable<ReadRange['values']>;

type Props = Record<string, unknown>;
type Shaper = (raw: unknown, props: Props) => object | null;

/** Composio wraps an upstream body in `response_data`; that envelope is theirs, not the API's. */
export function unwrapComposioEnvelope(raw: unknown): unknown {
  return isRecord(raw) && isRecord(raw.response_data) ? raw.response_data : raw;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function rowsOf(value: unknown): Rows | undefined {
  return Array.isArray(value) && value.every((row) => Array.isArray(row)) ? (value as Rows) : undefined;
}

/** `values.batchGet` answers with a `valueRanges` array; the SDK's `values.get` answers with the range itself. */
function readRange(raw: unknown, props: Props): ReadRange | null {
  const body = unwrapComposioEnvelope(raw);
  if (!isRecord(body)) return null;
  const ranges = body.valueRanges ?? body.value_ranges;
  const first = Array.isArray(ranges) ? ranges.find(isRecord) : undefined;
  if (!first) return null;
  const range = str(first.range) ?? str(props.range);
  if (range === undefined) return null;
  const majorDimension = str(first.majorDimension);
  const values = rowsOf(first.values);
  return {
    range,
    ...(majorDimension !== undefined ? { majorDimension } : {}),
    ...(values !== undefined ? { values } : {}),
  };
}

function createSpreadsheet(raw: unknown, props: Props): Created | null {
  const body = unwrapComposioEnvelope(raw);
  if (!isRecord(body)) return null;
  const spreadsheetId = str(body.spreadsheet_id) ?? str(body.spreadsheetId);
  const properties = isRecord(body.properties) ? body.properties : {};
  const title = str(body.title) ?? str(properties.title) ?? str(props.title);
  if (spreadsheetId === undefined || title === undefined) return null;
  const spreadsheetUrl = str(body.spreadsheet_url) ?? str(body.spreadsheetUrl);
  return { spreadsheetId, title, ...(spreadsheetUrl !== undefined ? { spreadsheetUrl } : {}) };
}

/** Insert and update declare the same written-cells block; `totals` is the batch response's roll-up. */
function writeResult(
  source: Record<string, unknown>,
  totals: Record<string, unknown>,
  props: Props,
): Appended | null {
  const spreadsheetId = str(source.spreadsheetId) ?? str(totals.spreadsheetId) ?? str(props.spreadsheetId);
  // Composio's batch response nulls the resolved range; the range the step asked for is the only honest stand-in.
  const updatedRange = str(source.updatedRange) ?? str(props.range);
  const updatedRows = num(source.updatedRows) ?? num(totals.totalUpdatedRows);
  const updatedColumns = num(source.updatedColumns) ?? num(totals.totalUpdatedColumns);
  const updatedCells = num(source.updatedCells) ?? num(totals.totalUpdatedCells);
  if (spreadsheetId === undefined || updatedRange === undefined) return null;
  if (updatedRows === undefined || updatedColumns === undefined || updatedCells === undefined) {
    return null;
  }
  return { spreadsheetId, updatedRange, updatedRows, updatedColumns, updatedCells };
}

function insertRow(raw: unknown, props: Props): Appended | null {
  const body = unwrapComposioEnvelope(raw);
  if (!isRecord(body)) return null;
  return writeResult(isRecord(body.updates) ? body.updates : body, body, props);
}

function updateRow(raw: unknown, props: Props): Updated | null {
  const body = unwrapComposioEnvelope(raw);
  if (!isRecord(body)) return null;
  const batch = isRecord(body.spreadsheet) ? body.spreadsheet : body;
  const first = Array.isArray(batch.responses) ? batch.responses.find(isRecord) : undefined;
  return writeResult(first ?? batch, batch, props);
}

/** The spreadsheet body carries each tab under `sheets[].properties`; the SDK returns the properties themselves. */
function tabOf(entry: unknown): Tab | null {
  const source = isRecord(entry) && isRecord(entry.properties) ? entry.properties : entry;
  if (!isRecord(source)) return null;
  const sheetId = num(source.sheetId) ?? num(source.sheet_id);
  const title = str(source.title);
  const index = num(source.index) ?? 0;
  return sheetId !== undefined && title !== undefined ? { sheetId, title, index } : null;
}

function listSheets(raw: unknown): Tabs | null {
  const body = unwrapComposioEnvelope(raw);
  if (!isRecord(body) || !Array.isArray(body.sheets)) return null;
  const sheets = body.sheets.map(tabOf).filter((tab): tab is Tab => tab !== null);
  return sheets.length > 0 ? { sheets, count: sheets.length } : null;
}

/** Drive answers with the API's own envelope (`kind`, `incompleteSearch`); the action declares the metadata itself. */
function driveFile(entry: unknown): DriveFile | null {
  if (!isRecord(entry)) return null;
  const id = str(entry.id);
  const name = str(entry.name);
  const mimeType = str(entry.mimeType) ?? str(entry.mime_type);
  if (id === undefined || name === undefined || mimeType === undefined) return null;
  const modifiedTime = str(entry.modifiedTime) ?? str(entry.modified_time);
  const size = str(entry.size);
  const webViewLink = str(entry.webViewLink) ?? str(entry.web_view_link);
  const parents = Array.isArray(entry.parents)
    ? entry.parents.filter((p) => typeof p === 'string')
    : undefined;
  return {
    id,
    name,
    mimeType,
    ...(modifiedTime !== undefined ? { modifiedTime } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(webViewLink !== undefined ? { webViewLink } : {}),
    ...(parents !== undefined ? { parents } : {}),
  };
}

function listFiles(raw: unknown): Listing | null {
  const body = unwrapComposioEnvelope(raw);
  if (!isRecord(body) || !Array.isArray(body.files)) return null;
  const files = body.files.map(driveFile).filter((file): file is DriveFile => file !== null);
  return files.length === body.files.length ? { files, count: files.length } : null;
}

function getFile(raw: unknown): DriveFile | null {
  return driveFile(unwrapComposioEnvelope(raw));
}

const SHAPES: ReadonlyMap<string, Shaper> = new Map<string, Shaper>([
  ['sheets.create_spreadsheet', createSpreadsheet],
  ['sheets.read_range', readRange],
  ['sheets.insert_row', insertRow],
  ['sheets.update_row', updateRow],
  ['sheets.list_sheets', listSheets],
  ['drive.list_files', listFiles],
  ['drive.get_file', getFile],
  ['drive.create_folder', getFile],
]);

/** The action's documented output, from whatever the Composio rail returned. Unmapped types pass through. */
export function alignComposioOutput(actionId: string, raw: unknown, props: Props): unknown {
  const shape = SHAPES.get(actionId);
  if (!shape) return raw;
  return shape(raw, props) ?? raw;
}

/** Action types with a mapping; the spec holds the full dual-rail inventory each one is classified in. */
export const ALIGNED_ACTION_TYPES: readonly string[] = [...SHAPES.keys()];
