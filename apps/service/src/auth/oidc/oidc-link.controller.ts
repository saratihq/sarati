import { Body, Controller, Delete, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { AuthGuard } from '../auth.guard';
import { requirePrincipal } from '../principal';
import { SessionOnly } from '../scope.decorator';
import { OidcCompleteDto, OidcLinkStartDto } from './oidc-flow.dto';
import { type FlowStart, OidcSignInService } from './oidc-sign-in.service';

/** Connecting single sign-on to the signed-in account — a person's own act, never an API key's. */
@Controller('api/auth/oidc/link')
@UseGuards(AuthGuard)
@SessionOnly()
export class OidcLinkController {
  constructor(private readonly sso: OidcSignInService) {}

  // It checks a password, and guessing only pays if you can guess often.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('start')
  start(@Req() req: Request, @Body() body: OidcLinkStartDto): Promise<FlowStart> {
    return this.sso.linkStart(requirePrincipal(req).user, {
      bindingHash: body.binding_hash,
      currentPassword: body.current_password,
    });
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @Post('complete')
  complete(
    @Req() req: Request,
    @Body() body: OidcCompleteDto,
  ): Promise<{ connected: true; email: string | null }> {
    return this.sso.linkComplete(requirePrincipal(req).user, body);
  }

  @HttpCode(204)
  @Delete()
  unlink(@Req() req: Request): Promise<void> {
    return this.sso.unlink(requirePrincipal(req).user);
  }
}
