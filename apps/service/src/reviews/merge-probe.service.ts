import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { WorkflowBranchEntity } from '../database/entities/workflow-branch.entity';
import { triggerTypesOf, validateAuthoredIr } from '../compose/author-validation';
import { BranchService } from '../workflows/branch.service';

/** `true`/`false` once the merge was actually evaluated; `'unknown'` when a head is missing and it cannot be. */
export type Mergeability = boolean | 'unknown';

/** Read-only mergeability probe: the merge's own three-way merge and author gate, minting, moving and locking nothing, so `mergeBranchIn` stays the one merge (invariant #5). */
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

    const heads = await this.branches.mergeHeads(em, source.headVersionId, target.headVersionId);
    if (!heads) return 'unknown';
    if (!heads.result.success || !heads.result.merged) return false;
    const merged = heads.result.merged as unknown as Record<string, unknown>;
    const facts = await this.branches.factsFor(source.workflowId, triggerTypesOf(merged));
    return validateAuthoredIr(merged, facts.gate, source.workflowId).valid;
  }
}
