/**
 * Curated action → Composio tool overrides for the COMPOSIO-DIRECT apps, where the generic name-matcher
 * misroutes or drops load-bearing props. A correction layer, not a parallel catalog: actions the matcher
 * already resolves are NOT listed, and `null` marks an action with no faithful equivalent (→ honest 400).
 */

export interface DirectToolOverride {
  /** Exact Composio tool slug (as in the live v3 catalog / the prebuilt file). */
  toolSlug: string;
  /** OUR props → the tool's arguments. Pure; nullish props are omitted. */
  toArguments(props: Record<string, unknown>): Record<string, unknown>;
}

/** Drop nullish values so optional props never reach the tool as null. */
function compact(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

/** Mirror the SDK's Gmail query grammar (quote terms containing whitespace). */
function quoteIfNeeded(value: string): string {
  const trimmed = value.trim();
  return /\s/.test(trimmed) ? `"${trimmed}"` : trimmed;
}

/** from/to/subject/raw-query → one Gmail search string (the SDK's buildSearchQuery). */
function gmailSearchQuery(props: Record<string, unknown>): string | undefined {
  const terms: string[] = [];
  if (typeof props.from === 'string' && props.from) terms.push(`from:${quoteIfNeeded(props.from)}`);
  if (typeof props.to === 'string' && props.to) terms.push(`to:${quoteIfNeeded(props.to)}`);
  if (typeof props.subject === 'string' && props.subject) {
    terms.push(`subject:${quoteIfNeeded(props.subject)}`);
  }
  if (typeof props.query === 'string' && props.query) terms.push(props.query.trim());
  const query = terms.join(' ').trim();
  return query || undefined;
}

/** A single label id (the SDK label dropdown's value) → the tool's `label_ids` array. */
function labelIdList(value: unknown): string[] | undefined {
  if (typeof value === 'string' && value) return [value];
  if (Array.isArray(value) && value.length > 0) return value.map(String);
  return undefined;
}

/** A comma-separated address string (or an array) → the tool's address array. */
function emailList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.length > 0 ? value.map(String) : undefined;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `values` as rows: a flat row (array of cells) becomes one-row 2D; 2D passes through. */
function rows2d(value: unknown): unknown[][] | undefined {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return undefined; // not JSON — let the tool reject it honestly
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  return Array.isArray(parsed[0]) ? (parsed as unknown[][]) : [parsed];
}

/** `Sheet1!A2:C2` → the BATCH_UPDATE shape: sheet name + first cell (quotes stripped). */
function parseA1(range: unknown): { sheetName?: string; firstCell?: string } {
  if (typeof range !== 'string' || !range) return {};
  const bang = range.indexOf('!');
  if (bang < 0) return { sheetName: range.replace(/^'|'$/g, '') };
  const sheetName = range.slice(0, bang).replace(/^'|'$/g, '');
  const cells = range.slice(bang + 1);
  const firstCell = cells.split(':')[0];
  return { sheetName, ...(firstCell ? { firstCell } : {}) };
}

/** RFC3339 start/end → CREATE_EVENT's duration args (omitted when underivable). */
function eventDuration(start: unknown, end: unknown): Record<string, unknown> {
  if (typeof start !== 'string' || typeof end !== 'string') return {};
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return {};
  const minutes = Math.round((endMs - startMs) / 60_000);
  return { event_duration_hour: Math.floor(minutes / 60), event_duration_minutes: minutes % 60 };
}

const OVERRIDES = new Map<string, DirectToolOverride | null>([
  [
    'gmail.list_messages',
    {
      toolSlug: 'GMAIL_FETCH_EMAILS',
      toArguments: (p) =>
        compact({ query: p.query, label_ids: labelIdList(p.labelIds), max_results: p.limit }),
    },
  ],
  [
    'gmail.gmail_search_mail',
    {
      toolSlug: 'GMAIL_FETCH_EMAILS',
      toArguments: (p) =>
        compact({
          query: gmailSearchQuery(p),
          label_ids: labelIdList(p.label), // the SDK dropdown's value IS the label id
          max_results: p.max,
        }),
    },
  ],
  [
    'gmail.gmail_get_mail',
    {
      toolSlug: 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
      toArguments: (p) => compact({ message_id: p.messageId, format: p.format }),
    },
  ],
  [
    'gmail.send_email',
    {
      toolSlug: 'GMAIL_SEND_EMAIL',
      toArguments: (p) =>
        compact({
          recipient_email: p.to,
          subject: p.subject,
          body: p.body,
          cc: emailList(p.cc),
          bcc: emailList(p.bcc),
        }),
    },
  ],
  [
    'gmail.create_draft',
    {
      toolSlug: 'GMAIL_CREATE_EMAIL_DRAFT',
      toArguments: (p) => compact({ recipient_email: p.to, subject: p.subject, body: p.body }),
    },
  ],
  [
    'sheets.create_spreadsheet',
    { toolSlug: 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1', toArguments: (p) => compact({ title: p.title }) },
  ],
  [
    'sheets.read_range',
    {
      toolSlug: 'GOOGLESHEETS_BATCH_GET',
      toArguments: (p) =>
        compact({
          spreadsheet_id: p.spreadsheetId,
          ranges: typeof p.range === 'string' && p.range ? [p.range] : undefined,
        }),
    },
  ],
  [
    'sheets.insert_row',
    {
      toolSlug: 'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND',
      toArguments: (p) =>
        compact({
          spreadsheetId: p.spreadsheetId,
          range: p.range,
          values: rows2d(p.values),
          valueInputOption: 'USER_ENTERED', // required by the tool; matches the SDK's write mode
        }),
    },
  ],
  [
    'sheets.update_row',
    {
      toolSlug: 'GOOGLESHEETS_BATCH_UPDATE',
      toArguments: (p) => {
        const { sheetName, firstCell } = parseA1(p.range);
        return compact({
          spreadsheet_id: p.spreadsheetId,
          sheet_name: sheetName,
          first_cell_location: firstCell,
          values: rows2d(p.values),
          valueInputOption: p.valueInputOption ?? 'USER_ENTERED',
        });
      },
    },
  ],
  [
    'sheets.clear_sheet',
    {
      toolSlug: 'GOOGLESHEETS_CLEAR_VALUES',
      toArguments: (p) => compact({ spreadsheet_id: p.spreadsheetId, range: p.range }),
    },
  ],
  [
    'docs.create_document',
    {
      toolSlug: 'GOOGLEDOCS_CREATE_DOCUMENT',
      // The tool REQUIRES text; our action creates an empty titled document.
      toArguments: (p) => compact({ title: p.title, text: '' }),
    },
  ],
  [
    'docs.read_document',
    { toolSlug: 'GOOGLEDOCS_GET_DOCUMENT_BY_ID', toArguments: (p) => compact({ id: p.documentId }) },
  ],
  // No faithful equivalent: appending needs the document's end index, which the tool requires as an input.
  ['docs.append_text', null],
  [
    'calendar.create_google_calendar_event',
    {
      toolSlug: 'GOOGLECALENDAR_CREATE_EVENT',
      toArguments: (p) =>
        compact({
          calendar_id: p.calendarId,
          summary: p.title,
          start_datetime: p.start,
          description: p.description,
          location: p.location,
          attendees: p.attendees,
          ...eventDuration(p.start, p.end), // the tool takes a duration, not an end time
        }),
    },
  ],
  [
    'calendar.google_calendar_get_events',
    {
      toolSlug: 'GOOGLECALENDAR_EVENTS_LIST',
      toArguments: (p) =>
        compact({
          calendarId: p.calendarId,
          timeMin: p.timeMin,
          timeMax: p.timeMax,
          q: p.query,
          maxResults: p.limit,
        }),
    },
  ],
  // The toolkit has NO get-one-event tool; the matcher would silently return the CALENDAR object instead.
  ['calendar.google_calendar_get_event_by_id', null],
  [
    'calendar.update_event',
    {
      // PATCH, not UPDATE — UPDATE_EVENT requires start_datetime, which a partial update may not carry.
      toolSlug: 'GOOGLECALENDAR_PATCH_EVENT',
      toArguments: (p) =>
        compact({
          calendar_id: p.calendarId,
          event_id: p.eventId,
          summary: p.title,
          start_time: p.start,
          end_time: p.end,
          location: p.location,
          description: p.description,
        }),
    },
  ],
  [
    'drive.list_files',
    {
      toolSlug: 'GOOGLEDRIVE_LIST_FILES',
      toArguments: (p) => compact({ q: p.query, pageSize: p.limit }),
    },
  ],
  [
    'drive.create_folder',
    {
      toolSlug: 'GOOGLEDRIVE_CREATE_FOLDER',
      toArguments: (p) => compact({ folder_name: p.name, parent_id: p.parentId }),
    },
  ],
]);

/** A tool mapping, `null` for a known-unmappable action (honest 400), or `undefined` → the generic matcher resolves it. */
export function directOverride(publicType: string): DirectToolOverride | null | undefined {
  return OVERRIDES.get(publicType);
}

/** Every overridden type — the catalog-consistency spec's input. */
export function directOverrideTypes(): ReadonlySet<string> {
  return new Set(OVERRIDES.keys());
}
