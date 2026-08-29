#!/bin/sh
# One container, the whole product: Postgres, service, agent, client and the proxy.
#
# The bundled database is REAL Postgres, not an embedded stand-in — the engine needs concurrent
# connections (service + agent), pg-boss and DBOS, none of which a single-connection embedded
# Postgres can carry. So this install is a supported single-machine install, and outgrowing it is
# `pg_dump` plus a DATABASE_URL, not starting over.
set -e

PGDATA=/data/postgres
DB_USER=sarati
DB_NAME=sarati

if [ -n "$DATABASE_URL" ]; then
  # An operator pointed us at their own Postgres: don't start ours, and don't touch their data.
  echo "sarati: using the DATABASE_URL you supplied; the bundled database stays stopped."
  sed -i '/^\[program:postgres\]/,/^$/d' /etc/supervisord.conf
else
  if [ ! -s "$PGDATA/PG_VERSION" ]; then
    echo "sarati: first boot — creating the bundled database in $PGDATA."
    mkdir -p "$PGDATA" /run/postgresql
    chown -R postgres:postgres "$PGDATA" /run/postgresql
    su-exec postgres initdb -D "$PGDATA" -U "$DB_USER" --auth-local=trust --auth-host=trust >/dev/null
    su-exec postgres pg_ctl -D "$PGDATA" -o "-c listen_addresses='' -c unix_socket_directories=/tmp" -w start >/dev/null
    su-exec postgres createdb -h /tmp -U "$DB_USER" "$DB_NAME"
    su-exec postgres pg_ctl -D "$PGDATA" -w stop >/dev/null
    echo "sarati: bundled database created. Back up the /data volume — it holds your workflows AND"
    echo "sarati: the keys that decrypt your stored credentials."
  fi
  chown -R postgres:postgres "$PGDATA"
  export DATABASE_URL="postgresql://${DB_USER}@127.0.0.1:5432/${DB_NAME}"
  echo "sarati: using the bundled database. Set DATABASE_URL to run against your own Postgres."
fi

mkdir -p /data
chown node:node /data

# The service and the agent must share one SECRET_KEY — the agent verifies sessions the service
# issued. The service's entrypoint would generate them, but only into its own process, so they are
# created HERE and inherited by both. Same file and same format the service already expects.
SECRETS_FILE="${SARATI_SECRETS_FILE:-/data/secrets.env}"
if [ ! -f "$SECRETS_FILE" ]; then
  node -e '
    const { randomBytes } = require("node:crypto");
    const b64url = (n) => randomBytes(n).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
    process.stdout.write(`SECRET_KEY=${b64url(48)}\nFERNET_KEY=${b64url(32)}\n`);
  ' > "$SECRETS_FILE"
  chmod 600 "$SECRETS_FILE"
  chown node:node "$SECRETS_FILE"
  echo "sarati: generated SECRET_KEY and FERNET_KEY into $SECRETS_FILE."
fi
while IFS='=' read -r key value; do
  [ -n "$key" ] || continue
  eval "current=\${$key:-}"
  [ -n "$current" ] || export "$key=$value"
done < "$SECRETS_FILE"

# One origin in front of everything, exactly as the compose proxy does it.
SARATI_URL="${SARATI_URL:-http://localhost:8080}"
export CORS_ORIGINS="${CORS_ORIGINS:-$SARATI_URL}"
export FRONTEND_URL="${FRONTEND_URL:-$SARATI_URL}"
export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-$SARATI_URL}"
export WORKFLOW_SERVICE_URL="${WORKFLOW_SERVICE_URL:-http://127.0.0.1:8001}"
export DATABASE_URL

# `docker exec` starts from the image environment, so the recovery tools an operator runs that way
# would not see anything computed above. Leave it where they can read it.
printf 'DATABASE_URL=%s\n' "$DATABASE_URL" > /data/runtime.env
chmod 600 /data/runtime.env
chown node:node /data/runtime.env

exec /usr/bin/supervisord -c /etc/supervisord.conf
