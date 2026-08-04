import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { AuthGuard } from './auth.guard';
import { requirePrincipal } from './principal';
import { Scope } from '../auth/scope.decorator';

/** Returns the caller's profile, provisioning the local row on first call. */
@Controller('api/auth')
@UseGuards(AuthGuard)
export class AuthController {
  @Scope('workflow:read')
  @Get('me')
  me(@Req() req: Request): Record<string, unknown> {
    const user = requirePrincipal(req).user;

    return {
      user: { id: user.id, email: user.email, name: user.name },
      settings: {},
    };
  }
}
