import { Controller, Get, HttpException, Param, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { requirePrincipal } from '../auth/principal';
import { Scope } from '../auth/scope.decorator';
import { type AccountIdentity, describeAccount } from '../connections/account-identity';
import { ConnectionsService } from '../connections/connections.service';
import { ConnectionIdentityService } from './connection-identity.service';

/** What a connection is authorized against — asked of the provider, so it cannot be stale. */
export interface ConnectionAccountResult {
  /** null when the provider was not asked (no probe for this app) or would not answer. */
  account: AccountIdentity | null;
  /** Plain language for the connections list; never invents an account. */
  detail: string;
}

/**
 * Lives beside the execution rail rather than in the connections module: answering "which account"
 * means running the provider's own who-am-I through the action router, and the router already
 * depends on connections.
 */
@Controller('api/connections')
@UseGuards(AuthGuard)
export class ConnectionAccountController {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly identity: ConnectionIdentityService,
  ) {}

  @Scope('connection:read')
  @Get(':id/account')
  async account(@Req() req: Request, @Param('id') id: string): Promise<ConnectionAccountResult> {
    const userId = requirePrincipal(req).user.id;
    const summary = (await this.connections.list(userId)).find((row) => row.id === id);
    if (!summary) throw new HttpException({ detail: 'Connection not found' }, 404);
    if (!this.identity.canProbe(summary.provider)) {
      return { account: null, detail: `Sarati cannot yet ask ${summary.provider} which account this is.` };
    }
    const account = await this.identity.probe(userId, id, summary.provider);
    return {
      account,
      detail: account
        ? `Authorized against ${describeAccount(account)}.`
        : `${summary.provider} would not say which account this is.`,
    };
  }
}
