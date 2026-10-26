import { Body, Controller, HttpCode, Post, Req, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';

import { tokenRejection } from './auth.errors';
import { ClerkVerifier } from './clerk.verifier';
import type { VerifiedIdentity } from './token-verifier';
import { UserProvisioningService } from './user-provisioning.service';

class ClerkLinkDto {
  @IsString()
  @MaxLength(200)
  password!: string;
}

/** A Clerk sign-in links the account its verified primary email names, and only by proving that account's password. */
@Controller('api/auth/clerk')
export class ClerkLinkController {
  constructor(
    private readonly clerk: ClerkVerifier,
    private readonly provisioning: UserProvisioningService,
  ) {}

  // It checks a password, and guessing only pays if you can guess often.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('link')
  async link(
    @Req() req: Request,
    @Body() body: ClerkLinkDto,
  ): Promise<{ user: { id: string; email: string; name: string } }> {
    const user = await this.provisioning.linkByPassword(await this.clerkSubject(req), body.password);
    return { user: { id: user.id, email: user.email, name: user.name } };
  }

  private async clerkSubject(req: Request): Promise<string> {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    let identity: VerifiedIdentity | null = null;
    try {
      identity = token ? await this.clerk.verify(token) : null;
    } catch (err) {
      throw tokenRejection(err) ?? err;
    }
    if (!identity?.clerkUserId) {
      throw new UnauthorizedException({ detail: 'Sign in with Clerk first.', code: 'no_credentials' });
    }
    return identity.clerkUserId;
  }
}
