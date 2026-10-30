---
title: Users and organizations
description: Invite people, and decide who can ship.
---

The first account on an instance is the owner, and if two people sign up at once only one gets in.
Who can make an account after that depends on how the instance signs people in:

- **Email and password:** everyone after joins by invite — signing up without one is refused:

  ```json
  {"code":"signup_closed",
   "detail":"This instance is not open for signup — ask an owner for an invite link."}
  ```

- **[Single sign-on](#single-sign-on):** anyone your identity provider signs in gets an account of
  their own the first time — only from your email domains, if you set them.

Either way, an organization is joined only by an invite sent to your email address.

## Personal and organization

Every account has a **personal** workspace of its own, with one member: its owner. Nobody can be
invited into it, and its owner cannot leave it. Work you want to share lives in an organization,
which you create from the user menu.

The organization switcher decides which workspace you are looking at, and workflows do not move
between them. Opening a workflow that belongs to another of your workspaces (a teammate's link, a
bookmark, or a run in the approvals inbox) switches to that workspace and says so. A link to a
workflow in a workspace you are not in does not open, the same as a link to one that does not exist.

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
joins only if their account holds that address — for an account single sign-on made, one the
provider confirmed (the `email_verified` claim). Anyone else is refused, and the invite stays
pending:

```json
{"code":"invite_email_mismatch",
 "detail":"This invite was sent to a different email address than sam@personal.example. Ask whoever invited you to invite that address, or sign in with the account the invite was sent to."}
```

So invite the email on the person's Sarati account, shown in **Settings → Profile**. For an account
that signs in only through single sign-on, that is the confirmed address its provider releases,
kept up to date at each sign-in. An account with a password keeps the address it was made with,
even once single sign-on is connected to it, so it can differ from the provider's.

A first single sign-on carrying an invite that can still be used, but that was sent to another
address or to one your provider did not confirm, is refused and makes no account. One carrying an
invite that can no longer be used (accepted, revoked, expired, or into a personal workspace) makes
the account and joins nothing, as signing in from the sign-in screen does.

An invite admits one account: once someone has accepted it, the link is spent. A revoke and an
accept that cross, or two accepts by accounts not yet in the organization, take turns, and whichever
comes second answers `404`, as for an invite that isn't there. A password sign-up through the link
is an accept too: the account is made only together with joining, so a sign-up that comes second, or
uses a spent link, is refused as `signup_closed` and makes no account. Accepting again with an
account that is already in it is a no-op. A spent link says "This invite can't be used" as soon as
it opens.

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
- **An address the provider did not confirm holds nothing:** one account holds each confirmed
  address. An account made from an address the provider did not confirm (no `email_verified: true`)
  is still made, but no invite is matched to it, and it does not stop the person the provider does
  confirm at that address — or a password sign-up for it — from getting an account of their own. So
  someone who signs in first with another person's address locks no one out and gains no
  organization, and the sign-in answers alike whether an account already has that address or not.
  The address does show wherever their own account appears. For a provider that lets people set
  their own address, set `OIDC_ALLOWED_DOMAINS` too, which also requires the address to be confirmed.
- **An account follows the person, not the email:** Sarati keys it by the provider's subject
  (`sub`), so someone whose email changes at the provider still lands in their own account. An
  account that signs in only through single sign-on takes the address the provider confirms at each
  sign-in, unless another account holds it; an account with a password keeps its own. An email never
  connects anyone to an account that already exists: signing in with a confirmed address another
  account holds is refused with "You already have an account".
- **Connecting an existing account:** sign in with its password, then **Settings → Profile → Single
  sign-on → Connect**. It asks for the password again and sends you to the provider, which signs you
  in again even if it already has you signed in (`max_age=0`, with `prompt=login` where the provider
  lists it), so the identity connected is the one that just signed in — never one someone left signed
  in on that browser. Sarati checks the ID token's `auth_time` to be sure; a provider that does not
  send it cannot connect accounts this way, and an operator connects them with `sarati-link-sso`
  instead. After that, either way leads into the same account. **Disconnect** works only while the
  account has a password and the instance still allows passwords; otherwise it says why it is
  unavailable.
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

### Connecting accounts from the server

An operator with shell access can connect an account to its subject at the provider directly — for
an account that cannot sign in to connect it: one made before v0.2.27 by an identity-provider token
sent to the API, one made through Clerk, or one connected to an earlier `OIDC_ISSUER`. Connect them
before their owners sign in: a first sign-in through the provider by someone whose account is not
connected yet is refused as "You already have an account" when the provider confirms an email that
account holds, and otherwise makes them a new, empty account. The boot log counts the accounts still
waiting.

```bash
cd sarati && docker compose exec sarati sarati-link-sso --list
```

That lists each account that is not connected to `OIDC_ISSUER` but has signed in some other way,
tab-separated: its id, its email, and what Sarati knows about it — the subject the retired token
sign-in stored, a Clerk user id, or the subject it was connected as at another issuer. Then:

```bash
# An account the retired token sign-in made, to the subject it stored:
docker compose exec sarati sarati-link-sso sam@example.com
# Every such account at once:
docker compose exec sarati sarati-link-sso --all
# Any account, to the person's subject at your provider — by its email or its id:
docker compose exec sarati sarati-link-sso sam@example.com <their sub>
```

The `sub` is the person's ID at the provider, shown in its admin console. An account is found by the
email it holds confirmed, in any letter case; pass its id from `--list` for any other. On a
five-container install it is `docker compose exec service` instead.

When someone signed in before their account was connected and got a new account, that one holds
their subject, so connecting the old one is refused. Add `--move` to take the subject off the new
account and give it to the old one:

```bash
docker compose exec sarati sarati-link-sso sam@example.com <their sub> --move
```

Their next sign-in lands in the old account. The new one keeps what it holds but no longer signs in
through the provider, and, with no password either, gives up its address — which the old account,
when it has no password of its own, takes at that sign-in.

### Switching from Clerk

Clerk and your own provider cannot both be set, and an email never connects an account, so each
person's Clerk account is connected to their subject at the new provider by an operator. Do it while
Clerk is still on, naming the new issuer for each command, so everyone's first sign-in through the
provider already lands in their account:

1. List the accounts, then connect each to the person's subject at the new provider — its admin
   console shows it — from a file of `email,sub` lines:

   ```bash
   docker compose exec -e OIDC_ISSUER=https://login.example.com sarati sarati-link-sso --list
   while IFS=, read -r email sub; do
     docker compose exec -T -e OIDC_ISSUER=https://login.example.com sarati sarati-link-sso "$email" "$sub" < /dev/null
   done < subjects.csv
   ```

2. Remove `CLERK_ISSUER` and `CLERK_SECRET_KEY`, set the three `OIDC_*` values, and run
   `docker compose up -d`. Clerk sessions stop working, and the boot log counts any account still
   not connected.

Someone not connected yet who signs in with an email their Clerk account holds, confirmed by the
provider, is refused until it is connected; otherwise they get a new account, which `--move` sets
right.

### Changing `OIDC_ISSUER`

Accounts are connected per issuer, so a new `OIDC_ISSUER` — another provider, or the same one at a
new address — connects nobody, and every single sign-on session from the old one stops working.
Connect everyone at the new issuer first, as for Clerk above:
`docker compose exec -e OIDC_ISSUER=<the new issuer> sarati sarati-link-sso --list` shows each
account with the subject it has at the old one. For the same provider at a new address, whose
subjects stayed the same, connect each account to that subject; for another provider, to the
person's subject there. Then set the new `OIDC_ISSUER`.

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
