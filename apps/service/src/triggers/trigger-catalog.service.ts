import { Injectable, Logger } from '@nestjs/common';

import { withDeadline } from '../common/deadline';
import { errorMessage } from '../common/error-message';
import {
  type ComposioProjectedCatalogEntry,
  ComposioTriggerProvider,
} from '../providers/composio-trigger.provider';
import { composioTriggerCatalog, composioTriggerTypes } from '../providers/composio-trigger.registry';
import { SdkPollingProvider } from '../providers/sdk-polling.provider';
import { SdkWebhookProvider } from '../providers/sdk-webhook.provider';
import { AGENT_TOOL_PUBLIC } from '../runtime/workflow-tool-contract';

import { ORCHESTR_SCHEDULE } from './schedule';
import { PlatformKeysService, type PlatformKeyScope } from '../platform/platform-keys.service';

/** The PUBLIC type of the native inbound-webhook trigger kind (catalog + version-doc node_type). */
export const INCOMING_WEBHOOK_PUBLIC = 'orchestr:webhook';
/** The PUBLIC type of the native synchronous chat-intake trigger kind. */
export const INCOMING_CHAT_PUBLIC = 'orchestr:chat';

// Re-exported so existing importers keep one source; it is declared with the contract it carries.
export { AGENT_TOOL_PUBLIC };
/** The manual trigger — fires ONLY via a manual Run, so it has NO runtime activation. */
export const MANUAL_TRIGGER = 'orchestr:trigger';

/** Which rail fires a trigger: our own engine, the clean-room SDK, or the Composio broker. */
export type TriggerRail = 'native' | 'sdk' | 'composio';

/** One offerable trigger: the picker row plus the rail that fires it. */
export interface TriggerCatalogRow {
  /** The wire shape `GET /api/triggers/catalog` serves — extra keys would break the palette contract. */
  entry: Record<string, unknown>;
  rail: TriggerRail;
}

const NATIVE_TRIGGERS: ReadonlyArray<Record<string, unknown>> = [
  {
    name: 'Incoming webhook',
    type: INCOMING_WEBHOOK_PUBLIC,
    category: 'control',
    description: 'Fires the workflow when this URL receives a POST',
    parameters: {},
    auth: 'none',
  },
  {
    name: 'Schedule',
    type: ORCHESTR_SCHEDULE,
    category: 'control',
    description: 'Fires the workflow on a timer — every N minutes, or a cron expression',
    parameters: {
      interval_minutes: {
        type: 'NUMBER',
        required: false,
        description: 'Fire every N minutes (at least 1). Set this OR cron, not both.',
      },
      cron: {
        type: 'SHORT_TEXT',
        required: false,
        description: '5-field cron expression, e.g. "0 9 * * 1-5" for weekdays at 09:00.',
      },
      timezone: {
        type: 'SHORT_TEXT',
        required: false,
        description: 'IANA timezone the cron evaluates in (default UTC), e.g. "Europe/London".',
      },
    },
    auth: 'none',
  },
  {
    name: 'Chat',
    type: INCOMING_CHAT_PUBLIC,
    category: 'control',
    description: 'Fires the workflow from a chat message and replies with the final step output',
    // All presentational: they shape the hosted/embed chat surface, never the run.
    parameters: {
      greeting: {
        type: 'SHORT_TEXT',
        required: false,
        description: 'Opening line shown before the first message.',
      },
      placeholder: {
        type: 'SHORT_TEXT',
        required: false,
        description: 'Placeholder text for the message input.',
      },
      initialMessages: {
        type: 'LONG_TEXT',
        required: false,
        description: 'Suggested first messages the user can pick from.',
      },
    },
    auth: 'none',
  },
  {
    name: 'Called by another workflow',
    type: AGENT_TOOL_PUBLIC,
    category: 'control',
    description:
      "Lets other workflows and AI agents run this one and use its result — it never fires on its own. Only the version live in production is callable, so publishing is what exposes it; the caller's arguments arrive as {{trigger.<input name>}}.",
    parameters: {
      tool_name: {
        type: 'SHORT_TEXT',
        required: true,
        description:
          'What agents call this by, e.g. "refund_customer". Lowercase words joined by underscores; the "orchestr_" prefix is reserved.',
      },
      description: {
        type: 'LONG_TEXT',
        required: true,
        description:
          'What this does and when to use it. A model decides whether to call it on this text alone, so be specific about what it changes.',
      },
      inputs: {
        type: 'LONG_TEXT',
        required: false,
        description:
          'The arguments it takes: a list of {name, type, description, required}. Each becomes {{trigger.<name>}}.',
      },
    },
    auth: 'none',
  },
];

/** Why Composio's part of a workspace's trigger list can't be read now: the workspace has no Composio key, or its listing failed, came back empty or ran late. */
export type UnreadListing = 'no_composio_key' | 'listing_unavailable';

/** The built-in trigger types, the manual one first — what every workspace offers whatever it has connected. */
export const NATIVE_TRIGGER_TYPES: readonly string[] = [
  MANUAL_TRIGGER,
  ...NATIVE_TRIGGERS.map((entry) => String(entry.type)),
];

/**
 * THE trigger catalog: the ONE source the picker route, the compose vocabulary and the
 * MCP surface all read, so a trigger the palette offers is a trigger `apply_ops` accepts.
 */
@Injectable()
export class TriggerCatalogService {
  private readonly logger = new Logger(TriggerCatalogService.name);
  // Partitions whose listing ran past one caller's wait: later callers don't wait on it again until it settles.
  private readonly overdue = new Set<string>();

  constructor(
    private readonly sdkWebhooks: SdkWebhookProvider,
    private readonly sdkPolling: SdkPollingProvider,
    private readonly composioTriggers: ComposioTriggerProvider,
    private readonly platformKeys: PlatformKeysService,
  ) {}

  /**
   * Whether `type` names a trigger, answered WITHOUT the live Composio projection — every rail but
   * that projection is in-process, so this is exact for native/SDK types and covers the shipped
   * Composio registry. Used where the answer must be synchronous (the author gate's diagnosis).
   */
  isKnownTriggerType(type: string): boolean {
    return (
      NATIVE_TRIGGERS.some((entry) => entry.type === type) ||
      this.sdkWebhooks.isRegisteredWebhook(type) ||
      this.sdkPolling.isPollingTrigger(type) ||
      composioTriggerTypes().has(type)
    );
  }

  /** Native + SDK + Composio triggers; a first-party entry wins any public-type overlap, and the hand-polled Composio ones are left out where the instance provides its own Composio account. */
  async list(scope: PlatformKeyScope): Promise<TriggerCatalogRow[]> {
    const rows = this.inProcessRows();
    return [...rows, ...liveRows(rows, await this.composioTriggers.catalog(scope))];
  }

  /** Whether the trigger picker offers `type` in every scope — the manual trigger, or a row of {@link list} — whatever Composio lists; null when only Composio's live listing can say. */
  offeredWithoutComposio(type: string): boolean | null {
    if (type === MANUAL_TRIGGER || this.inProcessRows().some((row) => row.entry.type === type)) return true;
    return composioTriggerTypes().has(type) ? false : null;
  }

  /** The types Composio's live listing adds to {@link list} for `scope`, or why they can't be known within `waitMs`. */
  async liveTypes(scope: PlatformKeyScope, waitMs: number): Promise<ReadonlySet<string> | UnreadListing> {
    const partition = this.platformKeys.composioPartition(scope);
    if (this.overdue.has(partition)) return 'listing_unavailable';
    const listing = this.composioTriggers.knownCatalog(scope);
    const late = new Error(`no answer within ${waitMs}ms`);
    let entries: ComposioProjectedCatalogEntry[] | null;
    try {
      entries = await withDeadline(listing, waitMs, () => late);
    } catch (err) {
      if (err === late) this.holdBackUntilSettled(partition, listing);
      this.logger.warn(`Composio's trigger listing is unknown for now: ${errorMessage(err)}`);
      return 'listing_unavailable';
    }
    if (entries) return new Set(liveRows(this.inProcessRows(), entries).map((row) => String(row.entry.type)));
    return (await this.composioTriggers.isConfigured(scope)) ? 'listing_unavailable' : 'no_composio_key';
  }

  private holdBackUntilSettled(partition: string, listing: Promise<unknown>): void {
    this.overdue.add(partition);
    const settled = (): void => {
      this.overdue.delete(partition);
    };
    void listing.then(settled, settled);
  }

  private inProcessRows(): TriggerCatalogRow[] {
    const handPolled = this.platformKeys.composioManagedByInstance() ? [] : composioTriggerCatalog();
    return [
      ...NATIVE_TRIGGERS.map((entry) => ({ entry, rail: 'native' as const })),
      ...this.sdkWebhooks.catalog().map((entry) => ({ entry, rail: 'sdk' as const })),
      ...this.sdkPolling.catalog().map((entry) => ({ entry, rail: 'sdk' as const })),
      ...handPolled.map((entry) => ({
        entry: entry as unknown as Record<string, unknown>,
        rail: 'composio' as const,
      })),
    ];
  }
}

function liveRows(
  inProcess: readonly TriggerCatalogRow[],
  entries: readonly ComposioProjectedCatalogEntry[],
): TriggerCatalogRow[] {
  const seen = new Set([...inProcess.map((row) => String(row.entry.type)), ...composioTriggerTypes()]);
  const rows: TriggerCatalogRow[] = [];
  for (const entry of entries) {
    if (seen.has(entry.type)) continue;
    seen.add(entry.type);
    rows.push({ entry: entry as unknown as Record<string, unknown>, rail: 'composio' });
  }
  return rows;
}
