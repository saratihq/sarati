---
title: Users and organizations
description: Invite people, and decide who can ship.
---

The first account on an instance is the owner. Who can make an account after that depends on how
the instance signs people in:

- **Email and password:** everyone after joins by invite — signing up without one is refused:

  ```json
  {"code":"signup_closed",
   "detail":"This instance is not open for signup — ask an owner for an invite link."}
  ```

- **[Single sign-on](#single-sign-on):** anyone your identity provider signs in gets an account of
  their own the first time — only from your email domains, if you set them.

Either way, an organization is joined only by an invite sent to your email address.

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
password, or continue with single sign-on, and land in the organization.

An invite admits only the account at the address it was sent to. A new password account is created
with that address; someone who continues with single sign-on, or opens the link already signed in,
joins only if their account's email is that address — for an account single sign-on made, an
address the provider confirmed (the `email_verified` claim). Anyone else holding the link is
refused, and the invite stays pending:

```json
{"code":"invite_email_mismatch",
 "detail":"This invite was sent to a different email address than sam@personal.example. Ask whoever invited you to invite that address, or sign in with the account the invite was sent to."}
```

So invite the address people sign in with — at your identity provider, that is the email it
releases for them.

An invite admits one account: once someone has accepted it, the link is spent. A revoke and an
accept that cross, or two accepts by accounts not yet in the organization, take turns, and whichever
comes second answers `404`, as for an invite that isn't there. Accepting again with an account that
is already in it is a no-op, and signing up with a spent link is refused as `signup_closed`. A spent
link says "This invite can't be used" as soon as it opens.

Only an owner can invite someone as an owner; an admin's attempt is refused.

<img class="shot shot-dark" src="/shots/org-members-dark.webp" alt="Organization settings: members with their roles, the invite form, and the danger zone." />
<img class="shot shot-light" src="/shots/org-members-light.webp" alt="Organization settings: members with their roles, the invite form, and the danger zone." />

## Single sign-on

Once single sign-on is [configured](/operate/configuration/#single-sign-on):

- **Who gets an account:** the first person to sign in on an empty instance becomes its owner, as with
  a password. After that, anyone your identity provider signs in gets an account the first time, with
  a personal workspace and no organization until someone invites them. With `OIDC_ALLOWED_DOMAINS`
  set, only addresses at those domains get in, and only when the provider confirms the address
  (the `email_verified` claim).
- **A provider anyone can join:** with Google, Apple, GitLab.com or personal Microsoft accounts as the
  provider, anyone with an account there can make one here unless `OIDC_ALLOWED_DOMAINS` is set. In
  production the boot log warns.
- **A provider that lets people set their own address:** set `OIDC_ALLOWED_DOMAINS` too, which also
  requires the address to be confirmed. Without it, someone can sign in first with another person's
  address: each email holds one account, so the real person is then refused as "You already have an
  account", and the other account shows that address in member lists and approvals. It gains no
  organization, since an invite is never matched to an address the provider did not confirm.
- **An account follows the person, not the email:** Sarati keys it by the provider's subject
  (`sub`), so someone whose email changes at the provider still lands in their own account. An email
  never connects anyone to an account that already exists: signing in with the email of an existing
  account is refused with "You already have an account".
- **Connecting an existing account:** sign in with its password, then **Settings → Profile → Single
  sign-on → Connect**. It asks for the password again and sends you to the provider; after that,
  either way leads into the same account. **Disconnect** works only while the account has a password
  and the instance still allows passwords; otherwise it says why it is unavailable.
- **Moving an instance over:** set the three `OIDC_*` values with `LOCAL_AUTH_ENABLED=true`, have
  everyone connect, then remove `LOCAL_AUTH_ENABLED`. Passwords then stop working, so every sign-in
  goes through the provider and its MFA.
- **Sessions:** a sign-in lasts 12 hours. Removing someone at the provider stops their next sign-in,
  not one already open. Signing out of Sarati leaves the provider signed in, and the sign-in screen
  says so — on a shared computer, sign out there too.
- **Offboarding:** removing someone at the provider does not touch what they already hold here. To
  end their access to an organization at once, remove them from it in Settings → Organization: that
  covers a session still open and their [API keys](/agents/api-keys/), since a key acts only in its
  owner's personal workspace. Keys they made keep working there until revoked, and only their owner
  sees them, in Settings → API keys.

An operator with shell access can connect an account to its subject at the provider directly — for
an account that cannot sign in to connect it, such as one made before v0.2.27 by an identity-provider
token sent to the API:

```bash
cd sarati && docker compose exec sarati sarati-link-sso sam@example.com <their sub>
```

The `sub` is the person's ID at the provider; the old token path stored it as the account's
`clerk_user_id`. On a five-container install it is `docker compose exec service` instead.

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

With single sign-on on and passwords off, this is also the way in while the provider is down: set
`LOCAL_AUTH_ENABLED=true`, run `docker compose up -d`, and sign in with the password you set.
