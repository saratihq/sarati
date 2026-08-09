---
title: Steps
description: The built-in control steps, and where app actions come from.
---

**+ Add step** opens the catalog. Search matches app names, action names and descriptions.

Each entry is badged:

- **No account needed** — runs in-process, no credentials.
- **One-click managed sign-in available** — sign into the app once, then use it anywhere.

## Control steps

| Step | What it does |
|---|---|
| If | Branches the flow. The first output runs when the condition holds. |
| Switch | Routes by condition. N outputs, first match wins. |
| Loop | Repeats a body sub-flow. |
| Code | Runs a code snippet in a sandbox to transform data. |
| Wait for event | Pauses the run until an event arrives — including a human decision. |
| AI Agent | A durable tool-calling agent. |
| Call workflow | Calls another workflow, and can be bound as an agent's tool. |

## App actions

Everything else in the catalog is an action: send a message, create an issue, fetch a record.

Actions with no account requirement cover a lot on their own — HTTP requests, text, JSON, CSV,
XML, dates, maths, crypto, PDF, QR codes, and a few public APIs. They are useful for real work and
they make a workflow testable before you have connected anything.

## Writing your own

Actions are typed and defined once, in their own open-source package:

```bash
pnpm add @sarati/actions-sdk
```

See the [Actions SDK](https://www.npmjs.com/package/@sarati/actions-sdk) for `defineAction`,
`defineTrigger`, prop schemas and the HTTP client. It is MIT-licensed and independent of this
platform.
