/**
 * The binary rail for the runtime. A step producing a file must NOT put bytes in the run scope —
 * the scope is plain JSON checkpointed to a `json` column — so it stores the bytes in a
 * {@link BlobStore} and emits a {@link FileHandle}, resolved back to bytes at the execution
 * boundary. The store is a seam (DB-backed by default, swappable for S3/GCS).
 */

/** Marker key that brands a value in the run scope as a file handle (not raw bytes). */
export const FILE_HANDLE_MARKER = '__orchestrFile';

/** A file in the blob store, referenced from the run scope — id + metadata only, never the bytes. */
export interface FileHandle {
  readonly [FILE_HANDLE_MARKER]: true;
  /** Blob id — the key the {@link BlobStore} stores the bytes under. */
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
}

/** The bytes + metadata a blob read returns. */
export interface BlobContent {
  data: Buffer;
  filename: string;
  mimeType: string;
}

/** What a step hands the store to persist a produced file. */
export interface BlobInput {
  filename: string;
  data: Buffer;
  mimeType?: string;
}

/** Ceiling on a single blob — files land in a `bytea` column, so one runaway step must not pin the DB. */
export const MAX_BLOB_BYTES = 25 * 1024 * 1024;

/** DI token for the runtime's blob store (the interpreter + provider depend on the seam). */
export const BLOB_STORE = Symbol('BLOB_STORE');

export interface BlobStore {
  /** Persist a file scoped to `runId` and return its handle; rejects a blob over {@link MAX_BLOB_BYTES}. */
  put(runId: string, input: BlobInput): Promise<FileHandle>;
  /** Read a blob's bytes + metadata by id, or `null` if unknown/expired. */
  get(id: string): Promise<BlobContent | null>;
  /** Delete every blob for a run (called when the run completes/expires). Returns the count removed. */
  deleteRun(runId: string): Promise<number>;
}

/** Narrow an arbitrary scope value to a {@link FileHandle}. */
export function isFileHandle(value: unknown): value is FileHandle {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v[FILE_HANDLE_MARKER] === true &&
    typeof v.id === 'string' &&
    typeof v.filename === 'string' &&
    typeof v.mimeType === 'string' &&
    typeof v.size === 'number'
  );
}

/** Build a {@link FileHandle} from stored-blob metadata. */
export function makeFileHandle(meta: {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}): FileHandle {
  return {
    [FILE_HANDLE_MARKER]: true,
    id: meta.id,
    filename: meta.filename,
    mimeType: meta.mimeType,
    size: meta.size,
  };
}

/** True if any file handle is reachable in a value tree (props/output scan). */
export function containsFileHandle(value: unknown): boolean {
  if (isFileHandle(value)) return true;
  if (Array.isArray(value)) return value.some(containsFileHandle);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsFileHandle);
  }
  return false;
}
