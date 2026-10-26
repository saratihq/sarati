import { Injectable, Logger } from '@nestjs/common';

export interface OrgInviteEmail {
  to: string;
  orgName: string;
  role: string;
  /** Client-side accept URL carrying the invite token. */
  inviteLink: string;
}

/** Outbound-mail seam: the default implementation sends nothing, since the inviter copies the link from Settings — a real provider replaces the binding. */
export interface EmailAdapter {
  sendOrgInvite(message: OrgInviteEmail): Promise<void>;
}

export const EMAIL_ADAPTER = Symbol('EMAIL_ADAPTER');

/** Logs that an invite went unsent, never its link or address, which together admit a new account. */
@Injectable()
export class ConsoleEmailAdapter implements EmailAdapter {
  private readonly logger = new Logger('EmailAdapter');

  sendOrgInvite(message: OrgInviteEmail): Promise<void> {
    this.logger.log(
      `No mail provider is configured, so the ${message.role} invite to "${message.orgName}" was not emailed; its link is in the organization's settings`,
    );
    return Promise.resolve();
  }
}
