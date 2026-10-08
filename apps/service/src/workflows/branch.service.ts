import { Injectable } from '@nestjs/common';
import { repairDocumentLayout } from '../compose/apply-ops';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { newId, now } from '../database/ids';
import { UserEntity } from '../database/entities/user.entity';
import { WorkflowReviewEntity } from '../database/entities/review.entity';
import { WorkflowBranchEntity } from '../database/entities/workflow-branch.entity';
import { WorkflowEntity } from '../database/entities/workflow.entity';
import { WorkflowVersionEntity } from '../database/entities/workflow-version.entity';
import { WorkflowVersionTagEntity } from '../database/entities/workflow-version-tag.entity';
import { EventsService } from '../events/events.service';
import { computeDiff } from '../ir/diff';
import { threeWayMerge, type ConflictEntry, type MergeResolution } from '../ir/merge';
import type { WorkflowIR } from '../ir/models';
import type { ReviewTestSummary } from '../reviews/review-test.types';
import { rawQuery } from '../database/raw-query';
export interface BranchMergeOutcome {
  success: boolean;
  /** Null on success means the target already had every change on the source, so nothing was minted. */
  mergedVersionId: string | null;
  conflicts: ConflictEntry[];
}

/** A branch's inherited starting point, carrying the version's number in ITS OWN branch's numbering. */
export interface ForkPoint {
  version_id: string;
  version_number: number;
  branch: string | null;
}

/**
 * Branch create/merge. Locks BOTH branch rows FOR UPDATE, name-sorted (deadlock safety); `latest`
 * floats to the merge commit INSIDE mergeBranch so every caller inherits it. Ancestor walk follows parent_id only.
 */
@Injectable()
export class BranchService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly events: EventsService,
  ) {}

  async createBranch(
    workflowId: string,
    name: string,
    fromVersionId: string | null,
    userId: string | null,
  ): Promise<WorkflowBranchEntity> {
    return this.dataSource.transaction(async (em) => {
      const wf = await em.findOne(WorkflowEntity, { where: { id: workflowId } });
      if (!wf) throw new DomainError(`Workflow ${workflowId} not found`);

      const existing = await em.findOne(WorkflowBranchEntity, { where: { workflowId: wf.id, name } });
      if (existing) {
        throw new DomainError(
          `Branch '${name}' already exists on this workflow — commit to it, or branch under another name.`,
        );
      }

      // Fork source: explicit version, else default-branch HEAD (latest, not prod).
      let sourceVersionId: string | null = null;
      if (fromVersionId) {
        // A fork point from ANOTHER workflow would hand this branch a head it does not own.
        const from = await em.findOne(WorkflowVersionEntity, {
          where: { id: fromVersionId, workflowId: wf.id },
        });
        if (!from) {
          throw new DomainError(`Version ${fromVersionId} does not belong to workflow ${workflowId}`, 404);
        }
        sourceVersionId = from.id;
      }
      if (!sourceVersionId && wf.defaultBranchId) {
        const defaultBranch = await em.findOne(WorkflowBranchEntity, { where: { id: wf.defaultBranchId } });
        sourceVersionId = defaultBranch?.headVersionId ?? null;
      }
      if (!sourceVersionId && wf.activeVersionId) sourceVersionId = wf.activeVersionId;

      const branch = em.create(WorkflowBranchEntity, {
        id: newId(),
        workflowId: wf.id,
        name,
        createdBy: userId,
        isDefault: false,
        isProtected: false,
        headVersionId: sourceVersionId,
        createdAt: now(),
      });
      await em.save(WorkflowBranchEntity, branch);

      // Per-branch `latest` tag at the fork point.
      if (sourceVersionId) {
        await em.save(
          em.create(WorkflowVersionTagEntity, {
            id: newId(),
            workflowId: wf.id,
            versionId: sourceVersionId,
            tag: 'latest',
            branchId: branch.id,
            activated: true,
            createdAt: now(),
          }),
        );
      }

      await this.events.emit(em, {
        orgId: wf.orgId,
        actorUserId: userId,
        type: 'branch.created',
        subjectType: 'branch',
        subjectId: branch.id,
        payload: { name },
      });
      return branch;
    });
  }

  /** Where a branch starts: the version it INHERITS and that version's own branch (invariant #1 — a fork point is never renumbered). */
  async forkPointOf(workflowId: string, versionId: string): Promise<ForkPoint | null> {
    const rows = await rawQuery<{ version_number: number; branch: string | null }>(
      this.dataSource.manager,
      `SELECT v.version_number::int AS version_number, b.name AS branch
         FROM workflow_versions v
         LEFT JOIN workflow_branches b ON b.id = v.branch_id
        WHERE v.id = $1 AND v.workflow_id = $2`,
      [versionId, workflowId],
    );
    const row = rows[0];
    if (!row) return null;
    return { version_id: versionId, version_number: row.version_number, branch: row.branch };
  }

  async listBranches(workflowId: string): Promise<WorkflowBranchEntity[]> {
    return this.dataSource.manager.find(WorkflowBranchEntity, {
      where: { workflowId },
      order: { isDefault: 'DESC', name: 'ASC' },
    });
  }

  async getBranch(em: EntityManager, workflowId: string, name: string): Promise<WorkflowBranchEntity> {
    const branch = await em.findOne(WorkflowBranchEntity, { where: { workflowId, name } });
    if (!branch) throw new DomainError(`Branch '${name}' not found`);
    return branch;
  }

  /** Branch protection toggle: user-settable, enforced by the merge gate when set. */
  async setProtection(
    workflowId: string,
    name: string,
    isProtected: boolean,
    actorId: string,
  ): Promise<WorkflowBranchEntity> {
    return this.dataSource.transaction(async (em) => {
      const branch = await this.getBranch(em, workflowId, name);
      branch.isProtected = isProtected;
      await em.save(WorkflowBranchEntity, branch);
      const wf = await em.findOne(WorkflowEntity, { where: { id: workflowId } });
      await this.events.emit(em, {
        orgId: wf?.orgId ?? null,
        actorUserId: actorId,
        type: isProtected ? 'branch.protected' : 'branch.unprotected',
        subjectType: 'branch',
        subjectId: branch.id,
        payload: { name },
      });
      return branch;
    });
  }

  /** Delete a branch, also removing its tag rows (rather than orphaning them via SET NULL); returns how many were removed. */
  async deleteBranch(workflowId: string, name: string, actorId: string | null): Promise<number> {
    return this.dataSource.transaction(async (em) => {
      const branch = await this.getBranch(em, workflowId, name);
      if (branch.isDefault) throw new DomainError('Cannot delete the default branch');
      if (branch.isProtected) {
        throw new DomainError(
          `Branch '${name}' is protected — an owner or admin has to unprotect it before it can be deleted`,
          409,
          { code: 'branch_protected' },
        );
      }

      const tags = await em.find(WorkflowVersionTagEntity, { where: { branchId: branch.id } });
      if (tags.length > 0) {
        await em.delete(
          WorkflowVersionTagEntity,
          tags.map((t) => t.id),
        );
      }
      await em.delete(WorkflowBranchEntity, { id: branch.id });

      const wf = await em.findOne(WorkflowEntity, { where: { id: workflowId } });
      await this.events.emit(em, {
        orgId: wf?.orgId ?? null,
        actorUserId: actorId,
        type: 'branch.deleted',
        subjectType: 'branch',
        subjectId: branch.id,
        payload: { name, tags_removed: tags.length },
      });
      return tags.length;
    });
  }

  /** Whether an approved review of this pair holds an approval of the source's CURRENT head — what a protected merge needs. */
  async approvedAtHead(
    em: EntityManager,
    workflowId: string,
    source: { id: string; headVersionId: string | null },
    target: { id: string },
  ): Promise<boolean> {
    if (!source.headVersionId) return false;
    const rows = await rawQuery<{ hit: number }>(
      em,
      `SELECT 1 AS hit FROM workflow_reviews r JOIN review_approvals a ON a.review_id = r.id
        WHERE r.workflow_id = $1 AND r.source_branch_id = $2 AND r.target_branch_id = $3 AND r.status = 'approved'
          AND a.decision = 'approved' AND a.source_version_id = $4
        LIMIT 1`,
      [workflowId, source.id, target.id, source.headVersionId],
    );
    return rows.length > 0;
  }

  /** The failing test that would refuse merging `source` into `target` now — what the review card shows. */
  async testBlockingMerge(
    em: EntityManager,
    workflowId: string,
    sourceBranchId: string,
    targetBranchId: string,
  ): Promise<FailingTest | null> {
    const [source, target] = await Promise.all([
      em.findOne(WorkflowBranchEntity, { where: { id: sourceBranchId } }),
      em.findOne(WorkflowBranchEntity, { where: { id: targetBranchId } }),
    ]);
    if (!target?.isProtected || !source?.headVersionId || !target.headVersionId) return null;
    return this.latestFailingTest(em, workflowId, {
      source: source.headVersionId,
      target: target.headVersionId,
    });
  }

  /**
   * The latest DECISIVE test of exactly these two versions, from any review — kept after that review or its
   * branch is gone — when it failed; a tie fails closed (constitution #15).
   */
  private async latestFailingTest(
    em: EntityManager,
    workflowId: string,
    heads: { source: string; target: string },
  ): Promise<FailingTest | null> {
    const rows = await rawQuery<{
      verdict: string;
      tested_at: Date;
      error: string | null;
      review_id: string | null;
      title: string | null;
      source_branch: string | null;
      target_branch: string | null;
    }>(
      em,
      `SELECT t.verdict, t.tested_at, t.summary->'head'->>'error' AS error, t.review_id, r.title,
              s.name AS source_branch, d.name AS target_branch
         FROM review_test_results t
         LEFT JOIN workflow_reviews r ON r.id = t.review_id
         LEFT JOIN workflow_branches s ON s.id = r.source_branch_id
         LEFT JOIN workflow_branches d ON d.id = r.target_branch_id
        WHERE t.workflow_id = $1 AND t.source_version_id = $2 AND t.target_version_id = $3 AND t.decisive
        ORDER BY t.tested_at DESC, (t.verdict = 'red') DESC
        LIMIT 1`,
      [workflowId, heads.source, heads.target],
    );
    const latest = rows[0];
    if (latest?.verdict !== 'red') return null;
    const review =
      latest.review_id && latest.title && latest.source_branch && latest.target_branch
        ? {
            id: latest.review_id,
            title: latest.title,
            sourceBranch: latest.source_branch,
            targetBranch: latest.target_branch,
          }
        : null;
    return { review, error: latest.error, testedAt: new Date(latest.tested_at).toISOString() };
  }

  /** Whether `versionId` is `headId` or in its history — parents AND merge parents — so the head already has it. */
  async historyContains(em: EntityManager, headId: string, versionId: string): Promise<boolean> {
    const rows = await rawQuery<{ found: number }>(
      em,
      `WITH RECURSIVE history(id) AS (
         SELECT $1::uuid
         UNION
         SELECT parent.id
           FROM history h
           JOIN workflow_versions v ON v.id = h.id
           CROSS JOIN LATERAL (VALUES (v.parent_id), (v.merge_parent_id)) AS parent(id)
          WHERE parent.id IS NOT NULL
       )
       SELECT 1 AS found FROM history WHERE id = $2::uuid LIMIT 1`,
      [headId, versionId],
    );
    return rows.length > 0;
  }

  /** Walk A's ancestry, then return the first hit on B's chain. Follows parent_id ONLY (merge parents are not walked). */
  async findCommonAncestor(
    em: EntityManager,
    versionAId: string,
    versionBId: string,
  ): Promise<WorkflowVersionEntity | null> {
    const verA = await em.findOne(WorkflowVersionEntity, { where: { id: versionAId } });
    if (!verA) return null;

    const rows = await rawQuery<{ id: string; parent_id: string | null; merge_parent_id: string | null }>(
      em,
      `SELECT id, parent_id, merge_parent_id FROM workflow_versions WHERE workflow_id = $1`,
      [verA.workflowId],
    );
    // Both parents, as `historyContains` walks them: a branch that took the target's changes shares the
    // target's head, and missing that re-raises every conflict it already resolved.
    const parentsOf = new Map(
      rows.map((r) => [r.id, [r.parent_id, r.merge_parent_id].filter((p): p is string => p !== null)]),
    );
    const ancestorsOfA = reachableFrom(versionAId, parentsOf);

    // Breadth-first from B, so the common ancestor found is the nearest one.
    const queue = [versionBId];
    const seen = new Set(queue);
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      if (ancestorsOfA.has(next)) return em.findOne(WorkflowVersionEntity, { where: { id: next } });
      for (const parent of parentsOf.get(next) ?? []) {
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }
    return null;
  }

  async mergeBranch(
    workflowId: string,
    sourceBranchName: string,
    targetBranchName: string,
    userId: string | null,
    resolutions?: MergeResolution[],
  ): Promise<BranchMergeOutcome> {
    return this.dataSource.transaction((em) =>
      this.mergeBranchIn(em, workflowId, sourceBranchName, targetBranchName, userId, resolutions),
    );
  }

  /** Same merge, inside the CALLER's transaction (reviews hold their row lock across it). */
  async mergeBranchIn(
    em: EntityManager,
    workflowId: string,
    sourceBranchName: string,
    targetBranchName: string,
    userId: string | null,
    resolutions?: MergeResolution[],
  ): Promise<BranchMergeOutcome> {
    {
      // Lock BOTH branches before reading heads; order by name for deadlock safety.
      const rows = await em
        .createQueryBuilder(WorkflowBranchEntity, 'b')
        .setLock('pessimistic_write')
        .where('b.workflow_id = :workflowId', { workflowId })
        .andWhere('b.name IN (:...names)', { names: [sourceBranchName, targetBranchName] })
        .orderBy('b.name', 'ASC')
        .getMany();
      const byName = new Map(rows.map((b) => [b.name, b]));
      const source = byName.get(sourceBranchName);
      const target = byName.get(targetBranchName);
      if (!source) throw new DomainError(`Branch '${sourceBranchName}' not found`);
      if (!target) throw new DomainError(`Branch '${targetBranchName}' not found`);
      if (!source.headVersionId || !target.headVersionId) {
        throw new DomainError('Both branches must have at least one commit');
      }

      // Enforced here, not per caller, so BOTH merge entry points inherit it (constitution rows 5, 15).
      if (target.isProtected) {
        const approved = await em.count(WorkflowReviewEntity, {
          where: { workflowId, sourceBranchId: source.id, targetBranchId: target.id, status: 'approved' },
        });
        if (approved === 0) {
          throw new DomainError(
            `Branch '${targetBranchName}' is protected — merge it through an approved review`,
          );
        }
        if (!(await this.approvedAtHead(em, workflowId, source, target))) {
          throw new DomainError(
            `Branch '${targetBranchName}' is protected — the review was approved before the latest changes to '${sourceBranchName}'. Approve it again to merge.`,
            409,
            { code: APPROVAL_STALE },
          );
        }
        const failing = await this.latestFailingTest(em, workflowId, {
          source: source.headVersionId,
          target: target.headVersionId,
        });
        if (failing) {
          throw new DomainError(`${PROTECTED_TARGET_TEST_FAILING} ${whereItRan(failing)}`, 400, {
            code: MERGE_TEST_FAILING,
            review_id: failing.review?.id ?? null,
          });
        }
        if (resolutions && resolutions.length > 0)
          throw protectedMergeConflicts(sourceBranchName, targetBranchName);
      }

      if (await this.historyContains(em, target.headVersionId, source.headVersionId)) {
        return { success: true, mergedVersionId: null, conflicts: [] };
      }

      const ancestor = await this.findCommonAncestor(em, source.headVersionId, target.headVersionId);
      const sourceHead = await em.findOne(WorkflowVersionEntity, { where: { id: source.headVersionId } });
      const targetHead = await em.findOne(WorkflowVersionEntity, { where: { id: target.headVersionId } });
      if (!sourceHead || !targetHead) throw new DomainError('Could not load branch head versions');

      const sourceIr = this.loadIrFor(sourceHead);
      const targetIr = this.loadIrFor(targetHead);
      const ancestorIr = ancestor ? this.loadIrFor(ancestor) : targetIr;

      const result = threeWayMerge(ancestorIr, sourceIr, targetIr, resolutions);
      if (!result.success || !result.merged) {
        if (target.isProtected) throw protectedMergeConflicts(sourceBranchName, targetBranchName);
        return { success: false, mergedVersionId: null, conflicts: result.conflicts };
      }

      // Native: the stored document IS the IR (identity).
      const mergedJson = JSON.parse(JSON.stringify(result.merged)) as Record<string, unknown>;
      const irDiff = computeDiff(targetIr, result.merged);

      const maxRow = await rawQuery<{ max: number }>(
        em,
        `SELECT COALESCE(MAX(version_number), 0)::int AS max FROM workflow_versions
          WHERE workflow_id = $1 AND branch_id = $2`,
        [workflowId, target.id],
      );
      const nextVersion = (maxRow[0]?.max ?? 0) + 1;

      // `author` is a display string, not an actor id — resolved here so BOTH merge entry points inherit it.
      const actingUser = userId ? await em.findOne(UserEntity, { where: { id: userId } }) : null;

      repairDocumentLayout(mergedJson, result.merged as unknown as Record<string, unknown>);
      const mergeVersion = em.create(WorkflowVersionEntity, {
        id: newId(),
        workflowId,
        versionNumber: nextVersion,
        workflowJson: mergedJson,
        workflowIr: JSON.parse(JSON.stringify(result.merged)) as Record<string, unknown>,
        irDiff: JSON.parse(JSON.stringify(irDiff)) as Record<string, unknown>,
        commitMessage: `Merge '${sourceBranchName}' into '${targetBranchName}'`,
        author: actingUser?.name ?? userId ?? null,
        branchId: target.id,
        parentId: target.headVersionId,
        mergeParentId: source.headVersionId,
        createdAt: now(),
      });
      await em.save(WorkflowVersionEntity, mergeVersion);

      target.headVersionId = mergeVersion.id;
      await em.save(WorkflowBranchEntity, target);

      // Float the target's `latest` to the merge commit — every merge path runs through here (vault invariant).
      await this.moveLatestTag(em, workflowId, mergeVersion.id, target.id);

      const wf = await em.findOne(WorkflowEntity, { where: { id: workflowId } });
      await this.events.emit(em, {
        orgId: wf?.orgId ?? null,
        actorUserId: userId,
        type: 'workflow.merged',
        subjectType: 'version',
        subjectId: mergeVersion.id,
        payload: { source: sourceBranchName, target: targetBranchName, version_number: nextVersion },
      });

      return { success: true, mergedVersionId: mergeVersion.id, conflicts: [] };
    }
  }

  /** Per-branch `latest` find-or-create. */
  async moveLatestTag(
    em: EntityManager,
    workflowId: string,
    newVersionId: string,
    branchId: string | null,
  ): Promise<void> {
    const qb = em
      .createQueryBuilder(WorkflowVersionTagEntity, 't')
      .where('t.workflow_id = :workflowId AND t.tag = :tag', { workflowId, tag: 'latest' });
    if (branchId) qb.andWhere('t.branch_id = :branchId', { branchId });
    const existing = await qb.getOne();

    if (existing) {
      existing.versionId = newVersionId;
      if (branchId) existing.branchId = branchId;
      await em.save(WorkflowVersionTagEntity, existing);
      return;
    }
    await em.save(
      em.create(WorkflowVersionTagEntity, {
        id: newId(),
        workflowId,
        versionId: newVersionId,
        tag: 'latest',
        branchId,
        activated: true,
        createdAt: now(),
      }),
    );
  }

  loadIrFor(version: WorkflowVersionEntity): WorkflowIR {
    // Native: the IR is stored directly; workflow_json is the same document.
    return (version.workflowIr ?? version.workflowJson) as unknown as WorkflowIR;
  }
}

/** Refusal when the latest test of the very heads being merged failed (constitution row 15). */
export const PROTECTED_TARGET_TEST_FAILING =
  'Target branch is protected — the pre-merge test is failing (a step errors on this branch that passes on the target). Commit a fix, or re-test once the cause is resolved.';

/** The `code` a failing-test refusal carries, beside the `review_id` holding that test. */
export const MERGE_TEST_FAILING = 'merge_test_failing';

/** The refusal code when a protected merge's approval was given on an earlier version of the source. */
export const APPROVAL_STALE = 'approval_stale';

/** The refusal code when a merge into a protected branch would need conflicts resolved at merge time. */
export const PROTECTED_MERGE_CONFLICTS = 'protected_merge_conflicts';

function protectedMergeConflicts(source: string, target: string): DomainError {
  return new DomainError(
    `Branch '${target}' is protected, so conflicts can't be resolved while merging into it — that would land content nobody reviewed or tested. Update '${source}' from '${target}', resolve the conflicts there, and get that reviewed.`,
    409,
    { code: PROTECTED_MERGE_CONFLICTS, source_branch: source, target_branch: target },
  );
}

/** The conclusive failing test that blocks a protected merge. */
export interface FailingTest {
  /** The review it was run from; null once that review's branch has been deleted. */
  review: { id: string; title: string; sourceBranch: string; targetBranch: string } | null;
  /** Why the change failed, as the run reported it. */
  error: string | null;
  testedAt: string;
}

function whereItRan(test: FailingTest): string {
  const where = test.review
    ? `The latest conclusive test of these versions is on review "${test.review.title}" (${test.review.sourceBranch} → ${test.review.targetBranch}).`
    : 'The latest conclusive test of these versions was run from a branch that has since been deleted.';
  return test.error ? `${where} It failed with: ${test.error.slice(0, 200)}` : where;
}

/** Whether `a` comes after `b` in the order the merge gate reads tests: later, or as late and failing. */
export function isNewerTest(a: ReviewTestSummary, b: ReviewTestSummary): boolean {
  const at = Date.parse(a.tested_at);
  const bt = Date.parse(b.tested_at);
  return at > bt || (at === bt && a.verdict === 'red' && b.verdict !== 'red');
}

/** Whether a test can decide a merge: one where the target failed too neither shows nor rules out a new failure. */
export function isDecisiveTest(test: ReviewTestSummary): boolean {
  return test.verdict === 'red' || test.head?.status !== 'error';
}

/** Every version reachable from `start` through either parent, `start` included. */
function reachableFrom(start: string, parentsOf: Map<string, string[]>): Set<string> {
  const reached = new Set<string>([start]);
  const stack = [start];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    for (const parent of parentsOf.get(next) ?? []) {
      if (!reached.has(parent)) {
        reached.add(parent);
        stack.push(parent);
      }
    }
  }
  return reached;
}
