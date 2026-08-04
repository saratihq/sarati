import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { isRecord } from '../common/json-util';
import { rawQuery } from '../database/raw-query';
import { AGENT_TOOL_PUBLIC } from '../triggers/trigger-catalog.service';

/** Platform tools own this prefix, so a workflow can never shadow one. */
const RESERVED_PREFIX = 'orchestr_';

/** One published workflow, as an agent sees it. */
export interface WorkflowTool {
  workflowId: string;
  name: string;
  description: string;
  inputs: WorkflowToolInput[];
}

export interface WorkflowToolInput {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object';
  description: string;
  required: boolean;
}

const TYPES = new Set(['string', 'number', 'boolean', 'object']);

/** A tool name an agent can actually call: lowercase, underscore-joined, never shadowing a platform tool. */
export function toolNameOf(raw: unknown, fallback: string): string | null {
  const source = typeof raw === 'string' && raw.trim() ? raw : fallback;
  const name = source
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  if (!name || /^\d/.test(name)) return null;
  // Refused rather than silently renamed: an author who picks a reserved name should find out,
  // not discover their tool answering to something else.
  return name.startsWith(RESERVED_PREFIX.replace(/_$/, '')) ? null : name;
}

/** The declared arguments; anything malformed is dropped rather than published as a broken schema. */
function inputsOf(raw: unknown): WorkflowToolInput[] {
  const declared = Array.isArray(raw) ? raw : parseJson(raw);
  return declared.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name.trim()) return [];
    const type = typeof entry.type === 'string' ? entry.type.toLowerCase() : 'string';
    return [
      {
        name: entry.name.trim(),
        type: (TYPES.has(type) ? type : 'string') as WorkflowToolInput['type'],
        description: typeof entry.description === 'string' ? entry.description : '',
        required: entry.required === true,
      },
    ];
  });
}

function parseJson(raw: unknown): unknown[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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

    const parameters = isRecord(trigger.parameters) ? trigger.parameters : {};
    const name = toolNameOf(parameters.tool_name, row.workflow_name);
    const description = typeof parameters.description === 'string' ? parameters.description.trim() : '';
    // A model chooses a tool on its description alone, so an undescribed one is not offered.
    if (!name || !description) return null;

    return {
      workflowId: row.workflow_id,
      name,
      description,
      inputs: inputsOf(parameters.inputs),
    };
  }
}
