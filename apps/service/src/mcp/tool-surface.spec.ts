import { z } from 'zod';

import { API_SCOPES } from '../auth/scopes';
import { CommitTool } from './tools/commit.tool';
import { ContextTool } from './tools/context.tool';
import { CreateBranchTool } from './tools/create-branch.tool';
import { CreateWorkflowTool } from './tools/create-workflow.tool';
import { DescribeActionTool } from './tools/describe-action.tool';
import { DiffTool } from './tools/diff.tool';
import { EditWorkflowTool } from './tools/edit-workflow.tool';
import { GetRunTool } from './tools/get-run.tool';
import { GetWorkflowTool } from './tools/get-workflow.tool';
import { ListConnectionsTool } from './tools/list-connections.tool';
import { ListWorkflowsTool } from './tools/list-workflows.tool';
import { OpenReviewTool } from './tools/open-review.tool';
import { SearchActionsTool } from './tools/search-actions.tool';
import { TestWorkflowTool } from './tools/test-workflow.tool';
import { ValidateTool } from './tools/validate.tool';
import type { McpTool } from './mcp-tool';

/** Declarations only — the injected services are never touched, so undefined stands in for them. */
const construct = (Tool: abstract new (...args: never[]) => McpTool): McpTool =>
  new (Tool as unknown as new (...args: unknown[]) => McpTool)(undefined, undefined, undefined);

const TOOLS = [
  ContextTool,
  SearchActionsTool,
  DescribeActionTool,
  ListWorkflowsTool,
  GetWorkflowTool,
  DiffTool,
  GetRunTool,
  ListConnectionsTool,
  ValidateTool,
  EditWorkflowTool,
  CreateWorkflowTool,
  CommitTool,
  CreateBranchTool,
  OpenReviewTool,
  TestWorkflowTool,
].map(construct);

const byName = [...TOOLS].sort((a, b) => a.name.localeCompare(b.name));

/** Tools that persist nothing — every other one is a write and must not claim to be read-only. */
const PURE = new Set([
  'orchestr_context',
  'orchestr_describe_action',
  'orchestr_diff',
  'orchestr_edit_workflow',
  'orchestr_get_run',
  'orchestr_get_workflow',
  'orchestr_list_connections',
  'orchestr_list_workflows',
  'orchestr_search_actions',
  'orchestr_validate',
]);

/** Calling these twice is refused, so a client must never retry them as if they were safe. */
const NOT_IDEMPOTENT = new Set(['orchestr_create_branch', 'orchestr_open_review', 'orchestr_test_workflow']);

/** The one tool that can reach a third-party system, and the only one allowed to say so. */
const TOUCHES_THE_WORLD = 'orchestr_test_workflow';

/**
 * The tool surface is a published contract (ADR 0052) — a client caches it and a model is prompted
 * against it. Every line here is a promise; changing one is an ADR-level decision, not a refactor.
 */
describe('MCP tool surface', () => {
  it('is exactly the v1 surface, in a stable order', () => {
    expect(byName.map((tool) => tool.name)).toEqual([
      'orchestr_commit',
      'orchestr_context',
      'orchestr_create_branch',
      'orchestr_create_workflow',
      'orchestr_describe_action',
      'orchestr_diff',
      'orchestr_edit_workflow',
      'orchestr_get_run',
      'orchestr_get_workflow',
      'orchestr_list_connections',
      'orchestr_list_workflows',
      'orchestr_open_review',
      'orchestr_search_actions',
      'orchestr_test_workflow',
      'orchestr_validate',
    ]);
  });

  it('maps every tool to the scope that gates it', () => {
    expect(Object.fromEntries(byName.map((tool) => [tool.name, tool.scope]))).toEqual({
      orchestr_commit: 'workflow:write',
      orchestr_context: 'workflow:read',
      orchestr_create_branch: 'workflow:write',
      orchestr_create_workflow: 'workflow:write',
      orchestr_describe_action: 'workflow:read',
      orchestr_diff: 'workflow:read',
      orchestr_edit_workflow: 'workflow:write',
      orchestr_get_run: 'workflow:read',
      orchestr_get_workflow: 'workflow:read',
      orchestr_list_connections: 'connection:read',
      orchestr_list_workflows: 'workflow:read',
      orchestr_open_review: 'workflow:write',
      orchestr_search_actions: 'workflow:read',
      orchestr_test_workflow: 'run:dry',
      orchestr_validate: 'workflow:read',
    });
  });

  it('declares a scope that exists', () => {
    for (const tool of byName) expect(API_SCOPES).toContain(tool.scope);
  });

  /** No v1 tool deploys, promotes, merges or runs — those routes are annotated so no MCP key holds them. */
  it('grants no tool a scope that could move what is live', () => {
    for (const tool of byName) {
      expect(['workflow:deploy', 'connection:write', 'org:manage', 'key:manage']).not.toContain(tool.scope);
    }
  });

  it('claims read-only exactly for the tools that persist nothing', () => {
    for (const tool of byName) {
      expect([tool.name, tool.annotations.readOnlyHint]).toEqual([tool.name, PURE.has(tool.name)]);
    }
  });

  it('never claims idempotence for a call that is refused on repeat', () => {
    for (const tool of byName) {
      expect([tool.name, tool.annotations.idempotentHint]).toEqual([
        tool.name,
        !NOT_IDEMPOTENT.has(tool.name),
      ]);
    }
  });

  /** Only the tool that actually fires side effects may warn about them — otherwise the warning is noise. */
  it('marks exactly one tool destructive and open-world', () => {
    for (const tool of byName) {
      const touches = tool.name === TOUCHES_THE_WORLD;
      expect([tool.name, tool.annotations.destructiveHint]).toEqual([tool.name, touches]);
      expect([tool.name, tool.annotations.openWorldHint]).toEqual([tool.name, touches]);
    }
  });

  /** Firing for real is a second capability, so the tool a preview-only key sees is gated on `run:dry`. */
  it('gates the executing tool on run:dry, never on run:execute alone', () => {
    const tool = byName.find((t) => t.name === TOUCHES_THE_WORLD);
    expect(tool?.scope).toBe('run:dry');
    const json = JSON.stringify(z.toJSONSchema(tool!.inputSchema, { io: 'output' }));
    expect(json).toContain('confirmation_token');
    expect(json).toContain('dry_run');
  });

  it('describes itself well enough for a model to choose it unprompted', () => {
    for (const tool of byName) {
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });

  it('carries object-shaped input and output schemas that render to JSON Schema', () => {
    for (const tool of byName) {
      for (const schema of [tool.inputSchema, tool.outputSchema]) {
        const json = z.toJSONSchema(schema, { io: 'output' }) as { type?: string };
        expect(json.type).toBe('object');
      }
    }
  });

  /** The note lives in the text block and `_meta`; declaring it here would be a field we never send. */
  it('never declares a truncation_note the presentation layer does not fill', () => {
    for (const tool of byName) {
      const json = JSON.stringify(z.toJSONSchema(tool.outputSchema, { io: 'output' }));
      expect(json).not.toContain('truncation_note');
    }
  });

  /** Save ≠ live (invariant #2): a write tool says so in its own output rather than leaving it implied. */
  it('makes every landing tool state that it did not publish anything', () => {
    for (const name of ['orchestr_commit', 'orchestr_create_workflow']) {
      const tool = byName.find((t) => t.name === name);
      const json = JSON.stringify(z.toJSONSchema(tool!.outputSchema, { io: 'output' }));
      expect(json).toContain('is_live');
    }
  });
});
