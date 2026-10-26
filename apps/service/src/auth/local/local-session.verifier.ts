import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { errors as joseErrors } from 'jose';

import type { EnvConfig } from '../../config/env.config';
import { InvalidTokenError, TokenExpiredError } from '../auth.errors';
import type { TokenVerifier, VerifiedIdentity } from '../token-verifier';
import { readSession, sessionRefusal, type LocalSession, type SessionDoors } from './local-session';

/** The sign-in methods whose sessions this instance accepts, read from its configuration. */
export function sessionDoorsOf(env: EnvConfig): SessionDoors {
  return { passwords: env.localAuthEnabled, ssoIssuer: env.oidcSignInEnabled ? env.oidcIssuer : null };
}

/** Verifies the sessions Sarati itself issues — password and single sign-on — each only while its method is on. */
@Injectable()
export class LocalSessionVerifier implements TokenVerifier {
  readonly name = 'local';

  constructor(private readonly config: ConfigService<{ env: EnvConfig }, true>) {}

  async verify(token: string): Promise<VerifiedIdentity | null> {
    const env = this.config.get('env', { infer: true });
    const doors = sessionDoorsOf(env);
    if (!doors.passwords && doors.ssoIssuer === null) return null;
    let session: LocalSession | null;
    try {
      session = await readSession(token, env.secretKey);
    } catch (err) {
      // An expired session IS ours: say so, rather than let it fall through as unrecognised.
      if (err instanceof joseErrors.JWTExpired) throw new TokenExpiredError();
      throw err;
    }
    if (!session) return null;
    const refusal = sessionRefusal(session.via, doors);
    if (refusal) throw new InvalidTokenError(`Session refused: ${refusal}`);
    return { userId: session.userId };
  }
}
