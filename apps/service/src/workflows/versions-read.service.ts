import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { In, type DataSource } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { isIdShape } from '../database/ids';
import { WorkflowBranchEntity } from '../database/entities/workflow-branch.entity';
import { WorkflowVersionEntity } from '../database/entities/workflow-version.entity';
import type { WorkflowVersionTagEntity } from '../database/entities/workflow-version-tag.entity';
import { EnvPointersService } from './env-pointers.service';
import { WorkflowsReadService } from './workflows-read.service';
import { versionResponse } from './workflow-responses';

/** How a caller names a version: an id, or a per-branch number that needs its branch (invariant #1). */
export type VersionRef =
  { readonly id: string } | { readonly number: number; readonly branch: string | null };

/** Distinct branch ids carried by a set of versions, in first-seen order. */
export function branchIdsOf(versions: readonly WorkflowVersionEntity[]): string[] {
  return [...new Set(versions.map((v) => v.branchId).filter((b): b is string => Boolean(b)))];
}

/** Version listing and detail: fork-point display + branch-scoped tag visibility. */
@Injectable()
export class VersionsReadService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly workflowsRead: WorkflowsReadService,
    private readonly envPointers: EnvPointersService,
  ) {}

  async getBranchByName(workflowId: string, name: string): Promise<WorkflowBranchEntity | null> {
    return this.dataSource.manager.findOne(WorkflowBranchEntity, { where: { workflowId, name } });
  }

  async listVersions(workflowId: string, branchName: string | null): Promise<Record<string, unknown>> {
    const em = this.dataSource.manager;
    const wf = await this.workflowsRead.getWorkflowEntity(workflowId);

    let targetBranch: WorkflowBranchEntity | null = null;
    if (branchName) targetBranch = await this.getBranchByName(workflowId, branchName);

    let versions = await em.find(WorkflowVersionEntity, {
      where: targetBranch ? { workflowId, branchId: targetBranch.id } : { workflowId },
      order: { versionNumber: 'DESC' },
    });

    // Fork-point row for a non-default branch: the parent of its earliest version when that parent
    // lives elsewhere; a branch with no versions of its own shows only its head (the fork version).
    let forkPointId: string | null = null;
    if (targetBranch && !targetBranch.isDefault) {
      if (versions.length > 0) {
        const earliest = versions.reduce((a, b) => (a.versionNumber < b.versionNumber ? a : b));
        if (earliest.parentId) {
          const parent = await em.findOne(WorkflowVersionEntity, { where: { id: earliest.parentId } });
          if (parent && parent.branchId !== targetBranch.id) {
            versions = [...versions, parent];
            forkPointId = parent.id;
          }
        }
      } else if (targetBranch.headVersionId) {
        const forkPoint = await em.findOne(WorkflowVersionEntity, {
          where: { id: targetBranch.headVersionId },
        });
        if (forkPoint) {
          versions = [forkPoint];
          forkPointId = forkPoint.id;
        }
      }
    }

    const branchNames = await this.branchNamesById(branchIdsOf(versions));

    const tagsByVersion = await this.workflowsRead.findTagsForVersions(versions.map((v) => v.id));

    // Branch-scoped when viewing a branch; otherwise dedupe by name, or per-branch `latest` rows repeat.
    const visibleTags = (v: WorkflowVersionEntity): WorkflowVersionTagEntity[] => {
      const tags = tagsByVersion.get(v.id) ?? [];
      if (targetBranch) return tags.filter((t) => t.branchId === targetBranch.id);
      const seen = new Set<string>();
      const out: WorkflowVersionTagEntity[] = [];
      for (const t of tags) {
        if (!seen.has(t.tag)) {
          seen.add(t.tag);
          out.push(t);
        }
      }
      return out;
    };

    return {
      workflow_id: workflowId,
      active_version_id: wf.activeVersionId,
      // Per-environment live pointers, prod first; `active_version_id` stays prod's legacy alias.
      env_pointers: await this.envPointers.listPointers(wf),
      versions: versions.map((v) => {
        const tags = visibleTags(v);
        const isFork = forkPointId !== null && v.id === forkPointId;
        return versionResponse(v, {
          branchName: v.branchId ? (branchNames.get(v.branchId) ?? null) : null,
          tags: tags.map((t) => t.tag),
          inactiveTags: tags.filter((t) => !t.activated).map((t) => t.tag),
          isForkPoint: isFork,
          forkSourceBranch: isFork && v.branchId ? (branchNames.get(v.branchId) ?? null) : null,
        });
      }),
    };
  }

  async getVersion(
    workflowId: string,
    versionNumber: number,
    branchName: string | null,
  ): Promise<Record<string, unknown>> {
    const version = await this.findVersion(workflowId, versionNumber, branchName);
    if (!version) {
      throw new DomainError(`Version ${versionNumber} not found for workflow ${workflowId}`, 404);
    }
    return versionResponse(version);
  }

  /** The ONE version-resolution site — an id, or a number the caller must disambiguate. */
  async resolveVersion(workflowId: string, ref: VersionRef): Promise<WorkflowVersionEntity | null> {
    return 'id' in ref
      ? this.findVersionById(workflowId, ref.id)
      : this.findVersion(workflowId, ref.number, ref.branch);
  }

  /** A version id resolves only inside its own workflow — a foreign id is not found, never read. */
  async findVersionById(workflowId: string, versionId: string): Promise<WorkflowVersionEntity | null> {
    if (!isIdShape(versionId)) return null;
    return this.dataSource.manager.findOne(WorkflowVersionEntity, {
      where: { id: versionId, workflowId },
    });
  }

  /**
   * Find one version by its PER-BRANCH number (invariant #1). An unresolvable branch name and a bare
   * number that matches on several branches both RAISE — an unfiltered match would be a coin flip.
   */
  async findVersion(
    workflowId: string,
    versionNumber: number,
    branchName: string | null,
  ): Promise<WorkflowVersionEntity | null> {
    if (branchName) {
      const branch = await this.getBranchByName(workflowId, branchName);
      if (!branch) throw new DomainError(`Branch not found: ${branchName}`, 404);
      return this.dataSource.manager.findOne(WorkflowVersionEntity, {
        where: { workflowId, versionNumber, branchId: branch.id },
      });
    }

    const matches = await this.dataSource.manager.find(WorkflowVersionEntity, {
      where: { workflowId, versionNumber },
    });
    if (matches.length > 1) throw new DomainError(await this.ambiguity(versionNumber, matches), 400);
    return matches[0] ?? null;
  }

  /** Branch id → name for the ids given; empty in, empty out. */
  async branchNamesById(branchIds: readonly string[]): Promise<Map<string, string>> {
    if (branchIds.length === 0) return new Map();
    const branches = await this.dataSource.manager.find(WorkflowBranchEntity, {
      where: { id: In([...branchIds]) },
    });
    return new Map(branches.map((b) => [b.id, b.name]));
  }

  private async ambiguity(versionNumber: number, matches: WorkflowVersionEntity[]): Promise<string> {
    const names = await this.branchNamesById(branchIdsOf(matches));
    const branches = [...names.values()].sort().join(', ');
    return `Version ${versionNumber} is ambiguous: version numbers are per-branch and this one exists on ${branches}. Pass \`branch\`, or reference the version by id.`;
  }
}
