import { MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from './password';

describe('local password hashing', () => {
  it('accepts the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPassword('Correct horse battery staple', stored)).toBe(false);
  }, 20_000);

  it('salts per password, so identical passwords do not share a hash', async () => {
    const [a, b] = await Promise.all([hashPassword('same password'), hashPassword('same password')]);
    expect(a).not.toEqual(b);
    expect(await verifyPassword('same password', a)).toBe(true);
    expect(await verifyPassword('same password', b)).toBe(true);
  }, 20_000);

  it('names its own cost parameters, so they can be raised without invalidating stored hashes', async () => {
    const [scheme, n, r, p] = (await hashPassword('a password here')).split('$');
    expect(scheme).toBe('scrypt');
    expect(Number(n)).toBeGreaterThanOrEqual(32_768);
    expect([Number(r), Number(p)]).toEqual([8, 1]);
  }, 20_000);

  /** A user with no password (Clerk/OIDC-provisioned) must never be loggable-in by any input. */
  it('treats a missing or foreign hash as a mismatch rather than throwing', async () => {
    expect(await verifyPassword('anything', null)).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
    expect(await verifyPassword('anything', 'mock-hash-from-the-python-app')).toBe(false);
    expect(await verifyPassword('anything', '$2b$12$abcdefghijklmnopqrstuv')).toBe(false);
    expect(await verifyPassword('anything', 'scrypt$0$0$0$$')).toBe(false);
  }, 20_000);

  it('states a minimum length rather than composition rules', () => {
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(12);
  });
});
