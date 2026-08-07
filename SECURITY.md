# Security policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.** [Open a private advisory](https://github.com/saratihq/sarati/security/advisories/new)
on this repository instead — it keeps the report, the fix and the disclosure in one place. If you
would rather not use GitHub, email <security@sarati.io>.

Please include the version or commit you tested, what an attacker gains, and the smallest set of
steps that reproduces it. A proof of concept helps; a working exploit is not required.

You will get an acknowledgement within **3 working days** and an assessment — accepted, needs more
information, or not a vulnerability — within **10 working days**. If a report goes unanswered past
that, chase it on the other channel above.

We will tell you when a fix lands and credit you in the advisory unless you would rather stay
anonymous. Please give us a chance to ship the fix before disclosing publicly.

## Scope

Anything in this repository: the API and execution engine (`apps/service`), the UI (`apps/client`),
the AI composer (`apps/agent`), the container images, and the default self-host configuration.

Especially in scope, because they carry the sharp edges:

- Authentication and session handling, including token issuance and verification.
- Credential storage — stored connection secrets are encrypted at rest and must never be returned
  over the API.
- Webhook intake: signature verification, replay, and cross-tenant delivery.
- Expression and code steps escaping their sandbox.
- Any path that lets one organization read or run another's workflows, runs, or connections.

Out of scope: findings that need an already-compromised host or database, denial of service by
volume alone, missing hardening headers with no demonstrated impact, and reports about third-party
services we integrate with — take those to the service in question.

**Security is never behind the commercial boundary.** A fix is never withheld from the open core;
see [README.md](README.md#editions).

## Self-hosting

If you run Sarati yourself, two operational notes matter more than anything else:

- The container generates `SECRET_KEY` and `FERNET_KEY` on first boot and writes them to the data
  volume. Back that volume up: **losing `FERNET_KEY` makes stored credentials unrecoverable**, and
  rotating `SECRET_KEY` signs everyone out.
- `MOCK_AUTH` bypasses authentication entirely and exists for local development. `ENVIRONMENT=production`
  refuses to boot with it enabled, or with a placeholder `SECRET_KEY`. If you find a path where an
  unconfigured instance serves work unauthenticated instead of refusing it, that is a vulnerability
  and we want the report.
