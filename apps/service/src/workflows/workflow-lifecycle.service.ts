import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import type { Principal } from '../auth/principal';
import { DomainError } from '../common/domain-error';
import { newId, now } from '../database/ids';
import { rawQuery } from '../database/raw-query';
import { WorkflowBranchEntity } from '../database/entities/workflow-branch.entity';
import { WorkflowEntity } from '../database/entities/workflow.entity';
import { WorkflowVersionEntity } from '../database/entities/workflow-version.entity';
import { WorkflowVersionTagEntity } from '../database/entities/workflow-version-tag.entity';
import { EventsService } from '../events/events.service';
import { lintDataRefs } from '../compiler/ref-lint';
import { assertAuthoredIrValid } from '../compose/author-validation';
import { ComposeCatalogService } from '../compose/compose-catalog.service';
import { EnvPointersService, PROD_ENV } from './env-pointers.service';
import { VersionsWriteService } from './versions-write.service';

/** What a caller must say to create a workflow; `irDoc` is the v1 document. */
export interface DraftCreateInput {
  /** The creator: identity, and the tenancy the workflow is attributed to (`activeOrgId`). */
  principal: Principal;
  name: string;
  description?: string | null;
  irDoc: Record<string, unknown>;
  commitMessage?: string | null;
}

/** A created draft: its workflow, the default branch it lives on, and its v1. */
export interface DraftCreateResult {
  workflow: WorkflowEntity;
  branchName: string;
  version: WorkflowVersionEntity;
  refWarnings: string[];
}

/** Workflow lifecycle: create from an IR document, delete, metadata save, tenancy attribution. */
@Injectable()
export class WorkflowLifecycleService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly versionsWrite: VersionsWriteService,
    private readonly envPointers: EnvPointersService,
    private readonly events: EventsService,
    private readonly catalog: ComposeCatalogService,
  ) {}

  /**
   * Create a workflow as a DRAFT: v1 is minted by the ONE commit path, so it faces the same
   * author-time gate as every other version, and nothing goes live — release stays the explicit
   * Publish act (invariant #2).
   */
  async createDraft(input: DraftCreateInput): Promise<DraftCreateResult> {
    const { user, activeOrgId: orgId } = input.principal;
    // The gate runs before anything is written, so a refused document leaves no empty workflow behind.
    assertAuthoredIrValid(input.irDoc, this.catalog.facts());

    const { wf, branchName } = await this.dataSource.transaction(async (em) => {
      const created = em.create(WorkflowEntity, {
        id: newId(),
        name: input.name,
        description: input.description ?? '',
        userId: user.id,
        orgId,
        source: 'generated',
        createdAt: now(),
        updatedAt: now(),
      });
      await em.save(WorkflowEntity, created);
      const branch = await this.versionsWrite.ensureDefaultBranch(em, created);
      await this.events.emit(em, {
        orgId,
        actorUserId: user.id,
        type: 'workflow.created',
        subjectType: 'workflow',
        subjectId: created.id,
        payload: { name: input.name, activated: false },
      });
      return { wf: created, branchName: branch.name };
    });

    const { version, refWarnings } = await this.versionsWrite.commit({
      workflowId: wf.id,
      workflowIr: input.irDoc,
      branchName,
      commitMessage: input.commitMessage ?? 'Initial version',
      author: user.name,
      actorId: user.id,
      principal: input.principal,
    });
    return { workflow: wf, branchName, version, refWarnings };
  }

  /** Create a workflow from an IR document; v1 goes live on create (the one exception to Save ≠ Live). */
  async deployCreateOnOrchestr(
    userId: string,
    orgId: string | null,
    irDoc: Record<string, unknown>,
    author?: string | null,
  ): Promise<Record<string, unknown>> {
    if (!Array.isArray(irDoc.nodes) || irDoc.nodes.length === 0) {
      throw new DomainError('workflow_json must be a WorkflowIR document with a non-empty nodes array');
    }
    // This route mints a version AND makes it live, so it faces the same author-time gate as commit —
    // otherwise a document refused at save is accepted straight into production here.
    assertAuthoredIrValid(irDoc, this.catalog.facts());
    const name = typeof irDoc.name === 'string' && irDoc.name ? irDoc.name : 'Generated Workflow';

    return this.dataSource.transaction(async (em) => {
      const wf = em.create(WorkflowEntity, {
        id: newId(),
        name,
        description: '',
        userId,
        orgId,
        source: 'generated',
        createdAt: now(),
        updatedAt: now(),
      });
      await em.save(WorkflowEntity, wf);

      const branch = await this.versionsWrite.ensureDefaultBranch(em, wf);
      const version = em.create(WorkflowVersionEntity, {
        id: newId(),
        workflowId: wf.id,
        versionNumber: 1,
        workflowJson: irDoc,
        workflowIr: irDoc,
        commitMessage: 'Initial version',
        author: author ?? null,
        branchId: branch.id,
        createdAt: now(),
      });
      await em.save(WorkflowVersionEntity, version);

      wf.activeVersionId = version.id;
      branch.headVersionId = version.id;
      await em.save(WorkflowEntity, wf);
      await em.save(WorkflowBranchEntity, branch);
      await this.envPointers.setPointer(em, wf.id, PROD_ENV, version.id);

      await em.save(
        em.create(WorkflowVersionTagEntity, {
          id: newId(),
          workflowId: wf.id,
          versionId: version.id,
          tag: 'latest',
          branchId: branch.id,
          activated: true,
          createdAt: now(),
        }),
      );

      await this.events.emit(em, {
        orgId,
        actorUserId: userId,
        type: 'workflow.created',
        subjectType: 'workflow',
        subjectId: wf.id,
        payload: { deployed: true, activated: true },
      });

      return {
        workflow_id: wf.id,
        workflow_url: '',
        name,
        version_number: 1,
        activated: true, // immediately runnable — there is no external activation step
        activation_error: null,
        // Broken data refs surface at save, not at run time.
        ref_warnings: lintDataRefs(irDoc),
      };
    });
  }

  async deleteWorkflow(workflowId: string, actorId: string | null): Promise<Record<string, unknown>> {
    const em = this.dataSource.manager;
    const wf = await em.findOne(WorkflowEntity, { where: { id: workflowId } });
    if (!wf) throw new DomainError(`Workflow ${workflowId} not found`, 404);

    await this.dataSource.transaction(async (tx) => {
      // The circular FKs must be broken before the cascade delete.
      await tx.query(
        `UPDATE workflows SET active_version_id = NULL, default_branch_id = NULL WHERE id = $1`,
        [wf.id],
      );
      await tx.query(`UPDATE workflow_branches SET head_version_id = NULL WHERE workflow_id = $1`, [wf.id]);
      await tx.query(`DELETE FROM workflows WHERE id = $1`, [wf.id]);
      await this.events.emit(tx, {
        orgId: wf.orgId,
        actorUserId: actorId,
        type: 'workflow.deleted',
        subjectType: 'workflow',
        subjectId: wf.id,
        payload: { name: wf.name },
      });
    });

    return { status: 'deleted' };
  }

  /** Metadata-only save (name/description). */
  async saveWorkflowMeta(wf: WorkflowEntity): Promise<void> {
    wf.updatedAt = now();
    await this.dataSource.manager.save(WorkflowEntity, wf);
  }

  /** The caller's personal-org id (tenancy attribution for new workflows). */
  async personalOrgIdOf(userId: string): Promise<string | null> {
    const rows = await rawQuery<{ id: string }>(
      this.dataSource.manager,
      `SELECT o.id FROM organizations o
         JOIN org_members m ON m.org_id = o.id
        WHERE m.user_id = $1 AND o.is_personal = true LIMIT 1`,
      [userId],
    );
    return rows[0]?.id ?? null;
  }
}
