import { BlockList, isIP } from 'node:net';

import { Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsString, Min, validateSync } from 'class-validator';

const INSECURE_SECRET_KEY = 'change-me-in-production';

/** The database CONTRIBUTING tells you to create, so a fresh clone runs with no .env at all. */
export const DEFAULT_DATABASE_URL = 'postgresql://orchestr:orchestr@localhost:5432/orchestr_svc';

/** Where the client runs in development — the one default behind CORS, azp and the OAuth redirect. */
const DEFAULT_CLIENT_ORIGIN = 'http://localhost:3100';

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const family = isIP(host);
  if (family === 0) return host === 'localhost';
  return LOOPBACK.check(host, family === 4 ? 'ipv4' : 'ipv6');
}

/** True when DATABASE_URL targets a local host; an unparseable DSN counts as local. */
function isLocalDatabaseHost(databaseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    return true; // can't parse a host → don't block boot on it
  }
  return host === '' || isLoopbackHost(host);
}

function httpUrl(value: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  return ['http:', 'https:'].includes(parsed.protocol) && parsed.hostname ? parsed : null;
}

/** Parse CORS_ORIGINS; each origin must be an http(s) URL with a hostname, else throws at startup. */
export function parseCorsOrigins(raw: string): string[] {
  const origins: string[] = [];
  for (const part of raw.split(',')) {
    const origin = part.trim();
    if (!origin) continue;
    if (!httpUrl(origin)) {
      throw new Error(
        `Invalid CORS origin ${JSON.stringify(origin)} in CORS_ORIGINS — ` +
          'each origin must be an http(s) URL like https://app.example.com',
      );
    }
    origins.push(origin);
  }
  return origins;
}

/** Parse a provider API base URL: http(s), a hostname, no query or fragment; trailing slashes dropped, else throws at startup. */
export function parseApiBaseUrl(name: string, raw: string): string {
  const value = raw.trim();
  const parsed = httpUrl(value);
  if (!parsed) {
    throw new Error(
      `Invalid ${name} ${JSON.stringify(raw)} — it must be an http(s) URL with a hostname, like https://api.example.com`,
    );
  }
  // Requests append their path, so even a bare `?` or `#` swallows it; the value may hold a key, so it is not echoed.
  if (/[?#]/.test(value)) {
    throw new Error(`${name} (${parsed.origin}${parsed.pathname}) must not carry a query string or fragment`);
  }
  return value.replace(/\/+$/, '');
}

function assertSecretStaysOffPlaintext(name: string, url: string): void {
  const { protocol, hostname } = new URL(url);
  if (protocol === 'http:' && !isLoopbackHost(hostname)) {
    throw new Error(
      `${name} must be https in production — every request to it carries an API secret; plain http only reaches this machine.`,
    );
  }
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

  /** Proxy hops in front of the service whose X-Forwarded-For entry is trusted; 0 = the socket peer is the client. */
  @IsInt()
  @Min(0)
  trustProxyHops = 0;

  /** The interface to listen on; empty = every interface. */
  @IsString()
  listenHost = '';

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

  /** Clerk Backend API base URL — overridable so tests can point at a stub. */
  @IsString()
  clerkApiUrl = 'https://api.clerk.com';

  /** Comma-separated azp allow-list; empty skips the azp check. */
  @IsString()
  clerkAuthorizedParties = DEFAULT_CLIENT_ORIGIN;

  /**
   * Email + password sign-in. Defaults ON so a self-hoster can reach their own instance,
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

  /** Open-core edition flag: gates ee-only wiring, never core logic. */
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

function asInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`${name} must be a whole number, got ${JSON.stringify(value)}`);
  return n;
}

/** TRUST_PROXY_HOPS, or the replaced TRUST_PROXY_HEADERS flag read as one hop; never suggests a value that shares a bucket. */
function proxyHops(raw: Record<string, string | undefined>): number {
  const hops = raw.TRUST_PROXY_HOPS?.trim() ?? '';
  const legacy = asBool(raw.TRUST_PROXY_HEADERS, false);
  const logger = new Logger('EnvConfig');
  if (hops === '') {
    if (legacy) {
      logger.warn(
        "TRUST_PROXY_HEADERS=true is read as TRUST_PROXY_HOPS=1 — remove it, and set TRUST_PROXY_HOPS=1 instead only if this service sits behind a proxy of your own rather than Sarati's",
      );
    }
    return legacy ? 1 : 0;
  }
  if (legacy) logger.warn('TRUST_PROXY_HEADERS is ignored because TRUST_PROXY_HOPS is set — remove it');
  if (/^\d+$/.test(hops)) return Number(hops);
  const flag = hops.toLowerCase();
  if (flag === 'true' || flag === 'false') {
    const read = flag === 'true' ? 1 : 0;
    logger.warn(`TRUST_PROXY_HOPS counts proxy hops — "${hops}" is read as ${read}; write the number`);
    return read;
  }
  throw new Error(
    `TRUST_PROXY_HOPS must be a whole number of proxy hops (0, 1, 2 …), got ${JSON.stringify(hops)}`,
  );
}

/** Parse the process env into an EnvConfig; fails fast at boot on invalid values and prod guards. */
export function validateEnv(raw: Record<string, string | undefined>): EnvConfig {
  // Drop undefined-valued keys so class defaults apply (plainToInstance would overwrite them).
  const provided = Object.fromEntries(
    Object.entries({
      environment: (raw.ENVIRONMENT ?? 'development').trim().toLowerCase(),
      port: asInt('PORT', raw.PORT, 8001),
      databaseUrl: raw.DATABASE_URL || DEFAULT_DATABASE_URL,
      corsOrigins: raw.CORS_ORIGINS || undefined,
      secretKey: raw.SECRET_KEY || INSECURE_SECRET_KEY,
      fernetKey: raw.FERNET_KEY ?? '',
      trustProxyHops: proxyHops(raw),
      listenHost: raw.LISTEN_HOST?.trim() ?? '',
      maxRequestBodyBytes: asInt('MAX_REQUEST_BODY_BYTES', raw.MAX_REQUEST_BODY_BYTES, 2_097_152),
      pgBossEnabled: asBool(raw.PGBOSS_ENABLED, true),
      dbosEnabled: asBool(raw.DBOS_ENABLED, false),
      dbosSystemDatabaseUrl: raw.DBOS_SYSTEM_DATABASE_URL ?? '',
      dbosAppVersion: raw.DBOS_APP_VERSION ?? '',
      dbosExecutorId: raw.DBOS_EXECUTOR_ID ?? '',
      triggerPollIntervalSeconds: asInt(
        'TRIGGER_POLL_INTERVAL_SECONDS',
        raw.TRIGGER_POLL_INTERVAL_SECONDS,
        60,
      ),
      runMaxDurationSeconds: asInt('RUN_MAX_DURATION_SECONDS', raw.RUN_MAX_DURATION_SECONDS, 3600),
      publicBaseUrl: raw.PUBLIC_BASE_URL ?? '',
      clerkIssuer: raw.CLERK_ISSUER ?? '',
      clerkSecretKey: raw.CLERK_SECRET_KEY ?? '',
      clerkApiUrl: raw.CLERK_API_URL ? parseApiBaseUrl('CLERK_API_URL', raw.CLERK_API_URL) : undefined,
      clerkAuthorizedParties: raw.CLERK_AUTHORIZED_PARTIES ?? undefined,
      localAuthEnabled: asBool(raw.LOCAL_AUTH_ENABLED, !raw.CLERK_ISSUER),
      oidcIssuer: raw.OIDC_ISSUER ?? '',
      oidcJwksUrl: raw.OIDC_JWKS_URL ?? '',
      oidcAudience: raw.OIDC_AUDIENCE ?? '',
      mockAuth: asBool(raw.MOCK_AUTH, false),
      composioBaseUrl: raw.COMPOSIO_BASE_URL
        ? parseApiBaseUrl('COMPOSIO_BASE_URL', raw.COMPOSIO_BASE_URL)
        : undefined,
      composioFallbackApps: raw.COMPOSIO_FALLBACK_APPS ?? '',
      edition: (raw.EDITION ?? 'oss').trim().toLowerCase(),
      frontendUrl: raw.FRONTEND_URL || DEFAULT_CLIENT_ORIGIN,
      throttleLimit: asInt('THROTTLE_LIMIT', raw.THROTTLE_LIMIT, 60),
      throttleTtlMs: asInt('THROTTLE_TTL_MS', raw.THROTTLE_TTL_MS, 60_000),
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
    if (cfg.clerkSecretKey) assertSecretStaysOffPlaintext('CLERK_API_URL', cfg.clerkApiUrl);
    assertSecretStaysOffPlaintext('COMPOSIO_BASE_URL', cfg.composioBaseUrl);
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
