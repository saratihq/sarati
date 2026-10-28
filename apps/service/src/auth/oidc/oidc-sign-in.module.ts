import { Module } from '@nestjs/common';

import { OrgsModule } from '../../orgs/orgs.module';
import { AuthModule } from '../auth.module';
import { LocalAuthModule } from '../local/local-auth.module';
import { OidcLinkController } from './oidc-link.controller';
import { OidcRelyingParty } from './oidc-relying-party';
import { OidcSignInController } from './oidc-sign-in.controller';
import { OidcSignInService } from './oidc-sign-in.service';

/** Browser single sign-on; it admits accounts through LocalAuthModule's seam and joins orgs through OrgsModule's. */
@Module({
  imports: [AuthModule, OrgsModule, LocalAuthModule],
  controllers: [OidcSignInController, OidcLinkController],
  providers: [OidcRelyingParty, OidcSignInService],
})
export class OidcSignInModule {}
