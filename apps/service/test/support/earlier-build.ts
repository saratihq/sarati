import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '..', '..', '..', '..');

/** An earlier build of the service, unpacked beside this one. */
export interface EarlierBuild {
  /** Its `apps/service`. */
  service: string;
  remove(): void;
}

/** Unpack the build at `sha` from this clone's history and install its service, from the local store when it can be. */
export function unpackBuild(sha: string): EarlierBuild {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`"${sha}" is not a full commit sha`);
  const dir = mkdtempSync(join(tmpdir(), 'sarati-earlier-'));
  try {
    const tar = join(dir, 'build.tar');
    execFileSync('git', ['-C', REPO, 'archive', '--format=tar', '-o', tar, sha]);
    execFileSync('tar', ['-x', '-f', tar, '-C', dir]);
    execFileSync(
      'pnpm',
      ['install', '--frozen-lockfile', '--prefer-offline', '--filter', '@sarati/service...'],
      {
        cwd: dir,
        stdio: 'ignore',
      },
    );
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    service: join(dir, 'apps', 'service'),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
