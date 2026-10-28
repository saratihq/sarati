import type { DataSource, EntityManager } from 'typeorm';

import type { Principal } from '../auth/principal';
import { DomainError } from '../common/domain-error';
import { OrganizationEntity } from '../database/entities/organization.entity';
import { WorkflowEntity } from '../database/entities/workflow.entity';
import { WorkflowEnvPointerEntity } from '../database/entities/workflow-env-pointer.entity';
import { WorkflowVersionEntity } from '../database/entities/workflow-version.entity';
import type { ConnectionsService } from '../connections/connections.service';
import type { EnvironmentsService } from '../environments/environments.service';
import type { EventsService } from '../events/events.service';
import type { OrgsService } from '../orgs/orgs.service';
import type { TriggerSignalsService } from '../triggers/trigger-signals.service';
import { EnvPointersService } from './env-pointers.service';

interface FakeState {
  wf?: WorkflowEntity | null;
  versions?: Array<{ id: string; workflowId: string; versionNumber: number; branchId?: string | null }>;
  pointers?: Array<{ workflowId: string; environment: string; versionId: string }>;
  org?: { id: string; isPersonal: boolean; personalOwnerId: string | null } | null;
}

const WORKFLOW_LOCK = /FROM workflows WHERE id = \$1 FOR (?:KEY SHARE|NO KEY UPDATE)/;

/** In-memory EntityManager double: findOne dispatches on the entity class. */
function fakeEm(state: FakeState): EntityManager & { findOne: jest.Mock; query: jest.Mock } {
  const query = jest.fn((sql: string) =>
    Promise.resolve(WORKFLOW_LOCK.test(String(sql)) && state.wf ? [{}] : []),
  );
  const findOne = jest.fn((entity: unknown, opts: { where: Record<string, unknown> }): Promise<unknown> => {
    const where = opts.where;
    if (entity === WorkflowEntity) return Promise.resolve(state.wf ?? null);
    if (entity === WorkflowVersionEntity) {
      return Promise.resolve(
        state.versions?.find(
          (v) =>
            (where.id === undefined || v.id === where.id) &&
            (where.workflowId === undefined || v.workflowId === where.workflowId),
        ) ?? null,
      );
    }
    if (entity === WorkflowEnvPointerEntity) {
      return Promise.resolve(
        state.pointers?.find(
          (p) => p.workflowId === where.workflowId && p.environment === where.environment,
        ) ?? null,
      );
    }
    if (entity === OrganizationEntity) return Promise.resolve(state.org ?? null);
    return Promise.resolve(null);
  });
  return { findOne, query } as unknown as EntityManager & { findOne: jest.Mock; query: jest.Mock };
}

/** The statements a call wrote, less the workflow-row lock every write takes first. */
const writes = (em: { query: jest.Mock }): unknown[][] =>
  em.query.mock.calls.filter(([sql]) => !WORKFLOW_LOCK.test(String(sql)));

function build(state: FakeState, opts: { role?: 'owner' | 'admin' | 'member' | null } = {}) {
  const em = fakeEm(state);
  const dataSource = {
    transaction: (cb: (m: EntityManager) => Promise<unknown>) => cb(em),
    manager: em,
  } as unknown as DataSource;
  const emit = jest.fn().mockResolvedValue(undefined);
  const roleOf = jest.fn().mockResolvedValue(opts.role ?? null);
  // Env rows exist only for org workflows; the dual-write resolves them here.
  const ensureEnvironment = jest
    .fn()
    .mockImplementation((_em: unknown, _orgId: string, name: string) =>
      Promise.resolve({ id: `env-${name}`, name, isProd: name === 'production' }),
    );
  const byIdForOrg = jest.fn().mockRejectedValue(new DomainError('Environment not found', 404));
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const accountsOn = jest.fn(() => ({}));
  const svc = new EnvPointersService(
    dataSource,
    { emit } as unknown as EventsService,
    { roleOf } as unknown as OrgsService,
    { ensureEnvironment, byIdForOrg } as unknown as EnvironmentsService,
    { enqueue } as unknown as TriggerSignalsService,
    { accountsOn } as unknown as ConnectionsService,
  );
  return { svc, em, emit, roleOf, ensureEnvironment, enqueue, accountsOn };
}

const WF = 'wf-1';
const V1 = '11111111-1111-1111-1111-111111111111';
const V2 = '22222222-2222-2222-2222-222222222222';
const MAIN = 'branch-main';
const USER = {
  kind: 'user',
  user: { id: 'user-1' },
  activeOrgId: null,
  activeOrgRole: null,
} as unknown as Principal;

const wf = (over: Record<string, unknown> = {}): WorkflowEntity =>
  ({
    id: WF,
    activeVersionId: null,
    defaultBranchId: MAIN,
    orgId: null,
    name: 'wf',
    ...over,
  }) as unknown as WorkflowEntity;

describe('EnvPointersService.resolveVersionId (the fire-path resolution seam)', () => {
  it('NULL environment resolves the prod pointer (== the pre-H1 behavior)', async () => {
    const { svc, em } = build({ pointers: [{ workflowId: WF, environment: 'production', versionId: V1 }] });
    await expect(svc.resolveVersionId(em, wf(), null)).resolves.toBe(V1);
    expect(em.findOne).toHaveBeenCalledWith(WorkflowEnvPointerEntity, {
      where: { workflowId: WF, environment: 'production' },
    });
  });

  it('a scoped environment resolves its OWN pointer, not prod', async () => {
    const { svc, em } = build({
      pointers: [
        { workflowId: WF, environment: 'production', versionId: V1 },
        { workflowId: WF, environment: 'staging', versionId: V2 },
      ],
    });
    await expect(svc.resolveVersionId(em, wf(), 'staging')).resolves.toBe(V2);
  });

  it('prod falls back to the legacy alias (active_version_id) when no pointer row exists', async () => {
    const { svc, em } = build({ pointers: [] });
    await expect(svc.resolveVersionId(em, wf({ activeVersionId: V1 }), null)).resolves.toBe(V1);
  });

  it('a missing non-prod pointer is null — the caller skips the fire (never falls back to prod)', async () => {
    const { svc, em } = build({ pointers: [{ workflowId: WF, environment: 'production', versionId: V1 }] });
    await expect(svc.resolveVersionId(em, wf({ activeVersionId: V1 }), 'staging')).resolves.toBeNull();
  });

  it('environment names are case-insensitive slugs (normalized to lowercase)', async () => {
    const { svc, em } = build({ pointers: [{ workflowId: WF, environment: 'staging', versionId: V2 }] });
    await expect(svc.resolveVersionId(em, wf(), 'Staging')).resolves.toBe(V2);
  });
});

describe('EnvPointersService.setPointer (the one alias-syncing write)', () => {
  it('upserts the pointer row; a prod move also syncs active_version_id', async () => {
    const { svc, em } = build({});
    await svc.setPointer(em, WF, 'production', V1);
    expect(em.query).toHaveBeenCalledTimes(2);
    expect(String(em.query.mock.calls[0][0])).toContain('INSERT INTO workflow_env_pointers');
    // Org-less workflow: no env row exists, so the dual-written id is null.
    expect(em.query.mock.calls[0][1]).toEqual([WF, 'production', V1, null]);
    expect(String(em.query.mock.calls[1][0])).toContain('UPDATE workflows SET active_version_id');
    expect(em.query.mock.calls[1][1]).toEqual([WF, V1]);
  });

  it('a non-prod move never touches the legacy alias', async () => {
    const { svc, em } = build({});
    await svc.setPointer(em, WF, 'staging', V2);
    expect(em.query).toHaveBeenCalledTimes(1);
    expect(String(em.query.mock.calls[0][0])).toContain('INSERT INTO workflow_env_pointers');
  });

  it("an ORG workflow's pointer is found by its env row's id and carries that row's name, inserted when there is none", async () => {
    const { svc, em, ensureEnvironment } = build({ wf: wf({ orgId: 'org-1' }) });
    await svc.setPointer(em, WF, 'staging', V2);
    expect(ensureEnvironment).toHaveBeenCalledWith(em, 'org-1', 'staging');
    expect(String(em.query.mock.calls[0][0])).toContain('WHERE workflow_id = $1 AND environment_id = $2');
    expect(em.query.mock.calls[0][1]).toEqual([WF, 'env-staging', V2, 'staging']);
    expect(String(em.query.mock.calls[1][0])).toContain('INSERT INTO workflow_env_pointers');
    expect(em.query.mock.calls[1][1]).toEqual([WF, 'staging', V2, 'env-staging']);
  });
});

describe('EnvPointersService.promote', () => {
  const versions = [
    { id: V1, workflowId: WF, versionNumber: 1, branchId: MAIN },
    { id: V2, workflowId: WF, versionNumber: 2, branchId: MAIN },
  ];

  it('moves the pointer and emits workflow.promoted once', async () => {
    const { svc, emit, em } = build({
      wf: wf({ activeVersionId: V1 }),
      versions,
      pointers: [{ workflowId: WF, environment: 'production', versionId: V1 }],
    });
    const res = await svc.promote(WF, 'staging', V2, USER);
    expect(res).toMatchObject({
      status: 'promoted',
      environment: 'staging',
      version_number: 2,
      previous_version_number: null, // staging had nothing before
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(String(em.query.mock.calls[0]![0])).toContain('FROM workflows WHERE id = $1 FOR NO KEY UPDATE');
    expect(writes(em)).toHaveLength(1); // pointer upsert only — no alias write for staging
  });

  it('is idempotent: re-promoting the pointed version writes and emits nothing', async () => {
    const { svc, emit, em } = build({
      wf: wf(),
      versions,
      pointers: [{ workflowId: WF, environment: 'staging', versionId: V2 }],
    });
    const res = await svc.promote(WF, 'staging', V2, USER);
    expect(res).toMatchObject({ status: 'promoted', version_number: 2, previous_version_number: 2 });
    expect(emit).not.toHaveBeenCalled();
    expect(writes(em)).toEqual([]);
  });

  it('prod promote via the endpoint == publish: pointer + alias move together', async () => {
    const { svc, em, emit } = build({ wf: wf({ activeVersionId: V1 }), versions, pointers: [] });
    const res = await svc.promote(WF, 'production', V2, USER);
    expect(res).toMatchObject({ environment: 'production', version_number: 2, previous_version_number: 1 });
    expect(writes(em)).toHaveLength(2); // upsert + alias sync
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid environment name', async () => {
    const { svc } = build({ wf: wf(), versions });
    await expect(svc.promote(WF, 'bad.env', V2, USER)).rejects.toMatchObject({ status: 400 });
  });

  it("404s a version that isn't this workflow's", async () => {
    const { svc } = build({ wf: wf(), versions: [] });
    await expect(svc.promote(WF, 'staging', V2, USER)).rejects.toMatchObject({ status: 404 });
  });

  it('prod/uat promote from the default branch only (tag-rule mirror)', async () => {
    const branchVersion = { id: V2, workflowId: WF, versionNumber: 2, branchId: 'branch-feature' };
    const { svc } = build({ wf: wf(), versions: [branchVersion] });
    await expect(svc.promote(WF, 'production', V2, USER)).rejects.toThrow(/default branch only/);
    await expect(svc.promote(WF, 'uat', V2, USER)).rejects.toThrow(/default branch only/);
    // …while a non-main-only env may point at a branch version.
    await expect(svc.promote(WF, 'staging', V2, USER)).resolves.toMatchObject({ status: 'promoted' });
  });

  it(' mirror + B3: a non-personal-org env pointer move needs owner/admin — for EVERY env incl. prod', async () => {
    const orgWf = wf({ orgId: 'org-1' });
    const org = { id: 'org-1', isPersonal: false, personalOwnerId: null };
    const member = build({ wf: orgWf, versions, org }, { role: 'member' });
    await expect(member.svc.promote(WF, 'staging', V2, USER)).rejects.toMatchObject({ status: 403 });

    const admin = build({ wf: orgWf, versions, org }, { role: 'admin' });
    await expect(admin.svc.promote(WF, 'staging', V2, USER)).resolves.toMatchObject({ status: 'promoted' });
    // The slot preflight reads on the promote's own transaction, never a second pooled connection.
    expect(admin.accountsOn).toHaveBeenCalledWith(admin.em);

    // prod is not exempt — the most consequential move is gated too.
    const memberProd = build({ wf: orgWf, versions, org }, { role: 'member' });
    await expect(memberProd.svc.promote(WF, 'production', V2, USER)).rejects.toMatchObject({ status: 403 });
    expect(memberProd.roleOf).toHaveBeenCalled();

    // …but an owner/admin still moves the prod pointer (capability moved, not removed).
    const ownerProd = build({ wf: orgWf, versions, org }, { role: 'owner' });
    await expect(ownerProd.svc.promote(WF, 'production', V2, USER)).resolves.toMatchObject({
      status: 'promoted',
    });

    // Its owner's personal workspace asks no role; anyone else there is asked it, as in a shared org.
    const personal = { id: 'org-1', isPersonal: true, personalOwnerId: 'user-1' };
    const own = build({ wf: orgWf, versions, org: personal }, { role: 'owner' });
    await expect(own.svc.promote(WF, 'production', V2, USER)).resolves.toMatchObject({
      status: 'promoted',
    });
    expect(own.roleOf).not.toHaveBeenCalled();
    const elsewhere = { ...personal, personalOwnerId: 'user-2' };
    const stray = build({ wf: orgWf, versions, org: elsewhere }, { role: 'member' });
    await expect(stray.svc.promote(WF, 'production', V2, USER)).rejects.toMatchObject({ status: 403 });
  });

  it('404s a missing workflow', async () => {
    const { svc } = build({ wf: null });
    await expect(svc.promote(WF, 'staging', V2, USER)).rejects.toMatchObject({ status: 404 });
  });

  it('propagates DomainError statuses (sanity: DomainError carries its status)', () => {
    expect(new DomainError('x', 403).status).toBe(403);
  });
});
