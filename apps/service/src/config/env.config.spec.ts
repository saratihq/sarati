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

  describe('TRUST_PROXY_HOPS', () => {
    const warned = (): string[] =>
      warn.mock.calls.map((call) => String(call[0])).filter((text) => text.includes('TRUST_PROXY'));
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => warn.mockRestore());

    it('defaults to trusting no proxy, and reads a whole number as given', () => {
      expect(validateEnv({}).trustProxyHops).toBe(0);
      expect(validateEnv({ TRUST_PROXY_HOPS: '2' }).trustProxyHops).toBe(2);
      expect(warned()).toEqual([]);
    });

    it('reads the old flag renamed — "true" as 1, "false" as 0 — and says to write the number', () => {
      expect(validateEnv({ TRUST_PROXY_HOPS: 'true' }).trustProxyHops).toBe(1);
      expect(validateEnv({ TRUST_PROXY_HOPS: 'FALSE' }).trustProxyHops).toBe(0);
      expect(warned()).toEqual([
        'TRUST_PROXY_HOPS counts proxy hops — "true" is read as 1; write the number',
        'TRUST_PROXY_HOPS counts proxy hops — "FALSE" is read as 0; write the number',
      ]);
    });

    it.each(['-1', '1.5', '1e1', 'two'])('refuses %j, naming the variable', (value) => {
      expect(() => validateEnv({ TRUST_PROXY_HOPS: value })).toThrow(
        `TRUST_PROXY_HOPS must be a whole number of proxy hops (0, 1, 2 …), got ${JSON.stringify(value)}`,
      );
    });

    it('reads TRUST_PROXY_HEADERS=true as one hop, and ignores it beside TRUST_PROXY_HOPS', () => {
      expect(validateEnv({ TRUST_PROXY_HEADERS: 'true' }).trustProxyHops).toBe(1);
      expect(validateEnv({ TRUST_PROXY_HEADERS: 'true', TRUST_PROXY_HOPS: '1' }).trustProxyHops).toBe(1);
      expect(warned()).toEqual([
        "TRUST_PROXY_HEADERS=true is read as TRUST_PROXY_HOPS=1 — remove it. Sarati's stack files set TRUST_PROXY_HOPS themselves, so a stack missing it runs an old stack file: re-run the installer. Set TRUST_PROXY_HOPS=1 yourself only for an image run behind a proxy of your own.",
        'TRUST_PROXY_HEADERS is ignored because TRUST_PROXY_HOPS is set — remove it',
      ]);
    });

    it('says nothing about TRUST_PROXY_HEADERS=false', () => {
      expect(validateEnv({ TRUST_PROXY_HEADERS: 'false' }).trustProxyHops).toBe(0);
      expect(warned()).toEqual([]);
    });
  });

  it('names the variable when a number is not one', () => {
    expect(() => validateEnv({ PORT: 'eighty' })).toThrow('PORT must be a whole number, got "eighty"');
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

  it('refuses a base URL carrying a username or password, naming only its origin and path', () => {
    for (const name of ['COMPOSIO_BASE_URL', 'CLERK_API_URL']) {
      for (const bad of [
        'https://proxyuser:SEKRET@proxy.example.com/c',
        'https://proxyuser@proxy.example.com/c',
      ]) {
        expect(() => validateEnv({ [name]: bad })).toThrow(
          `${name} (https://proxy.example.com/c) must not carry a username or password`,
        );
        expect(() => validateEnv({ [name]: bad })).not.toThrow(/proxyuser|SEKRET/);
      }
    }
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
