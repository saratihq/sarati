import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import { errorMessage } from '../common/error-message';

// `pnpm auth:link-sso <email> <sub>`: shell access to the box is the proof that this account is that subject at OIDC_ISSUER.
async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase();
  const subject = process.argv[3]?.trim();
  if (!email || !subject) fail('Usage: pnpm auth:link-sso <email> <sub>');
  if (subject.length > 255 || /\p{Cc}/u.test(subject)) fail('That subject is not one a provider issues.');

  const url = process.env.DATABASE_URL;
  if (!url) fail('DATABASE_URL is not set — run this where the service runs.');
  const issuer = process.env.OIDC_ISSUER?.trim();
  if (!issuer)
    fail('OIDC_ISSUER is not set — run this where the service runs, with single sign-on configured.');

  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('BEGIN');
    const found = await db.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = $1 FOR UPDATE', [
      email,
    ]);
    const user = found.rows[0];
    if (!user) fail(`No account with the email ${email}.`);

    const held = await db.query<{ user_id: string; subject: string }>(
      'SELECT user_id, subject FROM user_identities WHERE issuer = $1 AND (subject = $2 OR user_id = $3)',
      [issuer, subject, user.id],
    );
    for (const row of held.rows) {
      if (row.user_id === user.id && row.subject === subject) {
        await db.query('ROLLBACK');
        process.stdout.write(`${email} already signs in as ${subject} at ${issuer}.\n`);
        return;
      }
      if (row.user_id === user.id) {
        fail(
          `${email} is already connected to a different subject at ${issuer} — disconnect it in Settings first.`,
        );
      }
      fail(`${subject} at ${issuer} already signs in to another account.`);
    }

    await db.query(
      `INSERT INTO user_identities (id, user_id, issuer, subject, email_at_link, created_at)
       VALUES ($1, $2, $3, $4, NULL, now())`,
      [randomUUID(), user.id, issuer, subject],
    );
    await db.query('COMMIT');
    process.stdout.write(
      `Linked ${email} to ${subject} at ${issuer}. Their next single sign-on lands in this account.\n`,
    );
  } finally {
    await db.end();
  }
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

main().catch((err: unknown) => {
  fail(errorMessage(err));
});
