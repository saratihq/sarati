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
both steps, and marks what still needs connecting — sped up 4×:

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

> Let me run this fetch to make sure it returns real stories.
>
> That works — it came back with the front-page stories filtered to over 100 points. The top one
> right now is "Muse Glimmer: 30B-parameter model…" with 882 points.

## What it produces

Ordinary steps. Nothing special, nothing hidden:

```
orchestr:schedule   {"cron": "0 9 * * 1-5", "timezone": "UTC"}
http.send_request   {"method": "GET", "url": "https://hn.algolia.com/api/v1/search", …}
```

That is the same structure you get building by hand, so it diffs, reviews and merges like anything
else. A prompt change shows up as a field change.

## Check its work

It is a drafting tool, not an oracle.

**It states its assumptions on the node, not just in chat.** The schedule above carries a small
`assumed: UTC` label, because "9am" does not say whose 9am. Set the timezone you actually meant.

**It may solve the same request differently each time.** One run fetched the stories and filtered
them in a code step; another did both in a single HTTP call with a query filter. Both work — read
what it built.

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
