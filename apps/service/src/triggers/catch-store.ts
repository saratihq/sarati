import { Injectable } from '@nestjs/common';

import { DomainError } from '../common/domain-error';
import { newId } from '../database/ids';

/**
 * Ephemeral test-event inbox: the editor mints a catch URL, the user fires one event at it, and
 * the payload becomes the trigger's sample fields — nothing runs. The unguessable uuid is the
 * capability token. Deliberately in-memory, so it is single-process only.
 */

const TTL_MS = 15 * 60 * 1000;
const MAX_PER_USER = 20; // an editor mints one per popover — 20 is misuse
const MAX_PAYLOAD_BYTES = 128 * 1024;

interface CatchEntry {
  userId: string;
  expiresAt: number;
  payload?: unknown;
  receivedAt?: number;
}

@Injectable()
export class CatchStore {
  private readonly entries = new Map<string, CatchEntry>();

  /** Mint a catch id for this user. */
  create(userId: string): { catchId: string; expiresAt: string } {
    this.purge();
    const mine = [...this.entries.values()].filter((e) => e.userId === userId);
    if (mine.length >= MAX_PER_USER) {
      throw new DomainError('Too many open test-event catches — close some editors first', 429);
    }
    const catchId = newId();
    const expiresAt = Date.now() + TTL_MS;
    this.entries.set(catchId, { userId, expiresAt });
    return { catchId, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Public intake: store the payload (last event wins). 404 on unknown/expired. */
  receive(catchId: string, payload: unknown): void {
    this.purge();
    const entry = this.entries.get(catchId);
    if (!entry) throw new DomainError('Catch not found or expired', 404);
    const size = Buffer.byteLength(JSON.stringify(payload ?? null), 'utf8');
    if (size > MAX_PAYLOAD_BYTES) throw new DomainError('Test payload too large for a sample', 413);
    entry.payload = payload;
    entry.receivedAt = Date.now();
  }

  /** Owner poll: has anything landed yet? */
  read(catchId: string, userId: string): { received: boolean; payload: unknown } {
    this.purge();
    const entry = this.entries.get(catchId);
    if (!entry || entry.userId !== userId) throw new DomainError('Catch not found or expired', 404);
    return { received: entry.receivedAt !== undefined, payload: entry.payload ?? null };
  }

  private purge(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt < now) this.entries.delete(id);
    }
  }
}
