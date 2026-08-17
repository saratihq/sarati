import { Injectable } from '@nestjs/common';

import { ComposioTriggerProvider } from '../providers/composio-trigger.provider';
import { composioTriggerCatalog, composioTriggerTypes } from '../providers/composio-trigger.registry';
import { SdkPollingProvider } from '../providers/sdk-polling.provider';
import { SdkWebhookProvider } from '../providers/sdk-webhook.provider';

import { ORCHESTR_SCHEDULE } from './schedule';
import type { PlatformKeyScope } from '../platform/platform-keys.service';

/** The PUBLIC type of the native inbound-webhook trigger kind (catalog + version-doc node_type). */
export const INCOMING_WEBHOOK_PUBLIC = 'orchestr:webhook';
/** The PUBLIC type of the native synchronous chat-intake trigger kind (ADR 0045 addendum). */
export const INCOMING_CHAT_PUBLIC = 'orchestr:chat';

/** A workflow with this trigger is offered as an agent-callable tool (ADR 0053). */
export const AGENT_TOOL_PUBLIC = 'orchestr:tool_trigger';
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
    name: 'Callable by an agent',
    type: AGENT_TOOL_PUBLIC,
    category: 'control',
    description:
      'Publishes this workflow as a tool an AI agent can call (ADR 0053). Only the version live in production is callable, so publishing is what exposes it; the call arguments arrive as {{trigger.<input name>}}.',
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

/**
 * THE trigger catalog (ADR 0052): the ONE source the picker route, the compose vocabulary and the
 * MCP surface all read, so a trigger the palette offers is a trigger `apply_ops` accepts.
 */
@Injectable()
export class TriggerCatalogService {
  constructor(
    private readonly sdkWebhooks: SdkWebhookProvider,
    private readonly sdkPolling: SdkPollingProvider,
    private readonly composioTriggers: ComposioTriggerProvider,
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

  /** Native + SDK + Composio triggers; a first-party entry wins any public-type overlap. */
  async list(scope: PlatformKeyScope): Promise<TriggerCatalogRow[]> {
    const rows: TriggerCatalogRow[] = [
      ...NATIVE_TRIGGERS.map((entry) => ({ entry, rail: 'native' as const })),
      ...this.sdkWebhooks.catalog().map((entry) => ({ entry, rail: 'sdk' as const })),
      ...this.sdkPolling.catalog().map((entry) => ({ entry, rail: 'sdk' as const })),
      ...composioTriggerCatalog().map((entry) => ({
        entry: entry as unknown as Record<string, unknown>,
        rail: 'composio' as const,
      })),
    ];
    const seen = new Set(rows.map((row) => String(row.entry.type)));
    for (const entry of await this.composioTriggers.catalog(scope)) {
      if (seen.has(entry.type)) continue;
      seen.add(entry.type);
      rows.push({ entry: entry as unknown as Record<string, unknown>, rail: 'composio' });
    }
    return rows;
  }
}
