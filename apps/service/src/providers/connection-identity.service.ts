import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { errorMessage } from '../common/error-message';
import { type AccountIdentity } from '../connections/account-identity';
import { type ActivatedConnection, ConnectionsService } from '../connections/connections.service';
import { accountProbeFor, type AccountTarget } from './account-probes';
import { ActionRouterProvider } from './action-router.provider';

/** How long a just-completed connect waits for the answer; a slower one still lands, just after the connect returns. */
const ACTIVATION_WAIT_MS = 5_000;

/** Asks a connection's provider which account it is when the connection becomes usable, and answers from what it said. */
@Injectable()
export class ConnectionIdentityService implements OnModuleInit {
  private readonly logger = new Logger(ConnectionIdentityService.name);
  private readonly inflight = new Map<string, Promise<AccountIdentity | null>>();

  constructor(
    private readonly router: ActionRouterProvider,
    private readonly connections: ConnectionsService,
  ) {}

  onModuleInit(): void {
    this.connections.onActivated((connection) => this.askOnActivation(connection));
  }

  /** The stored answer, asking the provider when it never has been or `refresh` is set; null when it can't or won't say. */
  async account(target: AccountTarget, refresh: boolean): Promise<AccountIdentity | null> {
    if (!refresh) {
      const stored = await this.connections.accountOf(target.ownerUserId, target.connectionId);
      if (stored?.checkedAt) return stored.account;
    }
    return this.ask(target);
  }

  /** Whether this app can be asked at all — the caller says "unknown" rather than "no account". */
  canProbe(provider: string): boolean {
    return accountProbeFor(provider) !== undefined;
  }

  private ask(target: AccountTarget): Promise<AccountIdentity | null> {
    const pending = this.inflight.get(target.connectionId);
    if (pending) return pending;
    const asking = this.router
      .refreshAccount(target)
      .catch((err: unknown) => {
        this.logger.warn(
          `Connection ${target.connectionId} (${target.provider}): identity probe failed: ${errorMessage(err)}`,
        );
        return null;
      })
      .finally(() => this.inflight.delete(target.connectionId));
    this.inflight.set(target.connectionId, asking);
    return asking;
  }

  private async askOnActivation(connection: ActivatedConnection): Promise<void> {
    if (!this.canProbe(connection.provider)) return;
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ACTIVATION_WAIT_MS);
    });
    try {
      await Promise.race([
        this.ask({
          connectionId: connection.id,
          ownerUserId: connection.ownerUserId,
          provider: connection.provider,
          orgId: connection.orgId,
        }),
        waited,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
