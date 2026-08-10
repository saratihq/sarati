---
title: Environments
description: Point each environment at its own version, with its own accounts and its own URLs.
---

An environment is a **pointer at one version**. A fresh install has `production`, `staging` and
`uat`.

`production` and `uat` cannot be renamed or deleted.

The workflow overview shows which version each environment is on, and whether the branch head has
moved past it:

<img class="shot shot-dark" src="/shots/env-rail-dark.webp" alt="A workflow overview with the runtime rail showing the live version and trigger state." />
<img class="shot shot-light" src="/shots/env-rail-light.webp" alt="A workflow overview with the runtime rail showing the live version and trigger state." />

## Promote

Promoting moves the pointer. Nothing is copied, and the version being promoted does not change.

```
POST /api/workflows/<id>/promote
{"environment":"staging","version_id":"40cb9926-…"}

{"status":"promoted","environment":"staging","version_number":1,"previous_version_number":null}
```

Two environments can sit on different versions of the same workflow at the same time, and each has
its own webhook URL:

```bash
curl -X POST http://localhost:8080/api/hooks/<id>/production   # runs v7 → 10 stories
```

```bash
curl -X POST http://localhost:8080/api/hooks/<id>/staging      # runs v1 → 7 stories
```

Same workflow. Same moment. Different versions, because the pointers differ.

## Where a branch can go

`staging` and any environment you add accept a version from **any branch** — that is the point of a
staging environment.

`production` and `uat` take the default branch only:

> 'production' promotes from the default branch only — merge the branch first.

So the path to production runs through `main`, and through whatever review gate `main` carries.

## Connections belong to the environment

A step names the app it needs; the environment supplies the account. Staging hits the sandbox
account, production hits the real one, and the workflow document never contains a credential.

Sharing a workflow therefore never shares a credential.

## Publishing

**Publish** is promote-to-production. See
[Save, version, publish](/version-control/save-version-publish/).
