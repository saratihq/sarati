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
import { rawQuery } from '../database/raw-query';
export interface BranchMergeOutcome {
  success: boolean;
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

  /** Walk A's ancestry, then return the first hit on B's chain. Follows parent_id ONLY (merge parents are not walked). */
  async findCommonAncestor(
    em: EntityManager,
    versionAId: string,
    versionBId: string,
  ): Promise<WorkflowVersionEntity | null> {
    const verA = await em.findOne(WorkflowVersionEntity, { where: { id: versionAId } });
    if (!verA) return null;

    const rows = await rawQuery<{ id: string; parent_id: string | null }>(
      em,
      `SELECT id, parent_id FROM workflow_versions WHERE workflow_id = $1`,
      [verA.workflowId],
    );
    const parentMap = new Map(rows.map((r) => [r.id, r.parent_id]));

    const ancestorsOfA = new Set<string>();
    let current: string | null | undefined = versionAId;
    while (current) {
      ancestorsOfA.add(current);
      current = parentMap.get(current);
    }

    current = versionBId;
    while (current) {
      if (ancestorsOfA.has(current)) {
        return em.findOne(WorkflowVersionEntity, { where: { id: current } });
      }
      current = parentMap.get(current);
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

      // Enforced here, not per caller, so the branches page inherits it too (constitution row 5).
      if (target.isProtected) {
        const approvals = await em
          .createQueryBuilder(WorkflowReviewEntity, 'r')
          .where('r.workflow_id = :workflowId', { workflowId })
          .andWhere('r.source_branch_id = :sourceId', { sourceId: source.id })
          .andWhere('r.target_branch_id = :targetId', { targetId: target.id })
          .andWhere('r.status = :status', { status: 'approved' })
          .getCount();
        if (approvals === 0) {
          throw new DomainError(
            `Branch '${targetBranchName}' is protected — merge it through an approved review`,
          );
        }
      }

      if (source.headVersionId === target.headVersionId) {
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
