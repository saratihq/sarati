import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { isIdShape } from '../database/ids';
import { rawMutate, rawQuery } from '../database/raw-query';
import { ConnectionEntity } from '../database/entities/connection.entity';
import { EnvironmentEntity } from '../database/entities/environment.entity';
import { EventsService } from '../events/events.service';
import { TriggerSignalsService } from '../triggers/trigger-signals.service';
import {
  canonicalEnvName,
  ENV_NAME_SHAPE,
  normalizeEnvName,
  PROD_ENV,
  RESERVED_ENV_NAMES,
  UAT_ENV,
} from './env-name';

/** One slot as the environments surface renders it. */
export interface SlotView {
  app: string;
  connection_id: string;
  /** The connection's display identity (display_name, falling back to provider). */
  account_label: string;
  owner_user_id: string;
  /** Whose account fills this slot — the owning user's email (human-readable). */
  owner_label: string;
  /** The connection's H4 health status (`active`/`pending`/`expired`/`failed`). */
  status: string;
}

export interface EnvironmentView {
  id: string;
  name: string;
  is_prod: boolean;
  slots: SlotView[];
  pointer_count: number;
  trigger_count: number;
}

/** One environment referencing a connection (the delete-warning payload). */
export interface ConnectionReference {
  environment_id: string;
  environment: string;
  /** Distinct workflows with a pointer on that env — the blast radius. */
  workflows_affected: number;
}

/**
 * Named environments (ADR 0014): org-scoped SLOTS — (env, app) → one pool connection, by reference.
 * A missing slot fails honestly and NEVER falls back to the Default pool; names are stored lowercase.
 */
@Injectable()
export class EnvironmentsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly events: EventsService,
    private readonly triggerSignals: TriggerSignalsService,
  ) {}

  /** The org's environments (prod first), with slots and pointer/trigger counts. */
  async list(orgId: string): Promise<EnvironmentView[]> {
    await this.ensureDefaults(orgId);
    const em = this.dataSource.manager;
    const envs = await rawQuery<{
      id: string;
      name: string;
      is_prod: boolean;
      pointer_count: number;
      trigger_count: number;
    }>(
      em,
      `SELECT e.id, e.name, e.is_prod,
              (SELECT COUNT(*) FROM workflow_env_pointers p WHERE p.environment_id = e.id)::int AS pointer_count,
              (SELECT COUNT(*) FROM runtime_trigger_activations a WHERE a.environment_id = e.id)::int AS trigger_count
         FROM environments e
        WHERE e.org_id = $1
        ORDER BY e.is_prod DESC, e.name`,
      [orgId],
    );
    const slots = await rawQuery<{
      environment_id: string;
      app: string;
      connection_id: string;
      display_name: string | null;
      provider: string;
      owner_user_id: string;
      owner_email: string | null;
      status: string;
    }>(
      em,
      `SELECT ec.environment_id, ec.app, ec.connection_id, c.display_name, c.provider,
              c.user_id AS owner_user_id, u.email AS owner_email, c.status
         FROM environment_connections ec
         JOIN environments e ON e.id = ec.environment_id
         JOIN connections c ON c.id = ec.connection_id
         LEFT JOIN users u ON u.id = c.user_id
        WHERE e.org_id = $1
        ORDER BY ec.app`,
      [orgId],
    );
    return envs.map((e) => ({
      id: e.id,
      name: e.name,
      is_prod: e.is_prod,
      slots: slots
        .filter((s) => s.environment_id === e.id)
        .map((s) => ({
          app: s.app,
          connection_id: s.connection_id,
          account_label: s.display_name ?? s.provider,
          owner_user_id: s.owner_user_id,
          owner_label: s.owner_email ?? s.owner_user_id,
          status: s.status,
        })),
      pointer_count: e.pointer_count,
      trigger_count: e.trigger_count,
    }));
  }

  async create(orgId: string, rawName: string, actorUserId: string): Promise<{ id: string; name: string }> {
    const name = this.validName(rawName);
    return this.dataSource.transaction(async (em) => {
      const rows = await rawQuery<{ id: string }>(
        em,
        `INSERT INTO environments (org_id, name, is_prod) VALUES ($1, $2, $3)
         ON CONFLICT (org_id, lower(name)) DO NOTHING
         RETURNING id`,
        [orgId, name, name === PROD_ENV],
      );
      const row = rows[0];
      if (!row) throw new DomainError(`An environment named '${name}' already exists`, 409);
      await this.events.emit(em, {
        orgId,
        actorUserId,
        type: 'environment.created',
        subjectType: 'environment',
        subjectId: row.id,
        payload: { name },
      });
      return { id: row.id, name };
    });
  }

  /** Rename (label edit — pointers/activations follow via environment_id). 409 on is_prod. */
  async rename(
    orgId: string,
    envId: string,
    rawName: string,
    actorUserId: string,
  ): Promise<{ id: string; name: string }> {
    const name = this.validName(rawName);
    return this.dataSource.transaction(async (em) => {
      const env = await this.byIdForOrg(em, orgId, envId);
      if (env.isProd)
        throw new DomainError(`'${env.name}' is the production anchor — it cannot be renamed`, 409);
      if (env.name === UAT_ENV)
        throw new DomainError(`'uat' is a predefined environment — it cannot be renamed`, 409);
      if (env.name === name) return { id: env.id, name };
      const taken = await this.findByName(em, orgId, name);
      if (taken && taken.id !== env.id) {
        throw new DomainError(`An environment named '${name}' already exists`, 409);
      }
      await em.query(`UPDATE environments SET name = $2 WHERE id = $1`, [env.id, name]);
      // Dual-write the legacy pointer name string, or a pre-006 reader resolves the old name.
      await em.query(`UPDATE workflow_env_pointers SET environment = $2 WHERE environment_id = $1`, [
        env.id,
        name,
      ]);
      await this.events.emit(em, {
        orgId,
        actorUserId,
        type: 'environment.renamed',
        subjectType: 'environment',
        subjectId: env.id,
        payload: { from: env.name, to: name },
      });
      return { id: env.id, name };
    });
  }

  /** Delete an env: pointers dropped, slots and trigger activations cascade (ADR 0018); 409 on is_prod. */
  async remove(
    orgId: string,
    envId: string,
    actorUserId: string,
  ): Promise<{ removed_pointers: number; unbound_triggers: number }> {
    return this.dataSource.transaction(async (em) => {
      const env = await this.byIdForOrg(em, orgId, envId);
      if (env.isProd)
        throw new DomainError(`'${env.name}' is the production anchor — it cannot be deleted`, 409);
      if (env.name === UAT_ENV)
        throw new DomainError(`'uat' is a predefined environment — it cannot be deleted`, 409);
      // Also match legacy name-only rows, or the delete leaves a same-named ghost binding behind.
      const removedPointers = await rawMutate(
        em,
        `DELETE FROM workflow_env_pointers p
          USING workflows w
         WHERE w.id = p.workflow_id
           AND (p.environment_id = $1
                OR (p.environment_id IS NULL AND lower(p.environment) = $2 AND w.org_id = $3))`,
        [env.id, env.name, orgId],
      );
      // Count the activations the env delete will cascade away, for the receipt.
      const activationCount = await rawQuery<{ n: number }>(
        em,
        `SELECT COUNT(*)::int AS n FROM runtime_trigger_activations WHERE environment_id = $1`,
        [env.id],
      );
      const unboundTriggers = activationCount[0]?.n ?? 0;
      await em.query(`DELETE FROM environments WHERE id = $1`, [env.id]);
      await this.events.emit(em, {
        orgId,
        actorUserId,
        type: 'environment.deleted',
        subjectType: 'environment',
        subjectId: env.id,
        payload: { name: env.name, removed_pointers: removedPointers, unbound_triggers: unboundTriggers },
      });
      return { removed_pointers: removedPointers, unbound_triggers: unboundTriggers };
    });
  }

  /** Assign/replace a slot: (env, app) → a pool connection the caller owns; returns what it replaced and co-served envs. */
  async assignSlot(
    orgId: string,
    envId: string,
    app: string,
    connectionId: string,
    callerUserId: string,
  ): Promise<{ replaced_connection_id: string | null; also_in_environments: string[] }> {
    const result = await this.dataSource.transaction(async (em) => {
      const env = await this.byIdForOrg(em, orgId, envId);
      // Visibility = ownership: a foreign or malformed-id connection is an indistinguishable 404.
      const notFound = new DomainError('Connection not found', 404);
      if (!isIdShape(connectionId)) throw notFound;
      const conn = await em.findOne(ConnectionEntity, { where: { id: connectionId } });
      if (!conn || conn.userId !== callerUserId) throw notFound;

      const existing = await rawQuery<{ connection_id: string }>(
        em,
        `SELECT connection_id FROM environment_connections WHERE environment_id = $1 AND app = $2`,
        [env.id, app],
      );
      await em.query(
        `INSERT INTO environment_connections (environment_id, app, connection_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (environment_id, app)
         DO UPDATE SET connection_id = EXCLUDED.connection_id, created_at = now()`,
        [env.id, app, conn.id],
      );
      const also = await rawQuery<{ name: string }>(
        em,
        `SELECT DISTINCT e.name
           FROM environment_connections ec
           JOIN environments e ON e.id = ec.environment_id
          WHERE ec.connection_id = $1 AND e.org_id = $2 AND ec.environment_id <> $3
          ORDER BY e.name`,
        [conn.id, orgId, env.id],
      );
      const replaced = existing[0]?.connection_id ?? null;
      return {
        replaced_connection_id: replaced === conn.id ? null : replaced,
        also_in_environments: also.map((r) => r.name),
      };
    });
    // A slot swap changes what a promoted activation runs AS (ADR 0018) — reconcile this env's workflows.
    await this.enqueueEnvWorkflows(envId);
    return result;
  }

  /** Empty a slot — "<env> runs will fail on <app> until reassigned" (honest skip). */
  async emptySlot(orgId: string, envId: string, app: string): Promise<void> {
    const em = this.dataSource.manager;
    const env = await this.byIdForOrg(em, orgId, envId);
    const removed = await rawMutate(
      em,
      `DELETE FROM environment_connections WHERE environment_id = $1 AND app = $2`,
      [env.id, app],
    );
    if (removed === 0) {
      throw new DomainError(`No '${app}' slot assignment in the ${env.name} environment`, 404);
    }
    // Emptying a slot can strand a connection-needing activation (ADR 0018) — reconcile.
    await this.enqueueEnvWorkflows(envId);
  }

  /** Enqueue a trigger-activation reconcile for every workflow promoted to this env (ADR 0018). */
  private async enqueueEnvWorkflows(envId: string): Promise<void> {
    const rows = await rawQuery<{ workflow_id: string }>(
      this.dataSource.manager,
      `SELECT DISTINCT workflow_id FROM workflow_env_pointers WHERE environment_id = $1`,
      [envId],
    );
    for (const { workflow_id } of rows) await this.triggerSignals.enqueue(workflow_id);
  }

  /** Every environment whose slots reference this connection (delete warning). */
  async referencesOf(connectionId: string): Promise<ConnectionReference[]> {
    return (
      await rawQuery<{ environment_id: string; environment: string; workflows_affected: number }>(
        this.dataSource.manager,
        `SELECT e.id AS environment_id, e.name AS environment,
                (SELECT COUNT(DISTINCT p.workflow_id)
                   FROM workflow_env_pointers p WHERE p.environment_id = e.id)::int AS workflows_affected
           FROM environment_connections ec
           JOIN environments e ON e.id = ec.environment_id
          WHERE ec.connection_id = $1
          GROUP BY e.id, e.name, e.is_prod
          ORDER BY e.is_prod DESC, e.name`,
        [connectionId],
      )
    ).map((r) => ({
      environment_id: r.environment_id,
      environment: r.environment,
      workflows_affected: r.workflows_affected,
    }));
  }

  /** Find-or-create by name, so a pointer/trigger can never reference an env name with no row behind it. */
  async ensureEnvironment(em: EntityManager, orgId: string, rawName: string): Promise<EnvironmentEntity> {
    const name = canonicalEnvName(rawName);
    const found = await this.findByName(em, orgId, name);
    if (found) return found;
    await em.query(
      `INSERT INTO environments (org_id, name, is_prod) VALUES ($1, $2, $3)
       ON CONFLICT (org_id, lower(name)) DO NOTHING`,
      [orgId, name, name === PROD_ENV],
    );
    const after = await this.findByName(em, orgId, name);
    if (!after) throw new Error(`environment '${name}' vanished during ensure (org ${orgId})`);
    return after;
  }

  /** The org's env row by canonicalized NAME, or null — read-only, unlike `ensureEnvironment`. */
  findByNameForOrg(em: EntityManager, orgId: string, rawName: string): Promise<EnvironmentEntity | null> {
    return this.findByName(em, orgId, canonicalEnvName(rawName));
  }

  /** The org's env row by id — a foreign/unknown/malformed id is an indistinguishable 404. */
  async byIdForOrg(em: EntityManager, orgId: string, envId: string): Promise<EnvironmentEntity> {
    const notFound = new DomainError('Environment not found', 404);
    if (!isIdShape(envId)) throw notFound;
    const env = await em.findOne(EnvironmentEntity, { where: { id: envId, orgId } });
    if (!env) throw notFound;
    return env;
  }

  /** Lazy defaults: prod (is_prod anchor) + staging + uat, once per org. */
  private async ensureDefaults(orgId: string): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO environments (org_id, name, is_prod)
       VALUES ($1, 'production', true), ($1, 'staging', false), ($1, 'uat', false)
       ON CONFLICT (org_id, lower(name)) DO NOTHING`,
      [orgId],
    );
  }

  private findByName(em: EntityManager, orgId: string, name: string): Promise<EnvironmentEntity | null> {
    return em
      .createQueryBuilder(EnvironmentEntity, 'e')
      .where('e.org_id = :orgId', { orgId })
      .andWhere('lower(e.name) = :name', { name: normalizeEnvName(name) })
      .getOne();
  }

  private validName(rawName: string): string {
    const name = normalizeEnvName(rawName.trim());
    if (!ENV_NAME_SHAPE.test(name)) throw new DomainError('Invalid environment name', 400);
    if (RESERVED_ENV_NAMES.has(name)) {
      throw new DomainError(`'${name}' is reserved — it names the connection pool`, 400);
    }
    return name;
  }
}
