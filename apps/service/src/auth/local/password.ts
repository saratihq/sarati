import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/** `promisify` drops scrypt's options overload, so the cost parameters need their own wrapper. */
function derive(password: string, salt: Buffer, keyBytes: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyBytes, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Cost parameters (OWASP-acceptable for scrypt); stored per hash so they can be raised later. */
const N = 32_768;
const R = 8;
const P = 1;
const KEY_BYTES = 64;
const SALT_BYTES = 16;
/** 128·N·r is just over Node's 32 MiB default, which fails with "memory limit exceeded". */
const MAX_MEM = 128 * 1024 * 1024;

/** Below this a password is guessable; length beats composition rules (NIST SP 800-63B). */
export const MIN_PASSWORD_LENGTH = 12;

/** `scrypt$N$r$p$salt$hash` — self-describing, so raising the cost never invalidates stored hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, KEY_BYTES, { N, r: R, p: P, maxmem: MAX_MEM });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Constant-time verification; a malformed or foreign-scheme hash is a mismatch, never a throw. */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  const key = await derive(password, parsed.salt, parsed.hash.length, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p,
    maxmem: MAX_MEM,
  });
  return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
}

interface Parsed {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parse(stored: string | null): Parsed | null {
  if (!stored) return null;
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return null;
  const parsed = {
    n: Number(n),
    r: Number(r),
    p: Number(p),
    salt: Buffer.from(salt, 'base64'),
    hash: Buffer.from(hash, 'base64'),
  };
  const sane = [parsed.n, parsed.r, parsed.p].every((v) => Number.isInteger(v) && v > 0);
  return sane && parsed.salt.length > 0 && parsed.hash.length > 0 ? parsed : null;
}
