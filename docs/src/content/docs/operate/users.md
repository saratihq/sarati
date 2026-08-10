---
title: Users and organizations
description: Invite people, and decide who can ship.
---

The first account on an instance is the owner. **Everyone after joins by invite** — signing up
without one is refused:

```json
{"code":"signup_closed",
 "detail":"This instance is not open for signup — ask an owner for an invite link."}
```

## Personal and organization

Every account has a **personal** workspace of its own. Work you want to share lives in an
organization, which you create from the user menu.

The organization switcher decides which workspace you are looking at, and workflows do not move
between them.

## Invite someone

Settings → Organization → invite, or:

```bash
curl -X POST http://localhost:8080/api/orgs/<org-id>/invites \
  -H 'Content-Type: application/json' \
  -d '{"email":"sam@example.com","role":"member"}'
```

That returns an invite token. The link built from it is what the new person opens — they set a
password and land in the organization.

An invite is **token-bound, not email-bound**: whoever holds the link joins. Treat it like a
password, and delete one you did not mean to send.

## Roles

Three: `owner`, `admin`, `member`.

| | member | admin · owner |
|---|---|---|
| Read workflows and runs | ✅ | ✅ |
| Create branches, commit, open reviews | ✅ | ✅ |
| Approve a review | ✅ | ✅ |
| **Publish or promote to production** | ❌ | ✅ |
| Invite people, change roles, org settings | ❌ | ✅ |

A member is a full contributor who cannot ship. The refusals name the reason:

> Only owners and admins can move the 'production' pointer in an organization

> Only owners and admins can manage this organization

## Reviews need someone else

An author cannot approve their own review while there is anyone else in the workspace — so a second
member is what turns [protected branches](/version-control/branches/#protect-a-branch) into a real
gate rather than a formality. Working alone, you can approve your own, otherwise nothing could ever
merge.

## Passwords

Passwords are at least 12 characters — length beats symbols. If someone is locked out, an operator
with shell access can reset one:

```bash
docker compose exec service sarati-set-password someone@example.com
```
