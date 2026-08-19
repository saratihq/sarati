/**
 * The capability seam for action/trigger execution: the runtime calls THIS contract, never a concrete vendor.
 * `ActionRouterProvider` is the bound implementation. Connection management belongs to the auth phase, not here.
 */

/** A node's resolved input map — upstream `{{N.field}}` refs already substituted in. */
export type ConfiguredProps = Record<string, unknown>;

/** Result of one action run. `output` is what downstream nodes reference. */
export interface RunActionResult {
  output: unknown;
  /** Non-fatal notes on a SUCCESSFUL run (a dropped prop, an unconverted value), so a silently-ignored input is visible. */
  warnings?: string[];
}

export interface RunActionInput {
  /** Our end-user identity — scopes connections/accounts per tenant. */
  externalUserId: string;
  /** The PUBLIC action type, `"<slug>.<action>"`, e.g. `"http.send_request"`. */
  actionId: string;
  /** The node's configured inputs (the action's `propsValue`). */
  props: ConfiguredProps;
  /** Connection credential (OAuth token / API key) when the action needs auth. */
  auth?: unknown;
  /** The scoped run id, so any file blobs this step produces are cleaned up with the run. */
  runId?: string;
  /**
   * Deterministic per-step base key (`<runId>:<stepKey>`) stamped as `Idempotency-Key: <base>#<n>` per mutating
   * request, so a crash-replay re-issues byte-identical keys and a cooperative API dedupes. Absent = no key.
   */
  idempotencyKey?: string;
  /** Preview mode: the SDK rail stubs mutating HTTP (reads still run); the Composio rail skips the action entirely. */
  dryRun?: boolean;
  /**
   * Per-env connection scoping: set → the step resolves the env's SLOT, and a missing slot is a hard 428,
   * never a pool fallback. `environment` is the env NAME and, with `orgId`, the LEGACY pre-006 resolution key.
   */
  environment?: string | null;
  environmentId?: string | null;
  orgId?: string | null;
}

// ─── Trigger lifecycle ───

import type { ProviderStore } from './provider-store';

/**
 * Everything one trigger invocation needs. The STORE holds the poll/dedup cursor, so the SAME store instance
 * (backed by the trigger's DB row) must be passed to enable, every poll, and disable.
 */
export interface TriggerInput {
  externalUserId: string;
  /** The PUBLIC trigger type, `"<slug>.<trigger>"`, e.g. `"gmail.gmail_new_email_received"`. */
  triggerId: string;
  props: ConfiguredProps;
  auth?: unknown;
  store: ProviderStore;
}

export interface TriggerEvent {
  payload: unknown;
}

/** DI token for the runtime's action provider — the interpreter depends on this SEAM, not a concrete vendor. */
export const MANAGED_INTEGRATION_PROVIDER = Symbol('MANAGED_INTEGRATION_PROVIDER');

export interface ManagedIntegrationProvider {
  /** Stable provider key, e.g. `"router"`. */
  readonly key: string;

  /** Run one configured action and return its output. */
  runAction(input: RunActionInput): Promise<RunActionResult>;

  /** Start a trigger: seeds the dedup cursor so only post-enable events fire. */
  enableTrigger(input: TriggerInput): Promise<void>;
  /** One poll: returns only NEW events since the cursor. */
  pollTrigger(input: TriggerInput): Promise<TriggerEvent[]>;
  /** Stop a trigger (best-effort cleanup). */
  disableTrigger(input: TriggerInput): Promise<void>;
}
