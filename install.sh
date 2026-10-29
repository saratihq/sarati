#!/bin/sh
# Sarati installer.  curl -fsSL https://get.sarati.io | sh
#
# Fetches the stack definition, then starts it. Re-running is safe: an existing install keeps its
# shape, its keys and its data.
set -eu

REPO="${SARATI_REPO:-saratihq/sarati}"
REF="${SARATI_REF:-main}"
DIR="${SARATI_DIR:-sarati}"
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

lower=abcdefghijklmnopqrstuvwxyz
digits=0123456789

# Prints KEY $1's value from the .env in directory $2 (default .), read the way docker compose reads it.
setting() {
  tr -d '\r' 2>/dev/null < "${2:-.}/.env" |
    sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}$1[[:space:]]*=[[:space:]]*//p" | tail -1 |
    sed -e 's/^"\([^"]*\)".*/\1/' -e t -e "s/^'\([^']*\)'.*/\1/" -e t -e 's/[[:space:]]#.*//' -e 's/[[:space:]]*$//'
}

is_here() { [ "$1" -ef . ]; }

# Succeeds only when $1 provably does not exist: its nearest existing parent can be searched.
gone() {
  [ ! -e "$1" ] || return 1
  up=$(dirname "$1")
  while [ ! -e "$up" ]; do up=$(dirname "$up"); done
  [ -x "$up" ]
}

# Succeeds when $1 is another directory that may hold the install named $project.
claims() {
  ! is_here "$1" && ! gone "$1" || return 1
  claimed=$(setting COMPOSE_PROJECT_NAME "$1")
  [ -z "$claimed" ] || [ "$claimed" = "$project" ]
}

# Succeeds when $taken's install may move back here: this directory has a .env, and $taken's names no install.
movable() { [ -f .env ] && [ -r "$taken/.env" ] && [ -z "$(setting COMPOSE_PROJECT_NAME "$taken")" ]; }

# Prints the first $1-N, from N=2, that no container or volume on this machine uses.
free_name() {
  base=${1%-[0-9]*}
  n=2
  while printf '%s\n' "$listing" | grep -q "^$base-$n " ||
    docker volume inspect "$base-${n}_data" >/dev/null 2>&1 || docker volume inspect "$base-${n}_db-data" >/dev/null 2>&1; do
    n=$((n + 1))
  done
  echo "$base-$n"
}

# Prints the first port from 9090 that nothing answers on, as far as nc can tell.
free_port() {
  p=9090
  if command -v nc >/dev/null 2>&1; then
    while nc -z localhost "$p" 2>/dev/null; do p=$((p + 1)); done
  fi
  echo "$p"
}

# Prints $1 quoted for pasting into a shell, when it needs quoting.
shq() {
  case "$1" in
    *[!ABCDEFGHIJKLMNOPQRSTUVWXYZ$lower${digits}_./-]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
    *) printf '%s' "$1" ;;
  esac
}

listed() { echo "$1" | sed 's/ /, /g'; }

again() { printf "%s sh -c 'curl -fsSL https://get.sarati.io | sh'" "$*"; }

command -v docker >/dev/null 2>&1 || die "Docker is required — install it from https://docs.docker.com/get-docker/ and re-run this."
docker compose version >/dev/null 2>&1 || die "This needs Docker Compose v2 (bundled with modern Docker Desktop and docker-ce)."
docker info >/dev/null 2>&1 || die "Docker is installed but not running — start it and re-run this."
listing=$(docker ps -a --filter label=com.docker.compose.project \
  --format '{{ .Label "com.docker.compose.project" }} {{ .Label "com.docker.compose.project.working_dir" }}') ||
  die "Docker could not list its containers, so this cannot tell which install runs from where."

mkdir -p "$DIR"
cd "$DIR"

PORT=${SARATI_PORT:-$(setting SARATI_PORT)}
PORT=${PORT:-8080}

# The compose files pin `name: sarati`; COMPOSE_PROJECT_NAME in .env overrides it for docker compose here.
named=${COMPOSE_PROJECT_NAME:-}
recorded=$(setting COMPOSE_PROJECT_NAME)
from=${recorded:+$(pwd)/.env}
if [ -z "$recorded" ]; then
  recorded=$(printf '%s\n' "$listing" | while read -r name dir; do if is_here "$dir"; then echo "$name"; fi; done | sort -u | paste -sd ' ' -)
fi
if [ -z "$from" ] && [ "${recorded#* }" != "$recorded" ]; then
  case " $recorded " in
    *" $named "*) ;;
    *) die "More than one install ($(listed "$recorded")) was started from $(pwd).
  Re-run this with COMPOSE_PROJECT_NAME set to the one that belongs here." ;;
  esac
elif [ -n "$recorded" ] && [ -n "$named" ] && [ "$named" != "$recorded" ]; then
  [ -z "$from" ] || die "$from names this install $recorded, not $named.
  To upgrade it, re-run this without COMPOSE_PROJECT_NAME. For a separate install, give it its own SARATI_DIR too."
  die "The install named $recorded was started from $(pwd), not $named.
  To upgrade it, re-run this without COMPOSE_PROJECT_NAME. If it belongs in another directory, re-run this there with COMPOSE_PROJECT_NAME=$recorded first."
fi
project=${named:-${recorded:-sarati}}
case "$project" in
  [!$lower$digits]* | *[!$lower${digits}_-]*)
    die "COMPOSE_PROJECT_NAME${from:+ in $from} takes lowercase letters, digits, dashes and underscores, starting with a letter or digit — not '$project'." ;;
esac
export COMPOSE_PROJECT_NAME="$project"

here=$(shq "$(pwd)")
taken=$(printf '%s\n' "$listing" | while read -r name dir; do if [ "$name" = "$project" ] && claims "$dir"; then echo "$dir"; fi; done | head -1)
if [ -n "$taken" ] && ! { [ -n "$named" ] && movable; }; then
  if movable; then
    instead="If it belongs here, move it back:  $(again COMPOSE_PROJECT_NAME="$project" SARATI_DIR="$here")"
  else
    instead="To install a separate one here:  $(again COMPOSE_PROJECT_NAME="$(free_name "$project")" SARATI_DIR="$here" SARATI_PORT="$(free_port)")"
  fi
  die "The install named $project runs from $taken — installing it here would take it over.
  To upgrade it there:  $(again SARATI_DIR="$(shq "$taken")")
  $instead"
fi

if [ -z "$named$recorded" ] && [ ! -f .env ] && ! printf '%s\n' "$listing" | grep -q "^$project "; then
  for volume in "${project}_data" "${project}_db-data"; do
    docker volume inspect "$volume" >/dev/null 2>&1 || continue
    die "The install named $project keeps its data in the $volume volume, but nothing runs it, and $(pwd) has no .env.
  To upgrade it, re-run this with SARATI_DIR set to its own directory.
  To run it from here:  $(again COMPOSE_PROJECT_NAME="$project" SARATI_DIR="$here")
  To install a separate one here:  $(again COMPOSE_PROJECT_NAME="$(free_name "$project")" SARATI_DIR="$here" SARATI_PORT="$(free_port)")"
  done
fi

# A port already in use is the single most common failure, and it is nicer to say so up front —
# but this install's OWN container holding it is an upgrade, not a conflict.
ours=""
if [ -f docker-compose.yaml ]; then
  ours=$(docker compose ps --quiet 2>/dev/null | head -1)
fi
if [ -z "$ours" ] && command -v nc >/dev/null 2>&1 && nc -z localhost "$PORT" 2>/dev/null; then
  die "Port $PORT is already in use. Re-run with SARATI_PORT=$(free_port) (or any free port)."
fi

# A fresh machine gets the one-container product. An install that already exists keeps the shape it
# was built with — the two store their data differently, so switching underneath it would look
# exactly like data loss. Anything installed before this existed is compose.
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
  if [ -z "$(setting COMPOSE_PROJECT_NAME)" ]; then
    [ -z "$(tail -c 1 .env)" ] || echo >> .env
    echo "COMPOSE_PROJECT_NAME=$project" >> .env
    say "Saved COMPOSE_PROJECT_NAME=$project into .env, so docker compose here acts on this install alone."
  fi
elif [ "$stack" = single ]; then
  # No secrets are generated here: the container writes its own into the data volume, beside the
  # database they decrypt, so there is nothing that can be lost separately from the data.
  cat > .env <<EOF
SARATI_STACK=single
COMPOSE_PROJECT_NAME=${project}
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
    beside=$(free_name "$project")
    die "A Sarati database already exists on this machine, but its .env is gone — these new secrets would not match it.
  Restore that .env if you have it: a new FERNET_KEY cannot decrypt credentials the old one stored.
  To leave it alone and run a separate install beside it:  $(again COMPOSE_PROJECT_NAME="$beside" SARATI_DIR="$beside" SARATI_PORT="$(free_port)")
  To erase that database and start over:  docker volume rm ${project}_db-data"
  fi

  say "Generating this install's secrets…"
  # Base64url so the values are safe unquoted in an env file.
  rand() { LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$1"; }
  cat > .env <<EOF
SARATI_STACK=compose
COMPOSE_PROJECT_NAME=${project}
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
    echo "  logs:  cd $(shq "$DIR") && docker compose logs -f"
    echo "  stop:  cd $(shq "$DIR") && docker compose down"
    warn_if_unsafe
    exit 0
  fi
  printf '.'
  i=$((i + 1))
  sleep 2
done

printf '\n'
warn_if_unsafe
die "It did not answer within 3 minutes. Check: cd $(shq "$DIR") && docker compose logs"
