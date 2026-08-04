import { randomUUID } from 'node:crypto';

import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { RuntimeBlobEntity } from '../database/entities/runtime-blob.entity';
import {
  type BlobContent,
  type BlobInput,
  type BlobStore,
  type FileHandle,
  makeFileHandle,
  MAX_BLOB_BYTES,
} from './blob-store';

/**
 * The default {@link BlobStore}: run-scoped bytes in a Postgres `bytea` column, so they survive a
 * restart or crash-resume. The DataSource is optional so the runtime is constructable without a DB —
 * file steps then fail loudly rather than silently dropping bytes.
 */
@Injectable()
export class DbBlobStore implements BlobStore {
  constructor(@InjectDataSource() @Optional() private readonly dataSource?: DataSource) {}

  async put(runId: string, input: BlobInput): Promise<FileHandle> {
    if (!Buffer.isBuffer(input.data)) {
      throw new DomainError('Blob data must be a Buffer', 400);
    }
    if (input.data.byteLength > MAX_BLOB_BYTES) {
      throw new DomainError(
        `File "${input.filename}" is ${input.data.byteLength} bytes — over the ${MAX_BLOB_BYTES}-byte limit`,
        413,
      );
    }
    const repo = this.repo();
    const id = randomUUID();
    const filename = input.filename || 'file';
    const mimeType = input.mimeType || 'application/octet-stream';
    await repo.insert({
      id,
      runId,
      filename,
      mimeType,
      sizeBytes: input.data.byteLength,
      data: input.data,
      createdAt: new Date(),
    });
    return makeFileHandle({ id, filename, mimeType, size: input.data.byteLength });
  }

  async get(id: string): Promise<BlobContent | null> {
    const row = await this.repo().findOne({ where: { id } });
    if (!row) return null;
    // pg returns bytea as a Buffer; guard the boundary in case a driver hands back a string.
    const data = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
    return { data, filename: row.filename, mimeType: row.mimeType };
  }

  async deleteRun(runId: string): Promise<number> {
    const result = await this.repo().delete({ runId });
    return result.affected ?? 0;
  }

  private repo() {
    if (!this.dataSource) {
      throw new DomainError('File steps require a database — the blob store is unavailable', 503);
    }
    return this.dataSource.getRepository(RuntimeBlobEntity);
  }
}
