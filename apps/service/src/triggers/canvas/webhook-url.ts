import type { EnvConfig } from '../../config/env.config';
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

/** The canonical per-`(workflow, env)` chat PATH. */
export function chatPathFor(workflowId: string, environment: string): string {
  return `/api/chat/${workflowId}/${canonicalEnvName(environment)}`;
}

/** The absolute URL, given a public base (a trailing slash on the base is trimmed). */
export function webhookUrlFor(baseUrl: string, workflowId: string, environment: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${webhookPathFor(workflowId, environment)}`;
}

/** The URL this service serves a workflow's webhooks in `environment` at: under `PUBLIC_BASE_URL`, else on localhost. */
export function servedWebhookUrl(
  env: Pick<EnvConfig, 'publicBaseUrl' | 'port'>,
  workflowId: string,
  environment: string,
): string {
  return webhookUrlFor(env.publicBaseUrl || `http://localhost:${env.port}`, workflowId, environment);
}

/** Whether two webhook URLs reach the same `(workflow, env)` intake, which routes by the hooks path alone, whatever host or prefix is before it. */
export function sameWebhookIntake(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  const [x, y] = [intakeOf(a), intakeOf(b)];
  return x !== null && y !== null && x.workflowId === y.workflowId && x.environment === y.environment;
}

function intakeOf(url: string | null): WebhookTarget | null {
  const at = url?.lastIndexOf(`/${HOOKS_PREFIX}/`) ?? -1;
  return url && at >= 0 ? parseWebhookPath(url.slice(at)) : null;
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
