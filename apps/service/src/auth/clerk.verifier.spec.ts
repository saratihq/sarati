import { SignJWT } from 'jose';

import { ClerkVerifier } from './clerk.verifier';

interface ClerkEnv {
  clerkIssuer: string;
  clerkAuthorizedParties: string;
}

function makeVerifier(env: ClerkEnv): ClerkVerifier {
  const config = { get: () => env } as unknown as ConstructorParameters<typeof ClerkVerifier>[0];
  return new ClerkVerifier(config);
}

/**
 * The `TokenVerifier` contract: return null for a token shape you don't handle, throw only for
 * tokens you own. Clerk breaking it poisons every verifier behind it in the chain — today it is
 * last, which is the only reason that was survivable.
 */
describe('ClerkVerifier — declines what it does not own', () => {
  const ISSUER = 'https://clerk.example.com';

  const signedBy = async (issuer: string): Promise<string> =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(issuer)
      .setSubject('user_1')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('irrelevant-secret'));

  it('is inert when CLERK_ISSUER is unset, rather than rejecting the token', async () => {
    const verifier = makeVerifier({ clerkIssuer: '', clerkAuthorizedParties: '' });
    await expect(verifier.verify(await signedBy('orchestr:local'))).resolves.toBeNull();
  });

  it("passes another issuer's token to the next verifier", async () => {
    const verifier = makeVerifier({ clerkIssuer: ISSUER, clerkAuthorizedParties: '' });
    await expect(verifier.verify(await signedBy('orchestr:local'))).resolves.toBeNull();
  });

  it('declines a token that is not a JWT at all', async () => {
    const verifier = makeVerifier({ clerkIssuer: ISSUER, clerkAuthorizedParties: '' });
    await expect(verifier.verify('not-a-jwt')).resolves.toBeNull();
  });
});
