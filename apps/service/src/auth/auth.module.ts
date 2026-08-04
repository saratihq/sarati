import { Module } from '@nestjs/common';

import { ApiKeysService } from '../api-keys/api-keys.service';
import { ApiKeyVerifier } from '../api-keys/api-key.verifier';
import { AuthController } from './auth.controller';
import { ScopeEnforcer } from './scope-enforcer';
import { AuthGuard } from './auth.guard';
import { ClerkVerifier } from './clerk.verifier';
import { OidcVerifier } from './oidc.verifier';
import { LocalSessionVerifier } from './local/local-session.verifier';
import { TOKEN_VERIFIERS } from './token-verifier';
import { UserProvisioningService } from './user-provisioning.service';

@Module({
  controllers: [AuthController],
  providers: [
    ClerkVerifier,
    OidcVerifier,
    LocalSessionVerifier,
    ApiKeysService,
    ApiKeyVerifier,
    UserProvisioningService,
    ScopeEnforcer,
    AuthGuard,
    // The pluggable-auth seam, tried in order: API key → local session → OIDC → Clerk. Each is inert
    // unless configured, and each owns a distinct token shape or issuer.
    {
      provide: TOKEN_VERIFIERS,
      inject: [ApiKeyVerifier, LocalSessionVerifier, OidcVerifier, ClerkVerifier],
      useFactory: (
        apiKey: ApiKeyVerifier,
        local: LocalSessionVerifier,
        oidc: OidcVerifier,
        clerk: ClerkVerifier,
      ) => [apiKey, local, oidc, clerk],
    },
  ],
  // ScopeEnforcer must stay exported — AuthGuard depends on it in every module that guards a controller.
  exports: [AuthGuard, ScopeEnforcer, UserProvisioningService, ApiKeysService, TOKEN_VERIFIERS],
})
export class AuthModule {}
