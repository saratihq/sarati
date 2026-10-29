#!/bin/sh
# Sarati installer.  curl -fsSL https://get.sarati.io | sh
#
# Fetches the stack definition, then starts it. Re-running is safe: an existing install keeps its
# shape, its keys and its data.
set -eu

REPO="${SARATI_REPO:-saratihq/sarati}"
REF="${SARATI_REF:-main}"
DIR="${SARATI_DIR:-sarati}"
PORT="${SARATI_PORT:-8080}"
# Raised to each published advisory's patched version.
SAFE_VERSION=0.2.26
ADVISORIES=https://github.com/saratihq/sarati/security/advisories

say() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Succeeds only when $1 is a release (MAJOR.MINOR.PATCH) before $2.
before() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    if (a !~ /^[0-9]+\.[0-9]+\.[0-9]+$/) exit 1
    split(a, x, "."); split(b, y, ".")
    for (i = 1; i <= 3; i++) if (x[i] + 0 != y[i] + 0) exit !(x[i] + 0 < y[i] + 0)
    exit 1
  }'
}

running_version() {
  id=$(docker compose ps -q "$1" 2>/dev/null | head -1)
  [ -z "$id" ] || docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "$id" 2>/dev/null || true
}

warn_if_unsafe() {
  before "$running" "$SAFE_VERSION" || return 0
  printf '\n' >&2
  warn "this install runs Sarati $running. Every version before $SAFE_VERSION has a published security advisory:"
  echo "  $ADVISORIES" >&2
  if [ -n "$pulled" ]; then
    echo "  To upgrade, set SARATI_VERSION in $(pwd)/.env to latest, or to $SAFE_VERSION or later, and re-run this." >&2
    return 0
  fi
  echo "  Downloading the images failed this time${pull_error:+: $pull_error}" >&2
  echo "  Fix that and re-run this, with SARATI_VERSION in $(pwd)/.env set to latest, or to $SAFE_VERSION or later." >&2
}

command -v docker >/dev/null 2>&1 || die "Docker is required — install it from https://docs.docker.com/get-docker/ and re-run this."
docker compose version >/dev/null 2>&1 || die "This needs Docker Compose v2 (bundled with modern Docker Desktop and docker-ce)."
docker info >/dev/null 2>&1 || die "Docker is installed but not running — start it and re-run this."

mkdir -p "$DIR"
cd "$DIR"

# A port already in use is the single most common failure, and it is nicer to say so up front —
# but this install's OWN container holding it is an upgrade, not a conflict.
ours=""
if [ -f docker-compose.yaml ]; then
  ours=$(docker compose ps --quiet 2>/dev/null | head -1)
fi
if [ -z "$ours" ] && command -v nc >/dev/null 2>&1 && nc -z localhost "$PORT" 2>/dev/null; then
  die "Port $PORT is already in use. Re-run with SARATI_PORT=9090 (or any free port)."
fi

# A fresh machine gets the one-container product. An install that already exists keeps the shape it
# was built with — the two store their data differently, so switching underneath it would look
# exactly like data loss. Anything installed before this existed is compose.
project="${COMPOSE_PROJECT_NAME:-sarati}"
if [ -n "${SARATI_STACK:-}" ]; then
  stack="$SARATI_STACK"
elif [ -f .env ] && grep -q '^SARATI_STACK=' .env; then
  stack=$(sed -n 's/^SARATI_STACK=//p' .env | head -1)
elif [ -f .env ] || docker volume inspect "${project}_db-data" >/dev/null 2>&1; then
  stack=compose
else
  stack=single
fi
case "$stack" in
  single | compose) ;;
  *) die "SARATI_STACK must be 'single' or 'compose', not '$stack'." ;;
esac

say "Fetching the stack definition…"
base="https://raw.githubusercontent.com/${REPO}/${REF}"
if [ "$stack" = single ]; then
  curl -fsSL "$base/docker-compose.single.yaml" -o docker-compose.yaml ||
    die "Could not download docker-compose.single.yaml from $base"
else
  mkdir -p docker
  for f in docker-compose.yaml docker/Caddyfile; do
    curl -fsSL "$base/$f" -o "$f" || die "Could not download $f from $base"
  done
fi

if [ -f .env ]; then
  say "Keeping the existing .env — your keys and data are untouched."
elif [ "$stack" = single ]; then
  # No secrets are generated here: the container writes its own into the data volume, beside the
  # database they decrypt, so there is nothing that can be lost separately from the data.
  cat > .env <<EOF
SARATI_STACK=single
SARATI_URL=http://localhost:${PORT}
SARATI_PORT=${PORT}
SARATI_VERSION=${SARATI_VERSION:-latest}
EOF
  chmod 600 .env
else
  # The compose file pins one project name, so its volumes are shared by every install on this
  # machine unless COMPOSE_PROJECT_NAME says otherwise. Writing fresh secrets against an existing
  # database gives Postgres a password it never had (crash loop) and a FERNET_KEY that cannot
  # decrypt what the old one stored.
  if docker volume inspect "${project}_db-data" >/dev/null 2>&1; then
    die "A Sarati database already exists on this machine, but its .env is gone — these new secrets would not match it.
  Restore that .env if you have it: a new FERNET_KEY cannot decrypt credentials the old one stored.
  To leave it alone and install the one-container product:  SARATI_STACK=single sh -c 'curl -fsSL https://get.sarati.io | sh'
  To run a SECOND instance alongside it:  COMPOSE_PROJECT_NAME=sarati-2 SARATI_DIR=sarati-2 SARATI_PORT=9090 sh -c 'curl -fsSL https://get.sarati.io | sh'
  To erase that database and start over:  docker volume rm ${project}_db-data"
  fi

  say "Generating this install's secrets…"
  # Base64url so the values are safe unquoted in an env file.
  rand() { LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$1"; }
  cat > .env <<EOF
SARATI_STACK=compose
SECRET_KEY=$(rand 48)
FERNET_KEY=$(rand 43)=
POSTGRES_PASSWORD=$(rand 32)
SARATI_URL=http://localhost:${PORT}
SARATI_PORT=${PORT}
SARATI_VERSION=${SARATI_VERSION:-latest}
EOF
  chmod 600 .env
  say "Wrote $(pwd)/.env — back it up. Losing FERNET_KEY makes stored credentials unrecoverable."
fi

say "Starting Sarati…"
pulled=yes
pull_error=""
if ! pull_output=$(docker compose pull --quiet 2>&1); then
  pulled=""
  pull_error=$(printf '%s\n' "$pull_output" | sed '/^[[:space:]]*$/d' | tail -1)
fi
docker compose up -d
if [ "$stack" = single ]; then
  running=$(running_version sarati)
else
  running=$(running_version service)
fi

printf '\nWaiting for it to come up'
i=0
while [ "$i" -lt 90 ]; do
  if curl -fsS "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
    printf '\n\n'
    say "Sarati is running at http://localhost:${PORT}"
    echo "Open it and create the owner account — the first account is yours, everyone after joins by invite."
    echo
    if [ "$stack" = single ]; then
      echo "  back up:  the ${project}_data volume — it holds your workflows AND the keys that decrypt your credentials."
    fi
    echo "  logs:  cd $DIR && docker compose logs -f"
    echo "  stop:  cd $DIR && docker compose down"
    warn_if_unsafe
    exit 0
  fi
  printf '.'
  i=$((i + 1))
  sleep 2
done

printf '\n'
warn_if_unsafe
die "It did not answer within 3 minutes. Check: cd $DIR && docker compose logs"
