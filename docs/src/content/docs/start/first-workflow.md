---
title: Your first workflow
description: Build a workflow, run it, then branch it, review it and merge it.
---

Twelve minutes, no accounts to connect. You will build a workflow, fire it, change it on a branch,
review the change, and merge it.

Start from a running instance — see [Install](/start/install/).

## 1. Create the owner account

Open <http://localhost:8080>. The first account is the owner; everyone after joins by invite.

## 2. New workflow

Click **New workflow**. You land on the canvas with a **Trigger** step already placed.

<img class="shot shot-dark" src="/shots/canvas-dark.webp" alt="The canvas with a trigger step and one action wired to it." />
<img class="shot shot-light" src="/shots/canvas-light.webp" alt="The canvas with a trigger step and one action wired to it." />

## 3. Add a step

Click **+ Add step**, search `hacker`, and pick **Fetch Top Stories**.

It carries a **No account needed** badge — it runs in-process with no credentials. The new step
wires itself to the trigger.

<img class="shot shot-dark" src="/shots/catalog-dark.webp" alt="The step catalog, each entry badged with whether it needs an account." />
<img class="shot shot-light" src="/shots/catalog-light.webp" alt="The step catalog, each entry badged with whether it needs an account." />

## 4. Test it before it exists anywhere

Click the step, then **Test this step**. Real Hacker News data comes back.

<img class="shot shot-dark" src="/shots/step-inspector-dark.webp" alt="The step inspector showing real Hacker News output captured from a test run." />
<img class="shot shot-light" src="/shots/step-inspector-light.webp" alt="The step inspector showing real Hacker News output captured from a test run." />

Testing a single step costs nothing and needs no save. The output is captured so later steps can
pick fields from it.

## 5. Make it fire on a webhook

Click the **Trigger** step → **Change** → **Incoming webhook**.

## 6. Name it and save

Rename the workflow to `Daily digest`, then **Save**.

> Daily digest is under version control — v1 on main

Saving is a commit. The first version of a new workflow goes live on production immediately; every
version after this one needs an explicit publish.

## 7. Fire it

Click the **Trigger** step and copy the webhook URL, then:

```bash
curl -X POST http://localhost:8080/api/hooks/<workflow-id>/production \
  -H 'Content-Type: application/json' \
  -d '{"source":"terminal"}'
```

```json
{"status":"accepted","fired":1,"run_id":"13000cf9-…","run_ids":["13000cf9-…"]}
```

The webhook accepts and returns a run id. It does not wait for the workflow to finish.

## 8. See the run

Open **Runs**. One row: `Completed · WEBHOOK · PRODUCTION · v1 · 1.6s`. Click it for the step log
and the full output.

<img class="shot shot-dark" src="/shots/run-detail-dark.webp" alt="A completed run expanded to show its step log and full JSON output." />
<img class="shot shot-light" src="/shots/run-detail-light.webp" alt="A completed run expanded to show its step log and full JSON output." />

That is the whole build-and-run loop. The rest is what makes it safe to change.

## 9. Branch it

Click the branch selector (**main**) → **New branch**, type `more-stories`, click **Create**.

The view switches to the branch and tells you where it came from:

> more-stories started from main v1 — this version is inherited, not a copy drifting behind.

## 10. Change one field

**Start more-stories in the editor**, open **Fetch Top Stories**, set **Limit** to `25`, and
**Save to more-stories**.

> v1 saved on more-stories — committed to this branch, merge into main when it's ready to release.

That is the branch's *own* v1. Main still has its v1, and production is untouched.

## 11. Read the diff

Click **Compare**. One entry:

| Step | Field | Before | After |
|---|---|---|---|
| Fetch Top Stories | `parameters.limit` | `10` | `25` |

A field, not a wall of text. Two people editing different fields of the same step do not conflict.

<img class="shot shot-dark" src="/shots/compare-dark.webp" alt="Compare showing base and head side by side with one modified step." />
<img class="shot shot-light" src="/shots/compare-light.webp" alt="Compare showing base and head side by side with one modified step." />

## 12. Protect main

In the branch selector, turn on protection for **main**.

Now try to merge `more-stories` straight in:

> Branch 'main' is protected — merge it through an approved review

And try editing main directly:

> Branch 'main' is protected — commit to a branch and open a review to bring it in

There is no way around it.

## 13. Open a review, approve, merge

Click **New review**, give it a title, **Create review**. Open **DETAILS** — the diff is right
there, `1 change — main v1 → more-stories v1`.

<video class="shot shot-dark" src="/shots/review-merge-dark.webm" poster="/shots/review-merge-poster-dark.webp" width="1280" height="800" autoplay loop muted playsinline aria-label="A review showing the field-level diff, then approving it and merging."></video>
<video class="shot shot-light" src="/shots/review-merge-light.webm" poster="/shots/review-merge-poster-light.webp" width="1280" height="800" autoplay loop muted playsinline aria-label="A review showing the field-level diff, then approving it and merging."></video>

<img class="shot shot-dark" src="/shots/review-diff-dark.webp" alt="An open review showing the field-level diff, the test-this-branch panel, and the approve controls." />
<img class="shot shot-light" src="/shots/review-diff-light.webp" alt="An open review showing the field-level diff, the test-this-branch panel, and the approve controls." />

**Approve**, then **Merge**.

Working alone, you can approve your own review — otherwise you would deadlock. Once there is
someone else in the workspace, you cannot.

## 14. Merging is not deploying

Main is now on v2. Production is still on v1, and the trigger says so:

> Live — head has unpublished changes

Click **Publish v2**, then fire the webhook again — 25 stories this time.

| | Latest on main | Live in production |
|---|---|---|
| after the merge | v2 | v1 |
| after publishing | v2 | v2 |

## What you just did

Built a workflow, ran it, changed it without touching what was running, proved the change in a
diff, and released it deliberately.

Next: [How Sarati works](/start/how-it-works/) for the model behind it, or
[Triggers](/build/triggers/) to make it fire on something real.
