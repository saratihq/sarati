import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';

import { parseCorsOrigins, validateEnv, warnRetiredEnv } from './env.config';

const PROD = {
  ENVIRONMENT: 'production',
  DATABASE_URL: 'postgresql://u:p@db.example.com:5432/orchestr',
  FERNET_KEY: 'x',
  SECRET_KEY: 'real-secret',
  DBOS_ENABLED: 'true',
  DBOS_APP_VERSION: 'orchestr-1',
};

describe('env config', () => {
  it('applies defaults', () => {
    const cfg = validateEnv({});
    expect(cfg.port).toBe(8001);
    expect(cfg.environment).toBe('development');
    expect(cfg.maxRequestBodyBytes).toBe(2_097_152);
    expect(cfg.corsOriginList).toContain('http://localhost:3100');
    expect(cfg.frontendUrl).toBe('http://localhost:3100');
    expect(cfg.clerkAuthorizedParties).toBe('http://localhost:3100');
  });

  it('rejects invalid CORS origins loudly at boot', () => {
    expect(() => validateEnv({ CORS_ORIGINS: 'not-a-url' })).toThrow(/Invalid CORS origin/);
    expect(() => parseCorsOrigins('ftp://x.com')).toThrow(/Invalid CORS origin/);
  });

  it('production guards: default SECRET_KEY, missing FERNET_KEY, default DATABASE_URL', () => {
    expect(() => validateEnv(PROD)).not.toThrow();
    expect(() => validateEnv({ ...PROD, SECRET_KEY: undefined })).toThrow(/SECRET_KEY/);
    expect(() => validateEnv({ ...PROD, FERNET_KEY: undefined })).toThrow(/FERNET_KEY/);
    expect(() => validateEnv({ ...PROD, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });

  it('production fails closed on durability: DBOS_ENABLED and a stable DBOS_APP_VERSION are required', () => {
    expect(() => validateEnv({ ...PROD, DBOS_ENABLED: 'false' })).toThrow(/DBOS_ENABLED/);
    expect(() => validateEnv({ ...PROD, DBOS_ENABLED: undefined })).toThrow(/DBOS_ENABLED/);
    expect(() => validateEnv({ ...PROD, DBOS_APP_VERSION: undefined })).toThrow(/DBOS_APP_VERSION/);
  });

  it('parses provider API base URLs at boot: http(s) with a hostname, trailing slashes dropped', () => {
    expect(validateEnv({}).clerkApiUrl).toBe('https://api.clerk.com');
    expect(validateEnv({}).composioBaseUrl).toBe('https://backend.composio.dev');
    expect(validateEnv({ CLERK_API_URL: 'http://127.0.0.1:9/' }).clerkApiUrl).toBe('http://127.0.0.1:9');
    expect(validateEnv({ COMPOSIO_BASE_URL: 'https://proxy.example.com/composio//' }).composioBaseUrl).toBe(
      'https://proxy.example.com/composio',
    );
    for (const bad of ['api.clerk.com', 'not a url', 'ftp://api.clerk.com']) {
      expect(() => validateEnv({ CLERK_API_URL: bad })).toThrow(
        /CLERK_API_URL .* must be an http\(s\) URL with a hostname/,
      );
      expect(() => validateEnv({ COMPOSIO_BASE_URL: bad })).toThrow(
        /COMPOSIO_BASE_URL .* must be an http\(s\) URL with a hostname/,
      );
    }
  });

  it('refuses a base URL carrying a query string or fragment, even an empty one, without echoing it', () => {
    for (const bad of [
      'https://proxy.example.com/c?',
      'https://proxy.example.com/c#',
      'https://proxy.example.com/c?apikey=SEKRET',
    ]) {
      expect(() => validateEnv({ COMPOSIO_BASE_URL: bad })).toThrow(
        'COMPOSIO_BASE_URL (https://proxy.example.com/c) must not carry a query string or fragment',
      );
    }
    expect(() => validateEnv({ COMPOSIO_BASE_URL: 'https://proxy.example.com/c?apikey=SEKRET' })).not.toThrow(
      /SEKRET/,
    );
  });

  it('production keeps an API secret off plaintext: http only to this machine, and Clerk only once it holds a secret', () => {
    for (const local of ['http://localhost:15001', 'http://127.0.0.1:15001', 'http://[::1]:15001']) {
      expect(() => validateEnv({ ...PROD, COMPOSIO_BASE_URL: local })).not.toThrow();
      expect(() => validateEnv({ ...PROD, CLERK_SECRET_KEY: 'sk', CLERK_API_URL: local })).not.toThrow();
    }
    expect(() => validateEnv({ ...PROD, COMPOSIO_BASE_URL: 'http://composio.internal:9900' })).toThrow(
      /COMPOSIO_BASE_URL must be https in production/,
    );
    expect(() =>
      validateEnv({ ...PROD, CLERK_SECRET_KEY: 'sk', CLERK_API_URL: 'http://clerk-mock:8080' }),
    ).toThrow(/CLERK_API_URL must be https in production/);
    expect(() => validateEnv({ ...PROD, CLERK_API_URL: 'http://clerk-mock:8080' })).not.toThrow();
  });

  it('.env.example lists every variable validateEnv reads', () => {
    const read = new Set<string>();
    validateEnv(
      new Proxy<Record<string, string | undefined>>(
        {},
        {
          get: (_, key) => {
            if (typeof key === 'string') read.add(key);
            return undefined;
          },
        },
      ),
    );
    const example = readFileSync(join(__dirname, '..', '..', '.env.example'), 'utf8');
    const listed = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
    expect([...read].filter((key) => !listed.has(key))).toEqual([]);
  });

  it('warns once that COMPOSIO_FALLBACK_APPS does nothing when it is set, and is silent when it is not', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      warnRetiredEnv({ COMPOSIO_FALLBACK_APPS: 'zoom,jira' });
      expect(warn.mock.calls).toEqual([
        ['COMPOSIO_FALLBACK_APPS is no longer supported and has no effect. Remove it from .env.'],
      ]);
      warn.mockClear();
      warnRetiredEnv({});
      warnRetiredEnv({ COMPOSIO_FALLBACK_APPS: ' ' });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses to run dev-mode against a non-local database (prod DB, insecure defaults)', () => {
    expect(() => validateEnv({ DATABASE_URL: 'postgresql://u:p@db.example.com:5432/orchestr' })).toThrow(
      /non-local host/,
    );
    // A local database in development is fine.
    expect(() => validateEnv({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/orchestr_svc' })).not.toThrow();
    expect(() => validateEnv({ DATABASE_URL: 'postgresql://u:p@localhost:5432/orchestr_svc' })).not.toThrow();
    expect(() => validateEnv({ DATABASE_URL: 'postgresql://u:p@127.0.0.2:5432/orchestr_svc' })).not.toThrow();
  });

  it('normalizes environment casing (Production must not bypass guards)', () => {
    expect(() =>
      validateEnv({ ENVIRONMENT: 'Production', DATABASE_URL: 'postgresql://u:p@h:5/d', FERNET_KEY: 'x' }),
    ).toThrow(/SECRET_KEY/);
  });
});
