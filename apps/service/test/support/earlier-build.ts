import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '..', '..', '..', '..');

/** A release, by its tag and the full sha of the commit the tag names. */
export interface Release {
  tag: string;
  sha: string;
}

/** The release this build replaces, which going back lands on: re-point it, and run its rollback e2e, at every release. */
export const LAST_RELEASE: Release = { tag: 'v0.2.26', sha: '2d4323676428fb8034057093bc244bd7294c1a4d' };

const git = (...args: string[]): string =>
  execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).trim();

/** The newest `v*` release in this clone's history before `head`, a tag on `head` itself left out; null when there is none. */
export function newestReleaseBefore(head = 'HEAD'): Release | null {
  const onHead = new Set(git('tag', '--points-at', head).split('\n'));
  const tag = git('tag', '--merged', head, '--list', 'v*', '--sort=-v:refname')
    .split('\n')
    .find((name) => name !== '' && !onHead.has(name));
  return tag ? { tag, sha: git('rev-parse', `${tag}^{commit}`) } : null;
}

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
    git('archive', '--format=tar', '-o', tar, sha);
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
