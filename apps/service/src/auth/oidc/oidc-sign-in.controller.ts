import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import type { SessionGrant } from '../local/local-auth.service';
import { OidcCompleteDto, OidcStartDto } from './oidc-flow.dto';
import { type FlowStart, OidcSignInService } from './oidc-sign-in.service';

/** Single sign-on's way in. Unauthenticated by necessity — this is how a caller gets a session — so both routes are rate-limited. */
@Controller('api/auth/oidc')
export class OidcSignInController {
  constructor(private readonly sso: OidcSignInService) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @Post('start')
  start(@Body() body: OidcStartDto): Promise<FlowStart> {
    return this.sso.start({ bindingHash: body.binding_hash, inviteToken: body.invite_token });
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @Post('complete')
  complete(@Body() body: OidcCompleteDto): Promise<SessionGrant> {
    return this.sso.complete(body);
  }
}
