---
title: Approvals
description: Pause a run until a person decides.
---

A **Wait for event** step pauses the run until an event arrives on its topic, or the timeout passes.

```
Trigger → Manager approval → Record the decision
```

Configure the step with a topic and how long to wait:

| Field | |
|---|---|
| `topic` | The event name the run waits for, e.g. `manager_approval`. Names starting `orchestr:timer:` or `orchestr:wait:` are reserved: a workflow or raw plan that uses one is refused before any step runs. |
| `timeout_ms` | How long to wait before giving up |

## While it waits

The run's status is `waiting`, and the waiting step shows in the run's step log. Nothing after it
has executed.

Every wait for an event appears in the **Approvals inbox** in the header, org-wide — so an
approval is not something one person has to remember. You can act on a teammate's run, not only your
own. Your own waiting runs in your other workspaces are listed too; opening one switches to its
workspace.

A run paused by a **Wait** step of more than a minute is also `waiting`, but it is not in the inbox:
it resumes when its time is up, and nothing else can wake it. The editor and **Runs** show it as
**Waiting until** its wake time, or **Was due at** it once that time has passed; a run waiting for an
event reads **Waiting for a decision**, with a link to the inbox. Over the API,
`GET /api/runs/<run-id>` and the MCP tool `orchestr_get_run` say which:

```json
{"status": "waiting", "waiting": {"kind": "timer", "until": "2026-10-12T09:30:00.000Z"}}
```

`kind` is `timer`, `event`, or `decided` for a decision already made that the run has yet to take,
which also names who made it in `decided_by`; `until` is when a timer wakes, or when an event wait
times out.

<img class="shot shot-dark" src="/shots/approvals-dark.webp" alt="The approvals inbox with one waiting run, its topic and step, a countdown, and approve or reject." />
<img class="shot shot-light" src="/shots/approvals-light.webp" alt="The approvals inbox with one waiting run, its topic and step, a countdown, and approve or reject." />

Each entry shows the workflow, the topic it is waiting on, the step it waits at, who started it, how
long it has waited and **how long is left** before the timeout. **Custom payload…** sends an event other than approve or
reject. A wait leaves the inbox two seconds before it times out, since a decision could no longer
reach the run in time.

## More than one wait at once

Steps on separate branches run at the same time, so a run can wait on several things at once — a
**Wait** step and an approval, or two approvals. Each wait is its own: every approval is a separate
entry in the inbox, answered on its own, and a **Wait** step still wakes on its own clock. The run
stays `waiting` until none is left. Its `waiting` names the one that matters most — an approval
before a timer, then whichever is due first — and each step in the run's `steps` carries its own
`waiting` while it is parked.

Two waits in one run on the **same topic** are both listed, each row naming its step. Deciding one in
the inbox answers that wait and no other. A run started before this version with two such waits in
parallel branches is listed once for both, marked as sharing one decision: a decision sent by topic
answers one of them, whichever the run picks. The other ends with no decision (`null`) if it sees the
decision before the first one takes it; otherwise it stays parked until it times out, and a second
decision for it is refused as already decided. That entry leaves the inbox, and a decision for it is
refused, once either wait is within two seconds of timing out.

A run this version starts with a wait in a parallel branch, or beside another step that runs at the
same time, resumes after a restart or an upgrade where it was: no step that had finished runs again —
except in a workflow it was calling, which runs again from its start if the call had not finished —
and each decision reaches its own wait. A run an earlier version started that had already run steps
side by side when the service stopped can't be resumed safely, even with a single approval waiting:
after a restart or an upgrade it [ends in `error`](/run/runs/#durability) saying so, its waits leave
the inbox, and a decision made for one that it had not taken yet is recorded, with who made it, but
not applied. Run it again. Going back to an earlier version is in
[Upgrades](/operate/upgrades/#going-back).

## Deciding

**Approve** or **Reject** from the inbox — both resume what comes after that wait, carrying your
decision into it. Or send the event yourself:

```bash
curl -X POST http://localhost:8080/api/runs/<run-id>/events \
  -H 'Content-Type: application/json' \
  -d '{"topic":"manager_approval","step_key":"approval","payload":{"decision":"approved"}}'
```

```json
{"status":"sent","step_key":"approval"}
```

In the request, `step_key` names the wait: the `step_key` of its entry in `GET /api/runs/waiting`,
which is also the name the inbox shows on its row. A wait inside a loop or a branch runs under a
longer key than its node, such as `loop#0/approval`, and one in an error lane under the step that
failed into it, such as `charge#error/approval`. The reply's `step_key` names the wait the event
answered, and is `null` for an entry with no `step_key`.

Leave `step_key` out and the event answers the oldest wait on that topic that is still undecided and
more than two seconds from timing out. Sending the same event again therefore answers the next wait
on that topic, if there is one — so in a workflow with several approvals on one topic, send each
decision with its `step_key`, as the inbox does. An entry with no `step_key` is answered by topic only,
and is refused while any of its waits is within two seconds of timing out.

The steps after the wait execute, and the run reads `waiting` until no other wait is left. The wait
drops out of the inbox, and once the run takes the decision its step records **who** decided and
**when** — in a run with several approvals, each step keeps its own. Each step in
`GET /api/runs/<run-id>` and in the MCP tool `orchestr_get_run` carries its `decided_by` and
`decided_at`. The run's own `decided_by` in `GET /api/runs/<run-id>` names the person when every
decision on the run was theirs, with `decided_at` the latest of them; both are `null` when different
people decided, or nobody has yet.

A run decided on a version before this one kept only its last decider. Upgrading puts that decision
on its step only when the run has a single approval it could have answered. Otherwise the decision
stays on the run: `GET /api/runs/<run-id>` reports it as `unattributed_decision`, the run's own
`decided_by` counts it, and **Runs** names its decider on the run rather than on a step. The run
keeps one such decision, the latest by the time recorded with it, so a wait answered on the run after
the upgrade can take its place.

The payload is available to later steps, so the decision itself can drive what happens next. A
decision sent without one reaches them as `null`.

An event answers exactly one wait. Once a wait is decided, every further event naming it by
`step_key` is refused with `409`. So is one that arrives after the run was cancelled, one naming by
`step_key` a wait within two seconds of timing out, and one sent by topic only when every undecided
wait on that topic is within two seconds of timing out. So is an event on a topic the run is not
waiting on, or with a `step_key` the run has no wait at, which the refusal lists, and the run keeps
waiting. A topic starting `orchestr:timer:` belongs to a **Wait** step and is always refused with the
code `timer_wait`, as is a `step_key` naming a **Wait** step, and any event while the run waits only
on a **Wait** step.

A decision is kept with the wait it answers until the run takes it, so a run that is down when you
decide picks the decision up when it comes back. Until then the run reads **Decided by** whoever made
it, and the wait is no longer in the inbox.

## If nobody decides

When `timeout_ms` passes, the wait ends rather than hanging forever. A run whose worker died while
waiting is [reaped](/run/runs/#when-a-worker-dies) rather than left in limbo. So is a run holding a
decision it can no longer resume to take: it ends in an error that names who decided.
