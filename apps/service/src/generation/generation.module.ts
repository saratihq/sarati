import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ProvidersModule } from '../providers/providers.module';

import { NodeTypesController } from './node-types.controller';
import { VectorStore } from './vector-store';

/** Catalog slice: the retrieval the editor palette, inspector, and compose catalog all run on. */
@Module({
  imports: [AuthModule, ProvidersModule],
  controllers: [NodeTypesController],
  providers: [VectorStore],
  // The composer module reuses the in-memory catalog (one load, one merge).
  exports: [VectorStore],
})
export class GenerationModule {}
