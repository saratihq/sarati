import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Request } from 'express';
import type { DataSource } from 'typeorm';

import type { EnvConfig } from '../config/env.config';
import { UserIdentityEntity } from '../database/entities/user-identity.entity';
import { AuthGuard } from './auth.guard';
import { requirePrincipal } from './principal';
import { Scope } from '../auth/scope.decorator';

/** Returns the caller's profile, provisioning the local row on first call. */
@Controller('api/auth')
@UseGuards(AuthGuard)
export class AuthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService<{ env: EnvConfig }, true>,
  ) {}

  @Scope('workflow:read')
  @Get('me')
  async me(@Req() req: Request): Promise<Record<string, unknown>> {
    const user = requirePrincipal(req).user;
    const env = this.config.get('env', { infer: true });
    const identity = env.oidcSignInEnabled
      ? await this.dataSource.manager.findOne(UserIdentityEntity, {
          where: { userId: user.id, issuer: env.oidcIssuer },
        })
      : null;

    return {
      user: { id: user.id, email: user.email, name: user.name },
      settings: {},
      sign_in: {
        password: Boolean(user.hashedPassword),
        sso: env.oidcSignInEnabled
          ? { connected: identity !== null, email: identity?.emailAtLink ?? null }
          : null,
      },
    };
  }
}
