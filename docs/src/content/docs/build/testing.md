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

## The whole workflow

**Run** executes the workflow you are editing, top to bottom.

This runs your unsaved editor state — it does not touch the version that is live in production.

## Testing a change against what is live

When a change is up for review, the review panel can run **both** versions and compare their
output field by field, so you can see what the change actually does before approving it. See
[Reviews](/version-control/reviews/).
