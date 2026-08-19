import { Client } from 'pg';

import { MIN_PASSWORD_LENGTH, hashPassword } from '../auth/local/password';
import { errorMessage } from '../common/error-message';

/**
 * Set a local account's password from the machine running the instance. Shell access to
 * the box IS the proof of ownership, which is why this needs no email and no running service.
 *
 *   pnpm auth:set-password owner@example.com
 */
async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    fail('Usage: pnpm auth:set-password <email>');
  }

  const url = process.env.DATABASE_URL;
  if (!url) fail('DATABASE_URL is not set — run this where the service runs.');

  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const found = await db.query<{ id: string; name: string }>(
      `SELECT id, name FROM users WHERE lower(email) = $1`,
      [email],
    );
    const user = found.rows[0];
    if (!user) fail(`No account with the email ${email}.`);

    const password = await promptHidden(`New password for ${email} (min ${MIN_PASSWORD_LENGTH} chars): `);
    if (password.length < MIN_PASSWORD_LENGTH) {
      fail(`Too short — use at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    if (password !== (await promptHidden('Repeat it: '))) fail('Those did not match.');

    await db.query(`UPDATE users SET hashed_password = $1, updated_at = now() WHERE id = $2`, [
      await hashPassword(password),
      user.id,
    ]);
    process.stdout.write(`\nPassword updated for ${email}. Existing sessions keep working.\n`);
  } finally {
    await db.end();
  }
}

/**
 * Read one line. On a terminal the input is not echoed, so the password never lands in scrollback;
 * piped input (`docker compose exec -T`) is read plainly, because there is nothing to hide from.
 */
function promptHidden(prompt: string): Promise<string> {
  const input = process.stdin;
  process.stdout.write(prompt);
  if (!input.isTTY) return readLine(input);

  input.setRawMode(true);
  input.resume();
  return new Promise((resolve) => {
    let value = '';
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 0x03) process.exit(130); // Ctrl-C
        if (byte === 0x0d || byte === 0x0a) {
          input.setRawMode(false);
          input.pause();
          input.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (byte === 0x7f || byte === 0x08) value = value.slice(0, -1);
        else value += String.fromCharCode(byte);
      }
    };
    input.on('data', onData);
  });
}

/** Piped input arrives in chunks, not lines — what one read does not consume, the next one needs. */
let pending = '';

function readLine(input: NodeJS.ReadStream): Promise<string> {
  const take = (): string | null => {
    const newline = pending.indexOf('\n');
    if (newline < 0) return null;
    const line = pending.slice(0, newline).replace(/\r$/, '');
    pending = pending.slice(newline + 1);
    return line;
  };

  const buffered = take();
  if (buffered !== null) return Promise.resolve(buffered);

  return new Promise((resolve) => {
    const onData = (chunk: Buffer): void => {
      pending += chunk.toString('utf8');
      const line = take();
      if (line === null) return;
      input.removeListener('data', onData);
      input.pause();
      resolve(line);
    };
    input.on('data', onData);
    input.resume();
  });
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

main().catch((err: unknown) => {
  fail(errorMessage(err));
});
