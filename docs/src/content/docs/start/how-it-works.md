---
title: How Sarati works
description: Workflows, branches, versions, environments and runs — the five things everything else is built from.
---

Five things. Everything else follows from them.

## Workflow

Steps on a canvas, wired together. One step starts it — the trigger.

## Version

Every save is a version. A version is immutable: it is a record of exactly what the workflow was.

Saving never changes what is running.

## Branch

Versions live on a branch. `main` exists from the start; you can add more.

Version numbers are **per branch**. Your branch's first save is its v1, even though main already
has a v1. A version is always identified by its number *and* its branch.

A branch can be protected, which means it only takes change through an approved review.

## Environment

An environment is a pointer at one version.

A fresh install has `production`, `staging` and `uat`. `production` and `uat` cannot be renamed or
deleted. You can add others.

Promoting moves the pointer — nothing is copied, and the version being promoted does not change.

Connections belong to the environment, so a step names the app it needs and the environment
supplies the account. Staging hits the sandbox; production hits the real thing.

## Run

One execution of one version, in one environment.

Runs are durable. If the engine restarts mid-flight, a run resumes rather than being orphaned.

## How they fit

```
workflow
 └── branch (main, feature-x)
      └── version (v1, v2, …)   ← immutable, per-branch numbering
            ↑
       environment pointer (production → v2)
            ↓
           run
```

A change travels: **edit → save (new version) → review → merge → promote**. Each arrow is
deliberate, and none of them happen because someone was editing a canvas.

## Two rails for steps

Steps come from exactly two places:

- **Actions SDK** — first-party typed actions that run in-process. Many need no account at all.
  Write your own with [`@sarati/actions-sdk`](https://www.npmjs.com/package/@sarati/actions-sdk).
- **Managed connections** — apps you sign into once, brokered for you.

The catalog labels which is which: **No account needed** or **One-click managed sign-in
available**.
