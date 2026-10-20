import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { accountLabel, storedAccount } from '../connections/account-identity';
import { providersServing } from '../connections/run-as-account';
import { isIdShape } from '../database/ids';
import { isUniqueViolation } from '../database/pg-errors';
import { rawMutate, rawMutateReturning, rawQuery } from '../database/raw-query';
import { ConnectionEntity } from '../database/entities/connection.entity';
import { EnvironmentEntity } from '../database/entities/environment.entity';
import { EventsService } from '../events/events.service';
import { lockOrgForWrite } from '../orgs/org-row-lock';
import { TriggerSignalsService } from '../triggers/trigger-signals.service';
import { lockDeletable } from '../triggers/trigger-release';
import { runBounded } from '../common/bounded';
import { chatPathFor, webhookPathFor } from '../triggers/canvas/webhook-url';
import { INCOMING_CHAT_PUBLIC, INCOMING_WEBHOOK_PUBLIC } from '../triggers/trigger-catalog.service';
import type { WorkflowIR } from '../ir/models';
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
  /** The connection's display identity: its display name, else the account the provider named, else the app. */
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

/** An incoming-webhook or chat trigger whose URL a rename moves; a sender was given it by hand. */
export interface UrlChange {
  workflow_id: string;
  workflow_name: string;
  trigger: 'webhook' | 'chat';
  /** The service-relative intake path before the rename. */
  from: string;
  /** The service-relative intake path after it. */
  to: string;
}

/** A trigger whose `url_changes` entry the caller saw and confirmed moving. */
export type ConfirmedUrlChange = Pick<UrlChange, 'workflow_id' | 'trigger' | 'from' | 'to'>;

const DRAIN_CONCURRENCY = 5;

const ENSURE_ATTEMPTS = 3;

const DEFAULT_ENVS = [PROD_ENV, 'staging', UAT_ENV];

const HAND_GIVEN_URLS = [
  { trigger: 'chat', nodeType: INCOMING_CHAT_PUBLIC, pathFor: chatPathFor },
  { trigger: 'webhook', nodeType: INCOMING_WEBHOOK_PUBLIC, pathFor: webhookPathFor },
] as const;

/** One environment referencing a connection (the delete-warning payload). */
export interface ConnectionReference {
  environment_id: string;
  environment: string;
  /** Distinct workflows with a pointer on that env — the blast radius. */
  workflows_affected: number;
}

/**
 * Named environments: org-scoped SLOTS — (env, app) → one pool connection, by reference.
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
      account: unknown;
      owner_user_id: string;
      owner_email: string | null;
      status: string;
    }>(
      em,
      `SELECT ec.environment_id, ec.app, ec.connection_id, c.display_name, c.provider, c.account,
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
          account_label: s.display_name ?? slotAccountLabel(s.account) ?? s.provider,
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
      await lockOrgForWrite(em, orgId);
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

  /** Rename; registered webhooks move to the new URL, and each hand-given URL it moves must be in `confirmed` (409 lists them). 409 on is_prod. */
  async rename(
    orgId: string,
    envId: string,
    rawName: string,
    actorUserId: string,
    confirmed: ConfirmedUrlChange[] | null = null,
  ): Promise<{ id: string; name: string }> {
    const name = this.validName(rawName);
    const renamed = await this.dataSource.transaction(async (em) => {
      await lockOrgForWrite(em, orgId);
      const env = await this.byIdForOrg(em, orgId, envId, true);
      if (env.isProd)
        throw new DomainError(`'${env.name}' is the production anchor — it cannot be renamed`, 409);
      if (env.name === UAT_ENV)
        throw new DomainError(`'uat' is a predefined environment — it cannot be renamed`, 409);
      if (env.name === name) return { id: env.id, name };
      const taken = await this.findByName(em, orgId, name);
      if (taken && taken.id !== env.id) {
        throw new DomainError(`An environment named '${name}' already exists`, 409);
      }
      await this.assertUrlChangesConfirmed(em, env, name, confirmed);
      await em
        .query(`UPDATE environments SET name = $2 WHERE id = $1`, [env.id, name])
        .catch((err: unknown) => {
          // Another transaction took the name after the check above.
          throw isUniqueViolation(err)
            ? new DomainError(`An environment named '${name}' already exists`, 409)
            : err;
        });
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
    // The env's intake URLs carry its name, so its registered webhooks must be pointed at the new one.
    await this.enqueueEnvWorkflows(envId);
    return renamed;
  }

  /** Delete an env: unpromote its workflows, tear its triggers down, then drop it and its slots; 409 on is_prod. */
  async remove(
    orgId: string,
    envId: string,
    actorUserId: string,
  ): Promise<{ removed_pointers: number; unbound_triggers: number }> {
    const { env, removedPointers, holders } = await this.unpromoteAll(orgId, envId, actorUserId);
    // With the pointers gone each reconcile tears this env's activations down at their providers.
    await runBounded([...new Set(holders)], DRAIN_CONCURRENCY, (workflowId) =>
      this.triggerSignals.reconcileNow(workflowId),
    );
    return this.dataSource.transaction(async (em) => {
      await lockOrgForWrite(em, orgId);
      await lockDeletable(em, { environmentId: env.id }, `'${env.name}'`);
      await em.query(`DELETE FROM environments WHERE id = $1`, [env.id]);
      const receipt = { removed_pointers: removedPointers, unbound_triggers: holders.length };
      await this.events.emit(em, {
        orgId,
        actorUserId,
        type: 'environment.deleted',
        subjectType: 'environment',
        subjectId: env.id,
        payload: { name: env.name, ...receipt },
      });
      return receipt;
    });
  }

  // `holders` has one entry per activation in the env, so its length is the receipt's unbound count.
  private unpromoteAll(
    orgId: string,
    envId: string,
    actorUserId: string,
  ): Promise<{ env: EnvironmentEntity; removedPointers: number; holders: string[] }> {
    return this.dataSource.transaction(async (em) => {
      const env = await this.byIdForOrg(em, orgId, envId);
      if (env.isProd)
        throw new DomainError(`'${env.name}' is the production anchor — it cannot be deleted`, 409);
      if (env.name === UAT_ENV)
        throw new DomainError(`'uat' is a predefined environment — it cannot be deleted`, 409);
      const activations = await rawQuery<{ workflow_id: string }>(
        em,
        `SELECT workflow_id FROM runtime_trigger_activations WHERE environment_id = $1`,
        [env.id],
      );
      // Also match legacy name-only rows, or the delete leaves a same-named ghost binding behind.
      const removed = await rawMutateReturning<{ workflow_id: string }>(
        em,
        `DELETE FROM workflow_env_pointers p
          USING workflows w
         WHERE w.id = p.workflow_id
           AND (p.environment_id = $1
                OR (p.environment_id IS NULL AND lower(p.environment) = $2 AND w.org_id = $3))
        RETURNING p.workflow_id`,
        [env.id, env.name, orgId],
      );
      for (const { workflow_id } of removed) {
        await this.events.emit(em, {
          orgId,
          actorUserId,
          type: 'workflow.unpromoted',
          subjectType: 'workflow',
          subjectId: workflow_id,
          payload: { environment: env.name },
        });
      }
      return { env, removedPointers: removed.length, holders: activations.map((a) => a.workflow_id) };
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
      await lockOrgForWrite(em, orgId);
      const env = await this.byIdForOrg(em, orgId, envId);
      // Visibility = ownership: a foreign or malformed-id connection is an indistinguishable 404.
      const notFound = new DomainError('Connection not found', 404);
      if (!isIdShape(connectionId)) throw notFound;
      const conn = await em.findOne(ConnectionEntity, { where: { id: connectionId } });
      if (!conn || conn.userId !== callerUserId) throw notFound;
      if (!providersServing(app).includes(conn.provider)) {
        throw new DomainError(
          `That account is for ${conn.provider}, not ${app} — assign a ${app} account to this slot`,
          422,
        );
      }

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
    // A slot swap changes what a promoted activation runs AS — reconcile this env's workflows.
    await this.enqueueEnvWorkflows(envId);
    return result;
  }

  /** Empty a slot — "<env> runs will fail on <app> until reassigned" (honest skip). */
  async emptySlot(orgId: string, envId: string, app: string): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      await lockOrgForWrite(em, orgId);
      const env = await this.byIdForOrg(em, orgId, envId);
      const removed = await rawMutate(
        em,
        `DELETE FROM environment_connections WHERE environment_id = $1 AND app = $2`,
        [env.id, app],
      );
      if (removed === 0) {
        throw new DomainError(`No '${app}' slot assignment in the ${env.name} environment`, 404);
      }
    });
    // Emptying a slot can strand a connection-needing activation — reconcile.
    await this.enqueueEnvWorkflows(envId);
  }

  private async assertUrlChangesConfirmed(
    em: EntityManager,
    env: EnvironmentEntity,
    name: string,
    confirmed: ConfirmedUrlChange[] | null,
  ): Promise<void> {
    const changes = await this.urlChangesOf(em, env, name);
    const seen = (c: UrlChange): boolean =>
      confirmed?.some(
        (k) =>
          k.workflow_id === c.workflow_id && k.trigger === c.trigger && k.from === c.from && k.to === c.to,
      ) ?? false;
    if (changes.every(seen)) return;
    const count =
      changes.length === 1
        ? 'an incoming webhook or chat trigger'
        : `${changes.length} incoming webhook and chat triggers`;
    throw new DomainError(
      confirmed?.length
        ? `Renaming '${env.name}' now changes URLs you didn't confirm — check the list and confirm the rename again`
        : `Renaming '${env.name}' to '${name}' changes the URL of ${count}, so anything still sending to the old URL gets a 404 — confirm the rename to go ahead`,
      409,
      { url_changes: changes },
    );
  }

  // Read from what serves the URL — the pointer's pinned version — and held still until the rename commits.
  private async urlChangesOf(em: EntityManager, env: EnvironmentEntity, name: string): Promise<UrlChange[]> {
    // Locked on their own: a join that locks them re-checks a pointer moved meanwhile against the version it read first.
    await rawQuery(em, `SELECT 1 FROM workflow_env_pointers WHERE environment_id = $1 FOR SHARE`, [env.id]);
    const pointers = await rawQuery<{
      workflow_id: string;
      workflow_name: string;
      workflow_ir: WorkflowIR | null;
    }>(
      em,
      `SELECT p.workflow_id, w.name AS workflow_name, v.workflow_ir
         FROM workflow_env_pointers p
         JOIN workflows w ON w.id = p.workflow_id
         JOIN workflow_versions v ON v.id = p.version_id
        WHERE p.environment_id = $1
        ORDER BY w.name, p.workflow_id`,
      [env.id],
    );
    return pointers.flatMap((p) =>
      HAND_GIVEN_URLS.filter(({ nodeType }) =>
        p.workflow_ir?.nodes.some((n) => n.node_type === nodeType),
      ).map(({ trigger, pathFor }) => ({
        workflow_id: p.workflow_id,
        workflow_name: p.workflow_name,
        trigger,
        from: pathFor(p.workflow_id, env.name),
        to: pathFor(p.workflow_id, name),
      })),
    );
  }

  /** Enqueue a trigger-activation reconcile for every workflow promoted to this env. */
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

  /** Find-or-create by name, held FOR SHARE until the caller commits, so a rename waits for the pointer write it serves. */
  async ensureEnvironment(em: EntityManager, orgId: string, rawName: string): Promise<EnvironmentEntity> {
    const name = canonicalEnvName(rawName);
    let found = await this.findByName(em, orgId, name, true);
    // A rename or delete can take the row between the conflicting insert and the read, freeing the name again.
    for (let attempt = 0; !found && attempt < ENSURE_ATTEMPTS; attempt++) {
      await em.query(
        `INSERT INTO environments (org_id, name, is_prod) VALUES ($1, $2, $3)
         ON CONFLICT (org_id, lower(name)) DO NOTHING`,
        [orgId, name, name === PROD_ENV],
      );
      found = await this.findByName(em, orgId, name, true);
    }
    if (!found) {
      throw new DomainError(
        `The environment '${name}' kept being renamed or deleted while this ran — try again`,
        409,
      );
    }
    return found;
  }

  /** The org's env row by canonicalized NAME, or null; never creates one, unlike `ensureEnvironment`. `lock` holds it FOR SHARE until the caller commits. */
  findByNameForOrg(
    em: EntityManager,
    orgId: string,
    rawName: string,
    lock = false,
  ): Promise<EnvironmentEntity | null> {
    return this.findByName(em, orgId, canonicalEnvName(rawName), lock);
  }

  /** The org's env row by id — a foreign/unknown/malformed id is an indistinguishable 404. */
  async byIdForOrg(
    em: EntityManager,
    orgId: string,
    envId: string,
    lock = false,
  ): Promise<EnvironmentEntity> {
    const notFound = new DomainError('Environment not found', 404);
    if (!isIdShape(envId)) throw notFound;
    const env = await em.findOne(EnvironmentEntity, {
      where: { id: envId, orgId },
      ...(lock ? { lock: { mode: 'for_no_key_update' as const } } : {}),
    });
    if (!env) throw notFound;
    return env;
  }

  /** Lazy defaults: prod (is_prod anchor) + staging + uat, once per org. */
  private async ensureDefaults(orgId: string): Promise<void> {
    const [present] = await rawQuery<{ count: number }>(
      this.dataSource.manager,
      `SELECT count(*)::int AS count FROM environments WHERE org_id = $1 AND lower(name) = ANY($2)`,
      [orgId, DEFAULT_ENVS],
    );
    if (present?.count === DEFAULT_ENVS.length) return;
    await this.dataSource.transaction(async (em) => {
      await lockOrgForWrite(em, orgId);
      await em.query(
        `INSERT INTO environments (org_id, name, is_prod)
         SELECT $1, name, name = $3 FROM unnest($2::text[]) AS name
         ON CONFLICT (org_id, lower(name)) DO NOTHING`,
        [orgId, DEFAULT_ENVS, PROD_ENV],
      );
    });
  }

  private findByName(
    em: EntityManager,
    orgId: string,
    name: string,
    lock = false,
  ): Promise<EnvironmentEntity | null> {
    const query = em
      .createQueryBuilder(EnvironmentEntity, 'e')
      .where('e.org_id = :orgId', { orgId })
      .andWhere('lower(e.name) = :name', { name: normalizeEnvName(name) });
    return (lock ? query.setLock('pessimistic_read') : query).getOne();
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

function slotAccountLabel(raw: unknown): string | null {
  const account = storedAccount(raw);
  return account ? accountLabel(account) : null;
}
