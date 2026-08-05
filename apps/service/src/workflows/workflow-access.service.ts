import { Injectable } from '@nestjs/common';

import { DomainError } from '../common/domain-error';
import type { WorkflowEntity } from '../database/entities/workflow.entity';
import type { Principal } from '../auth/principal';
import { PolicyService, type PolicyAction } from '../policy/policy.service';
import { WorkflowsReadService } from './workflows-read.service';

/**
 * The ONE place a route decides whether a caller may touch a workflow, and what to say when they may
 * not. Reachability is answered before capability, so a workflow the caller cannot read is
 * indistinguishable from one that does not exist — a bare id must never confirm itself. Being able to
 * read it but not to act is a different answer: 403, naming the thing they cannot do.
 */
@Injectable()
export class WorkflowAccessService {
  constructor(
    private readonly reads: WorkflowsReadService,
    private readonly policy: PolicyService,
  ) {}

  async require(principal: Principal, workflowId: string, action: PolicyAction): Promise<WorkflowEntity> {
    const wf = await this.reads.getWorkflowEntity(workflowId);
    const subject = { orgId: wf.orgId, ownerUserId: wf.userId };

    if (!(await this.policy.can(principal, 'read', subject))) {
      throw new DomainError(`Workflow ${workflowId} not found`, 404);
    }
    if (action !== 'read' && !(await this.policy.can(principal, action, subject))) {
      throw new DomainError(`Not authorised to ${action} this workflow`, 403);
    }
    return wf;
  }
}
