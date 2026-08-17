import { Injectable } from '@nestjs/common';

import type { Principal } from '../auth/principal';
import { DomainError } from '../common/domain-error';
import type { WorkflowVersionEntity } from '../database/entities/workflow-version.entity';
import { computeDiff, IRDiffOperation, type IRDiff, type IRDiffEntry, type RenamePair } from '../ir/diff';
import type { WorkflowIR } from '../ir/models';
import { branchIdsOf, VersionsReadService, type VersionRef } from './versions-read.service';
import { WorkflowsReadService } from './workflows-read.service';
import { WorkflowAccessService } from './workflow-access.service';

/** One side of a diff, resolved — a version id is the only unambiguous reference (invariant #1). */
export interface DiffSide {
  version_id: string;
  version_number: number;
  branch: string | null;
  commit_message: string | null;
}

/** A change inside a node, keyed by `(node_id, path)` — field-level, never text-level (invariant #5). */
export interface NodeChange {
  operation: string;
  node_id: string;
  node_name: string | null;
  path: string | null;
  old_value: unknown;
  new_value: unknown;
}

/** A connection change, keyed by the endpoint tuple incl. `port_type`, never the edge id (invariant #13). */
export interface EdgeChange {
  operation: string;
  source_node_id: string;
  source_port: number;
  target_node_id: string;
  target_port: number;
  port_type: string;
}

/** A workflow-level settings change, keyed by its dotted path. */
export interface SettingsChange {
  path: string | null;
  old_value: unknown;
  new_value: unknown;
}

/** The field-level change set between two resolved versions, grouped by what each op is keyed on. */
export interface WorkflowChangeSet {
  workflow_id: string;
  from: DiffSide;
  to: DiffSide;
  summary: string;
  node_changes: NodeChange[];
  edge_changes: EdgeChange[];
  settings_changes: SettingsChange[];
  renames: RenamePair[];
}

/**
 * Version diffs, same-branch or cross-branch. Version numbers are PER-BRANCH, so every reference is
 * resolved through {@link VersionsReadService} — this service never queries a version itself.
 */
@Injectable()
export class DiffService {
  constructor(
    private readonly versionsRead: VersionsReadService,
    private readonly workflowsRead: WorkflowsReadService,
    private readonly access: WorkflowAccessService,
  ) {}

  /** The REST shape: the raw ops, plus both sides resolved to their id/number/branch. */
  async getDiff(
    principal: Principal,
    workflowId: string,
    from: VersionRef,
    to: VersionRef,
  ): Promise<Record<string, unknown>> {
    const compared = await this.compare(principal, workflowId, from, to);
    return {
      from_version: compared.from.version_number,
      to_version: compared.to.version_number,
      from_version_id: compared.from.version_id,
      to_version_id: compared.to.version_id,
      from_branch: compared.from.branch,
      to_branch: compared.to.branch,
      entries: compared.diff.entries,
      summary: compared.diff.summary,
      renames: compared.diff.renames,
    };
  }

  /** The same comparison, grouped for a caller that must see what each op is keyed on (ADR 0052). */
  async getChangeSet(
    principal: Principal,
    workflowId: string,
    from: VersionRef,
    to: VersionRef,
  ): Promise<WorkflowChangeSet> {
    const compared = await this.compare(principal, workflowId, from, to);
    const entries = compared.diff.entries;
    return {
      workflow_id: workflowId,
      from: compared.from,
      to: compared.to,
      summary: compared.diff.summary,
      node_changes: entries.filter(isNodeOp).map(nodeChange),
      edge_changes: entries.filter(isEdgeOp).map(edgeChange),
      settings_changes: entries.filter(isSettingsOp).map(settingsChange),
      renames: compared.diff.renames,
    };
  }

  loadIr(version: WorkflowVersionEntity): WorkflowIR {
    // Native: the IR is stored directly; workflow_json is the same document.
    return (version.workflowIr ?? version.workflowJson) as unknown as WorkflowIR;
  }

  private async compare(
    principal: Principal,
    workflowId: string,
    from: VersionRef,
    to: VersionRef,
  ): Promise<{ from: DiffSide; to: DiffSide; diff: IRDiff }> {
    await this.access.require(principal, workflowId, 'read');

    const fromVer = await this.versionsRead.resolveVersion(workflowId, from);
    if (!fromVer) throw notFound(workflowId, from);
    const toVer = await this.versionsRead.resolveVersion(workflowId, to);
    if (!toVer) throw notFound(workflowId, to);

    const branches = await this.versionsRead.branchNamesById(branchIdsOf([fromVer, toVer]));
    // Rename collapse is presentational — enabled HERE only, never in a merge path (invariant #13).
    const diff = computeDiff(this.loadIr(fromVer), this.loadIr(toVer), { detectRenames: true });
    return { from: side(fromVer, branches), to: side(toVer, branches), diff };
  }
}

const EDGE_OPS: ReadonlySet<string> = new Set([IRDiffOperation.ADD_EDGE, IRDiffOperation.REMOVE_EDGE]);

function isEdgeOp(e: IRDiffEntry): boolean {
  return EDGE_OPS.has(e.operation);
}

function isSettingsOp(e: IRDiffEntry): boolean {
  return e.operation === IRDiffOperation.MODIFY_SETTINGS;
}

function isNodeOp(e: IRDiffEntry): boolean {
  return !isEdgeOp(e) && !isSettingsOp(e);
}

function nodeChange(e: IRDiffEntry): NodeChange {
  return {
    operation: e.operation,
    node_id: e.target_id,
    node_name: e.target_name,
    path: e.path,
    old_value: e.old_value,
    new_value: e.new_value,
  };
}

function edgeChange(e: IRDiffEntry): EdgeChange {
  const dump = asRecord(e.new_value) ?? asRecord(e.old_value) ?? {};
  return {
    operation: e.operation,
    source_node_id: asString(dump.source_node_id),
    source_port: asNumber(dump.source_port),
    target_node_id: asString(dump.target_node_id),
    target_port: asNumber(dump.target_port),
    port_type: asString(dump.port_type),
  };
}

function settingsChange(e: IRDiffEntry): SettingsChange {
  return { path: e.path, old_value: e.old_value, new_value: e.new_value };
}

function side(version: WorkflowVersionEntity, branches: Map<string, string>): DiffSide {
  return {
    version_id: version.id,
    version_number: version.versionNumber,
    branch: version.branchId ? (branches.get(version.branchId) ?? null) : null,
    commit_message: version.commitMessage,
  };
}

function notFound(workflowId: string, ref: VersionRef): DomainError {
  return new DomainError(`Version ${namedRef(ref)} not found in workflow ${workflowId}`, 404);
}

function namedRef(ref: VersionRef): string {
  if ('id' in ref) return `id ${ref.id}`;
  if ('head' in ref) return `head of branch ${ref.head}`;
  return `number ${ref.number}${ref.branch ? ` on branch ${ref.branch}` : ''}`;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asNumber(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}
