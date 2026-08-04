import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuthModule } from '../auth/auth.module';
import type { EnvConfig } from '../config/env.config';
import { EnvironmentsModule } from '../environments/environments.module';
import { ComposioProvider } from './composio.provider';
import { ComposioExecutionProvider } from './composio-execution.provider';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';
import { ManagedConnectionsController } from './managed-connections.controller';
import { ManagedConnectionsService } from './managed-connections.service';
import { OAuthController } from './oauth.controller';
import { loadOAuthProviders, OAuthProvidersService } from './oauth-providers';
import { OAuthService } from './oauth.service';

/**
 * Managed-integration connections. `OAuthProvidersService` is built ONCE at boot from env + the endpoint catalog;
 * the Composio (managed-row) half is inert without COMPOSIO_API_KEY and the BYO token/oauth2 paths never touch it.
 */
@Module({
  // EnvironmentsModule: the delete endpoint consults slot references (ADR 0014).
  imports: [AuthModule, EnvironmentsModule],
  providers: [
    ConnectionsService,
    OAuthService,
    ComposioProvider,
    ComposioExecutionProvider,
    ManagedConnectionsService,
    {
      provide: OAuthProvidersService,
      inject: [ConfigService],
      useFactory: (config: ConfigService<{ env: EnvConfig }, true>) => {
        const env = config.get('env', { infer: true });
        const redirectUri = process.env.OAUTH_REDIRECT_URI || `${env.frontendUrl}/integrations/callback`;
        return new OAuthProvidersService(loadOAuthProviders(process.env, redirectUri), redirectUri);
      },
    },
  ],
  controllers: [ConnectionsController, ManagedConnectionsController, OAuthController],
  exports: [ConnectionsService, ManagedConnectionsService, ComposioExecutionProvider, ComposioProvider],
})
export class ConnectionsModule {}
