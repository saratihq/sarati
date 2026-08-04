import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  actions,
  type AuthHandle,
  type DropdownResult,
  type FetchLike,
  type PollingTrigger,
} from '@sarati/actions-sdk';

import { ConnectionsService } from '../connections/connections.service';
import type { TriggerEvent } from './managed-integration-provider';
import type { ProviderStore } from './provider-store';
import {
  buildDirectAuth,
  loadTriggerOptions,
  resolveTriggerCredential,
  sdkStore,
  triggerCatalogEntry,
} from './sdk-trigger-auth';

/** Optional token for the polling triggers' outbound fetch; unset in production → the SDK's global fetch. */
export const SDK_POLLING_FETCH = Symbol('SDK_POLLING_FETCH');

/** Common shape the poll/enable entrypoints share (one activation's context). */
interface SdkPollingContext {
  /** The run-as owner — scopes a `{connectionId}` credential decryption (slack). */
  externalUserId: string;
  props: Record<string, unknown>;
  /** Connection reference (`{connectionId}`) or an inline credential; null/none for no-auth triggers. */
  auth: Record<string, unknown> | null;
  /** The activation's persistent KV — the SDK's dedup/watermark cursor lives here. */
  store: ProviderStore;
}

/**
 * Runs the SDK's POLLING triggers (`runPoll` — the identity-deduped poll rail) IN-PROCESS, the counterpart of
 * {@link import('./sdk-webhook.provider').SdkWebhookProvider}. Always available (no COMPOSIO_API_KEY needed);
 * owns credential resolution and the SDK glue.
 */
@Injectable()
export class SdkPollingProvider {
  /** PUBLIC type → SDK polling trigger. Every polling trigger the SDK ships (`pollingTriggers`). */
  private readonly registry = new Map<string, PollingTrigger<never, unknown>>([
    [actions.rss.RSS_NEW_ITEM_TYPE, actions.rss.newItem as unknown as PollingTrigger<never, unknown>],
    [
      actions.hackernews.NEW_STORY_TYPE,
      actions.hackernews.newStory as unknown as PollingTrigger<never, unknown>,
    ],
    [actions.http.HTTP_NEW_ITEM_TYPE, actions.http.newItem as unknown as PollingTrigger<never, unknown>],
    [actions.slack.NEW_CHANNEL_TYPE, actions.slack.newChannel as unknown as PollingTrigger<never, unknown>],
    [
      actions.mailchimp.NEW_SUBSCRIBER_TYPE,
      actions.mailchimp.newSubscriber as unknown as PollingTrigger<never, unknown>,
    ],
    [actions.jira.NEW_ISSUE_TYPE, actions.jira.newIssue as unknown as PollingTrigger<never, unknown>],
    [actions.asana.NEW_TASK_TYPE, actions.asana.newTask as unknown as PollingTrigger<never, unknown>],
    [actions.todoist.NEW_TASK_TYPE, actions.todoist.newTask as unknown as PollingTrigger<never, unknown>],
    [
      actions.hubspot.NEW_CONTACT_TYPE,
      actions.hubspot.newContact as unknown as PollingTrigger<never, unknown>,
    ],
    [
      actions.intercom.NEW_CONVERSATION_TYPE,
      actions.intercom.newConversation as unknown as PollingTrigger<never, unknown>,
    ],
    [actions.zendesk.NEW_TICKET_TYPE, actions.zendesk.newTicket as unknown as PollingTrigger<never, unknown>],
    [
      actions.salesforce.NEW_RECORD_TYPE,
      actions.salesforce.newRecord as unknown as PollingTrigger<never, unknown>,
    ],
    [
      actions.airtable.AIRTABLE_NEW_RECORD_TYPE,
      actions.airtable.newRecord as unknown as PollingTrigger<never, unknown>,
    ],
    [
      actions.notion.NOTION_NEW_PAGE_TYPE,
      actions.notion.newPage as unknown as PollingTrigger<never, unknown>,
    ],
    [
      actions.dropbox.DROPBOX_NEW_FILE_TYPE,
      actions.dropbox.newFile as unknown as PollingTrigger<never, unknown>,
    ],
    [actions.drive.DRIVE_NEW_FILE_TYPE, actions.drive.newFile as unknown as PollingTrigger<never, unknown>],
    [actions.sheets.SHEETS_NEW_ROW_TYPE, actions.sheets.newRow as unknown as PollingTrigger<never, unknown>],
    [
      actions.zoom.ZOOM_NEW_RECORDING_TYPE,
      actions.zoom.newRecording as unknown as PollingTrigger<never, unknown>,
    ],
    [
      actions.calendar.CALENDAR_NEW_EVENT_TYPE,
      actions.calendar.newEvent as unknown as PollingTrigger<never, unknown>,
    ],
    [
      actions.outlook.OUTLOOK_NEW_EMAIL_TYPE,
      actions.outlook.newEmail as unknown as PollingTrigger<never, unknown>,
    ],
    [actions.gmail.GMAIL_NEW_EMAIL_TYPE, actions.gmail.newEmail as unknown as PollingTrigger<never, unknown>],
  ]);

  constructor(
    @Optional() private readonly connections?: ConnectionsService,
    @Optional() @Inject(SDK_POLLING_FETCH) private readonly fetchImpl?: FetchLike,
  ) {}

  /** Whether `type` is an SDK polling trigger (drives the triggers-service + reconciler branch). */
  isPollingTrigger(type: string): boolean {
    return this.registry.has(type);
  }

  /** Whether the trigger needs a connection (non-`none` scheme) — the reconciler's gate, so a no-auth trigger isn't held back. */
  needsConnection(type: string): boolean {
    const trigger = this.registry.get(type);
    return trigger ? trigger.auth.type !== 'none' : false;
  }

  /** Catalog entries for the trigger picker — same wire shape the other trigger entries use, plus `sample`. */
  catalog(): Array<Record<string, unknown>> {
    return [...this.registry.values()].map((trigger) =>
      triggerCatalogEntry(trigger.toManifest(), trigger.sampleData, trigger.auth),
    );
  }

  /** Live options for a dropdown prop on a polling trigger — see {@link loadTriggerOptions}. */
  loadOptions(
    type: string,
    prop: string,
    opts: { externalUserId: string; connectionId?: string; search?: string },
  ): Promise<DropdownResult<unknown>> {
    return loadTriggerOptions(this.require(type), prop, {
      connections: this.connections,
      ...opts,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
  }

  /** A priming poll whose events are DISCARDED, seeding the dedup watermark so activation can't fire the backlog. */
  async enable(type: string, ctx: SdkPollingContext): Promise<void> {
    await this.runPollEvents(type, ctx);
  }

  /** One poll returning only events unseen since the stored cursor; each payload becomes a fired run's `trigger` scope. */
  async pollOne(type: string, ctx: SdkPollingContext): Promise<TriggerEvent[]> {
    const events = await this.runPollEvents(type, ctx);
    return events.map((payload) => ({ payload }));
  }

  /** Resolve auth, run one poll, return the SDK's fresh (deduped) events. */
  private async runPollEvents(type: string, ctx: SdkPollingContext): Promise<unknown[]> {
    const trigger = this.require(type);
    const auth = await this.authFor(ctx.externalUserId, ctx.auth, trigger);
    const result = await trigger.runPoll({ auth, props: ctx.props, store: sdkStore(ctx.store) });
    return result.events;
  }

  private require(type: string): PollingTrigger<never, unknown> {
    const trigger = this.registry.get(type);
    if (!trigger) throw new Error(`No SDK polling trigger registered for "${type}"`);
    return trigger;
  }

  /** Build the opaque auth handle the trigger polls on — resolved credential + the (test-)injectable fetch. */
  private async authFor(
    externalUserId: string,
    auth: Record<string, unknown> | null,
    trigger: PollingTrigger<never, unknown>,
  ): Promise<AuthHandle> {
    const credential = await resolveTriggerCredential(this.connections, externalUserId, auth, trigger.auth);
    return buildDirectAuth(trigger.auth, credential, this.fetchImpl);
  }
}
