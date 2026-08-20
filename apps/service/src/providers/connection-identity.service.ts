import { Injectable, Logger } from '@nestjs/common';

import { errorMessage } from '../common/error-message';
import { isRecord } from '../common/json-util';
import { ActionRouterProvider } from './action-router.provider';
import { type AccountIdentity } from '../connections/account-identity';

/**
 * WHICH account a connection is authorized against, asked of the provider itself.
 *
 * The connected-account metadata cannot answer it: Composio returns the account's identity fields
 * REDACTED (`team: {id: "REDACTED", name: "REDACTED"}`), so a healthy credential on the wrong
 * workspace looks exactly like one on the right workspace. Only the provider's own "who am I" call
 * settles it, so this runs on demand — never on every listing.
 */
interface IdentityProbe {
  actionId: string;
  props: Record<string, unknown>;
  /** Where the answer names the account, and where it identifies it; `a.b` reads one level down. */
  name: readonly string[];
  id: readonly string[];
}

/** A managed Google connection carries Drive scope — the spreadsheet picker lists Drive files. */
const GOOGLE_ACCOUNT: IdentityProbe = {
  actionId: 'drive.get_about',
  props: { fields: 'user' },
  name: ['user.emailAddress', 'user.displayName'],
  id: ['user.permissionId'],
};

/** Only apps whose probe has been run against a live connection belong here. */
const PROBES: ReadonlyMap<string, IdentityProbe> = new Map<string, IdentityProbe>([
  ['slack', { actionId: 'slack.fetch_team_info', props: {}, name: ['team.name'], id: ['team.id'] }],
  ['github', { actionId: 'github.get_the_authenticated_user', props: {}, name: ['login'], id: ['id'] }],
  ['sheets', GOOGLE_ACCOUNT],
  ['drive', GOOGLE_ACCOUNT],
]);

/** Long enough that opening a dialog is one call per connection, short enough that a re-auth surfaces. */
const IDENTITY_TTL_MS = 10 * 60 * 1000;

@Injectable()
export class ConnectionIdentityService {
  private readonly logger = new Logger(ConnectionIdentityService.name);
  private readonly cache = new Map<string, { at: number; identity: AccountIdentity | null }>();

  constructor(private readonly router: ActionRouterProvider) {}

  /** `null` when the app has no probe or the provider would not answer — never a guess. */
  async probe(userId: string, connectionId: string, provider: string): Promise<AccountIdentity | null> {
    const probe = PROBES.get(provider);
    if (!probe) return null;
    const cached = this.cache.get(connectionId);
    if (cached && Date.now() - cached.at < IDENTITY_TTL_MS) return cached.identity;
    try {
      const result = await this.router.runAction({
        externalUserId: userId,
        actionId: probe.actionId,
        props: { ...probe.props, connectionId },
        auth: { connectionId },
      });
      const identity = identityFrom(result.output, probe);
      this.cache.set(connectionId, { at: Date.now(), identity });
      return identity;
    } catch (err) {
      this.logger.warn(
        `Connection ${connectionId} (${provider}): identity probe failed: ${errorMessage(err)}`,
      );
      return null;
    }
  }

  /** Drop a cached answer — a reconnect can point the same row at a different account. */
  forget(connectionId: string): void {
    this.cache.delete(connectionId);
  }

  /** Whether this app can be asked at all — the caller says "unknown" rather than "no account". */
  canProbe(provider: string): boolean {
    return PROBES.has(provider);
  }
}

function read(body: Record<string, unknown>, path: string): string | null {
  const [head, tail] = path.split('.');
  if (head === undefined) return null;
  const top = body[head];
  const value = tail === undefined ? top : isRecord(top) ? top[tail] : undefined;
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return typeof value === 'number' ? String(value) : null;
}

function firstOf(body: Record<string, unknown>, paths: readonly string[]): string | null {
  for (const path of paths) {
    const value = read(body, path);
    if (value !== null) return value;
  }
  return null;
}

function identityFrom(output: unknown, probe: IdentityProbe): AccountIdentity | null {
  const body = isRecord(output) && isRecord(output.response_data) ? output.response_data : output;
  if (!isRecord(body)) return null;
  const name = firstOf(body, probe.name);
  const id = firstOf(body, probe.id);
  return name === null && id === null ? null : { name, id };
}
