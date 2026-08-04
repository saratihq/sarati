import { Controller, Get, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { OrgManagementService } from './org-management.service';

/**
 * Reading an invite is unauthenticated by necessity: on a self-hosted instance the invitee has no
 * account yet (ADR 0054), so they must be able to see WHICH org they are joining before creating one.
 * The token is the capability, and the response deliberately omits the invitee's email.
 */
@Controller('api/orgs/invites')
export class InvitePreviewController {
  constructor(private readonly mgmt: OrgManagementService) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':token')
  preview(@Param('token') token: string): Promise<Record<string, unknown>> {
    return this.mgmt.previewInvite(token);
  }
}
