import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { WorkflowBranchEntity } from '../database/entities/workflow-branch.entity';
import { WorkflowVersionEntity } from '../database/entities/workflow-version.entity';
import { threeWayMerge } from '../ir/merge';
import { BranchService } from '../workflows/branch.service';

/** `true`/`false` once the merge was actually evaluated; `'unknown'` when a head is missing and it cannot be. */
export type Mergeability = boolean | 'unknown';

/**
 * Read-only mergeability probe: the same `threeWayMerge` core the merge runs, off the same ancestor
 * walk, minting no version, moving no head and locking no row — invariant #5's one merge
 * implementation (`branch.service.ts mergeBranchIn`) stays the only thing that can land a merge.
 */
@Injectable()
export class MergeProbeService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly branches: BranchService,
  ) {}

  async probe(sourceBranchId: string, targetBranchId: string): Promise<Mergeability> {
    const em = this.dataSource.manager;
    const [source, target] = await Promise.all([
      em.findOne(WorkflowBranchEntity, { where: { id: sourceBranchId } }),
      em.findOne(WorkflowBranchEntity, { where: { id: targetBranchId } }),
    ]);
    if (!source?.headVersionId || !target?.headVersionId) return 'unknown';
    if (source.headVersionId === target.headVersionId) return true;

    const [sourceHead, targetHead] = await Promise.all([
      em.findOne(WorkflowVersionEntity, { where: { id: source.headVersionId } }),
      em.findOne(WorkflowVersionEntity, { where: { id: target.headVersionId } }),
    ]);
    if (!sourceHead || !targetHead) return 'unknown';

    const ancestor = await this.branches.findCommonAncestor(em, source.headVersionId, target.headVersionId);
    const targetIr = this.branches.loadIrFor(targetHead);
    // No shared history: the merge falls back to target as the base, so the probe must too.
    const ancestorIr = ancestor ? this.branches.loadIrFor(ancestor) : targetIr;
    return threeWayMerge(ancestorIr, this.branches.loadIrFor(sourceHead), targetIr).success;
  }
}
