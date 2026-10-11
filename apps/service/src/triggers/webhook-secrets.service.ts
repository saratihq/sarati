import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import { EncryptionService } from '../common/crypto/encryption.service';
import { DomainError } from '../common/domain-error';
import { rawMutateReturning } from '../database/raw-query';
import type { WorkflowEntity } from '../database/entities/workflow.entity';
import { EnvironmentsService } from '../environments/environments.service';
import { lockWorkflowForWrite } from '../workflows/workflow-row-lock';

const NULL_ENV = '00000000-0000-0000-0000-000000000000';

/** The workflow a secret belongs to: its id, and its org, whose environments a name resolves in. */
export type SecretOwner = Pick<WorkflowEntity, 'id' | 'orgId'>;

/**
 * The env-scoped, Fernet-encrypted store for webhook signing secrets. Secrets
 * never enter the version doc — read only on-fire by the trigger intake.
 */
@Injectable()
export class WebhookSecretsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly encryption: EncryptionService,
    private readonly environments: EnvironmentsService,
  ) {}

  /** Upsert the signing secret for (workflow, env, node), encrypted at rest; 404 when the workflow or env is gone. */
  async setSecret(
    wf: SecretOwner,
    environment: string | undefined,
    nodeId: string,
    plaintext: string,
  ): Promise<void> {
    const enc = this.encryption.encryptToken(plaintext);
    await this.dataSource.transaction(async (em) => {
      await lockWorkflowForWrite(em, wf.id);
      const environmentId = await this.environmentIdOf(em, wf, environment, true);
      await em.query(
        `INSERT INTO webhook_trigger_secrets (workflow_id, environment_id, node_id, secret)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (workflow_id, COALESCE(environment_id, '${NULL_ENV}'::uuid), node_id)
         DO UPDATE SET secret = EXCLUDED.secret, updated_at = now()`,
        [wf.id, environmentId, nodeId, enc],
      );
    });
  }

  /** Remove the secret; true when there was one. 404 when the workflow or env is gone. */
  clearSecret(wf: SecretOwner, environment: string | undefined, nodeId: string): Promise<boolean> {
    return this.dataSource.transaction(async (em) => {
      await lockWorkflowForWrite(em, wf.id);
      const environmentId = await this.environmentIdOf(em, wf, environment, true);
      const removed = await rawMutateReturning<{ id: string }>(
        em,
        `DELETE FROM webhook_trigger_secrets
          WHERE workflow_id = $1
            AND COALESCE(environment_id, '${NULL_ENV}'::uuid) = COALESCE($2::uuid, '${NULL_ENV}'::uuid)
            AND node_id = $3
          RETURNING id`,
        [wf.id, environmentId, nodeId],
      );
      return removed.length > 0;
    });
  }

  /** Whether a secret EXISTS for (workflow, env, node) — never decrypts or returns the value. */
  async hasSecret(wf: SecretOwner, environment: string | undefined, nodeId: string): Promise<boolean> {
    const em = this.dataSource.manager;
    const environmentId = await this.environmentIdOf(em, wf, environment, false);
    const rows: unknown[] = await em.query(
      `SELECT 1 FROM webhook_trigger_secrets
        WHERE workflow_id = $1
          AND COALESCE(environment_id, '${NULL_ENV}'::uuid) = COALESCE($2::uuid, '${NULL_ENV}'::uuid)
          AND node_id = $3
        LIMIT 1`,
      [wf.id, environmentId, nodeId],
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

  // Only an org workflow has env rows; without one, or without a name, the secret is the env-less default.
  private async environmentIdOf(
    em: EntityManager,
    wf: SecretOwner,
    environment: string | undefined,
    lock: boolean,
  ): Promise<string | null> {
    if (!environment || !wf.orgId) return null;
    const env = await this.environments.findByNameForOrg(em, wf.orgId, environment, lock);
    if (!env) throw new DomainError('Environment not found', 404);
    return env.id;
  }
}
