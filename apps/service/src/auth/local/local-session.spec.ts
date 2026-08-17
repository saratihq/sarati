import { SignJWT } from 'jose';

import { TokenExpiredError } from '../auth.errors';
import { LOCAL_ISSUER, mintSession, readSession } from './local-session';
import { LocalSessionVerifier } from './local-session.verifier';

const SECRET = 'a-test-secret-that-is-long-enough';

function makeVerifier(env: { localAuthEnabled: boolean; secretKey: string }): LocalSessionVerifier {
  const config = { get: () => env } as unknown as ConstructorParameters<typeof LocalSessionVerifier>[0];
  return new LocalSessionVerifier(config);
}

async function expiredSession(secret: string): Promise<string> {
  const past = Math.floor(Date.now() / 1000) - 60;
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(LOCAL_ISSUER)
    .setSubject('user_1')
    .setIssuedAt(past - 60)
    .setExpirationTime(past)
    .sign(new TextEncoder().encode(secret));
}

describe('local session — an expired one reports as expired', () => {
  it('rethrows expiry rather than swallowing it into "not a local session"', async () => {
    await expect(readSession(await expiredSession(SECRET), SECRET)).rejects.toThrow();
  });

  it('the verifier turns that into TokenExpiredError, so the 401 can say so', async () => {
    const verifier = makeVerifier({ localAuthEnabled: true, secretKey: SECRET });
    await expect(verifier.verify(await expiredSession(SECRET))).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it('still declines a token signed with a DIFFERENT secret — that one is not ours', async () => {
    const verifier = makeVerifier({ localAuthEnabled: true, secretKey: SECRET });
    const foreign = await mintSession('user_1', 'a-completely-different-secret-value');
    await expect(verifier.verify(foreign.token)).resolves.toBeNull();
  });

  it('accepts a live session', async () => {
    const verifier = makeVerifier({ localAuthEnabled: true, secretKey: SECRET });
    const live = await mintSession('user_1', SECRET);
    await expect(verifier.verify(live.token)).resolves.toEqual({ userId: 'user_1' });
  });
});
