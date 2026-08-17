import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';

import type { Request } from 'express';

import { ComposerAvailability, DISABLED_MESSAGE } from './composer-availability.service';
import { callerOf } from './caller-context';

/**
 * Gates the composer's functional endpoints on it actually being configured.
 * Listed BEFORE ComposerAuthGuard so an unconfigured instance answers "not
 * configured" rather than "not authenticated" — guards run in declaration
 * order, and the misleading 401 is exactly what sends operators hunting for
 * the wrong problem.
 */
@Injectable()
export class ComposerEnabledGuard implements CanActivate {
  constructor(private readonly availability: ComposerAvailability) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const caller = callerOf(req);
    // No bearer at all: whose key would we even look for? Let ComposerAuthGuard answer 401
    // rather than reporting "no key" at someone who has not identified themselves.
    const reason = await this.availability.disabledReason(caller, { keyless: caller.token === null });
    if (reason === null) return true;
    throw new HttpException({ message: DISABLED_MESSAGE[reason], reason }, 503);
  }
}
