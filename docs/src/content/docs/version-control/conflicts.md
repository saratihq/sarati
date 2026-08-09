---
title: Merge conflicts
description: When two branches change the same field, pick a side field by field.
---

Two branches changing **different** fields of the same step merge cleanly. No prompt, no choice.

A conflict happens only when both sides changed **the same field**.

## What you see

The merge stops before writing anything and opens the resolver:

> **Resolve merge conflicts** — busy-hours → main
> 1 change differs on both sides. Nothing has merged yet.

For each conflicting field you get the step, the field path, and three choices:

| | |
|---|---|
| **Originally** | the value both branches started from |
| **Use theirs** | the incoming branch's value |
| **Use current** | the target branch's value |
| **Edit** | write a value that is neither |

The footer counts progress — `0 of 1 resolved` — and **Complete merge** stays disabled until every
conflict has a decision.

<img class="shot shot-dark" src="/shots/conflict-resolver-dark.webp" alt="The conflict resolver showing the original value and the two competing sides for one field." />
<img class="shot shot-light" src="/shots/conflict-resolver-light.webp" alt="The conflict resolver showing the original value and the two competing sides for one field." />

Cancelling changes nothing. Until you complete the merge, both branches are exactly as they were.

## A worked example

`main` and `busy-hours` both forked from a version where `limit` was `10`. Then `main` moved to `5`
and `busy-hours` moved to `45`:

```
Fetch Top Stories · parameters.limit
  Originally    10
  Use theirs    45   ← busy-hours (incoming)
  Use current    5   ← main (target)
```

Choosing **Use theirs** and completing the merge writes one new version on `main` whose `limit` is
`45`.

## Why it is a field and not a file

The comparison is three-way — ancestor, target, source — on **fields inside a step**, so:

- Two people editing different settings on one step never collide.
- The conflict names `parameters.limit`, not a line number.
- A step renamed on one side keeps its identity; it is not a delete plus an add.

## Adds on both sides

If both branches add a step with the same id but different content, that is a **whole-node**
conflict rather than a field one — you pick one side's node entire, because there is no sensible way
to interleave two different definitions.
