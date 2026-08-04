import { createHmac } from 'node:crypto';
import { FernetError, fernetDecrypt, fernetEncrypt } from './fernet';

/** Cross-compat fixtures from Python's cryptography library — a throwaway TEST key, safe to commit. */
const PYTHON_KEY = 'JOYyPENpghMweYV_xJd2gIL-bx8JC5nj_uZ0RuiTSBs=';
const PYTHON_TOKEN =
  'gAAAAABqSTB-wDVwQeA6-FN_op8UJqY_ZjiiJ9vOfMAYV6Lmm1cY6vkCe1wa1YMh2MWCh34Wz1B41vLZKh_eBNM9a9O2d6Xe0de_1Ugxgfx1PrSbi-VBFCQ=';
const PYTHON_PLAINTEXT = 'cross-compat: hello from python';

/** Token binary layout: [0] version, [1..8] timestamp, [9..24] IV, [25..-33] ciphertext, last 32 HMAC. */
const decodeToken = (token: string): Buffer => Buffer.from(token.replace(/=+$/, ''), 'base64url');

/** XOR one byte of a token; returns it base64url UNPADDED (decrypt must accept both paddings). */
const flipByte = (token: string, index: number): string => {
  const data = decodeToken(token);
  data.writeUInt8(data.readUInt8(index) ^ 0x01, index);
  return data.toString('base64url');
};

/** Overwrite a token's timestamp and re-sign it with the fixture key, so only the timestamp differs. */
const resignWithTimestamp = (token: string, key: string, timestamp: bigint): string => {
  const data = decodeToken(token);
  data.writeBigUInt64BE(timestamp, 1);
  const signingKey = decodeToken(key).subarray(0, 16);
  createHmac('sha256', signingKey)
    .update(data.subarray(0, data.length - 32))
    .digest()
    .copy(data, data.length - 32);
  return data.toString('base64url');
};

describe('fernet', () => {
  describe('round-trip', () => {
    it.each([
      ['ascii', 'hello world'],
      ['unicode', 'héllo wörld — ✓ 日本語 🎉'],
      ['empty string', ''],
      ['exactly one AES block', '0123456789abcdef'],
      ['long', 'x'.repeat(10_000)],
    ])('encrypt→decrypt returns the original plaintext (%s)', (_label, plaintext) => {
      const key = PYTHON_KEY;
      expect(fernetDecrypt(key, fernetEncrypt(key, plaintext))).toBe(plaintext);
    });

    it('emits base64url with = padding and the 0x80 version prefix, matching Python byte-format', () => {
      // Empty plaintext → 73 token bytes → base64 length 100 ending in '==', deterministic.
      const token = fernetEncrypt(PYTHON_KEY, '');
      expect(token).toMatch(/^gAAAAA[A-Za-z0-9_-]+==$/);
      expect(token.length % 4).toBe(0);
      expect(token).not.toMatch(/[+/]/);
    });
  });

  describe('cross-compatibility with Python cryptography.Fernet', () => {
    it('decrypts a token produced by Python', () => {
      expect(fernetDecrypt(PYTHON_KEY, PYTHON_TOKEN)).toBe(PYTHON_PLAINTEXT);
    });

    it('decrypts the same Python token without base64 padding', () => {
      expect(fernetDecrypt(PYTHON_KEY, PYTHON_TOKEN.replace(/=+$/, ''))).toBe(PYTHON_PLAINTEXT);
    });

    it('round-trips with the Python fixture key (reverse direction verified against Python once)', () => {
      const plaintext = 'ts->py: héllo from node ✓';
      expect(fernetDecrypt(PYTHON_KEY, fernetEncrypt(PYTHON_KEY, plaintext))).toBe(plaintext);
    });

    it('ignores the timestamp entirely, like Python decrypt(ttl=None)', () => {
      const epochZero = resignWithTimestamp(PYTHON_TOKEN, PYTHON_KEY, 0n);
      const farFuture = resignWithTimestamp(PYTHON_TOKEN, PYTHON_KEY, 0xffffffffffffffffn);
      expect(fernetDecrypt(PYTHON_KEY, epochZero)).toBe(PYTHON_PLAINTEXT);
      expect(fernetDecrypt(PYTHON_KEY, farFuture)).toBe(PYTHON_PLAINTEXT);
    });
  });

  describe('tampering and invalid input', () => {
    it('rejects a token with a flipped ciphertext byte', () => {
      expect(() => fernetDecrypt(PYTHON_KEY, flipByte(PYTHON_TOKEN, 30))).toThrow(FernetError);
    });

    it('rejects a token with a flipped HMAC byte', () => {
      const lastIndex = decodeToken(PYTHON_TOKEN).length - 1;
      expect(() => fernetDecrypt(PYTHON_KEY, flipByte(PYTHON_TOKEN, lastIndex))).toThrow(FernetError);
    });

    it('rejects a token with a flipped IV byte', () => {
      expect(() => fernetDecrypt(PYTHON_KEY, flipByte(PYTHON_TOKEN, 10))).toThrow(FernetError);
    });

    it('rejects a token whose version byte is not 0x80', () => {
      expect(() => fernetDecrypt(PYTHON_KEY, flipByte(PYTHON_TOKEN, 0))).toThrow(FernetError);
    });

    it('rejects decryption with a different (valid) key', () => {
      const otherKey = Buffer.alloc(32, 7).toString('base64url');
      expect(() => fernetDecrypt(otherKey, PYTHON_TOKEN)).toThrow(FernetError);
    });

    it.each([
      ['plain garbage', 'not-a-fernet-token!!'],
      ['empty string', ''],
      ['padding only', '==='],
      ['bad base64 length', 'A'],
      ['valid base64 but too short', 'gAAAAAAA'],
      ['whitespace', '  \n'],
    ])('rejects garbage token input (%s)', (_label, token) => {
      expect(() => fernetDecrypt(PYTHON_KEY, token)).toThrow(FernetError);
    });

    it.each([
      ['not base64', '!!!not-a-key!!!'],
      ['wrong length', Buffer.alloc(16, 1).toString('base64url')],
      ['empty', ''],
    ])('rejects a bad key (%s) on both encrypt and decrypt', (_label, badKey) => {
      expect(() => fernetEncrypt(badKey, 'x')).toThrow(FernetError);
      expect(() => fernetDecrypt(badKey, PYTHON_TOKEN)).toThrow(FernetError);
    });
  });
});
