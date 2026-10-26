import { SignJWT } from 'jose';

import { InvalidTokenError, TokenExpiredError } from '../auth.errors';
import { LOCAL_ISSUER, mintSession, readSession, sessionRefusal } from './local-session';
import { LocalSessionVerifier } from './local-session.verifier';

const SECRET = 'a-test-secret-that-is-long-enough';
const IDP = 'https://idp.example.com/';

interface Doors {
  localAuthEnabled: boolean;
  oidcSignInEnabled?: boolean;
  oidcIssuer?: string;
}

function makeVerifier(env: Doors): LocalSessionVerifier {
  const full = { oidcSignInEnabled: false, oidcIssuer: '', ...env, secretKey: SECRET };
  const config = { get: () => full } as unknown as ConstructorParameters<typeof LocalSessionVerifier>[0];
  return new LocalSessionVerifier(config);
}

async function signed(claims: Record<string, unknown>, lifetime = 3600): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(LOCAL_ISSUER)
    .setSubject('user_1')
    .setIssuedAt(now - 60)
    .setExpirationTime(now + lifetime)
    .sign(new TextEncoder().encode(SECRET));
}

describe('local session — an expired one reports as expired', () => {
  it('rethrows expiry rather than swallowing it into "not a local session"', async () => {
    await expect(readSession(await signed({}, -60), SECRET)).rejects.toThrow();
  });

  it('the verifier turns that into TokenExpiredError, so the 401 can say so', async () => {
    const verifier = makeVerifier({ localAuthEnabled: true });
    await expect(verifier.verify(await signed({}, -60))).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it('still declines a token signed with a DIFFERENT secret — that one is not ours', async () => {
    const verifier = makeVerifier({ localAuthEnabled: true });
    const foreign = await mintSession('user_1', 'a-completely-different-secret-value');
    await expect(verifier.verify(foreign.token)).resolves.toBeNull();
  });

  it('accepts a live session', async () => {
    const verifier = makeVerifier({ localAuthEnabled: true });
    const live = await mintSession('user_1', SECRET);
    await expect(verifier.verify(live.token)).resolves.toEqual({ userId: 'user_1' });
  });
});

describe('local session — the method it was signed in with', () => {
  it('names the method in the token, and the issuer only for single sign-on', async () => {
    const password = await readSession((await mintSession('user_1', SECRET)).token, SECRET);
    expect(password).toEqual({ userId: 'user_1', via: { method: 'password' } });
    const sso = await readSession(
      (await mintSession('user_1', SECRET, { method: 'oidc', idp: IDP })).token,
      SECRET,
    );
    expect(sso).toEqual({ userId: 'user_1', via: { method: 'oidc', idp: IDP } });
  });

  it('reads a token minted before methods were named as a password session', async () => {
    expect(await readSession(await signed({}), SECRET)).toEqual({
      userId: 'user_1',
      via: { method: 'password' },
    });
  });

  it('declines a method it does not know, and single sign-on without its issuer', async () => {
    expect(await readSession(await signed({ method: 'magic-link' }), SECRET)).toBeNull();
    expect(await readSession(await signed({ method: 'oidc' }), SECRET)).toBeNull();
    expect(await readSession(await signed({ method: 'oidc', idp: '' }), SECRET)).toBeNull();
  });

  it('accepts each method only while it is on, and single sign-on only from the configured issuer', () => {
    const open = { passwords: true, ssoIssuer: IDP };
    expect(sessionRefusal({ method: 'password' }, open)).toBeNull();
    expect(sessionRefusal({ method: 'oidc', idp: IDP }, open)).toBeNull();
    expect(sessionRefusal({ method: 'password' }, { passwords: false, ssoIssuer: IDP })).toMatch(/password/);
    expect(sessionRefusal({ method: 'oidc', idp: IDP }, { passwords: true, ssoIssuer: null })).toMatch(/off/);
    expect(sessionRefusal({ method: 'oidc', idp: 'https://other.example.com/' }, open)).toMatch(/other/);
    expect(sessionRefusal({ method: 'oidc', idp: 'https://idp.example.com' }, open)).toMatch(/other/);
  });

  it('the verifier refuses a session whose method is off rather than passing it on', async () => {
    const ssoOnly = makeVerifier({ localAuthEnabled: false, oidcSignInEnabled: true, oidcIssuer: IDP });
    const password = await mintSession('user_1', SECRET);
    await expect(ssoOnly.verify(password.token)).rejects.toBeInstanceOf(InvalidTokenError);
    const sso = await mintSession('user_1', SECRET, { method: 'oidc', idp: IDP });
    await expect(ssoOnly.verify(sso.token)).resolves.toEqual({ userId: 'user_1' });

    const passwordsOnly = makeVerifier({ localAuthEnabled: true });
    await expect(passwordsOnly.verify(sso.token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('is inert when neither method is on', async () => {
    const neither = makeVerifier({ localAuthEnabled: false });
    await expect(neither.verify((await mintSession('user_1', SECRET)).token)).resolves.toBeNull();
  });
});
