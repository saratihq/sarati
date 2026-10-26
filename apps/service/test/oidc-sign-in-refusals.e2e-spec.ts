import { randomUUID } from 'node:crypto';

import { type INestApplication, Logger } from '@nestjs/common';
import { generateKeyPair, UnsecuredJWT } from 'jose';
import { Client } from 'pg';

import { mintSession } from '../src/auth/local/local-session';
import { OidcRelyingParty } from '../src/auth/oidc/oidc-relying-party';
import { HostileIdp } from './support/hostile-idp';
import { bootService, freePort, THIS_SERVICE } from './support/service-process';
import {
  FRONTEND_URL,
  SSO_SECRET_KEY,
  bootSsoApp,
  clientAddress,
  from,
  newBinding,
  snapshotEnv,
} from './support/sso-app';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

interface Flow {
  binding: string;
  state: string;
  nonce: string;
  address: string;
  authorizeUrl: URL;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const DISCOVERY_PATH = '/tenant/.well-known/openid-configuration';

/** Every refusal the relying party owes, against a provider whose answers each test sets: status and code, nothing created, and the operator's log line. */
describe('single sign-on refusals against a hostile provider (e2e, isolated DB)', () => {
  const idp = new HostileIdp();
  let app: INestApplication;
  let db: Client;
  let databaseUrl: string;
  let restoreEnv: () => void;
  let warn: jest.SpyInstance;
  const bindings: string[] = [];
  const logLines: string[] = [];

  const ssoEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
    OIDC_ISSUER: idp.issuer,
    OIDC_CLIENT_ID: idp.clientId,
    OIDC_CLIENT_SECRET: idp.clientSecret,
    ...extra,
  });

  const warned = (): string[] => warn.mock.calls.map((call) => String(call[0]));

  async function begin(path = '/api/auth/oidc/start', token?: string): Promise<Flow> {
    const address = clientAddress();
    const { binding, bindingHash } = newBinding();
    bindings.push(binding);
    const req = from(app, address).post(path);
    if (token) void req.set('Authorization', `Bearer ${token}`);
    const res = await req.send({ binding_hash: bindingHash }).expect(200);
    const authorizeUrl = new URL(res.body.authorize_url as string);
    return {
      binding,
      state: res.body.state as string,
      nonce: authorizeUrl.searchParams.get('nonce')!,
      address,
      authorizeUrl,
    };
  }

  function claimsFor(flow: Flow, over: Record<string, unknown> = {}): Record<string, unknown> {
    const now = nowSeconds();
    return {
      iss: idp.issuer,
      aud: idp.clientId,
      sub: `sub-${randomUUID()}`,
      nonce: flow.nonce,
      iat: now,
      exp: now + 300,
      auth_time: now,
      email: `${randomUUID()}@example.com`,
      email_verified: true,
      ...over,
    };
  }

  function finish(
    flow: Flow,
    over: { code?: string; iss?: string | null; binding?: string; state?: string } = {},
    path = '/api/auth/oidc/complete',
    token?: string,
  ) {
    const req = from(app, flow.address).post(path);
    if (token) void req.set('Authorization', `Bearer ${token}`);
    const iss = over.iss === null ? {} : { iss: over.iss ?? idp.issuer };
    return req.send({
      code: over.code ?? 'the-code',
      state: over.state ?? flow.state,
      binding: over.binding ?? flow.binding,
      ...iss,
    });
  }

  async function rows(): Promise<number[]> {
    const counts: number[] = [];
    for (const table of ['users', 'user_identities', 'org_members', 'organizations']) {
      const res = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      counts.push(res.rows[0]!.n);
    }
    return counts;
  }

  /** Complete `flow` and expect the refusal: its status and code, and nothing created. */
  async function refused(
    flow: Flow,
    status: number,
    code: string,
    over: Parameters<typeof finish>[1] = {},
  ): Promise<Record<string, unknown>> {
    const before = await rows();
    const res = await finish(flow, over);
    expect({ status: res.status, code: res.body.code }).toEqual({ status, code });
    expect(await rows()).toEqual(before);
    return res.body as Record<string, unknown>;
  }

  async function idTokenRefused(
    flow: Flow,
    claims: Record<string, unknown>,
    reason: RegExp,
    opts: Parameters<HostileIdp['sign']>[1] = {},
  ) {
    idp.answerWith(claims, opts);
    await refused(flow, 401, 'oidc_token_rejected');
    expect(warned().at(-1)).toMatch(reason);
  }

  async function bareUser(): Promise<{ id: string; session: string }> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, $2, 'Bare', now(), now())`,
      [id, `${id}@example.com`],
    );
    return {
      id,
      session: (await mintSession(id, SSO_SECRET_KEY, { method: 'oidc', idp: idp.issuer })).token,
    };
  }

  beforeAll(async () => {
    restoreEnv = snapshotEnv();
    await idp.start();
    databaseUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    app = await bootSsoApp(databaseUrl, ssoEnv());
    warn = jest.spyOn(Logger.prototype, 'warn');
  }, 60_000);

  beforeEach(() => {
    idp.reset();
    app.get(OidcRelyingParty).forget();
    logLines.push(...warned());
    warn.mockClear();
  });

  afterAll(async () => {
    warn?.mockRestore();
    await app?.close();
    await db?.end();
    await idp.stop();
    restoreEnv();
  });

  it('signs in through it when it behaves: an issuer with a trailing slash kept verbatim, the client authenticated with Basic', async () => {
    const flow = await begin();
    expect(flow.authorizeUrl.origin + flow.authorizeUrl.pathname).toBe(`${idp.base}/tenant/authorize`);
    expect(Object.fromEntries(flow.authorizeUrl.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: idp.clientId,
      redirect_uri: 'http://127.0.0.1:3999/auth/oidc/callback',
      scope: 'openid email profile',
      code_challenge_method: 'S256',
      state: flow.state,
    });
    idp.answerWith(claimsFor(flow, { email: 'First@Example.com', name: 'First' }));
    const res = await finish(flow);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: 'first@example.com', name: 'First' });

    const [exchange] = idp.sent('/tenant/token');
    const [scheme, credentials] = String(exchange!.headers.authorization).split(' ');
    expect(scheme).toBe('Basic');
    const [id, secret] = Buffer.from(credentials!, 'base64').toString('utf8').split(':');
    const decode = (v: string): string => decodeURIComponent(v.replace(/\+/g, '%20'));
    expect([decode(id!), decode(secret!)]).toEqual([idp.clientId, idp.clientSecret]);
    const form = new URLSearchParams(exchange!.body);
    expect(form.get('client_secret')).toBeNull();
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('redirect_uri')).toBe('http://127.0.0.1:3999/auth/oidc/callback');
    expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('sends the client credentials in the body when the provider lists only client_secret_post', async () => {
    idp.discovery.token_endpoint_auth_methods_supported = ['client_secret_post'];
    const flow = await begin();
    idp.answerWith(claimsFor(flow));
    expect((await finish(flow)).status).toBe(200);
    const [exchange] = idp.sent('/tenant/token');
    expect(exchange!.headers.authorization).toBeUndefined();
    const form = new URLSearchParams(exchange!.body);
    expect([form.get('client_id'), form.get('client_secret')]).toEqual([idp.clientId, idp.clientSecret]);
  });

  describe('the state', () => {
    it('refuses an unknown, a spent, an expired, or another tab’s state alike — before any call to the provider', async () => {
      const unknown = await begin();
      const a = await refused(unknown, 400, 'oidc_state_invalid', {
        state: 'not-a-state-this-instance-issued',
      });

      const replayed = await begin();
      idp.answerWith(claimsFor(replayed));
      expect((await finish(replayed)).status).toBe(200);
      const b = await refused(replayed, 400, 'oidc_state_invalid');

      const expired = await begin();
      await db.query(`UPDATE oidc_login_states SET expires_at = now() - interval '1 second'`);
      const c = await refused(expired, 400, 'oidc_state_invalid');

      const otherTab = await begin();
      const d = await refused(otherTab, 400, 'oidc_state_invalid', { binding: newBinding().binding });
      const e = await refused(otherTab, 400, 'oidc_state_invalid');

      expect(new Set([a, b, c, d, e].map((body) => JSON.stringify(body))).size).toBe(1);
      expect(idp.sent('/tenant/token')).toHaveLength(1);
    });

    it('keeps sign-in and link flows apart, and a link flow to the account that started it', async () => {
      const ann = await bareUser();
      const ben = await bareUser();

      const signIn = await begin();
      const crossedIntoLink = await finish(signIn, {}, '/api/auth/oidc/link/complete', ann.session);
      expect({ status: crossedIntoLink.status, code: crossedIntoLink.body.code }).toEqual({
        status: 400,
        code: 'oidc_state_invalid',
      });

      const link = await begin('/api/auth/oidc/link/start', ann.session);
      await refused(link, 400, 'oidc_state_invalid');

      const annsLink = await begin('/api/auth/oidc/link/start', ann.session);
      const byBen = await finish(annsLink, {}, '/api/auth/oidc/link/complete', ben.session);
      expect({ status: byBen.status, code: byBen.body.code }).toEqual({
        status: 400,
        code: 'oidc_state_invalid',
      });

      expect(idp.sent('/tenant/token')).toHaveLength(0);
      const identities = await db.query(`SELECT 1 FROM user_identities WHERE user_id = ANY($1::uuid[])`, [
        [ann.id, ben.id],
      ]);
      expect(identities.rows).toEqual([]);
    });
  });

  describe('connecting, which needs the person to sign in at the provider again', () => {
    const params = (flow: Flow): Record<string, string> => Object.fromEntries(flow.authorizeUrl.searchParams);

    it('asks for a fresh sign-in on a link — max_age=0, and prompt=login only where the provider lists it — and on a sign-in neither', async () => {
      const ann = await bareUser();
      const signIn = params(await begin());
      expect([signIn.max_age, signIn.prompt]).toEqual([undefined, undefined]);
      const unlisted = params(await begin('/api/auth/oidc/link/start', ann.session));
      expect([unlisted.max_age, unlisted.prompt]).toEqual(['0', undefined]);

      idp.discovery.prompt_values_supported = ['none', 'login', 'consent'];
      app.get(OidcRelyingParty).forget();
      const listed = params(await begin('/api/auth/oidc/link/start', ann.session));
      expect([listed.max_age, listed.prompt]).toEqual(['0', 'login']);
      expect(params(await begin()).prompt).toBeUndefined();
    });

    it('refuses a link whose ID token shows no sign-in since the link began, or no auth_time at all, connecting nothing', async () => {
      const ann = await bareUser();
      const cases: Array<[Record<string, unknown>, RegExp]> = [
        [
          { auth_time: nowSeconds() - 10 * 60 },
          /signed the person in at .* before this connection began \(auth_time\)/,
        ],
        [{ auth_time: undefined }, /carries no auth_time, though max_age=0 asked for one/],
        [{ auth_time: String(nowSeconds()) }, /carries no auth_time, though max_age=0 asked for one/],
      ];
      for (const [over, reason] of cases) {
        const link = await begin('/api/auth/oidc/link/start', ann.session);
        idp.answerWith(claimsFor(link, over));
        const res = await finish(link, {}, '/api/auth/oidc/link/complete', ann.session);
        expect({ status: res.status, code: res.body.code }).toEqual({
          status: 401,
          code: 'oidc_reauthentication_required',
        });
        expect(res.body.detail).toContain('sign in');
        expect(warned().at(-1)).toMatch(reason);
      }
      const connected = await db.query(`SELECT 1 FROM user_identities WHERE user_id = $1`, [ann.id]);
      expect(connected.rows).toEqual([]);

      const fresh = await begin('/api/auth/oidc/link/start', ann.session);
      idp.answerWith(claimsFor(fresh, { auth_time: nowSeconds() - 30 }));
      const linked = await finish(fresh, {}, '/api/auth/oidc/link/complete', ann.session);
      expect(linked.status).toBe(200);
    });

    it('signs in without auth_time — only a link asks for one', async () => {
      const flow = await begin();
      idp.answerWith(claimsFor(flow, { auth_time: undefined }));
      expect((await finish(flow)).status).toBe(200);
    });
  });

  describe('the authorization response', () => {
    it('refuses an iss naming another issuer — a mix-up', async () => {
      const flow = await begin();
      idp.answerWith(claimsFor(flow));
      await refused(flow, 401, 'oidc_token_rejected', { iss: idp.issuer.replace(/\/$/, '') });
      expect(warned().at(-1)).toMatch(/names issuer .* not OIDC_ISSUER — a mix-up/);
      expect(idp.sent('/tenant/token')).toHaveLength(0);
    });

    it('requires iss when the provider advertises it, and goes without it when it does not', async () => {
      const flow = await begin();
      idp.answerWith(claimsFor(flow));
      await refused(flow, 401, 'oidc_token_rejected', { iss: null });
      expect(warned().at(-1)).toMatch(/carries no iss/);

      idp.discovery.authorization_response_iss_parameter_supported = false;
      app.get(OidcRelyingParty).forget();
      const quiet = await begin();
      idp.answerWith(claimsFor(quiet));
      expect((await finish(quiet, { iss: null })).status).toBe(200);
    });
  });

  describe('the token endpoint', () => {
    it('reads a refused code as a rejection, naming only the provider’s error code to the operator', async () => {
      idp.token = () => ({
        status: 400,
        headers: { 'content-type': 'application/json' },
        body: '{"error":"invalid_grant","error_description":"secret detail"}',
      });
      await refused(await begin(), 401, 'oidc_token_rejected');
      expect(warned().at(-1)).toMatch(/refused the code \(400\): invalid_grant$/);
    });

    it('reads every other failure as the provider being unavailable', async () => {
      idp.token = () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"access_token":"x"}',
      });
      await refused(await begin(), 502, 'oidc_unavailable');
      expect(warned().at(-1)).toMatch(/without an ID token/);

      idp.token = () => ({ status: 200, body: 'not json' });
      await refused(await begin(), 502, 'oidc_unavailable');

      idp.token = () => ({ status: 500, body: 'down' });
      await refused(await begin(), 502, 'oidc_unavailable');
      expect(warned().at(-1)).toMatch(/answered 500 to the code exchange/);

      idp.token = () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id_token: 'x', pad: 'p'.repeat(70_000) }),
      });
      await refused(await begin(), 502, 'oidc_unavailable');
      expect(warned().at(-1)).toMatch(/more than 64 KB/);
    });

    it('never follows a redirect', async () => {
      idp.token = () => ({ status: 302, headers: { location: `${idp.base}/tenant/elsewhere` } });
      await refused(await begin(), 502, 'oidc_unavailable');
      expect(idp.sent('/tenant/elsewhere')).toHaveLength(0);
    });

    it('answers 502 when the token endpoint refuses the connection', async () => {
      idp.discovery.token_endpoint = `http://127.0.0.1:${await freePort()}/token`;
      await refused(await begin(), 502, 'oidc_unavailable');
      expect(warned().at(-1)).toMatch(/could not be reached/);
    });
  });

  describe('the ID token', () => {
    it('refuses another issuer, another audience, and an audience list that names no authorized party', async () => {
      let flow = await begin();
      await idTokenRefused(flow, claimsFor(flow, { iss: `${idp.base}/tenant` }), /"iss" claim/);
      flow = await begin();
      await idTokenRefused(flow, claimsFor(flow, { aud: 'someone-else' }), /"aud" claim/);
      flow = await begin();
      await idTokenRefused(
        flow,
        claimsFor(flow, { aud: [idp.clientId, 'another-api'] }),
        /several audiences and no authorized party/,
      );
      flow = await begin();
      await idTokenRefused(
        flow,
        claimsFor(flow, { azp: 'someone-else' }),
        /issued to another client \(azp\)/,
      );
    });

    it('accepts an audience list whose authorized party is this client', async () => {
      const flow = await begin();
      idp.answerWith(claimsFor(flow, { aud: [idp.clientId, 'another-api'], azp: idp.clientId }));
      expect((await finish(flow)).status).toBe(200);
    });

    it('refuses an expired token, one issued too long ago, and one from beyond the clock tolerance — naming the clock', async () => {
      const now = nowSeconds();
      let flow = await begin();
      await idTokenRefused(
        flow,
        claimsFor(flow, { iat: now - 600, exp: now - 120 }),
        /has expired \(exp\).*clock/,
      );
      flow = await begin();
      await idTokenRefused(
        flow,
        claimsFor(flow, { iat: now - 12 * 60 }),
        /issued too long ago \(iat\).*clock/,
      );
      flow = await begin();
      await idTokenRefused(flow, claimsFor(flow, { iat: now + 90 }), /iat is out of range.*clock/);
      flow = await begin();
      await idTokenRefused(flow, claimsFor(flow, { nbf: now + 90 }), /nbf is out of range.*clock/);
    });

    it('accepts a provider clock 30 seconds ahead', async () => {
      const flow = await begin();
      idp.answerWith(claimsFor(flow, { iat: nowSeconds() + 30, nbf: nowSeconds() + 30 }));
      expect((await finish(flow)).status).toBe(200);
    });

    it('refuses a token answering another sign-in, or none (nonce)', async () => {
      let flow = await begin();
      await idTokenRefused(
        flow,
        claimsFor(flow, { nonce: 'another-flows-nonce' }),
        /answers another sign-in \(nonce\)/,
      );
      flow = await begin();
      await idTokenRefused(flow, claimsFor(flow, { nonce: undefined }), /missing required "nonce" claim/);
    });

    it('refuses alg none, HS256 keyed by the client secret or by the public key, and a key it does not publish', async () => {
      let flow = await begin();
      idp.token = () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id_token: new UnsecuredJWT(claimsFor(flow)).encode() }),
      });
      await refused(flow, 401, 'oidc_token_rejected');

      flow = await begin();
      await idTokenRefused(flow, claimsFor(flow), /failed verification/, {
        header: { alg: 'HS256' },
        key: new TextEncoder().encode(idp.clientSecret),
      });
      flow = await begin();
      await idTokenRefused(flow, claimsFor(flow), /failed verification/, {
        header: { alg: 'HS256' },
        key: new TextEncoder().encode(JSON.stringify(idp.jwk)),
      });
      flow = await begin();
      const rogue = await generateKeyPair('RS256');
      await idTokenRefused(flow, claimsFor(flow), /failed verification/, {
        header: { kid: 'rogue-key' },
        key: rogue.privateKey,
      });
    });

    it('refuses an access token passed off as an ID token (typ at+jwt)', async () => {
      const flow = await begin();
      await idTokenRefused(flow, claimsFor(flow), /typ at\+jwt/, { header: { typ: 'at+jwt' } });
    });

    it('refuses a token naming no usable subject', async () => {
      let flow = await begin();
      await idTokenRefused(flow, claimsFor(flow, { sub: undefined }), /missing required "sub" claim/);
      flow = await begin();
      await idTokenRefused(flow, claimsFor(flow, { sub: 's'.repeat(256) }), /no usable subject/);
      flow = await begin();
      await idTokenRefused(flow, claimsFor(flow, { sub: 'line\nbreak' }), /no usable subject/);
    });
  });

  describe('UserInfo, when the ID token holds the email back', () => {
    it('reads the email from UserInfo with the access token', async () => {
      const flow = await begin();
      const claims = claimsFor(flow, { email: undefined, email_verified: undefined });
      idp.answerWith(claims);
      idp.userinfo = () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sub: claims.sub, email: 'From.Userinfo@example.com', email_verified: true }),
      });
      const res = await finish(flow);
      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe('from.userinfo@example.com');
      expect(idp.sent('/tenant/userinfo')[0]!.headers.authorization).toBe('Bearer an-access-token');
    });

    it('refuses UserInfo answering for another subject, and reads its failure as unavailable', async () => {
      let flow = await begin();
      idp.answerWith(claimsFor(flow, { email: undefined }));
      idp.userinfo = () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sub: 'someone-else', email: 'x@example.com' }),
      });
      await refused(flow, 401, 'oidc_token_rejected');
      expect(warned().at(-1)).toMatch(/answered for another subject/);

      flow = await begin();
      idp.answerWith(claimsFor(flow, { email: undefined }));
      idp.userinfo = () => ({ status: 500, body: 'down' });
      await refused(flow, 502, 'oidc_unavailable');
    });

    it('reads UserInfo refusing the access token as a rejection', async () => {
      const flow = await begin();
      idp.answerWith(claimsFor(flow, { email: undefined }));
      idp.userinfo = () => ({ status: 401, body: '' });
      await refused(flow, 401, 'oidc_token_rejected');
      expect(warned().at(-1)).toMatch(/UserInfo endpoint refused the access token \(401\)/);
    });
  });

  describe("the provider's keys", () => {
    it('reads a key set it cannot fetch as the provider being unavailable, and reads discovery afresh after', async () => {
      idp.jwks = () => ({ status: 500, body: 'down' });
      const flow = await begin();
      idp.answerWith(claimsFor(flow));
      await refused(flow, 502, 'oidc_unavailable');
      expect(warned().at(-1)).toMatch(/keys \(jwks_uri\) could not be read/);
      const fetched = idp.sent(DISCOVERY_PATH).length;
      await begin();
      expect(idp.sent(DISCOVERY_PATH)).toHaveLength(fetched + 1);
    });

    it('reads a key set behind a closed port as the provider being unavailable', async () => {
      idp.discovery.jwks_uri = `http://127.0.0.1:${await freePort()}/jwks`;
      const flow = await begin();
      idp.answerWith(claimsFor(flow));
      await refused(flow, 502, 'oidc_unavailable');
      expect(warned().at(-1)).toMatch(/keys \(jwks_uri\) could not be read/);
    });
  });

  describe('discovery', () => {
    async function startRefused(reason: RegExp): Promise<void> {
      const res = await from(app)
        .post('/api/auth/oidc/start')
        .send({ binding_hash: newBinding().bindingHash });
      expect({ status: res.status, code: res.body.code }).toEqual({ status: 502, code: 'oidc_unavailable' });
      expect(warned().at(-1)).toMatch(reason);
      app.get(OidcRelyingParty).forget();
    }

    it('refuses a document naming another issuer, even a trailing slash apart', async () => {
      idp.discovery.issuer = idp.issuer.replace(/\/$/, '');
      await startRefused(/names issuer .* they must match exactly, trailing slash included/);
    });

    it('refuses a document missing an endpoint, a provider without PKCE S256, or one signing with none of the accepted algorithms', async () => {
      delete idp.discovery.jwks_uri;
      await startRefused(/jwks_uri is missing/);
      idp.reset();
      idp.discovery.code_challenge_methods_supported = ['plain'];
      await startRefused(/does not support PKCE S256/);
      idp.reset();
      idp.discovery.id_token_signing_alg_values_supported = ['HS256', 'none'];
      await startRefused(/signs ID tokens with none of RS256, PS256, ES256/);
      idp.reset();
      idp.discovery.token_endpoint_auth_methods_supported = ['private_key_jwt'];
      await startRefused(/accepts neither client_secret_basic nor client_secret_post/);
    });

    it('never follows a redirect off the discovery URL', async () => {
      idp.discoveryReply = () => ({ status: 302, headers: { location: `${idp.base}/tenant/elsewhere` } });
      await startRefused(/answered 302, not the discovery document/);
      expect(idp.sent('/tenant/elsewhere')).toHaveLength(0);
    });
  });

  describe('admission', () => {
    it('admits an email the provider did not verify while no domains are set, and refuses an unusable one', async () => {
      let flow = await begin();
      idp.answerWith(claimsFor(flow, { email_verified: 'true' }));
      expect((await finish(flow)).status).toBe(200);

      flow = await begin();
      idp.answerWith(claimsFor(flow, { email: `${'x'.repeat(250)}@example.com` }));
      await refused(flow, 403, 'oidc_email_missing');
      flow = await begin();
      idp.answerWith(claimsFor(flow, { email: 'not an email' }));
      await refused(flow, 403, 'oidc_email_missing');
      for (const email of ['a\u0000b@example.com', 'a\u001b[31mb@example.com', 'a\u202eb@example.com']) {
        flow = await begin();
        idp.answerWith(claimsFor(flow, { email }));
        await refused(flow, 403, 'oidc_email_missing');
      }
    });

    it('keeps control and format characters, a direction override among them, out of a name the provider gives', async () => {
      const flow = await begin();
      idp.answerWith(claimsFor(flow, { name: '\u200bAdmin\u202egnp.exe\u0007' }));
      const res = await finish(flow);
      expect(res.status).toBe(200);
      expect(res.body.user.name).toBe('Admingnp.exe');
    });

    describe('with OIDC_ALLOWED_DOMAINS', () => {
      beforeAll(async () => {
        await app.close();
        app = await bootSsoApp(databaseUrl, ssoEnv({ OIDC_ALLOWED_DOMAINS: 'example.com' }));
      }, 30_000);

      it('needs email_verified to be exactly true, naming the claim', async () => {
        for (const verified of [false, undefined, 'true', 1]) {
          const flow = await begin();
          idp.answerWith(claimsFor(flow, { email_verified: verified }));
          const body = await refused(flow, 403, 'oidc_email_unverified');
          expect(body.detail).toContain('email_verified');
        }
      });

      it('refuses a verified address at another domain, or a subdomain', async () => {
        for (const email of ['a@example.org', 'a@eng.example.com']) {
          const flow = await begin();
          idp.answerWith(claimsFor(flow, { email }));
          await refused(flow, 403, 'oidc_domain_not_allowed');
        }
      });

      it('holds a link to the same rule, connecting nothing', async () => {
        const ann = await bareUser();
        const cases: Array<[Record<string, unknown>, string]> = [
          [{ email: 'a@example.org' }, 'oidc_domain_not_allowed'],
          [{ email_verified: false }, 'oidc_email_unverified'],
        ];
        for (const [over, code] of cases) {
          const link = await begin('/api/auth/oidc/link/start', ann.session);
          idp.answerWith(claimsFor(link, over));
          const res = await finish(link, {}, '/api/auth/oidc/link/complete', ann.session);
          expect({ status: res.status, code: res.body.code }).toEqual({ status: 403, code });
        }
        const identities = await db.query(`SELECT 1 FROM user_identities WHERE user_id = $1`, [ann.id]);
        expect(identities.rows).toEqual([]);
      });
    });
  });

  describe('in production', () => {
    it('refuses a discovery document naming a plain-http endpoint off this machine, and never calls it', async () => {
      idp.discovery.token_endpoint = 'http://idp.invalid/token';
      const service = await bootService({
        service: THIS_SERVICE,
        databaseUrl: await createE2eDatabase(ADMIN_URL),
        env: {
          ...ssoEnv({ OIDC_ALLOWED_DOMAINS: '' }),
          ENVIRONMENT: 'production',
          MOCK_AUTH: 'false',
          SECRET_KEY: SSO_SECRET_KEY,
          FERNET_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          DBOS_APP_VERSION: 'e2e-production',
          FRONTEND_URL,
        },
      });
      try {
        const res = await fetch(`${service.base}/api/auth/oidc/start`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ binding_hash: newBinding().bindingHash }),
        });
        expect({ status: res.status, code: ((await res.json()) as { code?: string }).code }).toEqual({
          status: 502,
          code: 'oidc_unavailable',
        });
        expect(service.log()).toMatch(/token_endpoint is plain http, which production refuses/);
        expect(idp.sent(DISCOVERY_PATH)).toHaveLength(1);
      } finally {
        await service.crash();
      }
    }, 120_000);
  });

  it('never writes a secret, a token, a code or a binding to the log', () => {
    const log = [...logLines, ...warned()].join('\n');
    expect(log).toMatch(/Single sign-on refused/);
    expect(log).not.toContain(idp.clientSecret);
    expect(log).not.toMatch(/eyJ|an-access-token|the-code|secret detail/);
    for (const binding of bindings) expect(log).not.toContain(binding);
  });
});
