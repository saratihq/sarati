import { DomainError } from '../common/domain-error';

/**
 * The ONE opaque offset-cursor codec every paging MCP tool shares — one encoding and one rejection
 * message, so a cursor minted by any tool is read (or refused) identically by all of them.
 */

export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

/** Decode a cursor to its offset; absent means "first page". A cursor we did not mint is a 400. */
export function decodeOffsetCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const offset = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new DomainError(
      '`cursor` is not one this tool issued — omit it to start from the first page.',
      400,
    );
  }
  return offset;
}
