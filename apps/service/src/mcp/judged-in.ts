import { DomainError } from '../common/domain-error';
import type { AuthoringScope } from '../compose/compose-catalog.service';
import type { WorkflowAccessService } from '../workflows/workflow-access.service';
import type { McpCallContext } from './mcp-tool';

/** Where a tool judges a document: `workflowId`'s workspace when the caller can read it, as its commit is judged; otherwise the caller's, as a create is. */
export async function judgedIn(
  access: WorkflowAccessService,
  ctx: McpCallContext,
  workflowId: string | undefined,
): Promise<AuthoringScope> {
  const caller = { userId: ctx.principal.user.id, orgId: ctx.principal.activeOrgId };
  if (workflowId === undefined) return caller;
  try {
    await access.require(ctx.principal, workflowId, 'read');
  } catch (err) {
    // An unreadable id reads as an absent one: it confirms nothing.
    if (err instanceof DomainError && err.status === 404) return caller;
    throw err;
  }
  return { workflowId };
}
