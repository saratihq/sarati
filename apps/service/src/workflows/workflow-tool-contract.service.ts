import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { isRecord } from '../common/json-util';
import { rawQuery } from '../database/raw-query';
import type { AgentWorkflowCatalog, JsonSchema } from '../runtime/agent';
import { contractOf, schemaOf } from '../runtime/workflow-tool-contract';
import { AGENT_TOOL_PUBLIC } from '../triggers/trigger-catalog.service';

interface PublishedRow {
  workflow_name: string;
  document: Record<string, unknown> | null;
}

/**
 * The contract a sub-workflow declares about being called as a tool, read from the version LIVE in
 * production — the same source the MCP tool list reads, so an in-workflow agent and an external
 * client are offered the same tool (ADR 0053 §1). Committing cannot change it; publishing can.
 */
@Injectable()
export class WorkflowToolContractService implements AgentWorkflowCatalog {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async describeWorkflow(
    workflowId: string,
  ): Promise<{ description: string; parameters: JsonSchema } | undefined> {
    const rows = await rawQuery<PublishedRow>(
      this.dataSource.manager,
      `SELECT w.name AS workflow_name,
              COALESCE(v.workflow_ir, v.workflow_json) AS document
         FROM workflows w
         JOIN environments e ON e.org_id = w.org_id AND e.is_prod = true
         JOIN workflow_env_pointers p ON p.workflow_id = w.id AND p.environment_id = e.id
         JOIN workflow_versions v ON v.id = p.version_id
        WHERE w.id = $1`,
      [workflowId],
    );
    const row = rows[0];
    if (!row) return undefined;

    const nodes = Array.isArray(row.document?.nodes) ? row.document.nodes : [];
    const trigger = nodes.filter(isRecord).find((node) => node.node_type === AGENT_TOOL_PUBLIC);
    if (!trigger) return undefined;

    const contract = contractOf(trigger.parameters, row.workflow_name);
    if (!contract) return undefined;

    return { description: contract.description, parameters: schemaOf(contract.inputs) };
  }
}
