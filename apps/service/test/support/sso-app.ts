import { createHash, randomBytes } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { listenOnLoopback } from './listen';

/** The SECRET_KEY every single sign-on suite signs its sessions with. */
export const SSO_SECRET_KEY = 'an-e2e-secret-key-for-single-sign-on-sessions';

/** Where the client would be — nothing listens there; the provider's redirect to it is read, never followed. */
export const FRONTEND_URL = 'http://127.0.0.1:3999';
export const REDIRECT_URI = `${FRONTEND_URL}/auth/oidc/callback`;

const BOOT_VARS = [
  'DATABASE_URL',
  'PGBOSS_ENABLED',
  'DBOS_ENABLED',
  'THROTTLE_LIMIT',
  'MOCK_AUTH',
  'CLERK_ISSUER',
  'SECRET_KEY',
  'FRONTEND_URL',
  'TRUST_PROXY_HOPS',
  'LOCAL_AUTH_ENABLED',
  'OIDC_ISSUER',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_ALLOWED_DOMAINS',
  'OIDC_JWKS_URL',
  'OIDC_AUDIENCE',
];

/** Put back every variable {@link bootSsoApp} sets, so no later suite in this worker boots with single sign-on on. */
export function snapshotEnv(): () => void {
  const saved = Object.fromEntries(BOOT_VARS.map((name) => [name, process.env[name]]));
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/** Boot the service on `databaseUrl` with exactly `env` on top of the e2e base; unlisted sign-in variables are unset. */
export async function bootSsoApp(
  databaseUrl: string,
  env: Record<string, string>,
): Promise<INestApplication> {
  for (const name of BOOT_VARS) delete process.env[name];
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl,
    PGBOSS_ENABLED: 'false',
    DBOS_ENABLED: 'false',
    THROTTLE_LIMIT: '10000',
    MOCK_AUTH: 'false',
    SECRET_KEY: SSO_SECRET_KEY,
    FRONTEND_URL,
    // The per-route sign-in limits count per client address; each flow below names its own.
    TRUST_PROXY_HOPS: '1',
    ...env,
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
  configureApp(app);
  await app.init();
  await listenOnLoopback(app);
  return app;
}

/** A tab's binding and the hash it sends to /start. */
export function newBinding(): { binding: string; bindingHash: string } {
  const binding = randomBytes(32).toString('base64url');
  return { binding, bindingHash: createHash('sha256').update(binding).digest('base64url') };
}

let addresses = 0;

/** A client address no other flow in this run has used, so no flow shares another's rate-limit bucket. */
export function clientAddress(): string {
  addresses += 1;
  return `198.18.${Math.floor(addresses / 250) % 250}.${(addresses % 250) + 1}`;
}

/** A request from its own client address. */
export function from(
  app: INestApplication,
  address = clientAddress(),
): {
  get: (path: string) => request.Test;
  post: (path: string) => request.Test;
  delete: (path: string) => request.Test;
} {
  const server = (): ReturnType<typeof request> => request(app.getHttpServer());
  return {
    get: (path) => server().get(path).set('X-Forwarded-For', address),
    post: (path) => server().post(path).set('X-Forwarded-For', address),
    delete: (path) => server().delete(path).set('X-Forwarded-For', address),
  };
}
