/** What the overview knows of a workflow's release: production's version and the main branch's head. */
export interface ReleaseState {
  live: number | null;
  liveId: string | null;
  latest: number;
  latestId: string | null;
}

/** True when main holds a version production isn't running — including a workflow never published at all. */
export function hasUnpublishedVersion(release: ReleaseState | null): boolean {
  if (release == null || release.latest < 1) return false;
  if (release.live == null) return true;
  // Identity, not the number: a per-branch number can outrank main's head (invariant #1).
  return release.liveId != null && release.latestId != null
    ? release.liveId !== release.latestId
    : release.latest > release.live;
}
