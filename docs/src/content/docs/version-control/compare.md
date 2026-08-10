---
title: Compare versions
description: See exactly which fields changed, on which steps.
---

**Compare** puts two versions side by side and lists what differs.

Pick a **BASE** and a **HEAD**. They can be two versions of one branch, or the heads of two
different branches.

## What a diff is

A diff is a list of field changes, not a text comparison.

| Step | Field | Before | After |
|---|---|---|---|
| Fetch Top Stories | `parameters.limit` | `10` | `25` |

The header counts them — `1 MODIFIED` — and the changed steps are highlighted on both canvases.

Click a highlighted step and a drawer opens with its accounting and the values themselves:

```
Fetch Top Stories                 hackernews.fetch_top_stories
~1 changed   +0 added   −0 removed

PARAMETERS                                             1 change
  parameters.limit
    − 5
    + 45
```

<img class="shot shot-dark" src="/shots/compare-dark.webp" alt="Compare showing base and head side by side with one modified step." />
<img class="shot shot-light" src="/shots/compare-light.webp" alt="Compare showing base and head side by side with one modified step." />

## Why field-level matters

- Two people editing **different fields of the same step** merge cleanly. Text diffs cannot do
  this.
- A **renamed step** shows up as a rename. It keeps its identity, so it is not a delete plus an add,
  and everything pointing at it still points at it.
- A step's **error path** is a distinct connection from its normal path, so the two can never be
  collapsed into one.

## Nothing to show

If two versions have the same content, the diff is empty — and saving in that state would not have
created a version in the first place.
