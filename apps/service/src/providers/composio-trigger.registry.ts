import { Logger } from '@nestjs/common';

import { isRecord } from '../common/json-util';

import type { ConfiguredProps } from './managed-integration-provider';

/**
 * Composio-polled trigger registry: one spec per PUBLIC trigger type letting the {@link ActionRouterProvider} poll a
 * MANAGED-connection trigger; a trigger without a spec here is unsupported. Every entry's app slug MUST be in
 * `COMPOSIO_DIRECT_APPS` (unit-enforced). Pure module — the router owns store access, Composio calls, and cursor semantics.
 */

/** Store key of the TIMEBASED poll cursor (epoch ms); the router advances it to the newest seen event. */
export const POLL_CURSOR_KEY = 'lastPoll';

/** One fetched candidate: its event time (dedupe key) + the payload the plan sees. */
export interface ComposioTriggerItem {
  epochMilliSeconds: number;
  payload: unknown;
}

/** The picker row for a Composio-polled trigger; carried on the spec so the registry is the ONE source of mechanics + metadata. */
export interface ComposioTriggerCatalogEntry {
  name: string;
  type: string;
  category: string;
  description: string;
  parameters: Record<string, unknown>;
  auth: 'none' | 'connection';
}

export interface ComposioTriggerSpec {
  /** The picker/catalog metadata for this trigger type. */
  catalog: ComposioTriggerCatalogEntry;
  /** The exact Composio tool slug that fetches candidate items. */
  toolSlug: string;
  /** Tool arguments for one poll, from the trigger's props + the current cursor. */
  buildArguments(props: ConfiguredProps, lastPollEpochMs: number): Record<string, unknown>;
  /** Items out of the tool's `data` envelope, sorted OLDEST FIRST so events fire chronologically. */
  extractItems(data: unknown): ComposioTriggerItem[];
}

const logger = new Logger('ComposioTriggerRegistry');

// ─── gmail.gmail_new_email_received — Gmail new-mail poll ────────────────────

/** The label prop may be a dropdown OBJECT (`{name}`); accept a bare string too. */
function labelNameOf(label: unknown): string | null {
  if (typeof label === 'string' && label) return label;
  if (isRecord(label) && typeof label.name === 'string' && label.name) return label.name;
  return null;
}

/** The provider's exact query grammar: from/to/subject/label/category + after:<seconds>. */
function gmailQuery(props: ConfiguredProps, lastPollEpochMs: number): string {
  const parts: string[] = [];
  if (typeof props.from === 'string' && props.from) parts.push(`from:(${props.from})`);
  if (typeof props.to === 'string' && props.to) parts.push(`to:(${props.to})`);
  if (typeof props.subject === 'string' && props.subject) parts.push(`subject:(${props.subject})`);
  const label = labelNameOf(props.label);
  if (label) parts.push(`label:${label}`);
  if (typeof props.category === 'string' && props.category) parts.push(`category:${props.category}`);
  const afterSeconds = Math.floor(lastPollEpochMs / 1000);
  if (afterSeconds > 0) parts.push(`after:${afterSeconds}`);
  return parts.join(' ');
}

/** A message's event epoch from `messageTimestamp`, else `internalDate`; `null` → the caller skips the item (logged). */
function gmailEpochMs(message: Record<string, unknown>): number | null {
  if (typeof message.messageTimestamp === 'string') {
    const epoch = Date.parse(message.messageTimestamp);
    if (!Number.isNaN(epoch)) return epoch;
  }
  const internal = message.internalDate;
  if (typeof internal === 'string' || typeof internal === 'number') {
    const epoch = Number(internal);
    if (Number.isFinite(epoch) && epoch > 0) return epoch;
  }
  return null;
}

function gmailItems(data: unknown): ComposioTriggerItem[] {
  const messages = isRecord(data) && Array.isArray(data.messages) ? data.messages : [];
  const items: ComposioTriggerItem[] = [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const epoch = gmailEpochMs(message);
    if (epoch === null) {
      const id = typeof message.messageId === 'string' ? message.messageId : '?';
      logger.warn(`gmail poll: message ${id} has no parseable timestamp — skipped`);
      continue;
    }
    items.push({ epochMilliSeconds: epoch, payload: message });
  }
  items.sort((a, b) => a.epochMilliSeconds - b.epochMilliSeconds); // fire oldest first
  return items;
}

const GMAIL_NEW_EMAIL: ComposioTriggerSpec = {
  catalog: {
    name: 'New Email',
    type: 'gmail.gmail_new_email_received',
    category: 'gmail',
    description: 'Triggers when new mail is found in your Gmail inbox',
    parameters: {
      subject: { type: 'SHORT_TEXT', description: 'The email subject', required: false },
      from: {
        type: 'SHORT_TEXT',
        description: 'Optional filter on the email sender; leave empty for any',
        required: false,
      },
      to: {
        type: 'SHORT_TEXT',
        description: 'Optional filter on the email recipient; leave empty for any',
        required: false,
      },
      label: {
        type: 'SHORT_TEXT',
        description: 'Optional Gmail label to filter on; leave empty for any',
        required: false,
      },
      category: {
        type: 'SHORT_TEXT',
        description: 'Optional Gmail category to filter on; leave empty for any',
        required: false,
      },
    },
    auth: 'connection',
  },
  toolSlug: 'GMAIL_FETCH_EMAILS',
  buildArguments: (props, lastPollEpochMs) => {
    const query = gmailQuery(props, lastPollEpochMs);
    return {
      ...(query ? { query } : {}),
      // No cursor yet → sample a small window on the first poll.
      max_results: lastPollEpochMs === 0 ? 5 : 20,
    };
  },
  extractItems: gmailItems,
};

const REGISTRY: ReadonlyMap<string, ComposioTriggerSpec> = new Map([
  ['gmail.gmail_new_email_received', GMAIL_NEW_EMAIL],
]);

/** The spec for a PUBLIC trigger type, or undefined → unsupported (no poll rail). */
export function composioTriggerSpec(publicTriggerType: string): ComposioTriggerSpec | undefined {
  return REGISTRY.get(publicTriggerType);
}

/** Every registered public trigger type — the rails-consistency test's input. */
export function composioTriggerTypes(): ReadonlySet<string> {
  return new Set(REGISTRY.keys());
}

/** Picker rows for every Composio-polled trigger — the ONLY source of Composio polling-trigger catalog entries. */
export function composioTriggerCatalog(): ComposioTriggerCatalogEntry[] {
  return [...REGISTRY.values()].map((spec) => spec.catalog);
}
