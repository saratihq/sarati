import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import { ADMISSION_LOCK_SPACE } from '../auth/local/admission-lock';
import {
  isClerkUserId,
  UNCONNECTED_ACCOUNTS_SQL,
  type UnconnectedAccount,
} from '../auth/oidc/unconnected-accounts';
import { errorMessage } from '../common/error-message';

const USAGE = `Usage:
  pnpm auth:link-sso --list                      accounts not connected to OIDC_ISSUER that signed in some other way
  pnpm auth:link-sso <email|account id> [<sub>]  connect one — to <sub>, or to the subject the retired token sign-in stored
  pnpm auth:link-sso --all                       connect every account the retired token sign-in made to the subject it stored
Add --move to take <sub> off an account a first sign-in made by mistake.`;

const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Account {
  id: string;
  email: string;
  clerk_user_id: string | null;
}

// `pnpm auth:link-sso …`: shell access to the box is the proof that an account is that subject at OIDC_ISSUER.
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const move = args.includes('--move');
  const [who, subject, ...extra] = args.filter((arg) => arg !== '--move');
  const listing = who === '--list' || who === '--all';
  if (!who || extra.length > 0 || (listing && (subject !== undefined || move))) fail(USAGE);

  const url = process.env.DATABASE_URL;
  if (!url) fail('DATABASE_URL is not set — run this where the service runs.');
  const issuer = process.env.OIDC_ISSUER?.trim();
  if (!issuer)
    fail('OIDC_ISSUER is not set — run this where the service runs, with single sign-on configured.');

  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    if (who === '--list') return await list(db, issuer);
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock($1, 0)', [ADMISSION_LOCK_SPACE]);
    if (who === '--all') await linkAll(db, issuer);
    else await linkOne(db, issuer, await accountOf(db, who.trim()), subject?.trim(), move);
    await db.query('COMMIT');
  } finally {
    await db.end();
  }
}

async function list(db: Client, issuer: string): Promise<void> {
  const { rows } = await db.query<UnconnectedAccount>(UNCONNECTED_ACCOUNTS_SQL, [issuer]);
  if (rows.length === 0) {
    process.stdout.write(`Every account that signed in some other way is connected to ${issuer}.\n`);
    return;
  }
  for (const row of rows) {
    const known = [
      ...(row.clerk_user_id
        ? [
            `${row.clerk_user_id} (${isClerkUserId(row.clerk_user_id) ? 'Clerk' : 'the retired token sign-in'})`,
          ]
        : []),
      ...row.elsewhere.map((identity) => `${identity.subject} at ${identity.issuer}`),
    ];
    process.stdout.write(`${row.id}\t${row.email}\t${known.join('; ')}\n`);
  }
}

async function linkAll(db: Client, issuer: string): Promise<void> {
  const { rows } = await db.query<UnconnectedAccount>(UNCONNECTED_ACCOUNTS_SQL, [issuer]);
  let linked = 0;
  for (const row of rows) {
    const stored = row.clerk_user_id;
    const why = !stored
      ? 'it holds no subject from the retired token sign-in — connect it alone with the subject your provider issues'
      : isClerkUserId(stored)
        ? 'it was made by Clerk — connect it alone with the subject your provider issues'
        : await heldElsewhere(db, issuer, stored, row.id);
    if (why) {
      process.stdout.write(`Skipped ${row.email}: ${why}.\n`);
      continue;
    }
    await insertIdentity(db, issuer, row.id, stored!);
    process.stdout.write(`Linked ${row.email} to ${stored} at ${issuer}.\n`);
    linked += 1;
  }
  process.stdout.write(`${linked} connected, ${rows.length - linked} skipped.\n`);
}

async function heldElsewhere(
  db: Client,
  issuer: string,
  subject: string,
  userId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ email: string }>(
    `SELECT u.email FROM user_identities i JOIN users u ON u.id = i.user_id
      WHERE i.issuer = $1 AND i.subject = $2 AND i.user_id <> $3`,
    [issuer, subject, userId],
  );
  const holder = rows[0];
  return holder
    ? `${subject} already signs in to ${holder.email} — connect it alone with --move if a first sign-in made that account by mistake`
    : null;
}

async function accountOf(db: Client, who: string): Promise<Account> {
  if (ID_SHAPE.test(who)) {
    const { rows } = await db.query<Account>(
      'SELECT id, email, clerk_user_id FROM users WHERE id = $1 FOR UPDATE',
      [who],
    );
    return rows[0] ?? fail(`No account with the id ${who}.`);
  }
  const email = who.toLowerCase();
  const { rows } = await db.query<Account & { email_verified: boolean }>(
    'SELECT id, email, clerk_user_id, email_verified FROM users WHERE lower(email) = $1 ORDER BY id FOR UPDATE',
    [email],
  );
  const holder = rows.find((row) => row.email_verified);
  if (holder) return holder;
  if (rows.length === 0) fail(`No account with the email ${email}.`);
  fail(
    `No account holds ${email} confirmed; the ones using it unconfirmed are ${rows.map((row) => row.id).join(', ')} — pass one's id instead.`,
  );
}

function subjectFor(account: Account, given: string | undefined): string {
  if (given !== undefined) return given;
  const stored = account.clerk_user_id;
  if (!stored) {
    fail(
      `${account.email} holds no subject from the retired token sign-in — pass the subject your provider issues for this person.`,
    );
  }
  if (isClerkUserId(stored)) {
    fail(
      `${account.email} was made by Clerk, and ${stored} was issued by Clerk, not your provider — pass the subject your provider issues for this person.`,
    );
  }
  return stored;
}

async function linkOne(
  db: Client,
  issuer: string,
  account: Account,
  given: string | undefined,
  move: boolean,
): Promise<void> {
  const subject = subjectFor(account, given);
  if (!subject || subject.length > 255 || /\p{Cc}/u.test(subject))
    fail('That subject is not one a provider issues.');
  const held = await db.query<{ user_id: string; subject: string }>(
    'SELECT user_id, subject FROM user_identities WHERE issuer = $1 AND (subject = $2 OR user_id = $3)',
    [issuer, subject, account.id],
  );
  const own = held.rows.find((row) => row.user_id === account.id);
  if (own?.subject === subject) {
    process.stdout.write(`${account.email} already signs in as ${subject} at ${issuer}.\n`);
    return;
  }
  if (own) {
    fail(
      `${account.email} is already connected to a different subject at ${issuer} — disconnect it in Settings first.`,
    );
  }
  const other = held.rows.find((row) => row.user_id !== account.id);
  if (other && !move) {
    fail(
      `${subject} at ${issuer} already signs in to another account (${other.user_id}). If a first sign-in made that account by mistake, run this again with --move.`,
    );
  }
  if (other) await moveOff(db, issuer, subject, other.user_id);
  await insertIdentity(db, issuer, account.id, subject);
  process.stdout.write(
    `Linked ${account.email} to ${subject} at ${issuer}. Their next single sign-on lands in this account.\n`,
  );
}

// Left with no password, the account can no longer sign in by its address, so it gives the address up.
async function moveOff(db: Client, issuer: string, subject: string, userId: string): Promise<void> {
  const { rows } = await db.query<{ email: string; hashed_password: string | null }>(
    'SELECT email, hashed_password FROM users WHERE id = $1 FOR UPDATE',
    [userId],
  );
  const holder = rows[0]!;
  await db.query('DELETE FROM user_identities WHERE issuer = $1 AND subject = $2', [issuer, subject]);
  const releases = holder.hashed_password === null;
  if (releases)
    await db.query('UPDATE users SET email_verified = false, updated_at = now() WHERE id = $1', [userId]);
  process.stdout.write(
    `Moved ${subject} at ${issuer} from ${holder.email} (${userId}), which keeps what it holds but no longer signs in through single sign-on${releases ? ' and gives up its address' : ''}.\n`,
  );
}

async function insertIdentity(db: Client, issuer: string, userId: string, subject: string): Promise<void> {
  await db.query(
    `INSERT INTO user_identities (id, user_id, issuer, subject, email_at_link, created_at)
     VALUES ($1, $2, $3, $4, NULL, now())`,
    [randomUUID(), userId, issuer, subject],
  );
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

main().catch((err: unknown) => {
  fail(errorMessage(err));
});
