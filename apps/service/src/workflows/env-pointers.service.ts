import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { isIdShape } from '../database/ids';
import { rawMutate, rawQuery } from '../database/raw-query';
import { EnvironmentEntity } from '../database/entities/environment.entity';
import { OrganizationEntity } from '../database/entities/organization.entity';
import { WorkflowEntity } from '../database/entities/workflow.entity';
import { WorkflowEnvPointerEntity } from '../database/entities/workflow-env-pointer.entity';
import { WorkflowVersionEntity } from '../database/entities/workflow-version.entity';
import { canonicalEnvName, ENV_NAME_SHAPE, PROD_ENV } from '../environments/env-name';
import { assertEnvSlotsCover } from '../environments/env-slot-preflight';
import { EnvironmentsService } from '../environments/environments.service';
import { EventsService } from '../events/events.service';
import { OrgsService } from '../orgs/orgs.service';
import { TriggerSignalsService } from '../triggers/trigger-signals.service';

// Re-exported so existing importers (triggers, controllers) keep one source.
export { PROD_ENV };

/** Environment name shape — one vocabulary with environments rows and env-scoped triggers. */
export const ENV_SHAPE = ENV_NAME_SHAPE;

/** Environments that may only be promoted from the default branch. */
const MAIN_ONLY_ENVS = new Set([PROD_ENV, 'uat']);

/** One pointer as the workflow-detail response carries it. */
export interface EnvPointerView {
  environment: string;
  version_id: string;
  version_number: number;
}

/**
 * Per-environment live pointers: one row per (workflow, environment) says which version that env runs.
 * `workflows.active_version_id` is the prod row's LEGACY ALIAS — it must never drift, so every alias
 * write goes through `setPointer`, and prod reads fall back to it. Env names are lowercased at this seam.
 */
@Injectable()
export class EnvPointersService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly events: EventsService,
    private readonly orgs: OrgsService,
    private readonly environments: EnvironmentsService,
    private readonly triggerSignals: TriggerSignalsService,
  ) {}

  /**
   * THE resolution seam every trigger fire path must go through: which version does `environment`
   * run? `null` env = prod. Null return = nothing promoted yet, so the caller skips the fire.
   */
  async resolveVersionId(
    em: EntityManager,
    wf: WorkflowEntity,
    environment: string | null,
  ): Promise<string | null> {
    const env = normalizeEnv(environment);
    const row = await em.findOne(WorkflowEnvPointerEntity, {
      where: { workflowId: wf.id, environment: env },
    });
    if (row) return row.versionId;
    // prod's legacy alias — pre-backfill rows keep resolving exactly as before.
    return env === PROD_ENV ? wf.activeVersionId : null;
  }

  /**
   * The version a CALLER's environment runs — the one answer for calling a workflow from anywhere
   * (ADR 0062), so what an agent is offered and what actually executes can never be two versions.
   * `null` environmentId = Default, which runs production, exactly like a Default trigger fire.
   */
  async resolveVersionIdForCaller(
    em: EntityManager,
    wf: WorkflowEntity,
    environmentId: string | null,
  ): Promise<string | null> {
    if (!environmentId) return this.resolveVersionId(em, wf, null);
    const env = await em.findOne(EnvironmentEntity, { where: { id: environmentId } });
    return env ? this.resolveVersionIdForEnv(em, wf, env) : null;
  }

  /** The version an ENV ROW runs (ADR 0014): prefers `environment_id`, falls back to a name-only pointer, then the prod alias. */
  async resolveVersionIdForEnv(
    em: EntityManager,
    wf: WorkflowEntity,
    env: EnvironmentEntity,
  ): Promise<string | null> {
    const rows = await rawQuery<{ version_id: string }>(
      em,
      `SELECT version_id FROM workflow_env_pointers
        WHERE workflow_id = $1
          AND (environment_id = $2 OR (environment_id IS NULL AND lower(environment) = $3))
        ORDER BY (environment_id IS NULL)
        LIMIT 1`,
      [wf.id, env.id, env.name],
    );
    if (rows[0]) return rows[0].version_id;
    return env.isProd || env.name === PROD_ENV ? wf.activeVersionId : null;
  }

  /**
   * Move an environment's pointer (upsert). A prod move syncs the legacy alias in the SAME
   * transaction, and the row carries a find-or-created environments id so it can never dangle.
   */
  async setPointer(
    em: EntityManager,
    workflowId: string,
    environment: string,
    versionId: string,
  ): Promise<void> {
    const env = normalizeEnv(environment);
    const wf = await em.findOne(WorkflowEntity, { where: { id: workflowId } });
    const envRow = wf?.orgId ? await this.environments.ensureEnvironment(em, wf.orgId, env) : null;
    await em.query(
      `INSERT INTO workflow_env_pointers (workflow_id, environment, version_id, updated_at, environment_id)
       VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (workflow_id, environment)
       DO UPDATE SET version_id = EXCLUDED.version_id, updated_at = now(),
                     environment_id = EXCLUDED.environment_id`,
      [workflowId, env, versionId, envRow?.id ?? null],
    );
    if (env === PROD_ENV) {
      await em.query(`UPDATE workflows SET active_version_id = $2 WHERE id = $1`, [workflowId, versionId]);
    }
  }

  /**
   * Un-promote: delete the env's pointer, so its env-scoped triggers skip from the next fire.
   * Removing prod MUST also clear the legacy alias, or the prod fallback would keep resolving it.
   */
  async removePointer(
    workflowId: string,
    environmentId: string,
    actorUserId: string,
  ): Promise<{ removed: true; environment: string }> {
    const result = await this.dataSource.transaction(async (em) => {
      const wf = await em.findOne(WorkflowEntity, { where: { id: workflowId } });
      if (!wf) throw new DomainError(`Workflow ${workflowId} not found`, 404);
      if (!wf.orgId) throw new DomainError('Environment not found', 404); // org-less: no env rows
      const env = await this.environments.byIdForOrg(em, wf.orgId, environmentId);
      await this.assertPointerMoveAllowed(em, wf, env.name, actorUserId);

      const removed = await rawMutate(
        em,
        `DELETE FROM workflow_env_pointers
          WHERE workflow_id = $1
            AND (environment_id = $2 OR (environment_id IS NULL AND lower(environment) = $3))`,
        [wf.id, env.id, env.name],
      );
      const isProd = env.isProd || env.name === PROD_ENV;
      // A pre-backfill prod promotion may live only in the alias — clearing it IS the removal then.
      const aliasHeldProd = isProd && wf.activeVersionId !== null;
      if (removed === 0 && !aliasHeldProd) {
        throw new DomainError(`Workflow is not promoted to '${env.name}'`, 404);
      }
      if (isProd) {
        await em.query(`UPDATE workflows SET active_version_id = NULL WHERE id = $1`, [wf.id]);
      }
      await this.events.emit(em, {
        orgId: wf.orgId,
        actorUserId,
        type: 'workflow.unpromoted',
        subjectType: 'workflow',
        subjectId: wf.id,
        payload: { environment: env.name },
      });
      return { removed: true as const, environment: env.name };
    });
    // Pointer moved (committed) → reconcile this workflow's activations (ADR 0018).
    await this.triggerSignals.enqueue(workflowId);
    return result;
  }

  /** The workflow's pointers, prod first — synthesized from the legacy alias when no prod row exists, so it always agrees with `resolveVersionId`. */
  async listPointers(wf: WorkflowEntity): Promise<EnvPointerView[]> {
    const rows = await rawQuery<{ environment: string; version_id: string; version_number: number }>(
      this.dataSource.manager,
      `SELECT p.environment, p.version_id, v.version_number::int
         FROM workflow_env_pointers p
         JOIN workflow_versions v ON v.id = p.version_id
        WHERE p.workflow_id = $1
        ORDER BY (p.environment <> 'production'), p.environment`,
      [wf.id],
    );
    const pointers: EnvPointerView[] = rows.map((r) => ({
      environment: r.environment,
      version_id: r.version_id,
      version_number: r.version_number,
    }));
    if (!pointers.some((p) => p.environment === PROD_ENV) && wf.activeVersionId) {
      const alias = await this.dataSource.manager.findOne(WorkflowVersionEntity, {
        where: { id: wf.activeVersionId },
      });
      if (alias) {
        pointers.unshift({
          environment: PROD_ENV,
          version_id: alias.id,
          version_number: alias.versionNumber,
        });
      }
    }
    return pointers;
  }

  /**
   * Promote: point `environment` at a version. {@link MAIN_ONLY_ENVS} promote from the default
   * branch only, and an org workflow needs an owner/admin. Idempotent — a re-promote writes nothing.
   */
  async promote(
    workflowId: string,
    environmentRaw: string,
    versionId: string,
    actorUserId: string,
  ): Promise<Record<string, unknown>> {
    if (!ENV_SHAPE.test(environmentRaw)) throw new DomainError('Invalid environment name', 400);
    const environment = normalizeEnv(environmentRaw);

    const result = await this.dataSource.transaction(async (em) => {
      const wf = await em.findOne(WorkflowEntity, { where: { id: workflowId } });
      if (!wf) throw new DomainError(`Workflow ${workflowId} not found`, 404);

      const notFound = new DomainError(`Version ${versionId} not found for workflow ${workflowId}`, 404);
      if (!isIdShape(versionId)) throw notFound;
      const version = await em.findOne(WorkflowVersionEntity, {
        where: { id: versionId, workflowId: wf.id },
      });
      if (!version) throw notFound;

      if (MAIN_ONLY_ENVS.has(environment) && wf.defaultBranchId && version.branchId !== wf.defaultBranchId) {
        throw new DomainError(
          `'${environment}' promotes from the default branch only — merge the branch first.`,
          400,
        );
      }

      await this.assertPointerMoveAllowed(em, wf, environment, actorUserId);
      await this.assertEnvCanRun(em, wf, environment, version);

      const current = await em.findOne(WorkflowEnvPointerEntity, {
        where: { workflowId: wf.id, environment },
      });
      const currentVersionId = current?.versionId ?? (environment === PROD_ENV ? wf.activeVersionId : null);
      const previous = currentVersionId
        ? await em.findOne(WorkflowVersionEntity, { where: { id: currentVersionId } })
        : null;

      if (currentVersionId !== version.id) {
        await this.setPointer(em, wf.id, environment, version.id);
        await this.events.emit(em, {
          orgId: wf.orgId,
          actorUserId,
          type: 'workflow.promoted',
          subjectType: 'workflow',
          subjectId: wf.id,
          payload: { environment, version_number: version.versionNumber },
        });
      }

      return {
        status: 'promoted',
        workflow_id: wf.id,
        environment,
        version_id: version.id,
        version_number: version.versionNumber,
        // What the env ran before this call (equals version_number on an idempotent re-promote).
        previous_version_number: previous?.versionNumber ?? null,
      };
    });
    // Pointer moved (committed) → reconcile this workflow's activations (ADR 0018).
    await this.triggerSignals.enqueue(workflowId);
    return result;
  }

  /**
   * Refuse to make a version live somewhere it cannot run: every app its steps resolve a connection
   * for must have a slot in that environment. Deliberate acts only — publishing and promoting are
   * where the author asserts "run this here", while CREATING a workflow must never require the
   * environment to be configured first. Org-less has no env rows, so it passes.
   */
  async assertEnvCanRun(
    em: EntityManager,
    wf: WorkflowEntity,
    environment: string,
    version: WorkflowVersionEntity,
  ): Promise<void> {
    if (!wf.orgId) return;
    const env = await this.environments.ensureEnvironment(em, wf.orgId, normalizeEnv(environment));
    await assertEnvSlotsCover(em, env.id, env.name, version.workflowIr ?? version.workflowJson);
  }

  /**
   * The ONE gate every pointer move funnels through (publish/restore, promote, un-promote): moving an
   * org workflow's pointer needs an owner/admin for EVERY environment, prod included. Org-less passes.
   */
  async assertPointerMoveAllowed(
    em: EntityManager,
    wf: WorkflowEntity,
    environment: string,
    actorUserId: string,
  ): Promise<void> {
    if (!wf.orgId) return;
    const org = await em.findOne(OrganizationEntity, { where: { id: wf.orgId } });
    if (!org || org.isPersonal) return;
    const role = await this.orgs.roleOf(em, actorUserId, wf.orgId);
    if (role !== 'owner' && role !== 'admin') {
      throw new DomainError(
        `Only owners and admins can move the '${environment}' pointer in an organization`,
        403,
      );
    }
  }
}

/** Env names are case-insensitive slugs — lowercase at the pointer seam (like tags). */
function normalizeEnv(environment: string | null): string {
  // canonicalEnvName maps the legacy 'prod' — old clients/scripts keep working.
  return canonicalEnvName(environment ?? PROD_ENV);
}
