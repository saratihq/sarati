---
title: Reviews
description: Propose a change, test it against what is live, approve it, merge it.
---

A review proposes merging one branch into another. On a protected branch it is the only way in.

## Open one

From the workflow overview, open a review from your branch into `main`. Give it a title and, if it
helps, context for reviewers.

It appears in the workflow's activity feed alongside the versions, showing `source → target`,
comment count and approvals.

<img class="shot shot-dark" src="/shots/review-diff-dark.webp" alt="An open review with its field-level diff, test panel and approve controls." />
<img class="shot shot-light" src="/shots/review-diff-light.webp" alt="An open review with its field-level diff, test panel and approve controls." />

## Review it

- The **field-level diff is right there** in the review — `1 change — main v2 → your-branch v1`,
  then each changed step with its old and new values. You do not have to leave for
  [Compare](/version-control/compare/).
- **Test this branch** runs both versions for real — the target as the baseline, your branch as the
  head — and compares their **output** field by field. A diff tells you what changed; this tells you
  what it does.
- Comments are per review.

Pick the environment to run against, and whether the trigger payload comes from the **latest run**
or JSON you paste.

The result is **Passed**, **Failing** or **Inconclusive** — the target failed too, so it can't tell —
plus every output field that moved:

```
✓ Passed                          Tested just now
fetch_top_stories · count         45 → 7
fetch_top_stories · stories[7]    {…} → null
fetch_top_stories · stories[8]    {…} → null
```

:::caution
**This executes live steps.** Sarati asks first, in its own words:

> Run a real test? … Live steps will execute. Real effects can fire: messages sent, data written,
> external calls made.

Point it at a non-production environment unless you mean it.
:::

This test has no dry form. The editor's [Dry run](/build/testing/#the-whole-workflow) does, and an
agent testing over [MCP](/agents/mcp/#testing-is-dry-unless-you-confirm) is dry unless the run is
confirmed.

An untested review says so — *"This review was never tested."*

## Approve

Approve, or request changes.

**You cannot approve your own review while there is anyone else in the workspace.** Working alone,
you can — otherwise a solo instance could never merge anything.

An approval covers the version it was given on. Into a protected branch, a commit to your branch
after approval needs approving again — the card says *Approved before the latest changes*, and
Merge waits until then. If the branch changes while you have the review open, your decision is
refused and the card reloads, so you never approve changes you were not shown.

Approvals given before Sarati 0.2.20 recorded no version. After upgrading, an approved review into a
protected branch needs approving once more — the card says *Approved before approvals covered one
exact version*.

## Merge

Merge from the review once it is approved.

Merging into a protected branch before approval is refused:

> Target branch is protected — review must be approved before merging

Into a protected branch, a failing test also blocks the merge — from the review or with **Merge into
main** on the workflow overview alike. A test fails when a step errors on your branch but not on the
target. What counts is the latest conclusive test of exactly the content being merged — any two
versions holding that content, run from any review. Every result is kept, even after the branch it
ran from is deleted, so putting failing content back on a branch doesn't lift the failure. The
refusal and the review card name the review that ran it and what failed. A passing re-test, or a
commit that changes either side, lifts it. A test where the target fails too shows as **Inconclusive**: it decides nothing,
so an earlier failure still stands. A test whose run someone cancels has no result at all: it is not
kept, and neither blocks nor lifts a merge.

After a successful merge the target branch has a new version — the merge commit — and the review is
marked merged in the feed.

**The merge does not deploy.** Production still points where it pointed. Promote the new version
when you want it live — see [Save, version, publish](/version-control/save-version-publish/).

## Conflicts

If both branches changed the same field of the same step, the merge stops and opens the resolver —
see [Merge conflicts](/version-control/conflicts/). Into a protected branch it is refused instead, and
you resolve them on your branch with **Update *your-branch* from *target***.
