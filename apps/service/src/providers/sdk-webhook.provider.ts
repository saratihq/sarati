import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  actions,
  type AuthHandle,
  type DropdownResult,
  type FetchLike,
  type WebhookRegistration,
  type WebhookRequest,
  type WebhookTrigger,
} from '@sarati/actions-sdk';

import { ConnectionsService } from '../connections/connections.service';
import type { ProviderStore } from './provider-store';
import {
  buildDirectAuth,
  loadTriggerOptions,
  resolveTriggerCredential,
  sdkStore,
  triggerCatalogEntry,
} from './sdk-trigger-auth';

/** Optional token for the SDK triggers' outbound fetch; unset in production → the SDK's global fetch. */
export const SDK_WEBHOOK_FETCH = Symbol('SDK_WEBHOOK_FETCH');

/** The per-trigger secret WE generated — SINGLE definition site (reconciler writes, intake reads). */
export const WEBHOOK_SECRET_KEY = 'webhook.secret';
/** The durable {@link WebhookRegistration} handle `onEnable` returned — carries any PROVIDER-minted signing secret. */
export const WEBHOOK_REGISTRATION_KEY = 'webhook.registration';

/** Common shape the three lifecycle entrypoints share (one trigger row's context). */
interface SdkWebhookContext {
  externalUserId: string;
  /** The trigger's PUBLIC type, e.g. `github.new_push`. */
  type: string;
  props: Record<string, unknown>;
  /** Connection reference (`{connectionId}`) or an inline credential; never a raw secret in the row otherwise. */
  auth: Record<string, unknown> | null;
  /** The trigger's persistent KV (dedup cursor + our subscription/secret keys). */
  store: ProviderStore;
  /** The public intake URL GitHub/Stripe should call for this trigger. */
  webhookUrl: string;
  /** The per-trigger signing secret we registered the subscription with. */
  secret: string;
}

/**
 * Runs the SDK's REGISTERED-webhook triggers IN-PROCESS (the intake must answer a signature check per request).
 * Owns credential resolution and the SDK glue — auth-handle construction, the store adapter, request shaping.
 */
@Injectable()
export class SdkWebhookProvider {
  private readonly logger = new Logger(SdkWebhookProvider.name);

  /** PUBLIC type → SDK trigger. Only registered-webhook (onEnable) triggers belong here. */
  private readonly registry = new Map<string, WebhookTrigger<never, unknown>>([
    [actions.github.NEW_PUSH_TYPE, actions.github.newPush as unknown as WebhookTrigger<never, unknown>],
    [actions.github.NEW_ISSUE_TYPE, actions.github.newIssue as unknown as WebhookTrigger<never, unknown>],
    [
      actions.github.NEW_PULL_REQUEST_TYPE,
      actions.github.newPullRequest as unknown as WebhookTrigger<never, unknown>,
    ],
    [
      actions.stripe.PAYMENT_SUCCEEDED_TYPE,
      actions.stripe.paymentSucceeded as unknown as WebhookTrigger<never, unknown>,
    ],
    [
      actions.stripe.NEW_CUSTOMER_TYPE,
      actions.stripe.newCustomer as unknown as WebhookTrigger<never, unknown>,
    ],
    [
      actions.typeform.NEW_RESPONSE_TYPE,
      actions.typeform.newResponse as unknown as WebhookTrigger<never, unknown>,
    ],
    [
      actions.calendly.NEW_INVITEE_TYPE,
      actions.calendly.newInvitee as unknown as WebhookTrigger<never, unknown>,
    ],
    [actions.linear.NEW_ISSUE_TYPE, actions.linear.newIssue as unknown as WebhookTrigger<never, unknown>],
    [actions.clickup.NEW_TASK_TYPE, actions.clickup.newTask as unknown as WebhookTrigger<never, unknown>],
  ]);

  constructor(
    @Optional() private readonly connections?: ConnectionsService,
    @Optional() @Inject(SDK_WEBHOOK_FETCH) private readonly fetchImpl?: FetchLike,
  ) {}

  /** Whether `type` is an SDK registered-webhook trigger (drives the triggers-service branch). */
  isRegisteredWebhook(type: string): boolean {
    return this.registry.has(type);
  }

  /** Catalog entries for the trigger picker — same wire shape the other trigger entries use, plus `sample`. */
  catalog(): Array<Record<string, unknown>> {
    return [...this.registry.values()].map((trigger) =>
      triggerCatalogEntry(trigger.toManifest(), trigger.sampleData, trigger.auth),
    );
  }

  /** Live options for a dropdown prop on a registered-webhook trigger — see {@link loadTriggerOptions}. */
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

  /** Register the subscription and return the durable handle to persist; throws so a half-registered trigger is never silent. */
  async enable(ctx: SdkWebhookContext): Promise<WebhookRegistration | undefined> {
    const trigger = this.require(ctx.type);
    const auth = await this.authFor(ctx.externalUserId, ctx.auth, trigger);
    return trigger.enable({
      auth,
      props: ctx.props,
      store: sdkStore(ctx.store),
      webhookUrl: ctx.webhookUrl,
      secret: ctx.secret,
    });
  }

  /** The TRUST BOUNDARY for untrusted public-endpoint input: a bad signature throws 401 before anything fires. */
  async handleRequest(
    ctx: SdkWebhookContext & { request: WebhookRequest; registration?: WebhookRegistration },
  ): Promise<unknown[]> {
    const trigger = this.require(ctx.type);
    const auth = await this.authFor(ctx.externalUserId, ctx.auth, trigger);
    // Verify against the PROVIDER-minted secret when the handle carries one — verifying a provider-minted
    // subscription against the random secret WE generated would 401 every real delivery.
    const minted = ctx.registration?.signingSecret;
    const signingSecret = typeof minted === 'string' && minted ? minted : ctx.secret;
    return trigger.handleRequest({
      auth,
      props: ctx.props,
      store: sdkStore(ctx.store),
      request: ctx.request,
      secret: ctx.secret,
      secrets: { signingSecret },
      webhookUrl: ctx.webhookUrl,
    });
  }

  /** Delete the subscription named by `registration`. Best-effort teardown — see callers. */
  async disable(ctx: SdkWebhookContext & { registration?: WebhookRegistration }): Promise<void> {
    const trigger = this.require(ctx.type);
    const auth = await this.authFor(ctx.externalUserId, ctx.auth, trigger);
    await trigger.disable({
      auth,
      props: ctx.props,
      store: sdkStore(ctx.store),
      webhookUrl: ctx.webhookUrl,
      secret: ctx.secret,
      ...(ctx.registration ? { registration: ctx.registration } : {}),
    });
  }

  private require(type: string): WebhookTrigger<never, unknown> {
    const trigger = this.registry.get(type);
    if (!trigger) throw new Error(`No SDK webhook trigger registered for "${type}"`);
    return trigger;
  }

  /** Build the opaque auth handle the trigger runs on — resolved credential + the (test-)injectable fetch. */
  private async authFor(
    externalUserId: string,
    auth: Record<string, unknown> | null,
    trigger: WebhookTrigger<never, unknown>,
  ): Promise<AuthHandle> {
    const credential = await resolveTriggerCredential(this.connections, externalUserId, auth, trigger.auth);
    return buildDirectAuth(trigger.auth, credential, this.fetchImpl);
  }
}
