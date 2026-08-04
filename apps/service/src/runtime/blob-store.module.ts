import { Module } from '@nestjs/common';

import { BLOB_STORE } from './blob-store';
import { DbBlobStore } from './db-blob-store';

/**
 * The binary rail's storage seam, providing {@link BLOB_STORE} → {@link DbBlobStore}. A leaf module
 * both the runtime and the providers import, so the store stays swappable without a Runtime↔Providers cycle.
 */
@Module({
  providers: [DbBlobStore, { provide: BLOB_STORE, useExisting: DbBlobStore }],
  exports: [BLOB_STORE],
})
export class BlobStoreModule {}
