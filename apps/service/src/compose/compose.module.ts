import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { GenerationModule } from '../generation/generation.module';
import { TriggerCatalogModule } from '../triggers/trigger-catalog.module';

import { ComposeCatalogService } from './compose-catalog.service';
import { ComposeController } from './compose.controller';

/**
 * Composer-agent service surface: draft apply-ops + lean catalog search. GenerationModule is
 * imported for the shared VectorStore and TriggerCatalogModule for the one trigger source — one
 * catalog per kind serves discovery, the palette, the composer, and MCP.
 */
@Module({
  imports: [AuthModule, GenerationModule, TriggerCatalogModule],
  controllers: [ComposeController],
  providers: [ComposeCatalogService],
  // Exported so the commit path reuses the SAME node-type allow-list apply-ops validates
  // against — one catalog oracle.
  exports: [ComposeCatalogService],
})
export class ComposeModule {}
