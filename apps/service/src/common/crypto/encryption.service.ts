import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvConfig } from '../../config/env.config';
import { FernetError, fernetDecrypt, fernetEncrypt, looksLikeFernetToken } from './fernet';

/**
 * Fails OPEN without a FERNET_KEY (dev only — production boot requires one) and for values stored
 * before encryption, but CLOSED for a real token that won't decrypt, so ciphertext never ships out.
 */
@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private warned = false;

  constructor(private readonly config: ConfigService<{ env: EnvConfig }, true>) {}

  /** Whether a value stored now would actually be encrypted — a caller that must not fail open asks first. */
  canEncrypt(): boolean {
    return this.key() !== null;
  }

  encryptToken(plaintext: string): string {
    const key = this.key();
    if (!key) return plaintext;
    return fernetEncrypt(key, plaintext);
  }

  decryptToken(ciphertext: string): string {
    const key = this.key();
    if (!key) return ciphertext;
    try {
      return fernetDecrypt(key, ciphertext);
    } catch (err) {
      if (err instanceof FernetError) {
        // Not a Fernet token at all → a value stored before encryption: pass through.
        if (!looksLikeFernetToken(ciphertext)) return ciphertext;
        // A real token we cannot decrypt (wrong key / corruption) → fail closed.
        throw new FernetError(
          'Stored credential is encrypted but could not be decrypted — the FERNET_KEY is wrong (rotated?) or the value is corrupted.',
        );
      }
      throw err;
    }
  }

  private key(): string | null {
    const env = this.config.get('env', { infer: true });
    if (!env.fernetKey) {
      if (!this.warned) {
        this.logger.warn('FERNET_KEY is not set — engine/OAuth tokens will be stored in plaintext.');
        this.warned = true;
      }
      return null;
    }
    return env.fernetKey;
  }
}
