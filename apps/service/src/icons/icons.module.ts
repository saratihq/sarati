import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { IconsController } from './icons.controller';

@Module({ imports: [AuthModule], controllers: [IconsController] })
export class IconsModule {}
