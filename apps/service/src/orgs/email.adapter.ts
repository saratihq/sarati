import { Injectable, Logger } from '@nestjs/common';

export interface OrgInviteEmail {
  to: string;
  orgName: string;
  role: string;
  /** Client-side accept URL carrying the invite token. */
  inviteLink: string;
}

/** Outbound-mail seam: the default implementation only logs the link — a real provider replaces the binding. */
export interface EmailAdapter {
  sendOrgInvite(message: OrgInviteEmail): Promise<void>;
}

export const EMAIL_ADAPTER = Symbol('EMAIL_ADAPTER');

@Injectable()
export class ConsoleEmailAdapter implements EmailAdapter {
  private readonly logger = new Logger('EmailAdapter');

  sendOrgInvite(message: OrgInviteEmail): Promise<void> {
    this.logger.log(
      `invite link for ${message.to} (${message.role} of "${message.orgName}"): ${message.inviteLink}`,
    );
    return Promise.resolve();
  }
}
