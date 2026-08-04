#!/bin/sh
set -e

SECRETS_FILE="${SARATI_SECRETS_FILE:-/data/secrets.env}"

# Production boot refuses to start without these (see env.config.ts), and a shipped default would be
# no secret at all — so generate them once per install and keep them on the volume beside the data
# they protect. Losing this file makes stored OAuth credentials undecryptable.
if [ ! -f "$SECRETS_FILE" ]; then
  mkdir -p "$(dirname "$SECRETS_FILE")"
  node -e '
    const { randomBytes } = require("node:crypto");
    const b64url = (n) => randomBytes(n).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
    process.stdout.write(`SECRET_KEY=${b64url(48)}\nFERNET_KEY=${b64url(32)}\n`);
  ' > "$SECRETS_FILE"
  chmod 600 "$SECRETS_FILE"
  echo "sarati: generated SECRET_KEY and FERNET_KEY into $SECRETS_FILE (on the data volume)."
  echo "sarati: back that volume up — losing FERNET_KEY makes stored credentials unrecoverable."
fi

# Environment wins, so an operator supplying their own secrets is never overridden by the generated pair.
while IFS='=' read -r key value; do
  [ -n "$key" ] || continue
  eval "current=\${$key:-}"
  [ -n "$current" ] || export "$key=$value"
done < "$SECRETS_FILE"

# Durable execution is mandatory in production: without it a redeploy orphans in-flight runs. The
# version is deliberately stable rather than per-build, so a routine restart recovers its own runs.
export DBOS_ENABLED="${DBOS_ENABLED:-true}"
export DBOS_APP_VERSION="${DBOS_APP_VERSION:-orchestr-1}"

# Compose gates on Postgres being healthy, but a container restart can still beat it back up.
attempt=1
until node scripts/init-db.mjs && node scripts/migrate-db.mjs; do
  if [ "$attempt" -ge 10 ]; then
    echo "sarati: database is not reachable after $attempt attempts — giving up." >&2
    exit 1
  fi
  echo "sarati: database not ready (attempt $attempt) — retrying in 3s..."
  attempt=$((attempt + 1))
  sleep 3
done

exec "$@"
