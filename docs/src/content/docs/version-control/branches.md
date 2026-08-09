---
title: Branches
description: Work on a change without touching what is running.
---

Every workflow has `main`. Add a branch to change something without touching it.

## Create one

Click the branch selector on the workflow overview, type a name, **Create**.

The branch starts from the current version of the branch you were on. Nothing is copied — the
starting point is inherited.

## Version numbers are per branch

Your branch's first save is **its v1**, while main still has its own v1.

So a version is only unambiguous as a number *plus* a branch. The UI always shows both, and a bare
number that matches several branches is refused rather than guessed.

## Switch

The branch selector switches the whole workflow view — overview, editor, compare. The current
branch is in the URL, so a link you send opens on the same branch.

## Protect a branch

Turn on protection in the branch selector. A protected branch takes change **only** through an
approved review.

Both doors are locked:

| Attempt | Result |
|---|---|
| Merge a branch into it without an approved review | Refused — *merge it through an approved review* |
| Commit to it directly | Refused — *commit to a branch and open a review to bring it in* |

Promoting an older version still works, so protection can never leave you unable to roll back.

## Delete

Delete a branch from the selector once its change has landed. Its versions go with it, so delete
after merging, not before.
