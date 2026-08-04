/**
 * Fernet (https://github.com/fernet/spec) over node:crypto, byte-compatible with Python's
 * `cryptography.fernet.Fernet`; key = base64url(16-byte HMAC key || 16-byte AES-128-CBC key).
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Thrown for any invalid Fernet key or token. */
export class FernetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FernetError';
  }
}

const VERSION = 0x80;
const KEY_LENGTH = 32;
const HEADER_LENGTH = 1 + 8; // version byte + big-endian unix-seconds timestamp
const IV_LENGTH = 16;
const HMAC_LENGTH = 32;
const MIN_TOKEN_LENGTH = HEADER_LENGTH + IV_LENGTH + HMAC_LENGTH;

interface FernetKey {
  readonly signingKey: Buffer;
  readonly encryptionKey: Buffer;
}

/** Decode base64url, tolerating present or absent '=' padding. Returns null on invalid input. */
function b64urlDecode(value: string): Buffer | null {
  const unpadded = value.replace(/=+$/, '');
  if (!/^[A-Za-z0-9_-]*$/.test(unpadded) || unpadded.length % 4 === 1) {
    return null;
  }
  return Buffer.from(unpadded, 'base64url');
}

/** Encode base64url WITH '=' padding, matching Python's `base64.urlsafe_b64encode` output. */
function b64urlEncode(data: Buffer): string {
  return data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Split a base64url-encoded 32-byte Fernet key into its signing and encryption halves. */
function splitKey(key: string): FernetKey {
  const raw = b64urlDecode(key);
  if (raw === null || raw.length !== KEY_LENGTH) {
    throw new FernetError('Fernet key must be 32 url-safe base64-encoded bytes');
  }
  return { signingKey: raw.subarray(0, 16), encryptionKey: raw.subarray(16) };
}

/** HMAC-SHA256 over the signed portion of a token (everything before the trailing 32 bytes). */
function sign(signingKey: Buffer, payload: Buffer): Buffer {
  return createHmac('sha256', signingKey).update(payload).digest();
}

/** Encrypt UTF-8 `plaintext` into a Fernet token under a base64url 32-byte `key`. */
export function fernetEncrypt(key: string, plaintext: string): string {
  const { signingKey, encryptionKey } = splitKey(key);
  const header = Buffer.alloc(HEADER_LENGTH);
  header.writeUInt8(VERSION, 0);
  header.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)), 1);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-128-cbc', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const payload = Buffer.concat([header, iv, ciphertext]);
  return b64urlEncode(Buffer.concat([payload, sign(signingKey, payload)]));
}

/** STRUCTURAL check only (no HMAC/decrypt): tells an undecryptable real token — which must fail
 *  closed — apart from a value stored as plaintext before encryption was enabled. */
export function looksLikeFernetToken(value: string): boolean {
  const data = b64urlDecode(value);
  return data !== null && data.length >= MIN_TOKEN_LENGTH && data.readUInt8(0) === VERSION;
}

/** Decrypt a Fernet token to UTF-8; the embedded timestamp is NOT checked, so tokens never expire. */
export function fernetDecrypt(key: string, token: string): string {
  const { signingKey, encryptionKey } = splitKey(key);
  const data = b64urlDecode(token);
  if (data === null) {
    throw new FernetError('Invalid token: not base64url');
  }
  if (data.length < MIN_TOKEN_LENGTH) {
    throw new FernetError('Invalid token: too short');
  }
  if (data.readUInt8(0) !== VERSION) {
    throw new FernetError('Invalid token: unknown version');
  }
  const payload = data.subarray(0, data.length - HMAC_LENGTH);
  const expectedHmac = data.subarray(data.length - HMAC_LENGTH);
  if (!timingSafeEqual(sign(signingKey, payload), expectedHmac)) {
    throw new FernetError('Invalid token: signature mismatch');
  }
  const iv = payload.subarray(HEADER_LENGTH, HEADER_LENGTH + IV_LENGTH);
  const ciphertext = payload.subarray(HEADER_LENGTH + IV_LENGTH);
  try {
    const decipher = createDecipheriv('aes-128-cbc', encryptionKey, iv);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new FernetError('Invalid token: decryption failed');
  }
}
