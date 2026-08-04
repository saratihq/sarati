/**
 * Environment config, validated at boot. Structural misconfiguration still
 * fails fast (workflow-service convention), but the composer's own credentials
 * do not: a stack that ships this service by default must boot without them,
 * with the composer disabled and saying so, rather than crash-looping.
 */

/** Why the composer is off — the client renders one explanation per reason. */
export type ComposerDisabledReason = 'anthropic_api_key_missing' | 'caller_auth_unconfigured';

export interface EnvConfig {
  readonly environment: string;
  readonly port: number;
  readonly corsOriginList: readonly string[];
  /** workflow-service base URL, e.g. http://localhost:8001 */
  readonly workflowServiceUrl: string;
  /**
   * Optional ork_ fallback for tool calls when no caller token exists —
   * MOCK_AUTH development only. In authed mode every tool call forwards the
   * caller's own bearer token (runs are attributed to the person).
   */
  readonly workflowServiceApiKey: string | null;
  /** Claude Agent SDK credential. Null disables the composer — the service still boots. */
  readonly anthropicApiKey: string | null;
  /** Model the composer sessions run on. */
  readonly composerModel: string;
  /** Model for the focused param-filling sub-chain — unset disables fill_params entirely. */
  readonly paramModel: string | null;
  /**
   * Postgres for durable composer threads (write-through + attach rehydrate).
   * Optional and fail-soft: unset runs memory-only exactly as before — OSS/dev
   * without the database must keep working.
   */
  readonly databaseUrl: string | null;
  /** Dev/test only: bypass caller auth (parity with workflow-service's MOCK_AUTH). */
  readonly mockAuth: boolean;
  /**
   * Clerk instance issuer — callers are verified against its JWKS. One of the
   * caller-auth paths, not the only one: with none of them configured the
   * composer is OFF, but it is never left open.
   */
  readonly clerkIssuer: string | null;
  /** Comma-separated azp allow-list (browser origins); empty = azp not checked. */
  readonly clerkAuthorizedParties: string;
  /**
   * workflow-service's SECRET_KEY, non-null exactly when local-session auth is
   * usable here: a self-host signs in with email + password (workflow-service
   * ADR 0054) and carries an HS256 session JWT, so agent-service must share the
   * secret to verify it. Folded into one nullable field so "enabled" and "has a
   * key" cannot disagree. Null = this instance verifies no local sessions.
   */
  readonly localSessionSecret: string | null;
  /**
   * Null when the composer is fully configured. An install missing both
   * credentials reports the Anthropic key first — it is the documented opt-in,
   * and the auth wall is not something an operator can act on before it.
   */
  readonly composerDisabledReason: ComposerDisabledReason | null;
}

function asBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function validateEnv(raw: NodeJS.ProcessEnv): EnvConfig {
  const errors: string[] = [];

  const environment = raw.ENVIRONMENT ?? 'development';
  const port = Number(raw.PORT ?? '8010');
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('PORT must be a valid port number');

  const workflowServiceUrl = (raw.WORKFLOW_SERVICE_URL ?? 'http://localhost:8001').replace(/\/+$/, '');
  const workflowServiceApiKey = raw.WORKFLOW_SERVICE_API_KEY?.trim() || null;
  if (workflowServiceApiKey && !workflowServiceApiKey.startsWith('ork_')) {
    errors.push('WORKFLOW_SERVICE_API_KEY must be an ork_ API key (create one via POST /api/api-keys)');
  }
  const anthropicApiKey = raw.ANTHROPIC_API_KEY?.trim() || null;

  const mockAuth = (raw.MOCK_AUTH ?? '').trim().toLowerCase() === 'true';
  const clerkIssuer = raw.CLERK_ISSUER?.trim().replace(/\/+$/, '') || null;
  if (mockAuth && environment === 'production') {
    errors.push('MOCK_AUTH must not be enabled in production — it bypasses caller authentication entirely.');
  }
  if (mockAuth && !workflowServiceApiKey) {
    errors.push('MOCK_AUTH=true needs WORKFLOW_SERVICE_API_KEY — mock callers have no token to forward');
  }

  // Mirrors workflow-service: local auth is on by default and off when Clerk is
  // configured, so a Clerk deployment never silently grows a second front door.
  const localAuthEnabled = asBool(raw.LOCAL_AUTH_ENABLED, !clerkIssuer);
  const localSessionSecret = localAuthEnabled ? raw.SECRET_KEY?.trim() || null : null;

  const composerDisabledReason: ComposerDisabledReason | null = !anthropicApiKey
    ? 'anthropic_api_key_missing'
    : !mockAuth && !clerkIssuer && !localSessionSecret
      ? 'caller_auth_unconfigured'
      : null;

  if (errors.length > 0) {
    throw new Error(`Invalid environment:\n  - ${errors.join('\n  - ')}`);
  }

  return {
    environment,
    port,
    corsOriginList: (raw.CORS_ORIGINS ?? 'http://localhost:3100')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    workflowServiceUrl,
    workflowServiceApiKey,
    anthropicApiKey,
    composerModel: raw.COMPOSER_MODEL ?? 'claude-opus-4-8',
    paramModel: raw.PARAM_MODEL?.trim() || null,
    databaseUrl: raw.DATABASE_URL?.trim() || null,
    mockAuth,
    clerkIssuer,
    clerkAuthorizedParties: raw.CLERK_AUTHORIZED_PARTIES ?? '',
    localSessionSecret,
    composerDisabledReason,
  };
}
