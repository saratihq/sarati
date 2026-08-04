import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { EncryptionService } from '../common/crypto/encryption.service';

const NULL_ENV = '00000000-0000-0000-0000-000000000000';

/**
 * The env-scoped, Fernet-encrypted store for webhook signing secrets (ADR 0030). Secrets
 * never enter the version doc — read only on-fire by the trigger intake.
 */
@Injectable()
export class WebhookSecretsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly encryption: EncryptionService,
  ) {}

  /** Upsert the signing secret for (workflow, env, node). Encrypted at rest. */
  async setSecret(
    workflowId: string,
    environmentId: string | null,
    nodeId: string,
    plaintext: string,
  ): Promise<void> {
    const enc = this.encryption.encryptToken(plaintext);
    await this.dataSource.query(
      `INSERT INTO webhook_trigger_secrets (workflow_id, environment_id, node_id, secret)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workflow_id, COALESCE(environment_id, '${NULL_ENV}'::uuid), node_id)
       DO UPDATE SET secret = EXCLUDED.secret, updated_at = now()`,
      [workflowId, environmentId, nodeId, enc],
    );
  }

  /** Remove the secret; returns true if one existed. */
  async clearSecret(workflowId: string, environmentId: string | null, nodeId: string): Promise<boolean> {
    const res: unknown[] = await this.dataSource.query(
      `DELETE FROM webhook_trigger_secrets
        WHERE workflow_id = $1
          AND COALESCE(environment_id, '${NULL_ENV}'::uuid) = COALESCE($2::uuid, '${NULL_ENV}'::uuid)
          AND node_id = $3
        RETURNING id`,
      [workflowId, environmentId, nodeId],
    );
    return res.length > 0;
  }

  /** Whether a secret EXISTS for (workflow, env, node) — never decrypts or returns the value. */
  async hasSecret(workflowId: string, environmentId: string | null, nodeId: string): Promise<boolean> {
    const rows: unknown[] = await this.dataSource.query(
      `SELECT 1 FROM webhook_trigger_secrets
        WHERE workflow_id = $1
          AND COALESCE(environment_id, '${NULL_ENV}'::uuid) = COALESCE($2::uuid, '${NULL_ENV}'::uuid)
          AND node_id = $3
        LIMIT 1`,
      [workflowId, environmentId, nodeId],
    );
    return rows.length > 0;
  }

  /** The decrypted signing secret for on-fire verification, or null if none is set. */
  async getSecret(workflowId: string, environmentId: string | null, nodeId: string): Promise<string | null> {
    const rows: Array<{ secret: string }> = await this.dataSource.query(
      `SELECT secret FROM webhook_trigger_secrets
        WHERE workflow_id = $1
          AND COALESCE(environment_id, '${NULL_ENV}'::uuid) = COALESCE($2::uuid, '${NULL_ENV}'::uuid)
          AND node_id = $3
        LIMIT 1`,
      [workflowId, environmentId, nodeId],
    );
    const row = rows[0];
    return row ? this.encryption.decryptToken(row.secret) : null;
  }
}
