import { parseCorsOrigins, validateEnv } from './env.config';

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
    const prod = {
      ENVIRONMENT: 'production',
      DATABASE_URL: 'postgresql://u:p@db.example.com:5432/orchestr',
      FERNET_KEY: 'x',
      SECRET_KEY: 'real-secret',
      DBOS_ENABLED: 'true',
      DBOS_APP_VERSION: 'orchestr-1',
    };
    expect(() => validateEnv(prod)).not.toThrow();
    expect(() => validateEnv({ ...prod, SECRET_KEY: undefined })).toThrow(/SECRET_KEY/);
    expect(() => validateEnv({ ...prod, FERNET_KEY: undefined })).toThrow(/FERNET_KEY/);
    expect(() => validateEnv({ ...prod, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });

  it('production fails closed on durability: DBOS_ENABLED and a stable DBOS_APP_VERSION are required', () => {
    const prod = {
      ENVIRONMENT: 'production',
      DATABASE_URL: 'postgresql://u:p@db.example.com:5432/orchestr',
      FERNET_KEY: 'x',
      SECRET_KEY: 'real-secret',
      DBOS_ENABLED: 'true',
      DBOS_APP_VERSION: 'orchestr-1',
    };
    expect(() => validateEnv({ ...prod, DBOS_ENABLED: 'false' })).toThrow(/DBOS_ENABLED/);
    expect(() => validateEnv({ ...prod, DBOS_ENABLED: undefined })).toThrow(/DBOS_ENABLED/);
    expect(() => validateEnv({ ...prod, DBOS_APP_VERSION: undefined })).toThrow(/DBOS_APP_VERSION/);
  });

  it('refuses to run dev-mode against a non-local database (prod DB, insecure defaults)', () => {
    expect(() => validateEnv({ DATABASE_URL: 'postgresql://u:p@db.example.com:5432/orchestr' })).toThrow(
      /non-local host/,
    );
    // A local database in development is fine.
    expect(() => validateEnv({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/orchestr_svc' })).not.toThrow();
    expect(() => validateEnv({ DATABASE_URL: 'postgresql://u:p@localhost:5432/orchestr_svc' })).not.toThrow();
  });

  it('normalizes environment casing (Production must not bypass guards)', () => {
    expect(() =>
      validateEnv({ ENVIRONMENT: 'Production', DATABASE_URL: 'postgresql://u:p@h:5/d', FERNET_KEY: 'x' }),
    ).toThrow(/SECRET_KEY/);
  });
});
