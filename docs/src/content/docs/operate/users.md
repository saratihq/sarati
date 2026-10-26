---
title: Users and organizations
description: Invite people, and decide who can ship.
---

The first account on an instance is the owner, and if two people sign up at once only one gets in.
**Everyone after joins by invite** — signing up without one is refused:

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

A new account can only be created with the email address the invite was sent to. Someone who
already has an account joins by opening the link while signed in — for them the link alone is
enough, so treat it like a password and delete one you did not mean to send.

An invite admits one account: once someone has accepted it, the link is spent. A revoke and an
accept that cross, or two accepts by accounts not yet in the organization, take turns, and whichever
comes second answers `404`, as for an invite that isn't there. Signing up with the link is an accept
too: the account is made only together with joining, so a sign-up that comes second, or uses a spent
link, is refused as `signup_closed` and makes no account. Accepting again with an account that is
already in it is a no-op.

Only an owner can invite someone as an owner; an admin's attempt is refused.

<img class="shot shot-dark" src="/shots/org-members-dark.webp" alt="Organization settings: members with their roles, the invite form, and the danger zone." />
<img class="shot shot-light" src="/shots/org-members-light.webp" alt="Organization settings: members with their roles, the invite form, and the danger zone." />

## Roles

Three: `owner`, `admin`, `member`.

| | member | admin · owner |
|---|---|---|
| Read workflows and runs | ✅ | ✅ |
| Create branches, commit, open reviews | ✅ | ✅ |
| Approve a review | ✅ | ✅ |
| **Publish, promote or un-promote — to any environment** | ❌ | ✅ |
| [Test a branch](/version-control/reviews/#review-it) under an environment — on Default, anyone can | ❌ | ✅ |
| Delete a workflow, protect or unprotect a branch | ❌ | ✅ |
| Invite and remove people, org settings | ❌ | ✅ |
| Change roles, transfer ownership, invite or remove an owner, delete the organization | ❌ | owner only |

A member is a full contributor who cannot ship: a workflow a member creates is saved, not live,
until an owner or admin publishes it. Creating a workflow gives no extra rights over it:
the role decides, and leaving the organization, or being removed, ends access to its workflows and
their runs, including the ones you created. The refusals name the reason:

> Only owners and admins can move the 'staging' pointer in an organization

> Only owners can change member roles

In your personal workspace you are the owner, so none of this applies.

## Reviews need someone else

An author cannot approve their own review while there is anyone else in the workspace — so a second
member is what turns [protected branches](/version-control/branches/#protect-a-branch) into a real
gate rather than a formality. Working alone, you can approve your own, otherwise nothing could ever
merge.

## Passwords

Passwords are at least 12 characters — length beats symbols. If someone is locked out, an operator
with shell access can reset one:

```bash
cd sarati && docker compose exec sarati sarati-set-password someone@example.com
```

On a five-container install the service is its own container, so it is `docker compose exec service`
instead. Running it by hand without the installer, it is `docker exec -it sarati`.
