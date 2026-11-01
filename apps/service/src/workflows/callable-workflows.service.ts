import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { rawQuery } from '../database/raw-query';
import { contractOfDocument } from '../runtime/workflow-tool-contract';
import type { WorkflowToolInput } from '../runtime/workflow-tool-contract';

export type { WorkflowToolInput };

/** One workflow that DECLARES itself callable, as a caller sees it. */
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

/** Which of an org's workflows can be called: those whose production-live version has an `orchestr:tool_trigger` with a description and a usable tool name — the one source for the editor's picker and the MCP tool list, which also drops a name two of them share. */
@Injectable()
export class CallableWorkflowsService {
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
    const contract = contractOfDocument(row.document, row.workflow_name);
    return contract ? { workflowId: row.workflow_id, ...contract } : null;
  }
}
