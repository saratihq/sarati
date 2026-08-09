---
title: Save, version, publish
description: Saving is not deploying. The one rule to get right.
---

**Saving creates a version. It does not change what is running.**

Releasing is a separate, deliberate act: **Promote** (or **Publish**, which is promote-to-production).

## What saving does

`Save new version` commits your canvas as a new, immutable version at the head of the current
branch.

If nothing actually changed, no version is created. Sarati compares content, so re-saving an
untouched workflow — or one you edited and put back — is a no-op.

## The one exception

The **first** version of a brand-new workflow goes live in production immediately. A workflow that
could not run until you found a second button would be a worse product.

Every version after that one waits for you.

## Reading the state

The workflow overview shows both facts at once:

- The version feed, newest first, with `LATEST` on the branch head.
- The runtime rail: **Live on Sarati v2**.

<img class="shot shot-dark" src="/shots/overview-dark.webp" alt="The workflow overview: version feed on the left, live version and trigger state on the right." />
<img class="shot shot-light" src="/shots/overview-light.webp" alt="The workflow overview: version feed on the left, live version and trigger state on the right." />

When the head is ahead of what is live, the trigger card says so outright: *Live — head has
unpublished changes.*

When latest is ahead of live, you have saved work that is not released. That is a normal state, not
a warning.

## A worked example

| Moment | Latest on main | Live in production |
|---|---|---|
| First save of a new workflow | v1 | v1 |
| Save a change on a branch | v1 | v1 |
| Merge that branch into main | **v2** | v1 |
| Publish v2 | v2 | **v2** |

Merging is not deploying. A merge moves the branch head; the environment pointer stays where it is
until you move it.

## Publishing

**Promote** on a version moves an environment's pointer to it.

Nothing is copied and the version does not change — an environment is a pointer at a version. See
[Runs](/run/runs/) for what happens to work already in flight.

## Getting back to a known-good version

Two different moves. Both work on a protected branch — protection must never leave you unable to
recover.

**Put an older version live.** Promote it. The pointer moves; history is untouched.

```
live_version: 7  →  promote v1  →  live_version: 1
```

**Bring an older version back as the current one.** Roll back. This writes a *new* version at the
branch head carrying the old content — history moves forward, never backwards, and the live pointer
does not move on its own.

```
POST /api/workflows/<id>/versions/1/rollback?branch=main
{"status":"rolled_back","new_version_number":7,"rolled_back_to":1}
```

The `branch` matters: version numbers are per branch, so a bare number that exists on several
branches is refused rather than guessed.

> Version 1 is ambiguous: version numbers are per-branch and this one exists on
> evening-recap, main, more-stories… Pass `branch`, or reference the version by id.

After a rollback the head is the restored content but production is still where it was. Promote the
new version when you want it live.
