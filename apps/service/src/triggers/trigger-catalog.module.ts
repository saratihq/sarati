import { Module } from '@nestjs/common';

import { ProvidersModule } from '../providers/providers.module';

import { TriggerCatalogService } from './trigger-catalog.service';

/** The trigger catalog on its own slice, so the compose/MCP catalog can read it without the fire path. */
@Module({
  imports: [ProvidersModule],
  providers: [TriggerCatalogService],
  exports: [TriggerCatalogService],
})
export class TriggerCatalogModule {}
