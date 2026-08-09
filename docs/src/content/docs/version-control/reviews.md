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
  head — and compares their output field by field. A diff tells you what changed; this tells you
  what it does.
- Comments are per review.

:::caution
**Test this branch executes live steps.** It runs both versions against a real environment, so
anything that sends, writes or charges will actually do it. Point it at a non-production
environment unless you mean it.
:::

## Approve

Approve, or request changes.

**You cannot approve your own review while there is anyone else in the workspace.** Working alone,
you can — otherwise a solo instance could never merge anything.

## Merge

Merge from the review once it is approved.

Merging into a protected branch before approval is refused:

> Target branch is protected — review must be approved before merging

After a successful merge the target branch has a new version — the merge commit — and the review is
marked merged in the feed.

**The merge does not deploy.** Production still points where it pointed. Promote the new version
when you want it live — see [Save, version, publish](/version-control/save-version-publish/).

## Conflicts

If both branches changed **the same field of the same step**, the merge stops and asks you to pick
a side, field by field.

Different fields on the same step are not a conflict — they merge.
