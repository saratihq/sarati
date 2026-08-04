import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvConfig } from '../config/env.config';

/**
 * Gates the composer's functional endpoints on it actually being configured.
 * Listed BEFORE ComposerAuthGuard so an unconfigured instance answers "not
 * configured" rather than "not authenticated" — guards run in declaration
 * order, and the misleading 401 is exactly what sends operators hunting for
 * the wrong problem.
 */
@Injectable()
export class ComposerEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService<{ env: EnvConfig }, true>) {}

  canActivate(_context: ExecutionContext): boolean {
    const reason = this.config.get('env', { infer: true }).composerDisabledReason;
    if (reason === null) return true;
    throw new HttpException({ message: DISABLED_MESSAGE[reason], reason }, 503);
  }
}

/** One actionable sentence per reason — surfaced verbatim by the client. */
export const DISABLED_MESSAGE = {
  anthropic_api_key_missing:
    'The AI composer is not configured on this instance: ANTHROPIC_API_KEY is unset. Set it on the agent service and restart to enable it.',
  caller_auth_unconfigured:
    'The AI composer is not configured on this instance: composer callers cannot be authenticated. Set SECRET_KEY to the same value the workflow service uses (this enables local email + password sign-in), or CLERK_ISSUER for a Clerk deployment, then restart to enable it.',
} as const;
