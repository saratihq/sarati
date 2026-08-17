import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { errors as joseErrors } from 'jose';

import type { EnvConfig } from '../../config/env.config';
import { TokenExpiredError } from '../auth.errors';
import type { TokenVerifier, VerifiedIdentity } from '../token-verifier';
import { readSession } from './local-session';

/** Verifies sessions issued by local email+password login (ADR 0054); inert when local auth is off. */
@Injectable()
export class LocalSessionVerifier implements TokenVerifier {
  readonly name = 'local';

  constructor(private readonly config: ConfigService<{ env: EnvConfig }, true>) {}

  async verify(token: string): Promise<VerifiedIdentity | null> {
    const env = this.config.get('env', { infer: true });
    if (!env.localAuthEnabled) return null;
    let userId: string | null;
    try {
      userId = await readSession(token, env.secretKey);
    } catch (err) {
      // An expired session IS ours: say so, rather than let it fall through as unrecognised.
      if (err instanceof joseErrors.JWTExpired) throw new TokenExpiredError();
      throw err;
    }
    // The session names a local user directly — no provisioning, no profile fetch.
    return userId ? { userId } : null;
  }
}
