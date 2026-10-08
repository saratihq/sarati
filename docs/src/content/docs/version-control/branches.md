---
title: Branches
description: Work on a change without touching what is running.
---

Every workflow has `main`. Add a branch to change something without touching it.

## Create one

Click the branch selector on the workflow overview, type a name, **Create**.

The branch starts from the latest version on `main`, whichever branch you were on. Nothing is
copied — the starting point is inherited.

<img class="shot shot-dark" src="/shots/branch-selector-dark.webp" alt="The branch selector listing branches, with the default marked and a new-branch action." />
<img class="shot shot-light" src="/shots/branch-selector-light.webp" alt="The branch selector listing branches, with the default marked and a new-branch action." />

## Version numbers are per branch

Your branch's first save is **its v1**, while main still has its own v1.

So a version is only unambiguous as a number *plus* a branch. The UI always shows both, and a bare
number that matches several branches is refused rather than guessed.

## Switch

The branch selector switches the whole workflow view — overview, editor, compare. The current
branch is in the URL, so a link you send opens on the same branch.

## Protect a branch

Turn on protection in the branch selector. A protected branch takes change **only** through an
approved review — of exactly what lands.

Both doors are locked:

| Attempt | Result |
|---|---|
| Merge a branch into it without an approved review — or while the latest conclusive [test](/version-control/reviews/#merge) of the two versions fails | Refused — *merge it through an approved review*, or *the pre-merge test is failing* |
| Merge after new commits on the branch since it was approved | Refused until the review is approved again — an approval covers the version it was given on |
| Merge with conflicts | Refused — [update your branch from it](/version-control/conflicts/#into-a-protected-branch) and resolve them there |
| Commit to it directly | Refused — *commit to a branch and open a review to bring it in* |
| Delete it | Refused — an owner or admin unprotects it first |

Promoting an older version still works, so protection can never leave you unable to roll back. A
rollback to the version the branch already holds changes nothing.

## Delete

**Merge into main** deletes the branch once its change lands, unless a review of it into main is
still under way — that review is marked merged and the branch is kept. You can also delete one from
the selector. A protected branch is never deleted: Merge into main keeps it, and the selector waits
for it to be unprotected.

Either way its reviews are deleted with it and its versions drop out of the feed. An environment
already running one of them keeps running it.
