import { Global, Module } from '@nestjs/common';

import { EncryptionService } from './common/crypto/encryption.service';
import { ENTITLEMENTS_PROVIDER, UnlimitedEntitlements } from './entitlements/entitlements';
import { EventsService } from './events/events.service';
import { OrgsService } from './orgs/orgs.service';
import { PlatformKeysService } from './platform/platform-keys.service';
import { PolicyService } from './policy/policy.service';

/**
 * The day-one primitives (ADR 0037), global so every slice consumes them
 * without import ceremony. ee/ overrides ENTITLEMENTS_PROVIDER (and later
 * registers policy extensions / event consumers) through these same tokens.
 */
@Global()
@Module({
  providers: [
    OrgsService,
    EventsService,
    PolicyService,
    EncryptionService,
    PlatformKeysService,
    { provide: ENTITLEMENTS_PROVIDER, useClass: UnlimitedEntitlements },
  ],
  exports: [
    OrgsService,
    EventsService,
    PolicyService,
    EncryptionService,
    PlatformKeysService,
    ENTITLEMENTS_PROVIDER,
  ],
})
export class CoreModule {}
