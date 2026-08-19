import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { ILike, In, type DataSource } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { isRecord } from '../common/json-util';
import { connectionRequirements } from '../compose/author-validation';
import { ComposeCatalogService } from '../compose/compose-catalog.service';
import { irEdgeFromDump } from '../ir/diff';
import { isIdShape } from '../database/ids';
import { rawQuery } from '../database/raw-query';
import { WorkflowBranchEntity } from '../database/entities/workflow-branch.entity';
import { WorkflowEntity } from '../database/entities/workflow.entity';
import { WorkflowVersionEntity } from '../database/entities/workflow-version.entity';
import { WorkflowVersionTagEntity } from '../database/entities/workflow-version-tag.entity';
import { BranchService } from './branch.service';
import { EnvPointersService, type EnvPointerView } from './env-pointers.service';

/** One row of the workflow list. */
export type WorkflowSummary = {
  id: string;
  name: string;
  active: boolean;
  source: string;
  node_count: number;
  node_types: string[];
  version_count: number;
  environments: string[];
  created_at: string | null;
  updated_at: string | null;
};

/** One page of the workflow list. */
export type WorkflowListPage = {
  workflows: WorkflowSummary[];
  total: number;
  has_more: boolean;
  limit: number;
  offset: number;
};

/** A branch as every branch response carries it. */
export type BranchView = {
  id: string;
  name: string;
  head_version_id: string | null;
  is_default: boolean;
  is_protected: boolean;
  created_at: string | null;
};

/** A branch's head version, with the graph a caller needs to reason about it. */
export type BranchHeadVersionView = {
  version_id: string;
  version_number: number;
  commit_message: string | null;
  author: string | null;
  parent_id: string | null;
  created_at: string | null;
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
};

/** The editable head of one branch: its document, the sibling branches, and the live env pointers. */
export type BranchHeadView = {
  workflow_id: string;
  workflow_name: string;
  branch: BranchView;
  head: BranchHeadVersionView | null;
  branches: BranchView[];
  env_pointers: EnvPointerView[];
};

/** Whether a workflow is live: the pointer IS the deployment, so the active version pointer is the signal. */
function isWorkflowLive(wf: WorkflowEntity): boolean {
  return wf.activeVersionId !== null;
}

/** A stored document's `nodes`/`edges`, tolerant of legacy rows that carry neither. */
function docList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

/** Edges leave the read path normalized (invariant #13), so no reader restates what an absent field means. */
function edgeList(value: unknown): Record<string, unknown>[] {
  return docList(value).map((edge) => ({ ...irEdgeFromDump(edge) }));
}

/** Search term → LIKE pattern; the caller's own `%`/`_` are literals, not wildcards. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export function branchView(branch: WorkflowBranchEntity): BranchView {
  return {
    id: branch.id,
    name: branch.name,
    head_version_id: branch.headVersionId,
    is_default: branch.isDefault,
    is_protected: branch.isProtected,
    created_at: branch.createdAt?.toISOString() ?? null,
  };
}

/** Workflow reads: listing, detail, display version, branch head, config. */
@Injectable()
export class WorkflowsReadService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly envPointers: EnvPointersService,
    private readonly branches: BranchService,
    private readonly catalog: ComposeCatalogService,
  ) {}

  async getWorkflowEntity(workflowId: string): Promise<WorkflowEntity> {
    if (!isIdShape(workflowId)) {
      throw new DomainError(`Workflow ${workflowId} not found`, 404);
    }
    const wf = await this.dataSource.manager.findOne(WorkflowEntity, { where: { id: workflowId } });
    if (!wf) throw new DomainError(`Workflow ${workflowId} not found`, 404);
    return wf;
  }

  /** The active version if set, else the latest on the default branch. */
  async getDisplayVersion(wf: WorkflowEntity): Promise<WorkflowVersionEntity | null> {
    const em = this.dataSource.manager;
    if (wf.activeVersionId) {
      return em.findOne(WorkflowVersionEntity, { where: { id: wf.activeVersionId } });
    }
    if (wf.defaultBranchId) {
      return em.findOne(WorkflowVersionEntity, {
        where: { workflowId: wf.id, branchId: wf.defaultBranchId },
        order: { versionNumber: 'DESC' },
      });
    }
    return null;
  }

  /** The default branch's head — the "latest" the client compares against live. */
  async getHeadVersion(wf: WorkflowEntity): Promise<WorkflowVersionEntity | null> {
    if (!wf.defaultBranchId) return null;
    const branch = await this.dataSource.manager.findOne(WorkflowBranchEntity, {
      where: { id: wf.defaultBranchId },
    });
    return this.headVersionOf(wf.id, wf.defaultBranchId, branch?.headVersionId ?? null);
  }

  /** A branch's head: its `head_version_id`, falling back to MAX(version_number) on that branch for legacy rows. */
  private async headVersionOf(
    workflowId: string,
    branchId: string,
    headVersionId: string | null,
  ): Promise<WorkflowVersionEntity | null> {
    const em = this.dataSource.manager;
    if (headVersionId) {
      const head = await em.findOne(WorkflowVersionEntity, { where: { id: headVersionId } });
      if (head) return head;
    }
    return em.findOne(WorkflowVersionEntity, {
      where: { workflowId, branchId },
      order: { versionNumber: 'DESC' },
    });
  }

  /** The named branch, or the workflow's default branch when `name` is null. */
  private async resolveBranch(wf: WorkflowEntity, name: string | null): Promise<WorkflowBranchEntity> {
    const em = this.dataSource.manager;
    if (name) {
      const branch = await em.findOne(WorkflowBranchEntity, { where: { workflowId: wf.id, name } });
      if (!branch) throw new DomainError(`Branch '${name}' not found for workflow ${wf.id}`, 404);
      return branch;
    }
    const fallback = wf.defaultBranchId
      ? await em.findOne(WorkflowBranchEntity, { where: { id: wf.defaultBranchId } })
      : null;
    if (!fallback) throw new DomainError(`Workflow ${wf.id} has no default branch`, 404);
    return fallback;
  }

  /**
   * The editable head of one branch — the read a caller needs before proposing an edit, without the
   * whole version history. Version numbers are per-branch, so the branch is part of the identity.
   */
  async getBranchHead(workflowId: string, branchName: string | null): Promise<BranchHeadView> {
    const wf = await this.getWorkflowEntity(workflowId);
    const branch = await this.resolveBranch(wf, branchName);
    const head = await this.headVersionOf(wf.id, branch.id, branch.headVersionId);
    return {
      workflow_id: wf.id,
      workflow_name: wf.name,
      branch: branchView(branch),
      head: head ? this.headView(head) : null,
      branches: (await this.branches.listBranches(wf.id)).map(branchView),
      env_pointers: await this.envPointers.listPointers(wf),
    };
  }

  private headView(head: WorkflowVersionEntity): BranchHeadVersionView {
    const doc = this.branches.loadIrFor(head);
    return {
      version_id: head.id,
      version_number: head.versionNumber,
      commit_message: head.commitMessage,
      author: head.author,
      parent_id: head.parentId,
      created_at: head.createdAt?.toISOString() ?? null,
      nodes: docList(doc.nodes),
      edges: edgeList(doc.edges),
    };
  }

  async listWorkflows(
    userId: string,
    activeOrgId: string | null,
    limitRaw: number,
    offsetRaw: number,
    nameQuery: string | null = null,
  ): Promise<WorkflowListPage> {
    const limit = Math.max(1, Math.min(limitRaw, 100));
    const offset = Math.max(0, offsetRaw);
    const em = this.dataSource.manager;

    // Org-scoped listing (the guard already resolved X-Org-Id → membership); user_id only for org-less legacy rows.
    const scope = activeOrgId ? { orgId: activeOrgId } : { userId };
    const where = nameQuery ? { ...scope, name: ILike(likePattern(nameQuery)) } : scope;
    const total = await em.count(WorkflowEntity, { where });
    const workflows = await em.find(WorkflowEntity, {
      where,
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });

    const ids = workflows.map((w) => w.id);
    const displayVersions = new Map<string, WorkflowVersionEntity>();
    if (ids.length > 0) {
      const activeIds = workflows.map((w) => w.activeVersionId).filter((v): v is string => Boolean(v));
      if (activeIds.length > 0) {
        for (const v of await em.find(WorkflowVersionEntity, { where: { id: In(activeIds) } })) {
          const owner = workflows.find((w) => w.activeVersionId === v.id);
          if (owner) displayVersions.set(owner.id, v);
        }
      }
      // Latest-on-default-branch for the rest.
      const needing = workflows.filter((w) => !displayVersions.has(w.id) && w.defaultBranchId);
      if (needing.length > 0) {
        const rows = await rawQuery<Record<string, unknown>>(
          em,
          `SELECT DISTINCT ON (v.workflow_id) v.*
             FROM workflow_versions v
             JOIN workflows w ON w.id = v.workflow_id AND v.branch_id = w.default_branch_id
            WHERE v.workflow_id = ANY($1)
            ORDER BY v.workflow_id, v.version_number DESC`,
          [needing.map((w) => w.id)],
        );
        for (const row of rows) {
          displayVersions.set(String(row.workflow_id), {
            workflowJson: row.workflow_json,
          } as WorkflowVersionEntity);
        }
      }
    }

    const versionCounts = new Map<string, number>();
    if (ids.length > 0) {
      const rows = await rawQuery<{ workflow_id: string; cnt: number }>(
        em,
        `SELECT workflow_id, count(*)::int AS cnt FROM workflow_versions WHERE workflow_id = ANY($1) GROUP BY workflow_id`,
        [ids],
      );
      for (const row of rows) versionCounts.set(row.workflow_id, row.cnt);
    }

    // Non-prod env pointers — the dashboard shows chips only when a workflow runs somewhere besides prod.
    const envsByWf = new Map<string, string[]>();
    if (ids.length > 0) {
      const rows = await rawQuery<{ workflow_id: string; environment: string }>(
        em,
        `SELECT workflow_id, environment FROM workflow_env_pointers
          WHERE workflow_id = ANY($1) AND environment <> 'production'
          ORDER BY environment`,
        [ids],
      );
      for (const row of rows) {
        envsByWf.set(row.workflow_id, [...(envsByWf.get(row.workflow_id) ?? []), row.environment]);
      }
    }

    const summaries = workflows.map((wf) => {
      const display = displayVersions.get(wf.id);
      const nodes = Array.isArray(display?.workflowJson?.nodes)
        ? (display.workflowJson.nodes as Array<Record<string, unknown>>)
        : [];
      const nodeTypes = [
        ...new Set(nodes.map((n) => (typeof n.node_type === 'string' ? n.node_type : '')).filter(Boolean)),
      ];
      return {
        id: wf.id,
        name: wf.name,
        active: isWorkflowLive(wf),
        source: wf.source,
        node_count: nodes.length,
        node_types: nodeTypes,
        version_count: versionCounts.get(wf.id) ?? 0,
        environments: envsByWf.get(wf.id) ?? [],
        created_at: wf.createdAt?.toISOString() ?? null,
        updated_at: wf.updatedAt?.toISOString() ?? null,
      };
    });

    return {
      workflows: summaries,
      total,
      has_more: offset + summaries.length < total,
      limit,
      offset,
    };
  }

  async getWorkflow(workflowId: string): Promise<Record<string, unknown>> {
    const wf = await this.getWorkflowEntity(workflowId);
    const display = await this.getDisplayVersion(wf);
    const head = await this.getHeadVersion(wf);
    const versionCount = await this.dataSource.manager.count(WorkflowVersionEntity, {
      where: { workflowId: wf.id },
    });

    const doc = display ? this.branches.loadIrFor(display) : null;
    // Save ≠ Live: `live_version` is what runs, `latest_version` the newest saved on the default
    // branch (latest > live means unpublished changes); `current_version` stays the DISPLAY version.
    const liveVersion = wf.activeVersionId ? (display?.versionNumber ?? null) : null;
    return {
      id: wf.id,
      name: wf.name,
      active: isWorkflowLive(wf),
      nodes: docList(doc?.nodes),
      edges: edgeList(doc?.edges),
      version_count: versionCount,
      current_version: display?.versionNumber ?? 0,
      live_version: liveVersion,
      latest_version: head?.versionNumber ?? display?.versionNumber ?? 0,
      // Per-environment live pointers, prod first; `live_version` above stays the prod pointer's number.
      env_pointers: await this.envPointers.listPointers(wf),
      created_at: wf.createdAt?.toISOString() ?? null,
      updated_at: wf.updatedAt?.toISOString() ?? null,
    };
  }

  async getConfig(workflowId: string): Promise<Record<string, unknown>> {
    const wf = await this.getWorkflowEntity(workflowId);
    const display = await this.getDisplayVersion(wf);
    if (!display?.workflowJson) {
      return {
        workflow_id: workflowId,
        credentials: [],
        webhook_inputs: [],
        has_webhook_trigger: false,
        webhook_path: null,
        has_chat_trigger: false,
        chat_path: null,
      };
    }

    const nodes = Array.isArray(display.workflowJson.nodes)
      ? (display.workflowJson.nodes as Array<Record<string, unknown>>)
      : [];

    // Auth requirements come from the ONE connection-requirement site, so the config view
    // and the author-time validator can never disagree about whether a step is wired up.
    const credentials = connectionRequirements(display.workflowJson, this.catalog.facts()).map((req) => ({
      node_name: req.node_name,
      node_type: req.node_type,
      auth_type: req.auth,
      description: `Requires ${req.auth} credentials`,
      configured: req.configured,
    }));
    let hasWebhook = false;
    let webhookPath: string | null = null;
    let hasChat = false;

    for (const node of nodes) {
      // Stored workflow_json IS the native IR document, so nodes key on `node_type`.
      const nodeType = typeof node.node_type === 'string' ? node.node_type : '';
      const params = isRecord(node.parameters) ? node.parameters : {};
      if (nodeType.startsWith('orchestr:webhook')) {
        hasWebhook = true;
        if (typeof params.path === 'string') webhookPath = params.path;
      }
      if (nodeType === 'orchestr:chat') hasChat = true;
    }

    return {
      workflow_id: workflowId,
      credentials,
      webhook_inputs: [],
      has_webhook_trigger: hasWebhook,
      webhook_path: webhookPath,
      // Chat intake: the path BASE only — the client appends the target env (`/api/chat/<wf>/<env>`).
      has_chat_trigger: hasChat,
      chat_path: hasChat ? `/api/chat/${workflowId}` : null,
    };
  }

  async findTagsForVersions(versionIds: string[]): Promise<Map<string, WorkflowVersionTagEntity[]>> {
    const out = new Map<string, WorkflowVersionTagEntity[]>();
    if (versionIds.length === 0) return out;
    const tags = await this.dataSource.manager.find(WorkflowVersionTagEntity, {
      where: { versionId: In(versionIds) },
    });
    for (const tag of tags) {
      const list = out.get(tag.versionId) ?? [];
      list.push(tag);
      out.set(tag.versionId, list);
    }
    return out;
  }
}
