---
title: The canvas
description: Add steps, wire them, and handle errors per step.
---

The canvas is the editor. Open a workflow and click **Edit**, or create a new one.

Every new workflow starts with a **Trigger** step already placed. You cannot delete it — a workflow
has exactly one way in. You can [change what kind it is](/build/triggers/).

<img class="shot shot-dark" src="/shots/canvas-dark.webp" alt="The canvas with a trigger step wired to an action." />
<img class="shot shot-light" src="/shots/canvas-light.webp" alt="The canvas with a trigger step wired to an action." />

## Add and wire

**+ Add step** opens the catalog. Picking a step drops it on the canvas and wires it to the step
you had selected.

To wire by hand, drag from one step's output port to another's input port.

```
Drag cards to rearrange · drag port → port to wire steps · Delete removes a selected step or wire
```

Moving a step is presentation, not history — it does not create a version.

## Rename a step

Click the step's title in the inspector. The rename is tracked as a rename: the step keeps its
identity, so a diff shows "renamed", not "deleted and added".

## When a step fails

Every step has two settings in its inspector.

**On failure**

| Option | What happens |
|---|---|
| Stop the run | The run stops at this step. The default. |
| Continue — skip this step's error | The run carries on to the next step. |

**Retry on failure** — number of attempts. `1` means run once and do not retry.

For anything more than skip-or-stop, give the step an **error output**: drag from its error port to
the steps that should handle the failure. The error lane runs *instead of* the normal path, never
both.

## Save

The save button names where the version is going: **Save new version** on `main`, **Save to
&lt;branch&gt;** when you are on a branch, with the header reading *"saves commit to this branch, the
live workflow is untouched"*.

If nothing changed, no version is created — Sarati compares the content, not the file.

See [Save, version, publish](/version-control/save-version-publish/).
