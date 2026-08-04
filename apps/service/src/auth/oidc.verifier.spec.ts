import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { exportJWK, generateKeyPair, type KeyLike, SignJWT } from 'jose';

import { TokenExpiredError } from './auth.errors';
import { OidcVerifier } from './oidc.verifier';
import type { VerifiedIdentity } from './token-verifier';

interface OidcEnv {
  oidcIssuer: string;
  oidcJwksUrl: string;
  oidcAudience: string;
}

function makeVerifier(env: OidcEnv): OidcVerifier {
  const config = { get: () => env } as unknown as ConstructorParameters<typeof OidcVerifier>[0];
  return new OidcVerifier(config);
}

describe('OidcVerifier', () => {
  const ISSUER = 'https://idp.example.com';
  let jwksServer: Server;
  let jwksUrl: string;
  let privateKey: KeyLike;

  beforeAll(async () => {
    const { publicKey, privateKey: priv } = await generateKeyPair('RS256');
    privateKey = priv;
    const jwk = { ...(await exportJWK(publicKey)), kid: 'test-kid', alg: 'RS256', use: 'sig' };
    jwksServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
    jwksUrl = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/jwks`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => jwksServer.close((e) => (e ? reject(e) : resolve())));
  });

  const sign = (claims: Record<string, unknown>, expiry = '5m'): Promise<string> =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuer(ISSUER)
      .setSubject(typeof claims.sub === 'string' ? claims.sub : 'user-1')
      .setIssuedAt()
      .setExpirationTime(expiry)
      .sign(privateKey);

  const env = (over: Partial<OidcEnv> = {}): OidcEnv => ({
    oidcIssuer: ISSUER,
    oidcJwksUrl: jwksUrl,
    oidcAudience: '',
    ...over,
  });

  it('is inert (returns null) when OIDC_ISSUER is unset', async () => {
    const token = await sign({ sub: 'user-1', email: 'a@b.com' });
    expect(await makeVerifier(env({ oidcIssuer: '' })).verify(token)).toBeNull();
  });

  it('passes through (returns null) a token from a different issuer', async () => {
    const foreign = await new SignJWT({ sub: 'x' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuer('https://other-idp.com')
      .setSubject('x')
      .setExpirationTime('5m')
      .sign(privateKey);
    expect(await makeVerifier(env()).verify(foreign)).toBeNull();
  });

  it('returns null for a non-JWT bearer token (not ours to reject)', async () => {
    expect(await makeVerifier(env()).verify('ork_not_a_jwt')).toBeNull();
  });

  it('verifies a valid token and provisions from sub/email/name claims (verified email)', async () => {
    const token = await sign({ sub: 'user-42', email: 'jane@corp.com', email_verified: true, name: 'Jane' });
    const identity: VerifiedIdentity | null = await makeVerifier(env()).verify(token);
    expect(identity).toEqual({ clerkUserId: 'user-42', email: 'jane@corp.com', name: 'Jane' });
  });

  it('ignores an UNVERIFIED email claim (adopt-by-email takeover guard)', async () => {
    // email present but unverified → synthetic email that cannot adopt an existing account.
    const token = await sign({ sub: 'user-42', email: 'victim@corp.com', name: 'Jane' });
    const identity = await makeVerifier(env()).verify(token);
    expect(identity).toEqual({ clerkUserId: 'user-42', email: 'user-42@oidc.local', name: 'Jane' });
  });

  it('falls back to a synthetic email/name when the claims are absent', async () => {
    const token = await sign({ sub: 'user-99' });
    const identity = await makeVerifier(env()).verify(token);
    expect(identity).toEqual({
      clerkUserId: 'user-99',
      email: 'user-99@oidc.local',
      name: 'user-99@oidc.local',
    });
  });

  it('throws TokenExpiredError for an expired token', async () => {
    const token = await sign({ sub: 'user-1', email: 'a@b.com' }, '-1m');
    await expect(makeVerifier(env()).verify(token)).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it('rejects a token whose audience does not match', async () => {
    const token = await new SignJWT({ sub: 'user-1', email: 'a@b.com', aud: 'wrong-aud' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuer(ISSUER)
      .setSubject('user-1')
      .setExpirationTime('5m')
      .sign(privateKey);
    await expect(makeVerifier(env({ oidcAudience: 'expected-aud' })).verify(token)).rejects.toThrow();
  });
});
