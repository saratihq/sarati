import { Body, Controller, Get, HttpException, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsNotEmpty, IsOptional, IsString, ValidateNested } from 'class-validator';
import type { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { requirePrincipal } from '../auth/principal';
import type { ConnectionSummary } from './connections.service';
import { type ByoOAuthClient, type OAuthProviderSummary, OAuthProvidersService } from './oauth-providers';
import { OAuthExchangeError } from './oauth-token';
import { OAuthProviderNotConfiguredError, OAuthService, OAuthStateError } from './oauth.service';
import { Scope } from '../auth/scope.decorator';

/** A user's OWN OAuth app (ADR 0042) — the secret is sent once here, stored Fernet-encrypted, and never returned. */
class ByoOAuthClientDto {
  @IsString()
  @IsNotEmpty()
  client_id!: string;

  @IsString()
  @IsNotEmpty()
  client_secret!: string;

  @IsString()
  @IsNotEmpty()
  auth_url!: string;

  @IsString()
  @IsNotEmpty()
  token_url!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scopes?: string[];

  @IsOptional()
  @IsBoolean()
  use_pkce?: boolean;
}

class AuthorizeDto {
  /** Configured provider key, e.g. `google` or `slack`. */
  @IsString()
  @IsNotEmpty()
  provider!: string;

  /** Optional BYO own-client — when present, the flow runs against it. */
  @IsOptional()
  @ValidateNested()
  @Type(() => ByoOAuthClientDto)
  oauth_client?: ByoOAuthClientDto;
}

class CallbackDto {
  /** The `?code=` the provider handed the redirect. */
  @IsString()
  @IsNotEmpty()
  code!: string;

  /** The `?state=` — must match the single-use row minted at authorize time. */
  @IsString()
  @IsNotEmpty()
  state!: string;
}

/**
 * The OAuth2 authorization-code flow: the client opens `authorize_url`, then forwards `{code, state}` back here
 * (authenticated) to mint the connection. Secrets are never returned.
 */
@Controller('api/connections/oauth')
@UseGuards(AuthGuard)
export class OAuthController {
  constructor(
    private readonly oauth: OAuthService,
    private readonly providers: OAuthProvidersService,
  ) {}

  private userId(req: Request): string {
    return requirePrincipal(req).user.id;
  }

  /** Providers with a configured OAuth app — for the FE's "Connect …" buttons. */
  @Scope('connection:read')
  @Get('providers')
  listProviders(): OAuthProviderSummary[] {
    return this.providers.list();
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Scope('connection:write')
  @Post('authorize')
  async authorize(
    @Req() req: Request,
    @Body() body: AuthorizeDto,
  ): Promise<{ authorize_url: string; state: string }> {
    try {
      const byoClient: ByoOAuthClient | undefined = body.oauth_client
        ? {
            clientId: body.oauth_client.client_id,
            clientSecret: body.oauth_client.client_secret,
            authUrl: body.oauth_client.auth_url,
            tokenUrl: body.oauth_client.token_url,
            scopes: body.oauth_client.scopes ?? [],
            usePkce: body.oauth_client.use_pkce ?? true,
          }
        : undefined;
      const { authorizeUrl, state } = await this.oauth.startAuthorization(
        this.userId(req),
        body.provider,
        byoClient,
      );
      return { authorize_url: authorizeUrl, state };
    } catch (err) {
      if (err instanceof OAuthProviderNotConfiguredError)
        throw new HttpException({ detail: err.message }, 400);
      throw err;
    }
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Scope('connection:write')
  @Post('callback')
  async callback(
    @Req() req: Request,
    @Body() body: CallbackDto,
  ): Promise<{ status: string; connection: ConnectionSummary }> {
    try {
      const connection = await this.oauth.completeAuthorization(this.userId(req), body.code, body.state);
      return { status: 'connected', connection };
    } catch (err) {
      if (err instanceof OAuthStateError) throw new HttpException({ detail: err.message }, 400);
      if (err instanceof OAuthProviderNotConfiguredError)
        throw new HttpException({ detail: err.message }, 400);
      if (err instanceof OAuthExchangeError) throw new HttpException({ detail: err.message }, 502);
      throw err;
    }
  }
}
