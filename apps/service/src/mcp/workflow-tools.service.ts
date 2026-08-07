import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { isRecord } from '../common/json-util';
import { contractOf } from '../runtime/workflow-tool-contract';
import type { WorkflowToolInput } from '../runtime/workflow-tool-contract';
import { rawQuery } from '../database/raw-query';
import { AGENT_TOOL_PUBLIC } from '../triggers/trigger-catalog.service';

export { toolNameOf } from '../runtime/workflow-tool-contract';
export type { WorkflowToolInput };

/** One published workflow, as an agent sees it. */
export interface WorkflowTool {
  workflowId: string;
  name: string;
  description: string;
  inputs: WorkflowToolInput[];
}

interface PublishedRow {
  workflow_id: string;
  workflow_name: string;
  document: Record<string, unknown> | null;
}

/**
 * Which of an org's workflows are callable as tools (ADR 0053): the ones whose PRODUCTION-live
 * version carries an `orchestr:tool_trigger`. Built from environment pointers, so committing never
 * changes what an agent can call — only publishing does.
 */
@Injectable()
export class WorkflowToolsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async listFor(orgId: string | null): Promise<WorkflowTool[]> {
    if (!orgId) return [];
    const rows = await rawQuery<PublishedRow>(
      this.dataSource.manager,
      `SELECT w.id AS workflow_id,
              w.name AS workflow_name,
              COALESCE(v.workflow_ir, v.workflow_json) AS document
         FROM workflows w
         JOIN environments e ON e.org_id = w.org_id AND e.is_prod = true
         JOIN workflow_env_pointers p ON p.workflow_id = w.id AND p.environment_id = e.id
         JOIN workflow_versions v ON v.id = p.version_id
        WHERE w.org_id = $1
        ORDER BY w.name`,
      [orgId],
    );
    return rows.flatMap((row) => this.toolOf(row) ?? []);
  }

  private toolOf(row: PublishedRow): WorkflowTool | null {
    const nodes = Array.isArray(row.document?.nodes) ? row.document.nodes : [];
    const trigger = nodes.filter(isRecord).find((node) => node.node_type === AGENT_TOOL_PUBLIC);
    if (!trigger) return null;

    const contract = contractOf(trigger.parameters, row.workflow_name);
    if (!contract) return null;

    return { workflowId: row.workflow_id, ...contract };
  }
}
