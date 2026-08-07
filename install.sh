#!/bin/sh
# Sarati installer.  curl -fsSL https://get.sarati.io | bash
#
# Fetches the stack definition, generates this install's secrets, and starts it. Re-running is
# safe: an existing .env is never overwritten, so your keys and data survive an upgrade.
set -eu

REPO="${SARATI_REPO:-saratihq/sarati}"
REF="${SARATI_REF:-main}"
DIR="${SARATI_DIR:-sarati}"
PORT="${SARATI_PORT:-8080}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "Docker is required — install it from https://docs.docker.com/get-docker/ and re-run this."
docker compose version >/dev/null 2>&1 || die "This needs Docker Compose v2 (bundled with modern Docker Desktop and docker-ce)."
docker info >/dev/null 2>&1 || die "Docker is installed but not running — start it and re-run this."

# A port already in use is the single most common failure, and it is nicer to say so up front.
if command -v nc >/dev/null 2>&1 && nc -z localhost "$PORT" 2>/dev/null; then
  die "Port $PORT is already in use. Re-run with SARATI_PORT=9090 (or any free port)."
fi

mkdir -p "$DIR/docker"
cd "$DIR"

say "Fetching the stack definition…"
base="https://raw.githubusercontent.com/${REPO}/${REF}"
for f in docker-compose.yaml docker/Caddyfile; do
  curl -fsSL "$base/$f" -o "$f" || die "Could not download $f from $base"
done

if [ -f .env ]; then
  say "Keeping the existing .env — your keys and data are untouched."
else
  # The compose file pins one project name, so its volumes are shared by every install on this
  # machine unless COMPOSE_PROJECT_NAME says otherwise. Writing fresh secrets against an existing
  # database gives Postgres a password it never had (crash loop) and a FERNET_KEY that cannot
  # decrypt what the old one stored.
  project="${COMPOSE_PROJECT_NAME:-sarati}"
  if docker volume inspect "${project}_db-data" >/dev/null 2>&1; then
    die "A Sarati database already exists on this machine, but its .env is gone — these new secrets would not match it.
  Restore that .env if you have it: a new FERNET_KEY cannot decrypt credentials the old one stored.
  To run a SECOND instance alongside it:  COMPOSE_PROJECT_NAME=sarati-2 SARATI_DIR=sarati-2 SARATI_PORT=9090 sh -c 'curl -fsSL https://get.sarati.io | sh'
  To erase that database and start over:  docker volume rm ${project}_db-data"
  fi

  say "Generating this install's secrets…"
  # Base64url so the values are safe unquoted in an env file.
  rand() { LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$1"; }
  cat > .env <<EOF
SECRET_KEY=$(rand 48)
FERNET_KEY=$(rand 43)=
POSTGRES_PASSWORD=$(rand 32)
SARATI_URL=http://localhost:${PORT}
SARATI_PORT=${PORT}
SARATI_VERSION=${SARATI_VERSION:-latest}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
EOF
  chmod 600 .env
  say "Wrote $(pwd)/.env — back it up. Losing FERNET_KEY makes stored credentials unrecoverable."
fi

say "Starting Sarati…"
docker compose pull --quiet 2>/dev/null || true
docker compose up -d

printf '\nWaiting for it to come up'
i=0
while [ "$i" -lt 90 ]; do
  if curl -fsS "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
    printf '\n\n'
    say "Sarati is running at http://localhost:${PORT}"
    echo "Open it and create the owner account — the first account is yours, everyone after joins by invite."
    echo
    echo "  logs:  cd $DIR && docker compose logs -f"
    echo "  stop:  cd $DIR && docker compose down"
    exit 0
  fi
  printf '.'
  i=$((i + 1))
  sleep 2
done

printf '\n'
die "It did not answer within 3 minutes. Check: cd $DIR && docker compose logs"
