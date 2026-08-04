import { Module } from '@nestjs/common';

import { OrgsModule } from '../../orgs/orgs.module';
import { LocalAuthController } from './local-auth.controller';
import { LocalAuthService } from './local-auth.service';

/**
 * Registration and login live here rather than in AuthModule: they need the org invite path, and
 * OrgsModule already imports AuthModule. The session VERIFIER stays in AuthModule — it reads a
 * signed token and needs nothing else.
 */
@Module({
  imports: [OrgsModule],
  controllers: [LocalAuthController],
  providers: [LocalAuthService],
})
export class LocalAuthModule {}
