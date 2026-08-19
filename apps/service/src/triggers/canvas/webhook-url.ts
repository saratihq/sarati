import { isIdShape } from '../../database/ids';
import { canonicalEnvName } from '../../environments/env-name';

/**
 * The per-`(workflow, env)` webhook URL scheme `/api/hooks/<workflowId>/<env>` — STABLE
 * within an env, so it must never be re-keyed per version. Env names canonicalize here (invariant #7).
 */

const HOOKS_PREFIX = 'api/hooks';

/** The parsed target of a per-`(workflow, env)` webhook hit. */
export interface WebhookTarget {
  workflowId: string;
  /** Canonicalized env name (`prod → production`). */
  environment: string;
}

/** The canonical per-`(workflow, env)` webhook PATH (leading slash, no trailing slash). */
export function webhookPathFor(workflowId: string, environment: string): string {
  return `/${HOOKS_PREFIX}/${workflowId}/${canonicalEnvName(environment)}`;
}

/** The absolute URL, given a public base (a trailing slash on the base is trimmed). */
export function webhookUrlFor(baseUrl: string, workflowId: string, environment: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${webhookPathFor(workflowId, environment)}`;
}

/**
 * Parse a request path into a per-`(workflow, env)` target, or `null` when it is not one. The
 * segment after `api/hooks/` MUST be a uuid, which is what keeps the `catch/:catchId` intake out.
 */
export function parseWebhookPath(path: string): WebhookTarget | null {
  const trimmed = path.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!trimmed.startsWith(`${HOOKS_PREFIX}/`)) return null;
  const segments = trimmed.slice(HOOKS_PREFIX.length + 1).split('/');
  if (segments.length !== 2) return null; // one segment = legacy; more = not ours
  const workflowId = segments[0] ?? '';
  const envRaw = segments[1] ?? '';
  if (!isIdShape(workflowId) || envRaw === '') return null;
  return { workflowId, environment: canonicalEnvName(envRaw) };
}
