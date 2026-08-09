---
title: Data between steps
description: Reference an earlier step's output in any field.
---

Any field can read what an earlier step produced.

## Insert a reference

Click the `{}` button on a field and pick from the earlier step's output.

Or type it:

```
{{step_id.path}}
```

The trigger is `trigger`:

```
{{trigger.body.email}}
```

A step's id is shown under its name in the inspector — for example `fetch_top_stories`. It is the
step's identity and does not change when you rename the step.

## Get real fields to pick from

The picker can only offer fields it has seen. Run the step once with
[**Test this step**](/build/testing/) and its real output becomes available to every later step.

Until then you are typing paths from memory.

## Expressions

The `fx` toggle on a field switches it from a literal value to an expression, so you can compute
rather than just substitute.

## Pinned data

After testing a step you can **Pin for runs**. The pinned output is then used instead of calling
the service again, so you can build and re-run the rest of the workflow against a fixed payload.

Pinned data is a build-time convenience. **Clear** it before you rely on the workflow in
production.
