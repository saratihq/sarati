import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { InternalPlatformKeysController } from './internal-platform-keys.controller';
import { PlatformKeysController } from './platform-keys.controller';

@Module({
  imports: [AuthModule],
  controllers: [PlatformKeysController, InternalPlatformKeysController],
})
export class PlatformModule {}
