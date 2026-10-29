#!/bin/sh
# Sarati installer.  curl -fsSL https://get.sarati.io | sh
#
# Fetches the stack definition, then starts it. Re-running is safe: an existing install keeps its
# shape, its keys and its data.
set -eu
unset CDPATH

REPO="${SARATI_REPO:-saratihq/sarati}"
REF="${SARATI_REF:-main}"
DIR="${SARATI_DIR:-sarati}"
# Raised to each published advisory's patched version.
SAFE_VERSION=0.2.26
ADVISORIES=https://github.com/saratihq/sarati/security/advisories

say() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[31merror:\033[0m %s\n' "$*" >&2
  while [ -n "${top:-}" ] && [ "$made" != "$top" ] && rmdir "$made" 2>/dev/null; do made=$(dirname "$made"); done
  exit 1
}

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
  printf '  %s\n' "$ADVISORIES" >&2
  if [ -n "$pulled" ]; then
    printf '  To upgrade, set SARATI_VERSION in %s/.env to latest, or to %s or later, and re-run this.\n' "$(pwd)" "$SAFE_VERSION" >&2
    return 0
  fi
  printf '  Downloading the images failed this time%s\n' "${pull_error:+: $pull_error}" >&2
  printf '  Fix that and re-run this, with SARATI_VERSION in %s/.env set to latest, or to %s or later.\n' "$(pwd)" "$SAFE_VERSION" >&2
}

lower=abcdefghijklmnopqrstuvwxyz
digits=0123456789

# Prints KEY $1 from the .env in directory $2 (default .), read the way docker compose reads it.
setting() {
  [ -r "${2:-.}/.env" ] || return 0
  LC_ALL=C tr -d '\r' < "${2:-.}/.env" |
    LC_ALL=C sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}$1[[:space:]]*=[[:space:]]*//p" | tail -1 |
    LC_ALL=C sed -e 's/^"\([^"]*\)".*/\1/' -e t -e "s/^'\([^']*\)'.*/\1/" -e t -e 's/[[:space:]]#.*//' -e 's/[[:space:]]*$//'
}

is_here() { [ "$1" -ef . ]; }

valid() { case "$1" in [!$lower$digits]* | *[!$lower${digits}_-]*) return 1 ;; esac; }

# Succeeds only when $1 provably does not exist: its nearest existing parent can be searched.
gone() {
  [ ! -e "$1" ] || return 1
  up=$(dirname "$1")
  while [ ! -e "$up" ]; do up=$(dirname "$up"); done
  [ -x "$up" ]
}

has_data() { printf '%s\n' "$volumes" | grep -qx -e "$1 data" -e "$1 db-data"; }

has_database() { printf '%s\n' "$stored" | awk -v v="${1}_db-data" '$1 == v { found = 1 } END { exit !found }'; }

started_here() {
  printf '%s\n' "$listing" | while read -r name dir; do if is_here "$dir"; then printf '%s\n' "$name"; fi; done | sort -u | paste -sd ' ' -
}

# Prints the installs started from here, and this directory's own name beside one when only its data is left.
found_here() {
  started=$(started_here)
  own=$(basename "$(pwd)")
  case "$started" in
    "" | *" "* | "$own") ;;
    *) if valid "$own" && has_data "$own" && ! printf '%s\n' "$listing" | grep -q "^$own "; then started="$started $own"; fi ;;
  esac
  echo "$started"
}

# Prints another install started from here whose running container publishes port $port.
holder() {
  for other in $(started_here); do
    [ "$other" != "$project" ] || continue
    for id in $(docker ps -q --filter "label=com.docker.compose.project=$other"); do
      case " $(echo $(docker port "$id" 2>/dev/null)) " in *:"$port "*) echo "$other" && return ;; esac
    done
  done
}

elsewhere() {
  printf '%s\n' "$listing" | while read -r name dir; do
    if [ "$name" = "$project" ] && [ -n "$dir" ] && ! is_here "$dir"; then printf '%s\n' "$dir"; fi
  done | sort -u
}

# Succeeds when a run told the name may take $project over from directory $1, which does not name it itself.
yields() {
  [ -n "$named$from" ] || return 1
  ! gone "$1" || return 0
  [ -x "$1" ] && { [ -r "$1/.env" ] || [ ! -e "$1/.env" ]; } || return 1
  [ "$(setting COMPOSE_PROJECT_NAME "$1")" != "$project" ]
}

blocker() {
  elsewhere | while read -r dir; do
    if ! yields "$dir"; then
      printf '%s\n' "$dir"
      break
    fi
  done
}

# Prints the first <base>-N from N=2 that nothing uses; <base> is $1 less its -N, and $2 = here allows this directory.
free_name() {
  case ${1##*-} in "" | *[!$digits]*) base=$1 ;; *) base=${1%-*} ;; esac
  n=2
  while printf '%s\n' "$listing" "$volumes" | grep -q "^$base-$n " || printf '%s\n' "$stored" | grep -q "^$base-${n}_" ||
    { [ -e "$parent/$base-$n" ] && ! { [ "${2:-}" = here ] && is_here "$parent/$base-$n"; }; }; do
    n=$((n + 1))
  done
  echo "$base-$n"
}

# Succeeds when port $1 is listened on, or bound by a container, stopped or not, that free_port saw.
busy() {
  case " $(echo $bound) " in *" $1 "*) return 0 ;; esac
  command -v nc >/dev/null 2>&1 && nc -z "$probe" "$1" 2>/dev/null
}

# Prints a SARATI_PORT on the address asked for whose port nothing holds.
free_port() {
  ids=$(docker ps -aq) || ids=""
  bound=""
  # A hint only: a port missed here is still checked before anything starts.
  [ -z "$ids" ] || bound=$(docker inspect --format '{{ range $p, $b := .HostConfig.PortBindings }}{{ range $b }} {{ .HostPort }}{{ end }}{{ end }}' $ids 2>/dev/null) || bound=""
  p=9090
  while busy "$p"; do p=$((p + 1)); done
  echo "${bind:+$bind:}$p"
}

# Prints $1 quoted for pasting into a shell, when it needs quoting.
shq() {
  case "$1" in
    *[!ABCDEFGHIJKLMNOPQRSTUVWXYZ$lower${digits}_./-]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
    *) printf '%s' "$1" ;;
  esac
}

again() { printf "%s sh -c 'curl -fsSL https://get.sarati.io | sh'" "$*"; }

listed() { echo "$1" | sed 's/ /, /g'; }

# Prints the command that copies the .env in directory $1 here, as private and writable as one this writes.
copy() { printf 'cp %s %s/.env && chmod 600 %s/.env && ' "$(shq "$1/.env")" "$here" "$here"; }

warn_left() {
  [ -z "$left" ] || printf '%s\n' "$left" | while read -r dir; do
    warn "$dir still has a docker-compose.yaml, and docker compose there would act on this install. Remove it:  rm $(shq "$dir/docker-compose.yaml")"
  done
}

# Prints the chmod a run in directory $1 needs first, to save the name in its read-only .env.
unlock() {
  [ ! -f "$1/.env" ] || [ -n "$(setting COMPOSE_PROJECT_NAME "$1")" ] || [ -w "$1/.env" ] || printf 'chmod u+w %s' "$(shq "$1/.env")"
}

# Succeeds when a plain run in directory $1, after unlock, would upgrade $project there.
passes() {
  (
    cd "$1" 2>/dev/null || exit 1
    [ ! -e .env ] || [ -r .env ] || exit 1
    named=""
    recorded=$(setting COMPOSE_PROJECT_NAME)
    from=${recorded:+.env}
    [ -n "$recorded" ] || recorded=$(found_here)
    [ "$recorded" = "$project" ] && [ -z "$(blocker)" ] && { [ -f .env ] || ! has_database "$project"; }
  )
}

# Refuses to take over $project, which runs from directory $1 or, with $1 empty, only keeps its data; says what would work.
refuse() {
  if [ -z "$1" ]; then
    lead="The install named $project is not running, but its data is kept"
    ways="
  To start it again, run docker compose up -d in its own directory."
  else
    lead="The install named $project runs from $1"
    ways=""
    fix=$(unlock "$1")
    ! passes "$1" || ways="
  To upgrade it there:  ${fix:+$fix && }$(again SARATI_DIR="$(shq "$1")")"
  fi
  if [ -z "$named$from" ] && (named=$project && [ -z "$(blocker)" ]); then
    if [ -z "$1" ]; then
      top=""
      ways="$ways
  To move it here, move the .env and docker-compose.yaml from its directory into $here, then:  $private$move"
      if has_database "$project"; then
        ways="$ways
  If its directory is gone, restore its .env into $here, then:  $private$move"
      else
        ways="$ways
  If its directory is gone:  $fresh"
      fi
    elif [ ! -f .env ] && [ -r "$1/.env" ] && [ -z "$(setting COMPOSE_PROJECT_NAME "$1")" ]; then
      top=""
      ways="$ways
  To move it here with its settings:  $(copy "$1")$move"
    elif [ ! -f .env ] && has_database "$project"; then
      top=""
      ways="$ways
  To move it here, restore its .env into $here, then:  $private$move"
    elif [ ! -f .env ]; then
      ways="$ways
  To move it here:  $fresh"
    else
      fix=$(unlock "$(pwd)")
      ways="$ways
  To move it here:  ${fix:+$fix && }$move"
    fi
  fi
  if [ ! -f .env ] && [ -z "$recorded" ]; then
    name=$(free_name "$project" here)
    into=$here
  else
    name=$(free_name "$project")
    into=$(shq "$parent/$name")
  fi
  die "$lead — installing it here would take it over.$ways
  To install a separate one:  $(again "${keep}COMPOSE_PROJECT_NAME=$name" SARATI_DIR="$into" SARATI_PORT="$(free_port)")"
}

# Prints the installs a .env naming none may be: sarati, and each other install whose data nothing runs.
candidates() {
  if printf '%s\n' "$listing" | grep -q '^sarati ' || has_data sarati; then echo sarati; fi
  {
    printf '%s\n' "$volumes" | awk 'NF == 2 { v[$1] = v[$1] " " $2 } END { for (p in v) if (v[p] == " data" || (v[p] ~ / db-data( |$)/ && v[p] ~ / service-data( |$)/)) print p }'
    printf '%s\n' "$volumes" | sed -n 's/^\(sarati-[0-9][0-9]*\) data$/\1/p; s/^\(sarati-[0-9][0-9]*\) db-data$/\1/p'
    own=$(basename "$(pwd)")
    ! valid "$own" || ! has_data "$own" || echo "$own"
  } | sort -u | while read -r name; do
    [ "$name" = sarati ] || printf '%s\n' "$listing" | grep -q "^$name " || printf '%s\n' "$name"
  done
}

case "${SARATI_STACK:-single}" in
  single | compose) ;;
  *) die "SARATI_STACK must be 'single' or 'compose', not '$SARATI_STACK'." ;;
esac
keep=""
[ -z "${SARATI_STACK:-}" ] || keep="SARATI_STACK=$SARATI_STACK "
[ -z "${SARATI_VERSION:-}" ] || keep="${keep}SARATI_VERSION=$(shq "$SARATI_VERSION") "
given=""
[ -z "${SARATI_VERSION:-}" ] || given="SARATI_VERSION=$(shq "$SARATI_VERSION") "
[ -z "${SARATI_PORT:-}" ] || given="${given}SARATI_PORT=$(shq "$SARATI_PORT") "

command -v docker >/dev/null 2>&1 || die "Docker is required — install it from https://docs.docker.com/get-docker/ and re-run this."
docker compose version >/dev/null 2>&1 || die "This needs Docker Compose v2 (bundled with modern Docker Desktop and docker-ce)."
docker info >/dev/null 2>&1 || die "Docker is installed but not running — start it and re-run this."
listing=$(docker ps -a --filter label=com.docker.compose.project \
  --format '{{ .Label "com.docker.compose.project" }} {{ .Label "com.docker.compose.project.working_dir" }}') ||
  die "Docker could not list its containers, so this cannot tell which install runs from where."
stored=$(docker volume ls --format '{{ .Name }} {{ .Label "com.docker.compose.project" }} {{ .Label "com.docker.compose.volume" }}') ||
  die "Docker could not list its volumes, so this cannot tell which install keeps which data."
volumes=$(printf '%s\n' "$stored" | awk 'NF == 3 { print $2, $3 }')

existing=$DIR
while [ ! -e "$existing" ]; do existing=$(dirname "$existing"); done
top=$(cd "$existing" && pwd -P) || die "Cannot reach $existing to make $DIR."
mkdir -p "$DIR"
cd "$DIR"
made=$(pwd -P)
[ "$made" != "$top" ] || top=""
[ ! -e .env ] || [ -r .env ] || die "Cannot read $(pwd)/.env, which holds this install's settings. Re-run this as the user that owns it."
parent=$(dirname "$(pwd)")

PORT=${SARATI_PORT:-$(setting SARATI_PORT)}
PORT=${PORT:-8080}
port=${PORT##*:}
bind=${PORT%"$port"}
bind=${bind%:}
case "$port" in "" | *[!$digits]*) die "SARATI_PORT takes a port, optionally after an address like 127.0.0.1:, not '$PORT'." ;; esac
case "$bind" in "" | 0.0.0.0 | :: | "[::]") host=localhost ;; \[*) host=$bind ;; *:*) host="[$bind]" ;; *) host=$bind ;; esac
probe=${host#\[}
probe=${probe%\]}

# The compose files pin `name: sarati`; COMPOSE_PROJECT_NAME in .env overrides it for docker compose here.
named=${COMPOSE_PROJECT_NAME:-}
recorded=$(setting COMPOSE_PROJECT_NAME)
from=${recorded:+$(pwd)/.env}
[ -n "$recorded" ] || recorded=$(found_here)
if [ -z "$from" ] && [ "${recorded#* }" != "$recorded" ]; then
  case " $recorded " in
    *" $named "*) ;;
    *) die "$(pwd) could hold more than one install: $(listed "$recorded").
  Re-run this with COMPOSE_PROJECT_NAME set to the one that belongs here." ;;
  esac
elif [ -n "$recorded" ] && [ -n "$named" ] && [ "$named" != "$recorded" ]; then
  [ -z "$from" ] || die "$from names this install $recorded, not $named.
  To upgrade it, re-run this without COMPOSE_PROJECT_NAME. For a separate install, give it its own SARATI_DIR too."
  die "The install named $recorded was started from $(pwd), not $named.
  To upgrade it, re-run this without COMPOSE_PROJECT_NAME. If it belongs in another directory, re-run this there with COMPOSE_PROJECT_NAME=$recorded first."
fi
project=${named:-${recorded:-sarati}}
valid "$project" ||
  die "COMPOSE_PROJECT_NAME${from:+ in $from} takes lowercase letters, digits, dashes and underscores, starting with a letter or digit — not '$project'."
export COMPOSE_PROJECT_NAME="$project"

here=$(shq "$(pwd)")
move=$(again COMPOSE_PROJECT_NAME="$project" SARATI_DIR="$here")
fresh=$(again "${given}COMPOSE_PROJECT_NAME=$project" SARATI_DIR="$here")
private="chmod 600 $here/.env && "
if [ -z "$named$recorded" ] && [ -f .env ]; then
  maybe=$(candidates)
  (named=$project && [ -z "$(blocker)" ]) || maybe=$(printf '%s\n' "$maybe" | sed '/^sarati$/d')
  if [ -n "$maybe" ] && { [ "$maybe" != sarati ] || [ -n "$(elsewhere)" ]; }; then
    list=""
    for name in $maybe; do
      dir=$(printf '%s\n' "$listing" | sed -n "s/^$name //p" | head -1)
      where="not running"
      [ -z "$dir" ] || where="runs from $dir"
      list="${list:+$list, }$name ($where)"
    done
    fix=$(unlock "$(pwd)")
    die "$(pwd)/.env names no install, and it could belong to $list.
  Re-run this with COMPOSE_PROJECT_NAME set to the one that belongs here, or to a new name for a separate install.${fix:+
  Its .env is read-only, so make it writable first:  $fix}"
  fi
fi
held=$(blocker)
[ -z "$held" ] || refuse "$held"
[ -n "$named$recorded" ] || [ -f .env ] || ! has_data "$project" || refuse ""
left=""
[ "$project" != sarati ] || left=$(elsewhere | while read -r dir; do
  if [ -f "$dir/docker-compose.yaml" ] && [ -z "$(setting COMPOSE_PROJECT_NAME "$dir")" ]; then printf '%s\n' "$dir"; fi
done)

# A fresh machine gets the one-container product. An install that already exists keeps the shape it
# was built with — the two store their data differently, so switching underneath it would look
# exactly like data loss. Anything installed before this existed is compose.
stack=${SARATI_STACK:-$(setting SARATI_STACK)}
if [ -z "$stack" ]; then
  if [ -f .env ] || has_database "$project"; then stack=compose; else stack=single; fi
fi
case "$stack" in
  single | compose) ;;
  *) die "SARATI_STACK must be 'single' or 'compose', not '$stack'." ;;
esac

# This install's own container publishing the port is an upgrade, not a conflict.
if [ "$stack" = single ]; then front=sarati; else front=proxy; fi
own=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$front") ||
  die "Docker could not list its containers, so this cannot tell which install runs from where."
published=$(for id in $own; do docker port "$id" 8080 2>/dev/null || true; done)
case " $(echo $published) " in
  *:"$port "*) ;;
  *)
    if command -v nc >/dev/null 2>&1 && nc -z "$probe" "$port" 2>/dev/null; then
      held=$(holder)
      [ -z "$held" ] || die "Port $PORT is held by the install named $held, which was also started from $(pwd).
  Run this for that install's own directory first, with COMPOSE_PROJECT_NAME=$held, then re-run this."
      [ ! -f .env ] || die "Port $PORT is already in use. Set SARATI_PORT in $(pwd)/.env to a free port, $(free_port) for example, and SARATI_URL to match, then re-run this."
      die "Port $PORT is already in use. Re-run with SARATI_PORT=$(free_port) (or any free port)."
    fi
    ;;
esac

if [ "$stack" = compose ] && [ ! -f .env ] && has_database "$project"; then
  top=""
  kept=$(elsewhere | while read -r dir; do
    if [ -r "$dir/.env" ] && [ -z "$(setting COMPOSE_PROJECT_NAME "$dir")" ]; then printf '%s\n' "$dir" && break; fi
  done)
  [ -z "$kept" ] || die "The install named $project runs from $kept, and the keys to its database are in its .env, not here.
  To move it here:  $(copy "$kept")$move"
  name=$(free_name "$project")
  erase="
  To erase that database and start over:  docker volume rm ${project}_db-data"
  if printf '%s\n' "$listing" | grep -q "^$project "; then
    where=$(elsewhere | head -1)
    case " $(started_here) " in
      *" $project "*) erase="
  To erase that database and start over:  docker rm -f \$(docker ps -aq --filter label=com.docker.compose.project=$project) && docker volume rm ${project}_db-data" ;;
      *) erase="${where:+
  The install named $project was started from $where and still uses that database.}" ;;
    esac
  fi
  die "A Sarati database already exists on this machine, but its .env is gone — these new secrets would not match it.
  A new FERNET_KEY cannot decrypt credentials the old one stored. To keep them, restore that .env into $here, then:  $private$move
  To leave it alone and run a separate install beside it:  $(again "${keep}COMPOSE_PROJECT_NAME=$name" SARATI_DIR="$(shq "$parent/$name")" SARATI_PORT="$(free_port)")$erase"
fi

fix=$(unlock "$(pwd)")
[ -z "$fix" ] ||
  die "$(pwd)/.env is read-only, and this needs to save COMPOSE_PROJECT_NAME=$project in it. Add that line yourself, or make it writable:  $fix"

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
SARATI_URL=http://${host}:${port}
SARATI_PORT=${PORT}
SARATI_VERSION=${SARATI_VERSION:-latest}
EOF
  chmod 600 .env
else
  say "Generating this install's secrets…"
  # Base64url so the values are safe unquoted in an env file.
  rand() { LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$1"; }
  cat > .env <<EOF
SARATI_STACK=compose
COMPOSE_PROJECT_NAME=${project}
SECRET_KEY=$(rand 48)
FERNET_KEY=$(rand 43)=
POSTGRES_PASSWORD=$(rand 32)
SARATI_URL=http://${host}:${port}
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
# Compose recreates only what changed, so a move recreates every container for each one's labels to name this directory.
if [ -n "$(elsewhere)" ]; then docker compose up -d --force-recreate; else docker compose up -d; fi
if [ "$stack" = single ]; then
  running=$(running_version sarati)
else
  running=$(running_version service)
fi

printf '\nWaiting for it to come up'
i=0
while [ "$i" -lt 90 ]; do
  if curl -fsS "http://${host}:${port}/api/health" >/dev/null 2>&1; then
    printf '\n\n'
    say "Sarati is running at http://${host}:${port}"
    echo "Open it and create the owner account — the first account is yours, everyone after joins by invite."
    echo
    if [ "$stack" = single ]; then
      echo "  back up:  the ${project}_data volume — it holds your workflows AND the keys that decrypt your credentials."
    fi
    printf '  logs:  cd %s && docker compose logs -f\n' "$(shq "$DIR")"
    printf '  stop:  cd %s && docker compose down\n' "$(shq "$DIR")"
    warn_if_unsafe
    warn_left
    exit 0
  fi
  printf '.'
  i=$((i + 1))
  sleep 2
done

printf '\n'
warn_if_unsafe
warn_left
die "It did not answer within 3 minutes. Check: cd $(shq "$DIR") && docker compose logs"
