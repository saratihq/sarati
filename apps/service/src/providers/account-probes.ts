import { isRecord } from '../common/json-util';
import { type AccountIdentity } from '../connections/account-identity';

/**
 * WHICH account a connection is authorized against, asked of the provider itself.
 *
 * The connected-account metadata cannot answer it: Composio returns the account's identity fields
 * REDACTED (`team: {id: "REDACTED", name: "REDACTED"}`), so a healthy credential on the wrong
 * workspace looks exactly like one on the right workspace. Only the provider's own "who am I" call
 * settles it.
 */
export interface AccountProbe {
  actionId: string;
  props: Record<string, unknown>;
  subject: AccountIdentity['subject'];
  /** Where the answer gives each field, first hit wins; `a.b` reads one level down. */
  name: readonly string[];
  id: readonly string[];
  email: readonly string[];
  handle: readonly string[];
}

/** The connection to ask about, run as its owner under the org whose Composio project brokers it. */
export interface AccountTarget {
  connectionId: string;
  ownerUserId: string;
  provider: string;
  orgId: string | null;
}

/** A managed Google connection carries Drive scope — the spreadsheet picker lists Drive files. */
const GOOGLE_ACCOUNT: AccountProbe = {
  actionId: 'drive.get_about',
  props: { fields: 'user' },
  subject: 'user',
  name: ['user.displayName'],
  id: ['user.permissionId'],
  email: ['user.emailAddress'],
  handle: [],
};

/** Only apps whose probe has been run against a live connection belong here. */
const PROBES: ReadonlyMap<string, AccountProbe> = new Map<string, AccountProbe>([
  [
    'slack',
    {
      actionId: 'slack.fetch_team_info',
      props: {},
      subject: 'workspace',
      name: ['team.name'],
      id: ['team.id'],
      email: [],
      handle: [],
    },
  ],
  [
    'github',
    {
      actionId: 'github.get_the_authenticated_user',
      props: {},
      subject: 'user',
      name: ['name'],
      id: ['id'],
      email: ['email'],
      handle: ['login'],
    },
  ],
  [
    'gmail',
    {
      actionId: 'gmail.get_profile',
      props: {},
      subject: 'user',
      name: [],
      id: ['emailAddress'],
      email: ['emailAddress'],
      handle: [],
    },
  ],
  ['sheets', GOOGLE_ACCOUNT],
  ['drive', GOOGLE_ACCOUNT],
]);

export function accountProbeFor(provider: string): AccountProbe | undefined {
  return PROBES.get(provider);
}

/** The identity a probe's answer names, or null rather than half an answer when it names nothing. */
export function identityFrom(output: unknown, probe: AccountProbe): AccountIdentity | null {
  const body = isRecord(output) && isRecord(output.response_data) ? output.response_data : output;
  if (!isRecord(body)) return null;
  const identity: AccountIdentity = {
    subject: probe.subject,
    name: firstOf(body, probe.name),
    id: firstOf(body, probe.id),
    email: firstOf(body, probe.email),
    handle: firstOf(body, probe.handle),
  };
  const named = [identity.name, identity.id, identity.email, identity.handle].some((v) => v !== null);
  return named ? identity : null;
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
