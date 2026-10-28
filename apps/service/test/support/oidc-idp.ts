import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { freePort } from './service-process';

/** One account the provider can sign in, keyed by its `sub`. */
export interface IdpAccount {
  email?: string;
  email_verified?: unknown;
  name?: string;
}

/** A real oidc-provider in a process of its own — ESM-only, so jest's CommonJS realm cannot load it in-process. */
export interface RealIdp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Replace the accounts it signs in; read on every lookup, so a change lands on the next sign-in. */
  setAccounts(accounts: Record<string, IdpAccount>): void;
  stop(): Promise<void>;
}

export async function startRealIdp(opts: {
  redirectUri: string;
  accounts: Record<string, IdpAccount>;
}): Promise<RealIdp> {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'sarati-oidc-idp-'));
  const accountsFile = join(dir, 'accounts.json');
  const setAccounts = (accounts: Record<string, IdpAccount>): void =>
    writeFileSync(accountsFile, JSON.stringify(accounts));
  setAccounts(opts.accounts);

  const clientId = 'sarati-e2e';
  const clientSecret = `secret-${port}-with spaces+and:colons`;
  const child = spawn(process.execPath, [join(__dirname, 'oidc-idp', 'provider.mjs')], {
    env: {
      PATH: process.env.PATH,
      OIDC_IDP_CONFIG: JSON.stringify({
        port,
        clientId,
        clientSecret,
        redirectUri: opts.redirectUri,
        accountsFile,
      }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const ready = new Promise<string>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      log += chunk.toString();
      const line = /READY (\S+)/.exec(log);
      if (line) resolve(line[1]!);
    });
    child.stderr.on('data', (chunk: Buffer) => (log += chunk.toString()));
    child.once('exit', (code) =>
      reject(new Error(`the identity provider exited (${code}) as it booted\n${log}`)),
    );
  });
  const issuer = await ready;
  return {
    issuer,
    clientId,
    clientSecret,
    setAccounts,
    stop: async () => {
      if (child.exitCode === null) child.kill('SIGKILL');
      await exited;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
