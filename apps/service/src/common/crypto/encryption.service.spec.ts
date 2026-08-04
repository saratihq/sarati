import { randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';

import type { EnvConfig } from '../../config/env.config';
import { EncryptionService } from './encryption.service';
import { FernetError, fernetEncrypt } from './fernet';

const freshKey = (): string => randomBytes(32).toString('base64url');

const service = (fernetKey: string | null): EncryptionService =>
  new EncryptionService({
    get: () => ({ fernetKey }),
  } as unknown as ConfigService<{ env: EnvConfig }, true>);

describe('EncryptionService.decryptToken', () => {
  it('round-trips a value it encrypted', () => {
    const svc = service(freshKey());
    const token = svc.encryptToken('super-secret');
    expect(svc.decryptToken(token)).toBe('super-secret');
  });

  it('passes a pre-encryption plaintext value through (parity: not a Fernet token)', () => {
    const svc = service(freshKey());
    // A raw OAuth/PAT-shaped value stored before encryption was enabled.
    expect(svc.decryptToken('ghp_rawPlaintextStoredBeforeEncryption')).toBe(
      'ghp_rawPlaintextStoredBeforeEncryption',
    );
  });

  it('FAILS CLOSED on a real Fernet token it cannot decrypt (wrong key / rotation)', () => {
    const token = fernetEncrypt(freshKey(), 'super-secret'); // encrypted with key A
    const svc = service(freshKey()); // service holds a DIFFERENT key B
    // It must throw, never silently hand back the raw ciphertext as if it were a credential.
    expect(() => svc.decryptToken(token)).toThrow(FernetError);
  });

  it('passes through when no key is configured (dev fail-open)', () => {
    const svc = service(null);
    expect(svc.decryptToken('anything-at-all')).toBe('anything-at-all');
  });
});
