import { isRecord } from '../common/json-util';
import { unwrapComposioEnvelope } from '../providers/composio-output-shape';

/**
 * Composio reports whether the HTTP call succeeded, not whether the API accepted it. Slack, Notion
 * and Airtable all answer 200 with the refusal in the body, so a step that "sent" a message nobody
 * received was recorded as a success.
 *
 * Only an explicit `ok: false` / `success: false` counts — a body that merely lacks the flag says
 * nothing, and guessing would fail steps that worked.
 */
export function upstreamRejection(data: unknown): string | null {
  const body = unwrapComposioEnvelope(data);
  if (!isRecord(body)) return null;
  if (body.ok !== false && body.success !== false) return null;
  return reasonOf(body) ?? 'the API rejected the call';
}

function reasonOf(body: Record<string, unknown>): string | null {
  const nested = isRecord(body.error) ? body.error : {};
  return text(body.error) ?? text(body.message) ?? text(nested.message) ?? text(nested.code);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}
