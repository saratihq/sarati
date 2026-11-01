import { createHash, randomBytes } from 'node:crypto';

import type { Client } from 'pg';

/** The stored hash of a plaintext key, as the service hashes the one it is sent. */
export const keyHash = (key: string): string => createHash('sha256').update(key, 'utf8').digest('hex');

/** Inserts a key of `userId` for `orgId`, the one org it acts in (constitution row 24), and returns its plaintext; no `scopes` is full authority. */
export async function insertApiKey(
  db: Pick<Client, 'query'>,
  userId: string,
  orgId: string,
  opts: { key?: string; scopes?: string[]; name?: string } = {},
): Promise<string> {
  const key = opts.key ?? `ork_e2e_${randomBytes(18).toString('hex')}`;
  await db.query(
    `INSERT INTO api_keys (id, user_id, org_id, name, key_hash, prefix, scopes, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::json, now())`,
    [
      userId,
      orgId,
      opts.name ?? 'e2e',
      keyHash(key),
      key.slice(0, 12),
      opts.scopes ? JSON.stringify(opts.scopes) : null,
    ],
  );
  return key;
}
