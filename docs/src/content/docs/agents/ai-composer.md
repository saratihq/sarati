---
title: The AI composer
description: Describe a workflow and it builds one on the canvas. What it does well, and where to check it.
---

The composer is off until the instance has an Anthropic key. Add it to your install's `.env` and
restart:

```bash
ANTHROPIC_API_KEY=sk-ant-…
```

```bash
docker compose up -d
```

Without it, **New workflow** opens a bare canvas. With it, the same entry point opens the composer
alongside the canvas.

<img class="shot shot-dark" src="/shots/composer-dark.webp" alt="The composer panel beside an empty canvas, offering starting points and a prompt box." />
<img class="shot shot-light" src="/shots/composer-light.webp" alt="The composer panel beside an empty canvas, offering starting points and a prompt box." />

## What a real run looks like

Asked to post to Slack when a new email arrives, it plans, asks which mail account to watch, builds
both steps, and marks what still needs connecting — at double speed:

<video class="shot" src="/shots/agent-at-work.mp4" poster="/shots/agent-at-work-poster.webp" width="1128" height="664" autoplay loop muted playsinline aria-label="The composer planning a workflow, asking which email account to watch, then building a Gmail trigger and a Slack step with Connect buttons on both."></video>

Walked through in full, with a different request:

> Every weekday at 9am, fetch the top Hacker News stories and keep only the ones with more than 100
> points.

It sketches a plan before touching the canvas — trigger, steps, and what it still needs — then
waits:

> **Still needs:** Where should the filtered stories go — a Slack channel, an email, a spreadsheet,
> or just leave them for now?

Answer, and it builds. It narrates as it goes, and it tests its own work when nothing is
destructive:

> Neither touches anything live — it just reads Hacker News — so I'll run the whole thing once to
> make sure the fetch and filter work.
>
> ● Everything ran clean. It pulled 30 top stories and kept the popular ones — for example "How I
> use LLMs to learn complex topics" at 249 points made the cut, while a 44-point story got dropped.

## What it produces

Ordinary steps. Nothing special, nothing hidden:

```
orchestr:schedule            {"interval_minutes": 1440}
hackernews.fetch_top_stories {"limit": 30}
orchestr:code                {"language": "js", "code": "…"}
```

That is the same structure you get building by hand, so it diffs, reviews and merges like anything
else. A prompt change shows up as a field change.

## Check its work

It is a drafting tool, not an oracle. Two things to check every time:

**It can be wrong about the product.** In the run above it claimed there is no weekday-at-9am timer
and downgraded the schedule to a plain 24-hour interval — then wrote that caveat onto the node. The
claim is false: schedules take a cron expression with a timezone.

```json
{"cron": "0 9 * * 1-5", "timezone": "Europe/Zurich"}
```

Read what it built, not only what it said about what it built.

**It does not name the workflow.** However descriptive its plan, the workflow saves as *Untitled
workflow* until you rename it.

## Saving

Nothing reaches the server until you save.

| | |
|---|---|
| **Save and turn on** | Creates the workflow and makes it live. |
| **Save as a draft** | Keeps it in **this browser only** — no workflow is created, and it will not appear on your dashboard. Press **Save** in the header to actually store it. |
| **Keep tweaking** | Carries on the conversation. |

The composer commits versions. It never moves a live pointer on an existing workflow — see
[Save, version, publish](/version-control/save-version-publish/).
