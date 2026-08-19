import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import type { Principal } from '../auth/principal';
import { DomainError } from '../common/domain-error';
import { errorMessage } from '../common/error-message';
import { newId, now } from '../database/ids';
import { jsonRecord, rawQuery } from '../database/raw-query';
import { WorkflowBranchEntity } from '../database/entities/workflow-branch.entity';
import { WorkflowEntity } from '../database/entities/workflow.entity';
import { WorkflowVersionEntity } from '../database/entities/workflow-version.entity';
import { EventsService } from '../events/events.service';
import { computeDiff, type IRDiff } from '../ir/diff';
import type { WorkflowIR } from '../ir/models';
import { lintDataRefs } from '../compiler/ref-lint';
import { assertAuthoredIrValid } from '../compose/author-validation';
import { composerMerge } from '../compose/compose-merge';
import { ComposeCatalogService } from '../compose/compose-catalog.service';
import { BranchService } from './branch.service';
import { VersionsReadService } from './versions-read.service';
import { TriggerSignalsService } from '../triggers/trigger-signals.service';
import { EnvPointersService, PROD_ENV } from './env-pointers.service';

export interface CommitInput {
  workflowJson?: Record<string, unknown> | null;
  workflowIr?: Record<string, unknown> | null;
  branchName: string;
  commitMessage: string | null;
  author: string | null;
  actorId: string | null;
  /** The caller — every bearer-facing call site passes it; a non-interactive one (API key: CI, an MCP agent) must then send `baseVersionId`. */
  principal?: Principal;
  /** Optimistic-concurrency token: the head the client edited from; a moved branch is a 409, never a silent clobber. Omitted → no guard. */
  baseVersionId?: string | null;
}

/** One field-level collision a caller must resolve by hand before re-committing. */
interface CommitConflict {
  node_id: string;
  node_name: string;
  kind: 'field' | 'edit_delete';
  field_path: string | null;
}

const BASE_VERSION_REQUIRED =
  'base_version_id is required when committing with an API key: send the version_id of the branch head ' +
  'this edit is based on, so a commit that landed while you were working is refused instead of clobbered. ' +
  "Read it from orchestr_get_workflow (`version_id`), or from a branch's `head_version_id`.";

/** One honest sentence from a field-level diff ("Added X · changed Y") — null whenever it can't say something true. */
function summarizeIrDiff(
  irDiff: Record<string, unknown> | null,
  newIr: Record<string, unknown> | null | undefined,
): string | null {
  const entries = (irDiff?.entries ?? null) as Array<{
    operation: string;
    target_id: string;
    target_name: string | null;
  }> | null;
  if (!entries || entries.length === 0) return null;
  const nodes = ((newIr?.nodes ?? []) as Array<{ id?: unknown; name?: unknown }>).filter(
    (n) => typeof n.id === 'string',
  );
  const nameOf = (e: { target_id: string; target_name: string | null }): string => {
    if (e.target_name) return e.target_name;
    const hit = nodes.find((n) => n.id === e.target_id);
    return typeof hit?.name === 'string' && hit.name ? hit.name : e.target_id;
  };
  const collect = (ops: string[]): string[] => [
    ...new Set(entries.filter((e) => ops.includes(e.operation)).map(nameOf)),
  ];
  const added = collect(['add_node']);
  const removed = collect(['remove_node']);
  const changed = collect(['modify_node', 'rename_node']).filter(
    (n) => !added.includes(n) && !removed.includes(n),
  );
  const list = (names: string[]): string =>
    names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2} more`;
  const parts: string[] = [];
  if (added.length) parts.push(`added ${list(added)}`);
  if (removed.length) parts.push(`removed ${list(removed)}`);
  if (changed.length) parts.push(`changed ${list(changed)}`);
  if (parts.length === 0) {
    if (entries.some((e) => e.operation === 'add_edge' || e.operation === 'remove_edge')) {
      parts.push('rewired steps');
    } else if (entries.some((e) => e.operation === 'modify_settings')) {
      parts.push('changed settings');
    }
  }
  if (parts.length === 0) return null;
  const sentence = parts.join(' · ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * Invariant #3's comparison against the branch head. `computeDiff` is the ONE answer to "did the
 * content change?" (invariant #4), so a failure here is never swallowed: minting a version on an
 * unanswerable diff is exactly how "a no-diff commit mints nothing" stops being true.
 */
function diffAgainstHead(head: Record<string, unknown>, draft: Record<string, unknown>): IRDiff {
  try {
    return computeDiff(head as unknown as WorkflowIR, draft as unknown as WorkflowIR);
  } catch (err) {
    throw new DomainError(
      'This document could not be compared with the branch head, so the commit was refused rather ' +
        'than minting a version that may be identical to it: ' +
        errorMessage(err),
      422,
      { code: 'head_diff_failed' },
    );
  }
}

/** The native document: the IR IS the stored workflow_json — identity both ways. */
function documentOf(input: CommitInput): Record<string, unknown> {
  const doc = input.workflowIr ?? input.workflowJson;
  if (!doc) throw new DomainError('Must provide either workflow_json or workflow_ir');
  return doc;
}

function isIrShaped(doc: unknown): boolean {
  const candidate = doc as { nodes?: unknown; edges?: unknown } | null | undefined;
  return !!candidate && Array.isArray(candidate.nodes) && Array.isArray(candidate.edges);
}

/**
 * The field-level collisions between the moved head and this draft — the SAME merge the composer
 * runs (position-only conflicts already filtered), read for its `conflicts` alone: a commit never
 * lands an auto-resolved document. `null` = the merge could not be computed, so claim nothing.
 */
function fieldConflicts(
  base: WorkflowIR | null,
  ours: WorkflowIR | null,
  theirs: Record<string, unknown>,
): CommitConflict[] | null {
  if (!isIrShaped(base) || !isIrShaped(ours) || !isIrShaped(theirs)) return null;
  try {
    const { conflicts } = composerMerge(
      base as WorkflowIR,
      ours as WorkflowIR,
      theirs as unknown as WorkflowIR,
    );
    return conflicts.map((c) => ({
      node_id: c.node_id,
      node_name: c.node_name,
      kind: c.kind,
      field_path: c.field_path,
    }));
  } catch {
    return null;
  }
}

const MAX_NAMED_CONFLICTS = 5;

function conflictSentence(conflicts: CommitConflict[] | null): string {
  if (conflicts === null) return 'Check that merge for field conflicts and resolve every one yourself.';
  if (conflicts.length === 0) return 'That merge is clean — no field conflicts.';
  const named = conflicts
    .slice(0, MAX_NAMED_CONFLICTS)
    .map((c) => `${c.node_name || c.node_id}${c.field_path ? ` (${c.field_path})` : ''}`)
    .join(', ');
  const more = conflicts.length > MAX_NAMED_CONFLICTS ? ', …' : '';
  return (
    `${conflicts.length} field-level conflict${conflicts.length === 1 ? '' : 's'} must be resolved by hand first — ` +
    `${named}${more}. Sarati never auto-resolves a field conflict for you: choose a value per field.`
  );
}

/** Commit / rollback / publish. Version numbering is computed under a branch-row FOR UPDATE lock, and `latest` floats on every write path. */
@Injectable()
export class VersionsWriteService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly branches: BranchService,
    private readonly events: EventsService,
    private readonly envPointers: EnvPointersService,
    private readonly triggerSignals: TriggerSignalsService,
    private readonly catalog: ComposeCatalogService,
    private readonly versions: VersionsReadService,
  ) {}

  /** The workflow's default branch, created on first use. */
  async ensureDefaultBranch(em: EntityManager, wf: WorkflowEntity): Promise<WorkflowBranchEntity> {
    if (wf.defaultBranchId) {
      const branch = await em.findOne(WorkflowBranchEntity, { where: { id: wf.defaultBranchId } });
      if (branch) return branch;
    }
    const branch = em.create(WorkflowBranchEntity, {
      id: newId(),
      workflowId: wf.id,
      name: 'main',
      isDefault: true,
      isProtected: false,
      headVersionId: null,
      createdBy: null,
      createdAt: now(),
    });
    await em.save(WorkflowBranchEntity, branch);
    wf.defaultBranchId = branch.id;
    await em.save(WorkflowEntity, wf);
    return branch;
  }

  /**
   * Layout is presentation, not history: a position-only move patches the branch head in place —
   * no new version, and nothing but `position` may change. A stale node id is ignored, not failed.
   */
  async patchLayout(
    workflowId: string,
    branchName: string | undefined,
    positions: Record<string, { x: number; y: number }>,
  ): Promise<{ updated: number }> {
    const entries = Object.entries(positions ?? {});
    if (entries.length === 0) throw new DomainError('positions must contain at least one node');
    for (const [nodeId, pos] of entries) {
      if (
        !nodeId ||
        typeof pos?.x !== 'number' ||
        typeof pos?.y !== 'number' ||
        !Number.isFinite(pos.x) ||
        !Number.isFinite(pos.y)
      ) {
        throw new DomainError('positions must map node ids to finite {x, y} coordinates');
      }
    }
    return this.dataSource.transaction(async (em) => {
      const wf = await em.findOne(WorkflowEntity, { where: { id: workflowId } });
      if (!wf) throw new DomainError('Workflow not found');
      const branch = branchName
        ? await em.findOne(WorkflowBranchEntity, { where: { workflowId, name: branchName } })
        : await this.ensureDefaultBranch(em, wf);
      if (!branch) throw new DomainError(`Branch '${branchName}' not found`);
      const head = await em.findOne(WorkflowVersionEntity, {
        where: { workflowId, branchId: branch.id },
        order: { versionNumber: 'DESC' },
      });
      if (!head) throw new DomainError('This workflow has no version to lay out yet');
      const patchDoc = (
        doc: Record<string, unknown> | null,
      ): { doc: Record<string, unknown> | null; touched: number } => {
        const nodes = (doc as { nodes?: Array<Record<string, unknown>> } | null)?.nodes;
        if (!doc || !Array.isArray(nodes)) return { doc, touched: 0 };
        let touched = 0;
        return {
          doc: {
            ...doc,
            nodes: nodes.map((n) => {
              const pos = typeof n.id === 'string' ? positions[n.id] : undefined;
              if (!pos) return n;
              touched += 1;
              return { ...n, position: { x: pos.x, y: pos.y } };
            }),
          },
          touched,
        };
      };
      const json = patchDoc(head.workflowJson);
      const ir = patchDoc(head.workflowIr);
      head.workflowJson = json.doc as Record<string, unknown>;
      head.workflowIr = ir.doc;
      await em.save(WorkflowVersionEntity, head);
      return { updated: Math.max(json.touched, ir.touched) };
    });
  }

  async commit(
    input: CommitInput & { workflowId: string },
  ): Promise<{ version: WorkflowVersionEntity; refWarnings: string[]; noChanges?: boolean }> {
    const irData = documentOf(input);

    return this.dataSource.transaction(async (em) => {
      const wf = await em.findOne(WorkflowEntity, { where: { id: input.workflowId } });
      if (!wf) throw new DomainError(`Workflow ${input.workflowId} not found`, 404);
      const branch = await this.lockBranchByName(em, wf.id, input.branchName);

      // Rollback deliberately still lands here — it is the documented recovery path.
      if (branch.isProtected) {
        throw new DomainError(
          `Branch '${branch.name}' is protected — commit to a branch and open a review to bring it in`,
          409,
          { code: 'branch_protected' },
        );
      }

      // Demanded HERE because the same key is a bearer on this route AND on the tool wrapping it.
      if (branch.headVersionId && input.principal?.kind === 'api_key' && !input.baseVersionId) {
        throw new DomainError(BASE_VERSION_REQUIRED, 400, { code: 'base_version_id_required' });
      }

      // Optimistic concurrency: a base that is no longer the head means another commit landed
      // mid-edit → 409, never a clobber. The branch row is FOR UPDATE-locked, so this read is authoritative.
      if (input.baseVersionId != null && branch.headVersionId !== input.baseVersionId) {
        throw await this.branchMoved(em, branch, input.baseVersionId, irData);
      }

      // A no-diff commit mints nothing (invariant #3) — the head IS the save.
      if (branch.headVersionId) {
        const head = await em.findOne(WorkflowVersionEntity, { where: { id: branch.headVersionId } });
        if (head?.workflowIr && diffAgainstHead(head.workflowIr, irData).entries.length === 0) {
          return { version: head, refWarnings: lintDataRefs(irData), noChanges: true };
        }
      }

      // The ONE author-time gate: a doc that only fails at RUN must fail at SAVE, and a
      // hand-written document faces exactly what an ops-built one does. Write path only — reads of
      // an existing phantom stay open so the user can fix it.
      const report = assertAuthoredIrValid(irData, this.catalog.facts(), wf.id);

      const version = await this.insertVersion(em, {
        wf,
        branch,
        workflowJson: irData,
        workflowIr: irData,
        commitMessage: input.commitMessage,
        author: input.author,
        actorId: input.actorId,
        eventType: 'workflow.committed',
      });
      // Broken data refs surface at save, not at run time.
      return { version, refWarnings: report.ref_warnings };
    });
  }

  /**
   * The refusal a moved branch earns: the mandated three-way mapping plus the field collisions it
   * would hit. The merge is NOT applied — an auto-resolved commit would make field-level conflicts a lie.
   */
  private async branchMoved(
    em: EntityManager,
    branch: WorkflowBranchEntity,
    baseVersionId: string,
    draft: Record<string, unknown>,
  ): Promise<DomainError> {
    const head = branch.headVersionId
      ? await em.findOne(WorkflowVersionEntity, { where: { id: branch.headVersionId } })
      : null;
    const base = await em.findOne(WorkflowVersionEntity, {
      where: { id: baseVersionId, workflowId: branch.workflowId },
    });
    const conflicts = fieldConflicts(
      base ? this.branches.loadIrFor(base) : null,
      head ? this.branches.loadIrFor(head) : null,
      draft,
    );
    const headLabel = head ? `v${head.versionNumber} (${head.id})` : 'another version';

    return new DomainError(
      `"${branch.name}" moved on since you started editing — ${headLabel} is the head now, so saving ` +
        `this document would drop that author's work. Merge three-way, mapped exactly: base = the ` +
        `version at base_version_id (${baseVersionId}), ours = the new branch head (the other ` +
        `author's), theirs = the document you just sent. ${conflictSentence(conflicts)} Then commit ` +
        `the resolved document with base_version_id set to the new head.`,
      409,
      {
        code: 'branch_moved',
        branch: branch.name,
        current_head_version_id: branch.headVersionId,
        current_head_version_number: head?.versionNumber ?? null,
        base_version_id: baseVersionId,
        merge: { base: baseVersionId, ours: branch.headVersionId, theirs: 'the submitted document' },
        conflicts,
      },
    );
  }

  async rollback(
    workflowId: string,
    versionNumber: number,
    branchName: string | null,
    actorId: string | null,
  ): Promise<Record<string, unknown>> {
    // One version-resolution site (invariant #1): an ambiguous bare number raises here too, never rolls
    // back whichever branch Postgres happened to return.
    const target = await this.versions.findVersion(workflowId, versionNumber, branchName);
    if (!target) {
      throw new DomainError(`Version ${versionNumber} not found for workflow ${workflowId}`, 404);
    }

    return this.dataSource.transaction(async (em) => {
      const targetBranch = target.branchId
        ? await em.findOne(WorkflowBranchEntity, { where: { id: target.branchId } })
        : null;

      const wf = await em.findOne(WorkflowEntity, { where: { id: workflowId } });
      if (!wf) throw new DomainError(`Workflow ${workflowId} not found`, 404);

      const branch = targetBranch ?? (await this.ensureDefaultBranch(em, wf));
      await this.lockBranchById(em, branch.id);

      const version = await this.insertVersion(em, {
        wf,
        branch,
        workflowJson: target.workflowJson,
        workflowIr: target.workflowIr,
        commitMessage: `Rollback to v${versionNumber}`,
        author: null,
        actorId,
        eventType: 'workflow.rolled_back',
        // A rollback deliberately stores no ir_diff.
        skipIrDiff: true,
      });

      return {
        status: 'rolled_back',
        new_version_number: version.versionNumber,
        rolled_back_to: versionNumber,
      };
    });
  }

  /**
   * Publish — the explicit release act: moves the live pointer to a default-branch version (head by
   * default), minting nothing. Idempotent. Env-less triggers head-track main and are unaffected.
   */
  async publish(
    workflowId: string,
    versionNumber: number | null,
    actorId: string | null,
  ): Promise<Record<string, unknown>> {
    return this.movePublishPointer(workflowId, versionNumber, actorId, {
      eventType: 'workflow.published',
      status: 'published',
      defaultToHead: true,
    });
  }

  /** Restore — the same instant pointer move as `publish`, but the version is always explicit. */
  async restore(
    workflowId: string,
    versionNumber: number,
    actorId: string | null,
  ): Promise<Record<string, unknown>> {
    return this.movePublishPointer(workflowId, versionNumber, actorId, {
      eventType: 'workflow.restored',
      status: 'restored',
      defaultToHead: false,
    });
  }

  /** Shared live-pointer move backing both `publish` and `restore`. */
  private async movePublishPointer(
    workflowId: string,
    versionNumber: number | null,
    actorId: string | null,
    opts: { eventType: string; status: string; defaultToHead: boolean },
  ): Promise<Record<string, unknown>> {
    const result = await this.dataSource.transaction(async (em) => {
      const wf = await em.findOne(WorkflowEntity, { where: { id: workflowId } });
      if (!wf) throw new DomainError(`Workflow ${workflowId} not found`, 404);

      const branch = await this.ensureDefaultBranch(em, wf);

      let target: WorkflowVersionEntity | null;
      if (versionNumber !== null) {
        target = await em.findOne(WorkflowVersionEntity, {
          where: { workflowId: wf.id, versionNumber, branchId: branch.id },
        });
        if (!target) {
          throw new DomainError(`Version ${versionNumber} not found for workflow ${workflowId}`, 404);
        }
      } else if (opts.defaultToHead) {
        target = branch.headVersionId
          ? await em.findOne(WorkflowVersionEntity, { where: { id: branch.headVersionId } })
          : await em.findOne(WorkflowVersionEntity, {
              where: { workflowId: wf.id, branchId: branch.id },
              order: { versionNumber: 'DESC' },
            });
        if (!target) throw new DomainError('Workflow has no version to publish', 400);
      } else {
        throw new DomainError('version_number is required', 400);
      }

      // Moving an org workflow's PROD pointer is owner/admin-only — the SAME gate promote enforces.
      // Gate the OPERATION (before the idempotency check) so a member is denied consistently.
      if (actorId) await this.envPointers.assertPointerMoveAllowed(em, wf, PROD_ENV, actorId);
      // Publish IS promote-to-prod: it refuses an environment that cannot run the version too.
      await this.envPointers.assertEnvCanRun(em, wf, PROD_ENV, target);

      // Only write + emit when the pointer actually moves, so a repeated publish doesn't spam the
      // outbox. Publish IS promote-to-prod: the write goes through the env-pointer seam.
      if (wf.activeVersionId !== target.id) {
        await this.envPointers.setPointer(em, wf.id, PROD_ENV, target.id);
        await this.events.emit(em, {
          orgId: wf.orgId,
          actorUserId: actorId,
          type: opts.eventType,
          subjectType: 'workflow',
          subjectId: wf.id,
          payload: { version_number: target.versionNumber },
        });
      }

      return { status: opts.status, workflow_id: wf.id, live_version: target.versionNumber };
    });
    // Prod pointer moved (committed) → reconcile this workflow's activations.
    await this.triggerSignals.enqueue(workflowId);
    return result;
  }

  /** Shared insert path: next-number under lock, ir_diff best-effort, head advance, latest float, event. */
  async insertVersion(
    em: EntityManager,
    args: {
      wf: WorkflowEntity;
      branch: WorkflowBranchEntity;
      workflowJson: Record<string, unknown>;
      workflowIr: Record<string, unknown> | null;
      commitMessage: string | null;
      author: string | null;
      actorId: string | null;
      eventType: string;
      parentOverride?: string | null;
      skipIrDiff?: boolean;
    },
  ): Promise<WorkflowVersionEntity> {
    const { wf, branch } = args;

    const maxRow = await rawQuery<{ max: number }>(
      em,
      `SELECT COALESCE(MAX(version_number), 0)::int AS max FROM workflow_versions
        WHERE workflow_id = $1 AND branch_id = $2`,
      [wf.id, branch.id],
    );
    const nextVersion = (maxRow[0]?.max ?? 0) + 1;

    // ir_diff vs previous head — best-effort, never blocks the write.
    let irDiffData: Record<string, unknown> | null = null;
    if (!args.skipIrDiff && branch.headVersionId && args.workflowIr) {
      const prev = await em.findOne(WorkflowVersionEntity, { where: { id: branch.headVersionId } });
      if (prev?.workflowIr) {
        try {
          irDiffData = jsonRecord(
            computeDiff(prev.workflowIr as unknown as WorkflowIR, args.workflowIr as unknown as WorkflowIR),
          );
        } catch {
          irDiffData = null;
        }
      }
    }

    const version = em.create(WorkflowVersionEntity, {
      id: newId(),
      workflowId: wf.id,
      versionNumber: nextVersion,
      workflowJson: args.workflowJson,
      workflowIr: args.workflowIr,
      irDiff: irDiffData,
      // Precedence: the user's words > a summary of the diff > nothing. Never numbered boilerplate.
      commitMessage: args.commitMessage ?? summarizeIrDiff(irDiffData, args.workflowIr) ?? null,
      author: args.author,
      branchId: branch.id,
      parentId: args.parentOverride !== undefined ? args.parentOverride : branch.headVersionId,
      createdAt: now(),
    });
    await em.save(WorkflowVersionEntity, version);

    branch.headVersionId = version.id;
    await em.save(WorkflowBranchEntity, branch);
    await this.branches.moveLatestTag(em, wf.id, version.id, branch.id);

    // Save ≠ Live: a commit advances the branch head + `latest` but NEVER the live pointer —
    // going live is the explicit Publish act (brand-new workflows excepted, which go live on create).

    await this.events.emit(em, {
      orgId: wf.orgId,
      actorUserId: args.actorId,
      type: args.eventType,
      subjectType: 'version',
      subjectId: version.id,
      payload: { branch: branch.name, version_number: nextVersion },
    });
    return version;
  }

  async lockBranchByName(em: EntityManager, workflowId: string, name: string): Promise<WorkflowBranchEntity> {
    const branch = await em
      .createQueryBuilder(WorkflowBranchEntity, 'b')
      .setLock('pessimistic_write')
      .where('b.workflow_id = :workflowId AND b.name = :name', { workflowId, name })
      .getOne();
    if (!branch) throw new DomainError(`Branch '${name}' not found`);
    return branch;
  }

  async lockBranchById(em: EntityManager, branchId: string): Promise<void> {
    await em
      .createQueryBuilder(WorkflowBranchEntity, 'b')
      .setLock('pessimistic_write')
      .where('b.id = :branchId', { branchId })
      .getOne();
  }
}
