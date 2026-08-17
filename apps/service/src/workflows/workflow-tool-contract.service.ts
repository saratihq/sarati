import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { WorkflowEntity } from '../database/entities/workflow.entity';
import { WorkflowVersionEntity } from '../database/entities/workflow-version.entity';
import type { AgentWorkflowCatalog, JsonSchema } from '../runtime/agent';
import { contractOfDocument, schemaOf } from '../runtime/workflow-tool-contract';
import { EnvPointersService } from './env-pointers.service';

/**
 * The contract a sub-workflow declares about being called, read from the version the CALLER's
 * environment runs — the same version the runner will execute, so what a model is offered and what
 * actually runs can never be two different documents (ADR 0053 §1, ADR 0062). Committing cannot
 * change it; promoting can.
 */
@Injectable()
export class WorkflowToolContractService implements AgentWorkflowCatalog {
  constructor(
    private readonly envPointers: EnvPointersService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async describeWorkflow(
    workflowId: string,
    environmentId: string | null,
  ): Promise<{ description: string; parameters: JsonSchema } | undefined> {
    const em = this.dataSource.manager;
    const wf = await em.findOne(WorkflowEntity, { where: { id: workflowId } });
    if (!wf) return undefined;

    const versionId = await this.envPointers.resolveVersionIdForCaller(em, wf, environmentId);
    if (!versionId) return undefined;

    const version = await em.findOne(WorkflowVersionEntity, { where: { id: versionId } });
    if (!version) return undefined;

    const contract = contractOfDocument(version.workflowIr ?? version.workflowJson, wf.name);
    if (!contract) return undefined;

    return { description: contract.description, parameters: schemaOf(contract.inputs) };
  }
}
