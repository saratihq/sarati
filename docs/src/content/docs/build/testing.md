---
title: Test as you build
description: Run one step, or the whole workflow, before anything is live.
---

## One step

Open a step and click **Test this step**. It runs with its current inputs and shows the real
output.

Two things follow:

- You see whether the step actually works, with real data, before wiring anything after it.
- Its fields become available to [later steps](/build/data/).

The inspector shows **Input** and **Output** tabs, so you can see what the step received as well as
what it returned.

<img class="shot shot-dark" src="/shots/step-inspector-dark.webp" alt="A step tested on its own, showing its real output." />
<img class="shot shot-light" src="/shots/step-inspector-light.webp" alt="A step tested on its own, showing its real output." />

## The whole workflow

Two buttons run the workflow you are editing, top to bottom. Both run your unsaved editor state —
neither touches the version that is live in production.

**Dry run** shows what the workflow would do without doing the parts that change anything:

- Reads run for real. A `GET` reaches the real system with your real credentials.
- Writes are not sent. A step that would `POST`, `PUT`, `PATCH` or `DELETE` stops there and lists the
  call it would have made.
- Waits are skipped: a delay does not delay, and an approval is not waited for.
- Steps on a [managed connection](/build/connections/) are not run at all.
- An AI Agent step still calls its model; the tools it picks follow the same rules.

The rule is the HTTP method, not the intent. A search an API exposes as `POST` is withheld, and a
`GET` that changes something is sent. A step after a withheld one gets nothing from it, so a dry run
proves less the more of a workflow hangs on its writes.

**Run** does all of it for real: messages sent, data written, approvals waited for.

Both land in [run history](/run/runs/#dry-runs), where a dry run is marked as one.

## Testing a change against what is live

When a change is up for review, the review panel can run **both** versions and compare their
output field by field, so you can see what the change actually does before approving it. See
[Reviews](/version-control/reviews/).
