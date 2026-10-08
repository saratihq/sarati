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

## Your own account

A step that signs in to an app can refer to the account it signs in as: the **Me** group in the
`{}` menu, or typed —

```
{{$account.email}}
```

`email`, `handle`, `id` and `name` are what the app says about that account, where it says them. On
an email recipient field, **Send to me** fills it in with one click.

It is whichever account runs the step: yours while you build and test, and the account assigned to
the [environment](/run/environments/) once it is promoted — a workflow promoted to production writes
to production's account, not yours. When Sarati can't tell which account that is, the step stops
before it calls the app instead of sending to an empty address.

Sarati knows the account for Gmail, and for Google Sheets, Google Drive and GitHub when they are
connected with one-click sign-in. Slack names the workspace, not the person, so a Slack step has no
**Me**.

## Get real fields to pick from

The picker can only offer fields it has seen. Run the step once with
[**Test this step**](/build/testing/) and its real output becomes available to every later step.

Until then you are typing paths from memory.

## Expressions

The `fx` toggle on a dropdown, checkbox or number field turns it into a text field, so it can hold
a `{{…}}` reference instead of a fixed value. References are substituted as they are; nothing is
computed.

## Pinned data

After testing a step you can **Pin for runs**. The pinned output is then used instead of calling
the service again, so you can build and re-run the rest of the workflow against a fixed payload.

Pinned data is a build-time convenience. **Clear** it before you rely on the workflow in
production.
