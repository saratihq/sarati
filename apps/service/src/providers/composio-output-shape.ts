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
type Profile = Awaited<ReturnType<typeof actions.gmail.getProfile.execute>>;
type Labels = Awaited<ReturnType<typeof actions.gmail.listLabels.execute>>;
type Label = Labels['labels'][number];
type Messages = Awaited<ReturnType<typeof actions.gmail.listMessages.execute>>;
type MessageRef = Messages['messages'][number];
type Calendars = Awaited<ReturnType<typeof actions.calendar.listCalendars.execute>>;
type CalendarEntry = Calendars['calendars'][number];
type Event = Awaited<ReturnType<typeof actions.calendar.createEvent.execute>>;
type Events = Awaited<ReturnType<typeof actions.calendar.listEvents.execute>>;
type Deleted = Awaited<ReturnType<typeof actions.calendar.deleteEvent.execute>>;

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

function gmailProfile(raw: unknown): Profile | null {
  const body = unwrapComposioEnvelope(raw);
  if (!isRecord(body)) return null;
  const emailAddress = str(body.emailAddress);
  const historyId =
    str(body.historyId) ?? (num(body.historyId) !== undefined ? String(body.historyId) : undefined);
  const messagesTotal = num(body.messagesTotal);
  const threadsTotal = num(body.threadsTotal);
  if (emailAddress === undefined || historyId === undefined) return null;
  if (messagesTotal === undefined || threadsTotal === undefined) return null;
  return { emailAddress, messagesTotal, threadsTotal, historyId };
}

/** The picker's rows: an id and a name, not Gmail's visibility flags. */
function labelOf(entry: unknown): Label | null {
  if (!isRecord(entry)) return null;
  const id = str(entry.id);
  const name = str(entry.name);
  if (id === undefined || name === undefined) return null;
  const type = str(entry.type);
  return { id, name, ...(type !== undefined ? { type } : {}) };
}

function gmailLabels(raw: unknown): Labels | null {
  const body = unwrapComposioEnvelope(raw);
  if (!isRecord(body) || !Array.isArray(body.labels)) return null;
  const labels = body.labels.map(labelOf).filter((label): label is Label => label !== null);
  return labels.length > 0 ? { labels, count: labels.length } : null;
}

/** Composio names the id `messageId`; the action declares `id`, and a ref is only id + thread. */
function messageRefOf(entry: unknown): MessageRef | null {
  if (!isRecord(entry)) return null;
  const id = str(entry.id) ?? str(entry.messageId);
  const threadId = str(entry.threadId) ?? str(entry.thread_id);
  return id !== undefined && threadId !== undefined ? { id, threadId } : null;
}

function gmailMessages(raw: unknown): Messages | null {
  const body = unwrapComposioEnvelope(raw);
  if (!isRecord(body) || !Array.isArray(body.messages)) return null;
  const messages = body.messages.map(messageRefOf).filter((ref): ref is MessageRef => ref !== null);
  return messages.length === body.messages.length ? { messages, count: messages.length } : null;
}

function calendarEntryOf(entry: unknown): CalendarEntry | null {
  if (!isRecord(entry)) return null;
  const id = str(entry.id);
  const summary = str(entry.summary);
  if (id === undefined || summary === undefined) return null;
  const description = str(entry.description);
  const accessRole = str(entry.accessRole);
  const timeZone = str(entry.timeZone);
  return {
    id,
    summary,
    ...(description !== undefined ? { description } : {}),
    ...(entry.primary === true ? { primary: true } : {}),
    ...(accessRole !== undefined ? { accessRole } : {}),
    ...(timeZone !== undefined ? { timeZone } : {}),
  };
}

function calendarList(raw: unknown): Calendars | null {
  const body = unwrapComposioEnvelope(raw);
  if (!isRecord(body) || !Array.isArray(body.calendars)) return null;
  const calendars = body.calendars
    .map(calendarEntryOf)
    .filter((entry): entry is CalendarEntry => entry !== null);
  return calendars.length > 0 ? { calendars, count: calendars.length } : null;
}

/** Google's Event resource carries etag/kind/sequence the action does not declare. */
function eventOf(entry: unknown): Event | null {
  if (!isRecord(entry)) return null;
  const id = str(entry.id);
  if (id === undefined) return null;
  const pick = (key: string): Record<string, string> => {
    const value = str(entry[key]);
    return value !== undefined ? { [key]: value } : {};
  };
  const object = (key: string): Record<string, unknown> =>
    isRecord(entry[key]) ? { [key]: entry[key] } : {};
  return {
    id,
    ...pick('status'),
    ...pick('htmlLink'),
    ...pick('summary'),
    ...pick('description'),
    ...pick('location'),
    ...pick('created'),
    ...pick('updated'),
    ...pick('recurringEventId'),
    ...object('start'),
    ...object('end'),
    ...object('organizer'),
    ...(Array.isArray(entry.attendees) ? { attendees: entry.attendees } : {}),
  };
}

function calendarEvent(raw: unknown): Event | null {
  return eventOf(unwrapComposioEnvelope(raw));
}

/** The events list answers with Google's `items`; the action declares `events` and a count. */
function calendarEvents(raw: unknown): Events | null {
  const body = unwrapComposioEnvelope(raw);
  if (!isRecord(body) || !Array.isArray(body.items)) return null;
  const events = body.items.map(eventOf).filter((event): event is Event => event !== null);
  return events.length === body.items.length ? { events, count: events.length } : null;
}

/** Composio answers `{status: "success"}`; the action declares which event went. */
function calendarDeleted(raw: unknown, props: Props): Deleted | null {
  const body = unwrapComposioEnvelope(raw);
  const eventId = str(props.eventId);
  if (!isRecord(body) || eventId === undefined) return null;
  const status = str(body.status);
  if (status !== 'success' && body.deleted !== true) return null;
  return { deleted: true, eventId };
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
  ['gmail.get_profile', gmailProfile],
  ['gmail.list_labels', gmailLabels],
  ['gmail.list_messages', gmailMessages],
  ['calendar.list_calendars', calendarList],
  ['calendar.create_google_calendar_event', calendarEvent],
  ['calendar.update_event', calendarEvent],
  ['calendar.google_calendar_get_events', calendarEvents],
  ['calendar.delete_event', calendarDeleted],
]);

/** The action's documented output, from whatever the Composio rail returned. Unmapped types pass through. */
export function alignComposioOutput(actionId: string, raw: unknown, props: Props): unknown {
  const shape = SHAPES.get(actionId);
  if (!shape) return raw;
  return shape(raw, props) ?? raw;
}

/** Action types with a mapping; the spec holds the full dual-rail inventory each one is classified in. */
export const ALIGNED_ACTION_TYPES: readonly string[] = [...SHAPES.keys()];
