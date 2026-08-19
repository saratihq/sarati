import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

import { LocalAuthService, type SessionGrant } from './local-auth.service';

class RegisterDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MaxLength(200)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  /** An org invite's token; required unless this is the instance's very first account. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  invite_token?: string;
}

class LoginDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MaxLength(200)
  password!: string;
}

/**
 * Email + password for self-host. Unauthenticated by necessity — these routes are how a
 * caller gets a session in the first place — so both are rate-limited and registration is
 * bootstrap-or-invite only.
 */
@Controller('api/auth/local')
export class LocalAuthController {
  constructor(private readonly local: LocalAuthService) {}

  /** What sign-in this instance offers, so the client knows whether to draw a form or a redirect. */
  @Get('status')
  async status(): Promise<{ enabled: boolean; awaiting_bootstrap: boolean }> {
    return { enabled: this.local.enabled, awaiting_bootstrap: await this.local.awaitingBootstrap() };
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(201)
  @Post('register')
  register(@Body() body: RegisterDto): Promise<SessionGrant> {
    return this.local.register({
      email: body.email,
      password: body.password,
      name: body.name,
      inviteToken: body.invite_token,
    });
  }

  // Guessing only pays if you can guess often.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('login')
  login(@Body() body: LoginDto): Promise<SessionGrant> {
    return this.local.login(body.email, body.password);
  }
}
