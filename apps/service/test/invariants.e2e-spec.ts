import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { Client } from 'pg';
import request from 'supertest';
import type { FetchLike, FetchLikeResponse } from '@sarati/actions-sdk';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { compileWorkflowIrDag } from '../src/compiler/compile-ir-dag';
import { ConnectionsService } from '../src/connections/connections.service';
import { computeDiff } from '../src/ir/diff';
import type { WorkflowIR } from '../src/ir/models';
import { type AgentResult } from '../src/runtime/agent';
import { ScriptedAgentModel } from '../src/runtime/agent.testkit';
import type { DagAgentNode } from '../src/runtime/dag-plan';
import { DagInterpreter } from '../src/runtime/dag-interpreter';
import { SDK_ACTIONS_FETCH } from '../src/providers/sdk-actions.provider';
import { TriggerReconcilerService } from '../src/triggers/canvas/trigger-reconciler.service';
import { listenOnLoopback } from './support/listen';
import { insertPersonalOrgs } from './support/personal-org';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** A Gmail behind our own Gmail actions: one mailbox per access token, and every search it is asked. */
const MAILBOXES: Record<string, string> = {
  'tok-authored': 'author@e2e.local',
  'tok-staging': 'staging@e2e.local',
  'tok-runner': 'runner@e2e.local',
  'tok-runner-2': 'runner2@e2e.local',
  'tok-slot': 'slot@e2e.local',
};
const gmailSearches: string[] = [];
const gmailFetch: FetchLike = (input, init) => {
  const url = new URL(String(input));
  const token = (init?.headers?.authorization ?? '').replace(/^Bearer /, '');
  const reply = (status: number, body: unknown): Promise<FetchLikeResponse> =>
    Promise.resolve({
      status,
      headers: { forEach: (cb) => cb('application/json', 'content-type') },
      text: () => Promise.resolve(JSON.stringify(body)),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });
  if (url.pathname.endsWith('/profile')) {
    const email = MAILBOXES[token];
    return email
      ? reply(200, { emailAddress: email, messagesTotal: 1, threadsTotal: 1, historyId: '1' })
      : reply(401, { error: { code: 401, message: 'Invalid Credentials' } });
  }
  if (url.pathname.endsWith('/messages')) {
    gmailSearches.push(url.searchParams.get('q') ?? '');
    return reply(200, { messages: [], resultSizeEstimate: 0 });
  }
  return reply(404, { error: { code: 404, message: `unexpected ${url.pathname}` } });
};

/**
 * THE CONSTITUTION (src/domain/README.md): one named test per load-bearing rule.
 * A red test here means the change is wrong, or is a deliberate amendment that says so — never edit the test to pass.
 */
describe('domain invariants (the constitution)', () => {
  let app: INestApplication;
  let db: Client;
  let reconciler: TriggerReconcilerService;

  const ir = (texts: string[], name = 'invariant probe') => ({
    version: '1',
    name,
    description: '',
    nodes: [
      {
        id: 'trigger',
        name: 'Trigger',
        node_type: 'orchestr:trigger',
        type_version: 1,
        parameters: {},
        position: { x: 0, y: 0 },
        metadata: {},
      },
      {
        id: 'announce',
        name: 'Announce',
        node_type: 'text.concat',
        type_version: 1,
        parameters: { texts, separator: '' },
        position: { x: 300, y: 0 },
        metadata: {},
      },
    ],
    edges: [
      {
        id: 'e1',
        source_node_id: 'trigger',
        source_port: 0,
        target_node_id: 'announce',
        target_port: 0,
        port_type: 'main',
      },
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: { engine: 'orchestr' },
  });

  const http = () => request(app.getHttpServer());
  const seed = async (name: string): Promise<string> => {
    const dep = await http()
      .post('/api/deploy')
      .send({ workflow_json: ir(['v1'], name) })
      .expect(201);
    return dep.body.workflow_id as string;
  };

  // ─── fixtures: a trigger is an IR NODE in the version doc ───

  /** A version doc whose SOURCE is a native canvas trigger node feeding an `announce` step. */
  const triggerIr = (
    trigger: { node_type: string; parameters?: Record<string, unknown> },
    marker: string,
    name = 'canvas trigger probe',
  ) => ({
    version: '1',
    name,
    description: '',
    nodes: [
      {
        id: 'trig',
        name: 'Trigger',
        node_type: trigger.node_type,
        type_version: 1,
        parameters: trigger.parameters ?? {},
        position: { x: 0, y: 0 },
        metadata: {},
      },
      {
        id: 'announce',
        name: 'Announce',
        node_type: 'text.concat',
        type_version: 1,
        parameters: { values: [marker], separator: '' },
        position: { x: 300, y: 0 },
        metadata: {},
      },
    ],
    edges: [
      {
        id: 'e1',
        source_node_id: 'trig',
        source_port: 0,
        target_node_id: 'announce',
        target_port: 0,
        port_type: 'main',
      },
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: { engine: 'orchestr' },
  });

  const webhookIr = (marker: string, name?: string) =>
    triggerIr({ node_type: 'orchestr:webhook' }, marker, name);
  const scheduleIr = (marker: string, props: Record<string, unknown>, name?: string) =>
    triggerIr({ node_type: 'orchestr:schedule', parameters: props }, marker, name);

  const seedDoc = async (doc: Record<string, unknown>): Promise<string> => {
    const dep = await http().post('/api/deploy').send({ workflow_json: doc }).expect(201);
    return dep.body.workflow_id as string;
  };

  const versionId = async (wf: string, versionNumber: number): Promise<string> => {
    const res = await http().get(`/api/workflows/${wf}/versions?branch=main`).expect(200);
    const found = (res.body.versions as Array<{ id: string; version_number: number }>).find(
      (v) => v.version_number === versionNumber,
    );
    return found!.id;
  };

  const awaitRun = async (runId: string): Promise<Record<string, unknown>> => {
    let run: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      const res = await http().get(`/api/runs/${runId}`).expect(200);
      run = res.body as Record<string, unknown>;
      if (run.status === 'completed' || run.status === 'error') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return run;
  };

  /** The activation row for a workflow's env — scoped by NAME because deploy also auto-promotes to production. */
  const activationRow = async (
    wf: string,
    envName: string,
  ): Promise<{ id: string; version_id: string; trigger_node_id: string; kind: string }> => {
    const res = await db.query(
      `SELECT a.id, a.version_id, a.trigger_node_id, a.kind
         FROM runtime_trigger_activations a
         JOIN environments e ON e.id = a.environment_id
        WHERE a.workflow_id = $1 AND e.name = $2`,
      [wf, envName],
    );
    return res.rows[0];
  };

  const scheduleCursor = async (activationId: string): Promise<string | null> => {
    const res = await db.query(
      `SELECT value FROM runtime_activation_store WHERE activation_id = $1 AND key = 'schedule.lastFire'`,
      [activationId],
    );
    return (res.rows[0]?.value as string | null) ?? null;
  };

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.MOCK_AUTH = 'true';
    process.env.FERNET_KEY = TEST_FERNET_KEY;
    // Rate limits have their own contract test (app.e2e-spec "429 contract"); left on here they only
    // cap how many invariants this file may assert, and the cap is wall-clock dependent. Disabled at
    // the storage: a per-route @Throttle overrides the env-driven limit, and APP_GUARD ignores
    // overrideGuard, so this is the only seam that actually stops the counting.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SDK_ACTIONS_FETCH)
      .useValue(gmailFetch)
      .overrideProvider(ThrottlerStorage)
      .useValue({
        increment: () =>
          Promise.resolve({ totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 }),
      })
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
    // pg-boss is off in e2e, so pointer moves reconcile inline and the reconciler can be driven directly.
    db = new Client({ connectionString: e2eUrl });
    await db.connect();
    reconciler = app.get(TriggerReconcilerService);
  }, 30_000);

  afterAll(async () => {
    await db.end();
    await app.close();
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
  });

  it('per-branch numbering: a branch inherits its fork point and its first own commit is v1', async () => {
    const wf = await seed('inv numbering');
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: ir(['v2']), branch: 'main' })
      .expect(201);
    await http().post(`/api/workflows/${wf}/branches`).send({ name: 'lane' }).expect(201);
    const commit = await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: ir(['lane-1']), branch: 'lane' })
      .expect(201);
    expect(commit.body.version_number).toBe(1); // the branch's OWN lane starts at 1
    const main = await http().get(`/api/workflows/${wf}/versions?branch=main`).expect(200);
    expect(main.body.versions.map((v: { version_number: number }) => v.version_number).sort()).toEqual([
      1, 2,
    ]);
    await http().delete(`/api/workflows/${wf}`).expect(200);
  });

  it('save never moves live: commits advance the head, only publish moves the pointer', async () => {
    const wf = await seed('inv save-live');
    const before = await http().get(`/api/workflows/${wf}`).expect(200);
    expect(before.body.live_version).toBe(1);
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: ir(['v2']), branch: 'main' })
      .expect(201);
    const after = await http().get(`/api/workflows/${wf}`).expect(200);
    expect(after.body.latest_version).toBe(2);
    expect(after.body.live_version).toBe(1); // untouched by the save
    await http().post(`/api/workflows/${wf}/publish`).send({}).expect(201);
    const published = await http().get(`/api/workflows/${wf}`).expect(200);
    expect(published.body.live_version).toBe(2); // the explicit act moved it
    await http().delete(`/api/workflows/${wf}`).expect(200);
  });

  it('no-diff commits mint nothing: the head is the save', async () => {
    const wf = await seed('inv no-diff');
    const again = await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: ir(['v1']), branch: 'main' })
      .expect(201);
    expect(again.body.no_changes).toBe(true);
    expect(again.body.version_number).toBe(1);
    const versions = await http().get(`/api/workflows/${wf}/versions?branch=main`).expect(200);
    expect(versions.body.versions).toHaveLength(1);
    await http().delete(`/api/workflows/${wf}`).expect(200);
  });

  it('a merge the target already contains mints nothing, through BOTH entry points', async () => {
    const wf = await seed('inv contained');
    await http().post(`/api/workflows/${wf}/branches`).send({ name: 'idle' }).expect(201);
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: ir(['v2']), branch: 'main' })
      .expect(201);

    const merge = await http()
      .post(`/api/workflows/${wf}/branches/idle/merge`)
      .send({ target_branch: 'main' })
      .expect(409);
    const review = await http()
      .post(`/api/workflows/${wf}/reviews`)
      .send({ source_branch: 'idle', title: 'nothing' })
      .expect(409);

    expect(merge.body.code).toBe('nothing_to_merge');
    expect(review.body.code).toBe('nothing_to_review');
    const versions = await http().get(`/api/workflows/${wf}/versions?branch=main`).expect(200);
    expect(versions.body.versions).toHaveLength(2);
    const branches = await http().get(`/api/workflows/${wf}/branches`).expect(200);
    expect(branches.body.branches.map((b: { name: string }) => b.name)).toContain('idle');
    await http().delete(`/api/workflows/${wf}`).expect(200);
  });

  it('field-level conflicts: same-field edits collide, different-field edits merge clean', async () => {
    const wf = await seed('inv conflicts');
    await http().post(`/api/workflows/${wf}/branches`).send({ name: 'lane' }).expect(201);
    // Same field both sides → conflict reported, nothing merged.
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: ir(['main-side']), branch: 'main' })
      .expect(201);
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: ir(['lane-side']), branch: 'lane' })
      .expect(201);
    const merge = await http()
      .post(`/api/workflows/${wf}/branches/lane/merge`)
      .send({ target_branch: 'main' })
      .expect(201);
    expect(merge.body.status).toBe('conflicts'); // reported, nothing merged
    const conflict = merge.body.conflicts[0];
    expect(conflict.field_path).toBe('parameters.texts'); // FIELD-level, keyed inside the node
    expect(conflict.source_value).toEqual(['lane-side']);
    expect(conflict.target_value).toEqual(['main-side']);
    await http().delete(`/api/workflows/${wf}`).expect(200);

    // Different fields of the SAME node merge clean — this goes red if granularity coarsens field→node.
    const wf2 = await seed('inv field-level');
    await http().post(`/api/workflows/${wf2}/branches`).send({ name: 'lane' }).expect(201);
    const sepDoc = ir(['v1']); // ancestor announce: { texts: ['v1'], separator: '' }
    (sepDoc.nodes[1] as { parameters: { separator: string } }).parameters.separator = ' | '; // MAIN edits separator
    await http()
      .post(`/api/workflows/${wf2}/commit`)
      .send({ workflow_ir: sepDoc, branch: 'main' })
      .expect(201);
    await http()
      .post(`/api/workflows/${wf2}/commit`)
      .send({ workflow_ir: ir(['lane-edit']), branch: 'lane' }) // LANE edits texts (a different field)
      .expect(201);
    const clean = await http()
      .post(`/api/workflows/${wf2}/branches/lane/merge`)
      .send({ target_branch: 'main' })
      .expect(201);
    expect(clean.body.status).toBe('merged'); // different fields → NO collision, merged clean
    const versions = await http().get(`/api/workflows/${wf2}/versions?branch=main`).expect(200);
    const mergedV = (
      versions.body.versions as Array<{ id: string; workflow_ir: { nodes: Array<Record<string, unknown>> } }>
    ).find((v) => v.id === clean.body.merged_version_id)!;
    const announce = mergedV.workflow_ir.nodes.find((n) => n.id === 'announce') as {
      parameters: Record<string, unknown>;
    };
    expect(announce.parameters.separator).toBe(' | '); // main's field survived
    expect(announce.parameters.texts).toEqual(['lane-edit']); // lane's field survived
    await http().delete(`/api/workflows/${wf2}`).expect(200);
  });

  it('a protected target refuses any merge no approved review authorised, through BOTH entry points', async () => {
    const wf = await seed('inv protected-merge');
    await http().post(`/api/workflows/${wf}/branches`).send({ name: 'lane' }).expect(201);
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: ir(['lane-change']), branch: 'lane' })
      .expect(201);
    await http()
      .patch(`/api/workflows/${wf}/branches/main/protection`)
      .send({ is_protected: true })
      .expect(200);

    // Authored change cannot land on it directly either.
    const direct_commit = await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: ir(['straight-to-main']), branch: 'main' })
      .expect(409);
    expect(direct_commit.body.code).toBe('branch_protected');

    // Branches page: no review at all.
    const direct = await http()
      .post(`/api/workflows/${wf}/branches/lane/merge`)
      .send({ target_branch: 'main' })
      .expect(400);
    expect(direct.body.detail).toContain('protected');

    // Reviews page: a review that exists but is not approved.
    const review = await http()
      .post(`/api/workflows/${wf}/reviews`)
      .send({ source_branch: 'lane', target_branch: 'main', title: 'lane → main' })
      .expect(201);
    await http().post(`/api/workflows/${wf}/reviews/${review.body.id}/merge`).send({}).expect(400);
    await http().post(`/api/workflows/${wf}/branches/lane/merge`).send({ target_branch: 'main' }).expect(400);

    // Approved — both entry points open.
    await http()
      .post(`/api/workflows/${wf}/reviews/${review.body.id}/approve`)
      .send({ decision: 'approved' })
      .expect(201);
    const merged = await http()
      .post(`/api/workflows/${wf}/branches/lane/merge`)
      .send({ target_branch: 'main' })
      .expect(201);
    expect(merged.body.status).toBe('merged');
    await http().delete(`/api/workflows/${wf}`).expect(200);
  });

  it('a protected target takes only what an approval covered, never conflicts resolved while merging, and cannot be deleted', async () => {
    const wf = await seed('inv reviewed-only');
    const setMain = async (texts: string[]): Promise<void> => {
      await http()
        .patch(`/api/workflows/${wf}/branches/main/protection`)
        .send({ is_protected: false })
        .expect(200);
      await http()
        .post(`/api/workflows/${wf}/commit`)
        .send({ workflow_ir: ir(texts), branch: 'main' })
        .expect(201);
      await http()
        .patch(`/api/workflows/${wf}/branches/main/protection`)
        .send({ is_protected: true })
        .expect(200);
    };
    const approve = (review: string) =>
      http()
        .post(`/api/workflows/${wf}/reviews/${review}/approve`)
        .send({ decision: 'approved' })
        .expect(201);
    const fromReview = (review: string) =>
      http().post(`/api/workflows/${wf}/reviews/${review}/merge`).send({});
    const fromBranches = () =>
      http().post(`/api/workflows/${wf}/branches/lane/merge`).send({ target_branch: 'main' });

    await http().post(`/api/workflows/${wf}/branches`).send({ name: 'lane' }).expect(201);
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: ir(['reviewed']), branch: 'lane' })
      .expect(201);
    await http()
      .patch(`/api/workflows/${wf}/branches/main/protection`)
      .send({ is_protected: true })
      .expect(200);
    const review = (
      await http()
        .post(`/api/workflows/${wf}/reviews`)
        .send({ source_branch: 'lane', target_branch: 'main', title: 'lane → main' })
        .expect(201)
    ).body.id as string;
    await approve(review);

    // An approval covers the version it saw: a later commit needs approving again, through both doors.
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: ir(['unreviewed']), branch: 'lane' })
      .expect(201);
    for (const res of [await fromReview(review), await fromBranches()]) {
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('approval_stale');
    }
    expect(
      (await http().get(`/api/workflows/${wf}/reviews/${review}`).expect(200)).body.approval_current,
    ).toBe(false);
    await approve(review);
    expect(
      (await http().get(`/api/workflows/${wf}/reviews/${review}`).expect(200)).body.approval_current,
    ).toBe(true);

    // Conflicts are never resolved while merging into it — neither offered nor accepted.
    await setMain(['main-moved']);
    for (const res of [
      await fromReview(review),
      await fromBranches(),
      await http()
        .post(`/api/workflows/${wf}/branches/lane/merge`)
        .send({
          target_branch: 'main',
          resolutions: [{ node_id: 'announce', field_path: 'parameters.texts', choice: 'source' }],
        }),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('protected_merge_conflicts');
    }

    // They are resolved on the branch instead, which a review and a test then see.
    const update = await http()
      .post(`/api/workflows/${wf}/branches/lane/update`)
      .send({ from_branch: 'main' })
      .expect(201);
    expect(update.body.status).toBe('conflicts');
    const resolved = await http()
      .post(`/api/workflows/${wf}/branches/lane/update`)
      .send({
        from_branch: 'main',
        resolutions: [
          { node_id: 'announce', field_path: 'parameters.texts', choice: 'custom', value: ['both'] },
        ],
      })
      .expect(201);
    expect(resolved.body.status).toBe('merged');
    expect((await fromReview(review)).body.code).toBe('approval_stale');
    await approve(review);
    expect((await fromReview(review).expect(201)).body.status).toBe('merged');

    // A rollback to what the head already holds mints nothing, so it cannot re-head a protected branch.
    const head = (await http().get(`/api/workflows/${wf}/branches/main/head`).expect(200)).body.head as {
      version_id: string;
      version_number: number;
    };
    const rollback = await http()
      .post(`/api/workflows/${wf}/versions/${head.version_number}/rollback?branch=main`)
      .expect(201);
    expect(rollback.body).toMatchObject({ no_changes: true, new_version_number: head.version_number });
    expect(
      (
        (await http().get(`/api/workflows/${wf}/branches/main/head`).expect(200)).body.head as {
          version_id: string;
        }
      ).version_id,
    ).toBe(head.version_id);

    // A protected branch cannot be deleted, so it cannot be recreated unprotected either; unprotected, it can.
    await http().post(`/api/workflows/${wf}/branches`).send({ name: 'release' }).expect(201);
    await http()
      .patch(`/api/workflows/${wf}/branches/release/protection`)
      .send({ is_protected: true })
      .expect(200);
    const refused = await http().delete(`/api/workflows/${wf}/branches/release`).expect(409);
    expect(refused.body.code).toBe('branch_protected');
    await http()
      .patch(`/api/workflows/${wf}/branches/release/protection`)
      .send({ is_protected: false })
      .expect(200);
    await http().delete(`/api/workflows/${wf}/branches/release`).expect(200);
    await http().delete(`/api/workflows/${wf}`).expect(200);
  });

  it('a protected target refuses a merge while the latest test of its heads is failing, through BOTH entry points', async () => {
    // A trigger payload decides each side: `fail` breaks only the branch; `down` breaks main too.
    const codeIr = (code: string, name: string, triggerName = 'Trigger'): Record<string, unknown> => {
      const base = ir(['unused'], name);
      return {
        ...base,
        nodes: [
          { ...base.nodes[0], name: triggerName },
          {
            id: 'check',
            name: 'Check',
            node_type: 'orchestr:code',
            type_version: 1,
            parameters: { language: 'js', code },
            position: { x: 300, y: 0 },
            metadata: {},
          },
        ],
        edges: [{ ...base.edges[0], target_node_id: 'check' }],
      };
    };
    const mainCode = "if (trigger.down) throw new Error('down'); return { ok: true };";
    const branchCode = "if (trigger.fail || trigger.down) throw new Error('boom'); return { ok: true };";
    const setUp = async (name: string): Promise<{ wf: string; review: string }> => {
      const wf = await seedDoc(codeIr(mainCode, name));
      await http().post(`/api/workflows/${wf}/branches`).send({ name: 'lane' }).expect(201);
      await http()
        .post(`/api/workflows/${wf}/commit`)
        .send({ workflow_ir: codeIr(branchCode, name), branch: 'lane' })
        .expect(201);
      await protect(wf, true);
      const review = await http()
        .post(`/api/workflows/${wf}/reviews`)
        .send({ source_branch: 'lane', target_branch: 'main', title: 'lane → main' })
        .expect(201);
      await http()
        .post(`/api/workflows/${wf}/reviews/${review.body.id}/approve`)
        .send({ decision: 'approved' })
        .expect(201);
      return { wf, review: review.body.id as string };
    };
    const protect = (wf: string, on: boolean) =>
      http().patch(`/api/workflows/${wf}/branches/main/protection`).send({ is_protected: on }).expect(200);
    const test = async (wf: string, review: string, payload: Record<string, unknown>): Promise<string> =>
      (
        await http()
          .post(`/api/workflows/${wf}/reviews/${review}/test`)
          .send({ trigger_payload: payload })
          .expect(201)
      ).body.verdict as string;
    const blockedOnCard = async (wf: string, review: string): Promise<unknown> =>
      (await http().get(`/api/workflows/${wf}/reviews/${review}`).expect(200)).body.merge_blocked_by_test;
    const mergeFromReview = (wf: string, review: string) =>
      http().post(`/api/workflows/${wf}/reviews/${review}/merge`).send({});
    const mergeFromBranches = (wf: string) =>
      http().post(`/api/workflows/${wf}/branches/lane/merge`).send({ target_branch: 'main' });

    const { wf, review } = await setUp('inv failing-test-merge');
    expect(await test(wf, review, { fail: true })).toBe('red');

    // Both doors refuse — the branches page included, which once checked only the approval — and say whose test it is.
    for (const refused of [await mergeFromReview(wf, review), await mergeFromBranches(wf)]) {
      expect(refused.status).toBe(400);
      expect(refused.body.detail).toContain('the pre-merge test is failing');
      expect(refused.body).toMatchObject({ code: 'merge_test_failing', review_id: review });
    }
    expect(await blockedOnCard(wf, review)).toMatchObject({
      review_id: review,
      title: 'lane → main',
      source_branch: 'lane',
    });

    // A test where main fails too decides nothing, so it cannot lift a real failure.
    expect(await test(wf, review, { down: true })).toBe('green');
    expect((await mergeFromBranches(wf)).body).toMatchObject({ review_id: review });

    // Any review into main counts, and the LATEST test of these heads decides.
    const sibling = await http()
      .post(`/api/workflows/${wf}/reviews`)
      .send({ source_branch: 'lane', target_branch: 'main', title: 'second look' })
      .expect(201);
    const siblingId = sibling.body.id as string;
    expect(await test(wf, siblingId, {})).toBe('green');
    expect(await blockedOnCard(wf, review)).toBeNull();
    expect(await test(wf, siblingId, { fail: true })).toBe('red');
    expect(await blockedOnCard(wf, review)).toMatchObject({
      review_id: siblingId,
      title: 'second look',
      source_branch: 'lane',
    });

    // Closing the review that ran it does not erase that failure…
    await http().post(`/api/workflows/${wf}/reviews/${siblingId}/close`).send({}).expect(201);
    expect((await mergeFromBranches(wf)).body).toMatchObject({
      code: 'merge_test_failing',
      review_id: siblingId,
    });

    // …a passing re-test of these same heads lifts it.
    expect(await test(wf, review, {})).toBe('green');
    expect((await mergeFromBranches(wf)).status).toBe(201);
    await http().delete(`/api/workflows/${wf}`).expect(200);

    // A failing test of OTHER heads says nothing — whichever side moved.
    const source = await setUp('inv stale-source');
    expect(await test(source.wf, source.review, { fail: true })).toBe('red');
    await http()
      .post(`/api/workflows/${source.wf}/commit`)
      .send({ workflow_ir: codeIr(mainCode, 'inv stale-source'), branch: 'lane' })
      .expect(201);
    // The new commit also needs approving again (approvals cover the version they saw) — that is not the test gate.
    await http()
      .post(`/api/workflows/${source.wf}/reviews/${source.review}/approve`)
      .send({ decision: 'approved' })
      .expect(201);
    expect((await mergeFromReview(source.wf, source.review).expect(201)).body.status).toBe('merged');
    await http().delete(`/api/workflows/${source.wf}`).expect(200);

    const target = await setUp('inv stale-target');
    expect(await test(target.wf, target.review, { fail: true })).toBe('red');
    await protect(target.wf, false);
    await http()
      .post(`/api/workflows/${target.wf}/commit`)
      .send({ workflow_ir: codeIr(mainCode, 'inv stale-target', 'Start'), branch: 'main' })
      .expect(201);
    await protect(target.wf, true);
    expect((await mergeFromBranches(target.wf)).status).toBe(201);
    await http().delete(`/api/workflows/${target.wf}`).expect(200);
  }, 90_000);

  it('latest floats to the merge commit, inside the merge itself', async () => {
    const wf = await seed('inv latest-floats');
    await http().post(`/api/workflows/${wf}/branches`).send({ name: 'lane' }).expect(201);
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: ir(['lane-change']), branch: 'lane' })
      .expect(201);
    await http().post(`/api/workflows/${wf}/branches/lane/merge`).send({}).expect(201);
    const main = await http().get(`/api/workflows/${wf}/versions?branch=main`).expect(200);
    const head = main.body.versions.reduce((a: { version_number: number }, b: { version_number: number }) =>
      b.version_number > a.version_number ? b : a,
    );
    expect(head.commit_message).toContain("Merge 'lane'");
    expect(head.tags).toContain('latest');
    await http().delete(`/api/workflows/${wf}`).expect(200);
  });

  it('env protection: production and uat are locked; prod is reserved and maps to production', async () => {
    const envs = await http().get('/api/environments').expect(200);
    const list = envs.body.environments as Array<{ id: string; name: string; is_prod: boolean }>;
    const production = list.find((e) => e.is_prod)!;
    const uat = list.find((e) => e.name === 'uat')!;
    expect(production.name).toBe('production');
    await http().patch(`/api/environments/${production.id}`).send({ name: 'live' }).expect(409);
    await http().delete(`/api/environments/${production.id}`).expect(409);
    await http().patch(`/api/environments/${uat.id}`).send({ name: 'acceptance' }).expect(409);
    await http().delete(`/api/environments/${uat.id}`).expect(409);
    await http().post('/api/environments').send({ name: 'prod' }).expect(400); // reserved
  });

  it('invariant 7: only creating an environment makes one — a promote by a name the workspace lacks, the reserved default included, is refused 404 and makes none', async () => {
    const wf = await seedDoc(webhookIr('inv7', 'inv7 promote'));
    const v1 = await versionId(wf, 1);
    const environmentRows = async (): Promise<unknown[]> =>
      (await db.query(`SELECT id, name FROM environments ORDER BY id`)).rows;
    const before = await environmentRows();

    for (const name of ['default', 'ghost-7']) {
      const refused = await http()
        .post(`/api/workflows/${wf}/promote`)
        .send({ environment: name, version_id: v1 })
        .expect(404);
      expect(refused.body).toEqual({
        detail:
          name === 'default'
            ? "'default' is reserved — it names the connection pool"
            : `This workspace has no environment named '${name}' — create it under Integrations → Environments first`,
        code: 'environment_not_found',
      });
    }
    const reserved = await http().post('/api/environments').send({ name: 'default' }).expect(400);
    expect(reserved.body.detail).toBe("'default' is reserved — it names the connection pool");

    expect(await environmentRows()).toEqual(before);
    await http().delete(`/api/workflows/${wf}`).expect(200);
  });

  it('main-only promotion: prod/uat refuse branch versions; staging accepts them', async () => {
    const wf = await seed('inv main-only');
    await http().post(`/api/workflows/${wf}/branches`).send({ name: 'lane' }).expect(201);
    const laneCommit = await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: ir(['lane']), branch: 'lane' })
      .expect(201);
    const laneVersionId = laneCommit.body.id as string;
    await http()
      .post(`/api/workflows/${wf}/promote`)
      .send({ environment: 'production', version_id: laneVersionId })
      .expect(400);
    await http()
      .post(`/api/workflows/${wf}/promote`)
      .send({ environment: 'uat', version_id: laneVersionId })
      .expect(400);
    await http()
      .post(`/api/workflows/${wf}/promote`)
      .send({ environment: 'staging', version_id: laneVersionId })
      .expect(201);
    await http().delete(`/api/workflows/${wf}`).expect(200);
  });

  // ─── — triggers in the canvas (invariant #9 amendment + new invariant #11) ───

  it('invariant 9: per-(workflow,env) webhook fires the pinned version, resolved from the version-doc trigger node', async () => {
    // v1 has a native webhook trigger node (the SOURCE) + an announce step that echoes the version.
    const wf = await seedDoc(webhookIr('v1', 'inv9 canvas'));
    const v1 = await versionId(wf, 1);
    await http()
      .post(`/api/workflows/${wf}/promote`)
      .send({ environment: 'staging', version_id: v1 })
      .expect(201);
    // Commit v2 — the head advances, but staging stays pinned to v1 (Save ≠ Live).
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: webhookIr('v2'), branch: 'main' })
      .expect(201);

    // A hit on /api/hooks/<wf>/staging resolves the env pointer → pinned v1 → its trigger node → runs ONLY v1.
    const fired = await http().post(`/api/hooks/${wf}/staging`).send({}).expect(202);
    const run = await awaitRun(fired.body.run_id as string);
    // Attribution is recorded at dispatch, so this holds independently of the downstream step's success.
    expect(run.environment).toBe('staging');
    expect(run.workflow_version_id).toBe(v1); // fired ONLY the env's pinned version, from its trigger node
    await http().delete(`/api/workflows/${wf}`).expect(200);
  }, 30_000);

  it('invariant 11: a commit changes no activation', async () => {
    const wf = await seedDoc(scheduleIr('v1', { interval_minutes: 60 }, 'inv11 no-touch'));
    const v1 = await versionId(wf, 1);
    await http()
      .post(`/api/workflows/${wf}/promote`)
      .send({ environment: 'staging', version_id: v1 })
      .expect(201);
    await reconciler.reconcile(wf); // materialize the derived activation (pinned v1, seeded cursor)
    const before = await activationRow(wf, 'staging');
    expect(before.version_id).toBe(v1);
    const cursor0 = await scheduleCursor(before.id);
    expect(cursor0).toBeTruthy();

    // A commit advances the head but moves no pointer — so it must change no activation.
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: scheduleIr('v2', { interval_minutes: 60 }), branch: 'main' })
      .expect(201);
    await reconciler.reconcile(wf); // reconciling after a bare commit is a no-op (pointer still v1)

    const after = await activationRow(wf, 'staging');
    expect(after.id).toBe(before.id);
    expect(after.version_id).toBe(v1); // still pinned to v1 — the commit touched nothing
    expect(await scheduleCursor(after.id)).toBe(cursor0); // cursor untouched
    await http().delete(`/api/workflows/${wf}`).expect(200);
  }, 30_000);

  it('invariant 11: promote keeps an unchanged trigger cursor, resets a changed one', async () => {
    const wf = await seedDoc(scheduleIr('v1', { interval_minutes: 60 }, 'inv11 cursor'));
    await http()
      .post(`/api/workflows/${wf}/promote`)
      .send({ environment: 'staging', version_id: await versionId(wf, 1) })
      .expect(201);
    await reconciler.reconcile(wf);
    const activation = await activationRow(wf, 'staging');
    const cursor0 = await scheduleCursor(activation.id);
    expect(cursor0).toBeTruthy();

    // v2 changes ONLY the downstream step; the schedule node is byte-identical → KEEP the cursor.
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: scheduleIr('v2', { interval_minutes: 60 }), branch: 'main' })
      .expect(201);
    await http()
      .post(`/api/workflows/${wf}/promote`)
      .send({ environment: 'staging', version_id: await versionId(wf, 2) })
      .expect(201);
    await reconciler.reconcile(wf);
    expect(await scheduleCursor(activation.id)).toBe(cursor0); // KEEP — computeDiff shows the node unchanged

    // v3 changes the SCHEDULE node's own props → RESET the cursor from now.
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: scheduleIr('v3', { interval_minutes: 30 }), branch: 'main' })
      .expect(201);
    await http()
      .post(`/api/workflows/${wf}/promote`)
      .send({ environment: 'staging', version_id: await versionId(wf, 3) })
      .expect(201);
    await reconciler.reconcile(wf);
    const cursor2 = await scheduleCursor(activation.id);
    expect(cursor2).not.toBe(cursor0); // RESET — the trigger node's config changed across the promote
    await http().delete(`/api/workflows/${wf}`).expect(200);
  }, 30_000);

  it('invariant 11: a reconcile never resolves while an earlier one for the same workflow is still applying', async () => {
    const wf = await seedDoc(scheduleIr('v1', { interval_minutes: 60 }, 'inv11 overlap'));
    const v1 = await versionId(wf, 1);

    type Materialize = (...args: unknown[]) => Promise<void>;
    const target = reconciler as unknown as { materialize: Materialize };
    const real = target.materialize.bind(reconciler);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const applying = new Promise<void>((resolve) => (entered = resolve));
    const spy = jest.spyOn(target, 'materialize').mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return real(...args);
    });

    try {
      await http()
        .post(`/api/workflows/${wf}/promote`)
        .send({ environment: 'staging', version_id: v1 })
        .expect(201);
      await applying; // the promote's own reconcile has saved the row and not yet seeded the cursor

      let settled = false;
      const second = reconciler.reconcile(wf).then(() => (settled = true));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled).toBe(false);

      release();
      await second;
      const staging = await activationRow(wf, 'staging');
      expect(await scheduleCursor(staging.id)).toBeTruthy();
    } finally {
      release();
      spy.mockRestore();
    }
    await http().delete(`/api/workflows/${wf}`).expect(200);
  }, 30_000);

  it('invariant 12: error output routes the error lane, never both, as a distinct edge', () => {
    const concat = (id: string, texts: string[]) => ({
      id,
      name: id,
      node_type: 'text.concat',
      type_version: 1,
      parameters: { texts, separator: '' },
      position: { x: 0, y: 0 },
      metadata: {},
    });
    const boom = {
      id: 'boom',
      name: 'boom',
      node_type: 'fault.throw', // throws when executed
      type_version: 1,
      parameters: {},
      position: { x: 0, y: 0 },
      metadata: {},
    };
    const edge = (id: string, from: string, to: string, port_type: string) => ({
      id,
      source_node_id: from,
      source_port: 0,
      target_node_id: to,
      target_port: 0,
      port_type,
    });
    const doc = {
      version: '1',
      name: 'err',
      description: '',
      nodes: [boom, concat('after', ['MAIN']), concat('handler', ['handled'])],
      edges: [edge('e-main', 'boom', 'after', 'main'), edge('e-err', 'boom', 'handler', 'error')],
      settings: { execution_order: 'v1', extra: {} },
      metadata: {},
    };

    // (a) The compiler lowers the error edge into boom.onErrorBranch — the handler leaves the main flow.
    const plan = compileWorkflowIrDag(doc);
    const boomNode = plan.nodes.find((n) => n.kind === 'action' && n.id === 'boom');
    expect(boomNode?.kind === 'action' ? boomNode.onErrorBranch?.nodes.map((n) => n.id) : null).toEqual([
      'handler',
    ]);
    expect(plan.nodes.map((n) => n.id)).toEqual(['boom', 'after']);

    // (b) The error lane runs IFF boom throws, in place of the main successor — never both.
    return new DagInterpreter({
      key: 'mock',
      runAction: (input) =>
        input.actionId === 'fault.throw'
          ? Promise.reject(new Error('kaboom'))
          : Promise.resolve({ output: 'ran' }),
      enableTrigger: () => Promise.resolve(),
      pollTrigger: () => Promise.resolve([]),
      disableTrigger: () => Promise.resolve(),
    })
      .run(plan, { externalUserId: 'u' })
      .then((result) => {
        expect(result.outputs.handler).toBe('ran'); // error lane ran
        expect(result.outputs.after).toBeUndefined(); // main successor skipped — never both

        // (c) The edge key includes `port_type` (invariant #4), so main→error is a remove + add.
        const mainOnly = { ...doc, edges: [edge('e', 'boom', 'handler', 'main')] };
        const errOnly = { ...doc, edges: [edge('e', 'boom', 'handler', 'error')] };
        const ops = computeDiff(mainOnly, errOnly).entries.map((x) => x.operation);
        expect(ops).toContain('remove_edge');
        expect(ops).toContain('add_edge');
      });
  });

  it("invariant 17: {{$account}} is the account the step RUNS AS — the environment slot's, not the author's — and an unknown one fails closed", async () => {
    const me = await http().get('/api/auth/me').expect(200);
    const userId = me.body.user.id as string;
    const connections = app.get(ConnectionsService);
    const gmail = (token: string) =>
      connections.createOAuth2(userId, 'gmail', { access_token: token, token_type: 'Bearer', raw: {} });
    const authored = await gmail('tok-authored');
    const slotted = await gmail('tok-staging');
    const unnamed = await gmail('tok-revoked');
    // Asked the moment the connection became usable.
    expect(authored.account).toMatchObject({ subject: 'user', email: 'author@e2e.local' });

    const doc = (connectionId: string, name: string): Record<string, unknown> => {
      const base = triggerIr({ node_type: 'orchestr:webhook' }, '', name);
      return {
        ...base,
        nodes: [
          base.nodes[0],
          {
            id: 'mail',
            name: 'Find mail to me',
            node_type: 'gmail.list_messages',
            type_version: 1,
            parameters: { connectionId, query: 'to:{{$account.email}}' },
            position: { x: 300, y: 0 },
            metadata: {},
          },
        ],
        edges: [{ ...base.edges[0], target_node_id: 'mail' }],
      };
    };

    // A Default run is the author's own account.
    gmailSearches.length = 0;
    await http()
      .post('/api/runs/from-ir')
      .send({ workflow_ir: doc(authored.id, 'inv17 default') })
      .expect(201);
    expect(gmailSearches).toEqual(['to:author@e2e.local']);

    // An environment run is its slot's account, even though the step names the author's connection.
    const wf = await seedDoc(doc(authored.id, 'inv17 staging'));
    const envs = await http().get('/api/environments').expect(200);
    const staging = (envs.body.environments as Array<{ id: string; name: string }>).find(
      (e) => e.name === 'staging',
    )!;
    await http()
      .put(`/api/environments/${staging.id}/slots/gmail`)
      .send({ connection_id: slotted.id })
      .expect(200);
    await http()
      .post(`/api/workflows/${wf}/promote`)
      .send({ environment: 'staging', version_id: await versionId(wf, 1) })
      .expect(201);
    gmailSearches.length = 0;
    const fired = await http().post(`/api/hooks/${wf}/staging`).send({}).expect(202);
    const run = await awaitRun(fired.body.run_id as string);
    expect(run.status).toBe('completed');
    expect(gmailSearches).toEqual(['to:staging@e2e.local']);

    // An account the provider won't name fails the step before the action is ever called.
    gmailSearches.length = 0;
    const refused = await http()
      .post('/api/runs/from-ir')
      .send({ workflow_ir: doc(unnamed.id, 'inv17 unnamed') });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refused.body)).toContain("couldn't ask gmail which account this step runs as");
    expect(gmailSearches).toEqual([]);

    await http().delete(`/api/environments/${staging.id}/slots/gmail`).expect(200);
    await http().delete(`/api/workflows/${wf}`).expect(200);
  }, 30_000);

  it("invariant 18: a step with no account chosen runs as the account its run decides — the environment's slot, else the runner's only one — and never a guess", async () => {
    const connections = app.get(ConnectionsService);
    const interpreter = app.get(DagInterpreter);
    const runner = '00000000-0000-4000-8000-000000000018';
    const slotOwner = '00000000-0000-4000-8000-000000000019';
    await db.query(
      `INSERT INTO users (id, email, name) VALUES ($1, 'runner@e2e.local', 'Runner'), ($2, 'slot@e2e.local', 'Slot')`,
      [runner, slotOwner],
    );
    const gmail = (owner: string, token: string) =>
      connections.createOAuth2(owner, 'gmail', { access_token: token, token_type: 'Bearer', raw: {} });
    const doc = (connectionId?: string): WorkflowIR => ({
      ...ir([''], 'inv18'),
      nodes: [
        ir([''], 'inv18').nodes[0]!,
        {
          id: 'mail',
          name: 'Find mail to me',
          node_type: 'gmail.list_messages',
          type_version: 1,
          parameters: { query: 'to:{{$account.email}}', ...(connectionId ? { connectionId } : {}) },
          position: { x: 300, y: 0 },
          metadata: {},
        },
      ],
      edges: [{ ...ir([''], 'inv18').edges[0]!, target_node_id: 'mail' }],
    });
    const run = (document: WorkflowIR, scope: Record<string, unknown> = {}) =>
      interpreter.run(compileWorkflowIrDag(document), {
        externalUserId: runner,
        initialScope: { trigger: {} },
        ...scope,
      });

    // Default, one account: the step runs as it, and {{$account}} reads it.
    const only = await gmail(runner, 'tok-runner');
    gmailSearches.length = 0;
    await run(doc());
    expect(gmailSearches).toEqual(['to:runner@e2e.local']);

    // An environment run takes the slot — chosen account or not — as the slot's owner.
    const org = '00000000-0000-4000-8000-0000000000b8';
    const [withSlot, emptyEnv] = [
      '00000000-0000-4000-8000-0000000000c8',
      '00000000-0000-4000-8000-0000000000c9',
    ];
    await db.query(`INSERT INTO organizations (id, name) VALUES ($1, 'Inv18')`, [org]);
    await db.query(
      `INSERT INTO environments (id, org_id, name, is_prod) VALUES ($1, $3, 'inv18-live', false), ($2, $3, 'inv18-empty', false)`,
      [withSlot, emptyEnv, org],
    );
    const slot = await gmail(slotOwner, 'tok-slot');
    await db.query(
      `INSERT INTO environment_connections (environment_id, app, connection_id) VALUES ($1, 'gmail', $2)`,
      [withSlot, slot.id],
    );
    for (const document of [doc(), doc(only.id)]) {
      gmailSearches.length = 0;
      await run(document, { environmentId: withSlot, environment: 'inv18-live', orgId: org });
      expect(gmailSearches).toEqual(['to:slot@e2e.local']);
    }

    // An empty slot refuses before the action, naming the environment even from its id alone.
    gmailSearches.length = 0;
    await expect(run(doc(), { environmentId: emptyEnv, orgId: org })).rejects.toThrow(
      /^inv18-empty has no gmail account assigned, so "Find mail to me" can't run there/,
    );

    // Two accounts and none chosen: refused naming the step — never a guess.
    await gmail(runner, 'tok-runner-2');
    await expect(run(doc())).rejects.toThrow(
      'Step "Find mail to me" has no gmail account chosen and you have 2 active gmail accounts — pick one on the step',
    );

    // A chosen account that isn't the runner's is refused — never swapped for one of theirs.
    await expect(run(doc(slot.id))).rejects.toThrow(
      `Step "Find mail to me" runs as a gmail account that no longer exists or isn't yours`,
    );
    expect(gmailSearches).toEqual([]);

    // Whether a step needs an account is the registry's answer: one stored on a step that needs none is never asked about.
    const [trigger, mail] = doc().nodes;
    const join = {
      ...doc(),
      nodes: [
        trigger!,
        { ...mail!, node_type: 'text.concat', parameters: { texts: ['a', 'b'], connectionId: slot.id } },
      ],
    };
    expect((await run(join)).outputs.mail).toBe('ab');

    // …nor read for {{$account}}, whoever's it is: a step that runs as no account has none to read.
    for (const held of [slot.id, only.id]) {
      const reads = {
        ...join,
        nodes: [
          trigger!,
          {
            ...mail!,
            node_type: 'text.concat',
            parameters: { texts: ['to:', '{{$account.email}}'], connectionId: held },
          },
        ],
      };
      await expect(run(reads)).rejects.toThrow(
        'Step "Find mail to me" uses no account, so {{$account.email}} has no value',
      );
    }
  }, 30_000);

  it('invariant 22: a personal workspace has exactly one member, its owner — no invite reaches it, and the database refuses a second member, a change of its role, its removal and a second one', async () => {
    await http().get('/api/orgs').expect(200);
    const me = '00000000-0000-0000-0000-000000000001';
    const mine = (await db.query(`SELECT id FROM organizations WHERE personal_owner_id = $1`, [me])).rows[0]!
      .id as string;
    const refused = await http()
      .post(`/api/orgs/${mine}/invites`)
      .send({ email: 'someone@e2e.local', role: 'member' })
      .expect(400);
    expect(refused.body.detail).toBe('The personal organization has no other members');

    const other = randomUUID();
    const theirs = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'other@e2e.local', 'Other', now(), now())`,
      [other],
    );
    await insertPersonalOrgs(db, { id: theirs, userId: other, name: 'Other' });
    const join = (role: string, personal: boolean) =>
      db.query(
        `INSERT INTO org_members (id, org_id, user_id, role, is_personal, created_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`,
        [mine, other, role, personal],
      );
    await expect(join('member', false)).rejects.toThrow(/org_members_org_id_is_personal_fkey/);
    await expect(join('owner', true)).rejects.toThrow(/uq_org_members_personal_org/);
    await expect(
      db.query(`UPDATE org_members SET role = 'admin' WHERE org_id = $1 AND user_id = $2`, [mine, me]),
    ).rejects.toThrow(/org_members_personal_role_check/);
    await expect(
      db.query(`DELETE FROM org_members WHERE org_id = $1 AND user_id = $2`, [mine, me]),
    ).rejects.toThrow(/organizations_personal_owner_member_fkey/);
    await expect(
      db.query(`UPDATE organizations SET is_personal = false, personal_owner_id = NULL WHERE id = $1`, [
        mine,
      ]),
    ).rejects.toThrow(/org_members_org_id_is_personal_fkey/);
    await expect(insertPersonalOrgs(db, { id: randomUUID(), userId: me, name: 'Again' })).rejects.toThrow(
      /organizations_personal_owner_id_key/,
    );
    await expect(
      db.query(
        `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'Nobody', true, now(), now())`,
        [randomUUID()],
      ),
    ).rejects.toThrow(/organizations_personal_owner_check/);

    const loner = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'loner@e2e.local', 'Loner', now(), now())`,
      [loner],
    );
    const committed = async (...statements: Array<[string, unknown[]]>): Promise<void> => {
      await db.query('BEGIN');
      try {
        for (const [text, values] of statements) await db.query(text, values);
        await db.query('COMMIT');
      } catch (err) {
        await db.query('ROLLBACK');
        throw err;
      }
    };
    const moved = randomUUID();
    const renumber = `UPDATE organizations SET id = $2 WHERE id = $1`;
    await expect(
      committed(
        [
          `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'Moved', true, now(), now())`,
          [moved],
        ],
        [renumber, [moved, randomUUID()]],
      ),
    ).rejects.toThrow(/organizations_personal_owner_check/);
    const named = randomUUID();
    const renamed = randomUUID();
    await expect(
      committed(
        [
          `INSERT INTO organizations (id, name, is_personal, personal_owner_id, created_at, updated_at) VALUES ($1, 'Named', false, $2, now(), now())`,
          [named, loner],
        ],
        [renumber, [named, renamed]],
        [
          `INSERT INTO org_members (id, org_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'owner', now())`,
          [renamed, loner],
        ],
      ),
    ).rejects.toThrow(/organizations_personal_owner_check/);

    const members = await db.query(
      `SELECT user_id, role FROM org_members WHERE org_id = ANY($1) ORDER BY user_id`,
      [[mine, theirs]],
    );
    expect(members.rows).toEqual(
      [
        { user_id: me, role: 'owner' },
        { user_id: other, role: 'owner' },
      ].sort((x, y) => (x.user_id < y.user_id ? -1 : 1)),
    );
  });

  it('invariant 14: a tool edge binds a tool, distinct from a main edge, never collapses', () => {
    const node = (id: string, node_type: string, parameters: Record<string, unknown> = {}) => ({
      id,
      name: id,
      node_type,
      type_version: 1,
      parameters,
      position: { x: 0, y: 0 },
      metadata: {},
    });
    const edge = (id: string, from: string, to: string, port_type: string) => ({
      id,
      source_node_id: from,
      source_port: 0,
      target_node_id: to,
      target_port: 0,
      port_type,
    });
    const doc = {
      version: '1',
      name: 'agent',
      description: '',
      nodes: [
        node('chat', 'orchestr:chat'),
        node('agent', 'orchestr:agent', { max_steps: 5, input: '{{trigger.chatInput}}' }),
        node('search', 'slack.send_message', { channel: '#ops' }), // the bound tool
        node('reply', 'text.concat', { texts: ['{{agent.text}}'], separator: '' }),
      ],
      edges: [
        edge('e-in', 'chat', 'agent', 'main'),
        edge('e-tool', 'agent', 'search', 'tool'),
        edge('e-out', 'agent', 'reply', 'main'),
      ],
      settings: { execution_order: 'v1', extra: {} },
      metadata: { engine: 'orchestr' },
    };

    // (a) The compiler PEELS the tool edge into agent.tools[] — the bound node leaves the main flow.
    const plan = compileWorkflowIrDag(doc);
    expect(plan.nodes.map((n) => n.id)).toEqual(['agent', 'reply']);
    const agent = plan.nodes.find((n) => n.id === 'agent') as DagAgentNode;
    expect(agent.tools).toEqual([
      {
        kind: 'action',
        // Sanitized to a provider-legal identifier; actionId keeps the routing id.
        name: 'slack_send_message',
        stepName: 'search',
        actionId: 'slack.send_message',
        props: { channel: '#ops' },
      },
    ]);
    expect(agent.tools[0]!.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);

    // (b) The bound tool runs through the durable dispatch, never as a main step.
    const model = new ScriptedAgentModel([
      // The model calls the tool by its SANITIZED model-facing name; the loop resolves it back.
      { text: 'searching', toolCalls: [{ id: 'c1', name: 'slack_send_message', input: { text: 'hi' } }] },
      { text: 'done', toolCalls: [] },
    ]);
    const provider = {
      key: 'mock',
      runAction: (input: { actionId: string }) => Promise.resolve({ output: { ran: input.actionId } }),
      enableTrigger: () => Promise.resolve(),
      pollTrigger: () => Promise.resolve([]),
      disableTrigger: () => Promise.resolve(),
    };
    return new DagInterpreter(provider, undefined, undefined, undefined, model)
      .run(plan, { externalUserId: 'u', initialScope: { trigger: { chatInput: 'go' } } })
      .then((result) => {
        const out = result.outputs.agent as AgentResult;
        expect(out.text).toBe('done');
        expect(out.steps.find((s) => s.kind === 'tool')?.tool).toBe('slack_send_message');

        // (c) The edge key includes `port_type` (invariant #4/#13), so main→tool is a remove + add.
        const mainOnly = { ...doc, edges: [edge('e', 'agent', 'search', 'main')] };
        const toolOnly = { ...doc, edges: [edge('e', 'agent', 'search', 'tool')] };
        const ops = computeDiff(mainOnly, toolOnly).entries.map((x) => x.operation);
        expect(ops).toContain('remove_edge');
        expect(ops).toContain('add_edge');
      });
  });
});
