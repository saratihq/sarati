import { Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsString, Min, validateSync } from 'class-validator';

const INSECURE_SECRET_KEY = 'change-me-in-production';

/** The database CONTRIBUTING tells you to create, so a fresh clone runs with no .env at all. */
export const DEFAULT_DATABASE_URL = 'postgresql://orchestr:orchestr@localhost:5432/orchestr_svc';

/** Where the client runs in development — the one default behind CORS, azp and the OAuth redirect. */
const DEFAULT_CLIENT_ORIGIN = 'http://localhost:3100';

/** Hostnames treated as a LOCAL database (dev-mode is permitted against these). */
const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '']);

/** True when DATABASE_URL targets a local host; an unparseable DSN counts as local. */
function isLocalDatabaseHost(databaseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(databaseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return true; // can't parse a host → don't block boot on it
  }
  return LOCAL_DB_HOSTS.has(host);
}

/** Parse CORS_ORIGINS; each origin must be an http(s) URL with a hostname, else throws at startup. */
export function parseCorsOrigins(raw: string): string[] {
  const origins: string[] = [];
  for (const part of raw.split(',')) {
    const origin = part.trim();
    if (!origin) continue;
    let parsed: URL | null = null;
    try {
      parsed = new URL(origin);
    } catch {
      parsed = null;
    }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
      throw new Error(
        `Invalid CORS origin ${JSON.stringify(origin)} in CORS_ORIGINS — ` +
          'each origin must be an http(s) URL like https://app.example.com',
      );
    }
    origins.push(origin);
  }
  return origins;
}

export class EnvConfig {
  @IsIn(['development', 'production'])
  environment: 'development' | 'production' = 'development';

  @IsInt()
  @Min(1)
  port = 8001;

  @IsString()
  databaseUrl = DEFAULT_DATABASE_URL;

  @IsString()
  corsOrigins = DEFAULT_CLIENT_ORIGIN;

  @IsString()
  secretKey = INSECURE_SECRET_KEY;

  @IsString()
  fernetKey = '';

  @IsBoolean()
  trustProxyHeaders = false;

  @IsInt()
  @Min(1)
  maxRequestBodyBytes = 2_097_152;

  @IsBoolean()
  pgBossEnabled = true;

  /** Launch the DBOS durable-execution runtime at boot; needs its own Postgres system DB. */
  @IsBoolean()
  dbosEnabled = false;

  /** DBOS system database URL; empty → databaseUrl with the db name suffixed `_dbos`. */
  @IsString()
  dbosSystemDatabaseUrl = '';

  /** DBOS app version — recovery only resumes runs recorded under the SAME version, so hold it
   *  stable across deploys or a deploy orphans in-flight runs. Empty → `DBOS_APP_VERSION_DEFAULT`. */
  @IsString()
  dbosAppVersion = '';

  /** DBOS executor id — recovery is scoped per executor, so each replica needs a distinct stable id.
   *  Empty → DBOS's `'local'`. */
  @IsString()
  dbosExecutorId = '';

  /** Runtime trigger poll cadence in seconds (0 disables; 1-min pg-boss floor). */
  @IsInt()
  @Min(0)
  triggerPollIntervalSeconds = 60;

  /** Max wall-clock seconds a run may stay in-flight before the reaper errors it (also the ceiling
   *  on a `waiting` HITL run). 0 disables the reaper. */
  @IsInt()
  @Min(0)
  runMaxDurationSeconds = 3600;

  /** This service's public base URL — webhook endpoint URLs are minted from it. Empty → localhost. */
  @IsString()
  publicBaseUrl = '';

  // ── Auth ──
  /** e.g. https://your-app.clerk.accounts.dev — empty disables the Clerk verifier. */
  @IsString()
  clerkIssuer = '';

  @IsString()
  clerkSecretKey = '';

  /** Comma-separated azp allow-list; empty skips the azp check. */
  @IsString()
  clerkAuthorizedParties = DEFAULT_CLIENT_ORIGIN;

  /**
   * Email + password sign-in (ADR 0054). Defaults ON so a self-hoster can reach their own instance,
   * and OFF where Clerk is configured so a managed deployment gains no second front door.
   */
  @IsBoolean()
  localAuthEnabled = true;

  // ── OSS self-host auth: generic OIDC. Empty issuer = inert. ──
  /** Your IdP's issuer URL (Auth0/Keycloak/Okta/…). Empty disables the OIDC verifier. */
  @IsString()
  oidcIssuer = '';

  /** JWKS URL; defaults to `<issuer>/.well-known/jwks.json` when empty. */
  @IsString()
  oidcJwksUrl = '';

  /** Expected `aud`; empty skips the audience check. */
  @IsString()
  oidcAudience = '';

  /** Dev/test only: bypass auth with a fixed test user. */
  @IsBoolean()
  mockAuth = false;

  // ── Composio managed connections. The API key is set in Settings, not here. ──
  /** Composio API base URL — overridable so tests can point at a stub. */
  @IsString()
  composioBaseUrl = 'https://backend.composio.dev';

  /** Extra app slugs (comma/space list) forced onto the Composio execution fallback rail. */
  @IsString()
  composioFallbackApps = '';

  /** Open-core edition flag (ADR 0004): gates ee-only wiring, never core logic. */
  @IsIn(['oss', 'cloud'])
  edition: 'oss' | 'cloud' = 'oss';

  @IsString()
  frontendUrl = DEFAULT_CLIENT_ORIGIN;

  // Configurable so the e2e suite can raise the global bucket while testing per-route limits.
  @IsInt()
  @Min(1)
  throttleLimit = 60;

  @IsInt()
  @Min(1)
  throttleTtlMs = 60_000;

  // Materialized (not getters) so they survive @nestjs/config's plain merge.
  corsOriginList!: readonly string[];
}

/** The ONE env-var truthiness rule — `1/true/yes/on` (case-insensitive); blank/unset takes the fallback. */
export function asBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function asInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`Expected an integer env value, got ${JSON.stringify(value)}`);
  return n;
}

/** Parse the process env into an EnvConfig; fails fast at boot on invalid values and prod guards. */
export function validateEnv(raw: Record<string, string | undefined>): EnvConfig {
  // Drop undefined-valued keys so class defaults apply (plainToInstance would overwrite them).
  const provided = Object.fromEntries(
    Object.entries({
      environment: (raw.ENVIRONMENT ?? 'development').trim().toLowerCase(),
      port: asInt(raw.PORT, 8001),
      databaseUrl: raw.DATABASE_URL || DEFAULT_DATABASE_URL,
      corsOrigins: raw.CORS_ORIGINS || undefined,
      secretKey: raw.SECRET_KEY || INSECURE_SECRET_KEY,
      fernetKey: raw.FERNET_KEY ?? '',
      trustProxyHeaders: asBool(raw.TRUST_PROXY_HEADERS, false),
      maxRequestBodyBytes: asInt(raw.MAX_REQUEST_BODY_BYTES, 2_097_152),
      pgBossEnabled: asBool(raw.PGBOSS_ENABLED, true),
      dbosEnabled: asBool(raw.DBOS_ENABLED, false),
      dbosSystemDatabaseUrl: raw.DBOS_SYSTEM_DATABASE_URL ?? '',
      dbosAppVersion: raw.DBOS_APP_VERSION ?? '',
      dbosExecutorId: raw.DBOS_EXECUTOR_ID ?? '',
      triggerPollIntervalSeconds: asInt(raw.TRIGGER_POLL_INTERVAL_SECONDS, 60),
      runMaxDurationSeconds: asInt(raw.RUN_MAX_DURATION_SECONDS, 3600),
      publicBaseUrl: raw.PUBLIC_BASE_URL ?? '',
      clerkIssuer: raw.CLERK_ISSUER ?? '',
      clerkSecretKey: raw.CLERK_SECRET_KEY ?? '',
      clerkAuthorizedParties: raw.CLERK_AUTHORIZED_PARTIES ?? undefined,
      localAuthEnabled: asBool(raw.LOCAL_AUTH_ENABLED, !raw.CLERK_ISSUER),
      oidcIssuer: raw.OIDC_ISSUER ?? '',
      oidcJwksUrl: raw.OIDC_JWKS_URL ?? '',
      oidcAudience: raw.OIDC_AUDIENCE ?? '',
      mockAuth: asBool(raw.MOCK_AUTH, false),
      composioBaseUrl: raw.COMPOSIO_BASE_URL || 'https://backend.composio.dev',
      composioFallbackApps: raw.COMPOSIO_FALLBACK_APPS ?? '',
      edition: (raw.EDITION ?? 'oss').trim().toLowerCase(),
      frontendUrl: raw.FRONTEND_URL || DEFAULT_CLIENT_ORIGIN,
      throttleLimit: asInt(raw.THROTTLE_LIMIT, 60),
      throttleTtlMs: asInt(raw.THROTTLE_TTL_MS, 60_000),
    }).filter(([, v]) => v !== undefined),
  );
  const cfg = plainToInstance(EnvConfig, provided);

  const errors = validateSync(cfg, { whitelist: true });
  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration: ${errors.map(String).join('; ')}`);
  }

  if (cfg.environment === 'production') {
    if (cfg.mockAuth) {
      throw new Error('MOCK_AUTH must not be enabled in production — it bypasses authentication entirely.');
    }
    if (cfg.secretKey === INSECURE_SECRET_KEY) {
      throw new Error('SECRET_KEY must be set to a secure random value in production.');
    }
    if (!cfg.fernetKey) {
      throw new Error('FERNET_KEY must be set in production (it encrypts stored engine/OAuth tokens).');
    }
    if (cfg.databaseUrl === DEFAULT_DATABASE_URL) {
      throw new Error(
        'DATABASE_URL is still the localhost development default — set it to your production database.',
      );
    }
    if (!cfg.dbosEnabled) {
      throw new Error(
        'DBOS_ENABLED must be true in production — without it runs execute in-process, so a ' +
          'crashed or redeployed worker orphans every in-flight run (no durable crash-resume).',
      );
    }
    if (!cfg.dbosAppVersion) {
      throw new Error(
        'DBOS_APP_VERSION must be set to a stable value in production (e.g. "orchestr-1") so a ' +
          'routine deploy recovers its in-flight runs. Set it once and hold it stable across ' +
          'deploys — never the git SHA; bump it only on a backward-incompatible interpreter change.',
      );
    }
  }

  // Dev mode boots with insecure defaults, so fail closed rather than run it against a real database.
  if (cfg.environment !== 'production' && !isLocalDatabaseHost(cfg.databaseUrl)) {
    throw new Error(
      `DATABASE_URL points at a non-local host but ENVIRONMENT is "${cfg.environment}". Refusing to ` +
        'run development mode against a remote database — set ENVIRONMENT=production for a real ' +
        'deployment, or point DATABASE_URL at a local database for development.',
    );
  }

  // Outside production the insecure default is deliberate — a fresh clone must boot with no .env —
  // but it is also what makes two builds on one port silently reject each other's sessions, which
  // presents as being logged out mid-task rather than as a configuration problem. Say so at boot.
  if (cfg.environment !== 'production' && cfg.secretKey === INSECURE_SECRET_KEY) {
    const logger = new Logger('EnvConfig');
    if (cfg.localAuthEnabled) {
      logger.warn(
        `SECRET_KEY is the built-in default (${INSECURE_SECRET_KEY}) and local auth is ON, so sessions ` +
          'are signed with a value every checkout shares. Any other build started on this port with a ' +
          'real SECRET_KEY will reject them and sign you out mid-task. Set SECRET_KEY in .env — a git ' +
          'worktree does not inherit one, because .env is gitignored.',
      );
    } else {
      logger.warn(`SECRET_KEY is the built-in default (${INSECURE_SECRET_KEY}) — set it in .env.`);
    }
  }

  // Validate eagerly so a typo fails at startup, not in the browser.
  cfg.corsOriginList = Object.freeze(parseCorsOrigins(cfg.corsOrigins));
  return cfg;
}
