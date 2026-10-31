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

# Succeeds when $1 is an IP address Docker takes: dotted IPv4, or IPv6, bracketed or not, that may end in IPv4.
is_ip() {
  printf '%s\n' "$1" | LC_ALL=C awk '
    function v4(s,   o, i) {
      if (split(s, o, ".") != 4) return 0
      for (i = 1; i <= 4; i++) if (o[i] !~ /^(0|[1-9][0-9]?[0-9]?)$/ || o[i] + 0 > 255) return 0
      return 1
    }
    function groups(s, last,   g, k, i, c) {
      if (s == "") return 0
      k = split(s, g, ":")
      for (i = 1; i <= k; i++) {
        if (last && i == k && g[i] ~ /\./) { if (!v4(g[i])) return -9; c += 2 }
        else if (g[i] ~ /^[0-9a-fA-F]+$/ && length(g[i]) <= 4) c++
        else return -9
      }
      return c
    }
    { s = $0 }
    END {
      if (NR != 1) exit 1
      if (s ~ /^\[.*\]$/) s = substr(s, 2, length(s) - 2)
      else if (index(s, ":") == 0) exit (!v4(s))
      if (index(s, "[") || index(s, "]") || index(s, ":") == 0) exit 1
      e = index(s, "::")
      if (e == 0) exit (groups(s, 1) != 8)
      tail = substr(s, e + 2)
      if (index(tail, "::")) exit 1
      h = groups(substr(s, 1, e - 1), 0)
      t = groups(tail, 1)
      exit (!(h >= 0 && t >= 0 && h + t <= 7))
    }'
}

# Prints KEY $1 from the .env in directory $2 (default .), read the way docker compose reads it.
setting() {
  [ -r "${2:-.}/.env" ] || return 0
  LC_ALL=C tr -d '\r' < "${2:-.}/.env" |
    LC_ALL=C sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}$1[[:space:]]*=[[:space:]]*//p" | tail -1 |
    LC_ALL=C sed -e 's/^"\([^"]*\)".*/\1/' -e t -e "s/^'\([^']*\)'.*/\1/" -e t -e 's/[[:space:]]#.*//' -e 's/[[:space:]]*$//'
}

is_here() { ! gone "$1" && [ "$1" -ef . ]; }

valid() { case "$1" in [!$lower$digits]* | *[!$lower${digits}_-]*) return 1 ;; esac; }

# Succeeds only when $1 provably does not exist: an absolute path whose nearest existing parent can be searched.
absent() {
  case "$1" in /*) ;; *) return 1 ;; esac
  [ ! -e "$1" ] || return 1
  up=$(dirname "$1")
  while [ ! -e "$up" ]; do up=$(dirname "$up"); done
  [ -x "$up" ]
}

# Succeeds when the containers' directory $1 did not exist as this run began, so no install runs from it, whatever this run makes.
gone() { [ -n "$1" ] && printf '%s\n' "$missing" | grep -qxF -- "$1"; }

has_data() { printf '%s\n' "$volumes" | grep -qx -e "$1 data" -e "$1 db-data"; }

has_database() { printf '%s\n' "$stored" | awk -v v="${1}_db-data" '$1 == v { found = 1 } END { exit !found }'; }

started_here() {
  printf '%s\n' "$listing" | while read -r name dir; do if is_here "$dir"; then printf '%s\n' "$name"; fi; done | sort -u | paste -sd ' ' -
}

# Prints the installs started from this directory before this run made it again.
remade_here() {
  printf '%s\n' "$listing" | while read -r name dir; do if gone "$dir" && [ "$dir" -ef . ]; then printf '%s\n' "$name"; fi; done | paste -sd ' ' -
}

# Prints the installs started from here, and beside one the installs this directory's .env may have held instead.
found_here() {
  started=$(started_here)
  own=$(basename "$(pwd)")
  case "$started" in
    "" | *" "* | "$own") ;;
    *)
      if [ "$own" = sarati ]; then
        if has_data sarati && homeless sarati; then started="$started sarati"; fi
      else
        for name in $(unclaimed . | tr ' ' '\n' | sort -u); do
          if [ "$name" != "$started" ] && { [ "$started" = sarati ] || [ "$name" = "$own" ]; }; then started="$started $name"; fi
        done
      fi
      ;;
  esac
  echo "$started"
}

# Succeeds when found_here weighs installs nothing runs: one install started here, in a directory named neither it nor sarati.
weighs() {
  case "$(started_here)" in "" | *" "* | "$(basename "$(pwd)")") return 1 ;; esac
  [ "$(basename "$(pwd)")" != sarati ]
}

# Prints the shape the .env in directory $1 records; with none, a database password means five containers.
recorded_shape() {
  kind=$(setting SARATI_STACK "$1")
  [ -n "$kind" ] || [ -z "$(setting POSTGRES_PASSWORD "$1")" ] || kind=compose
  echo "$kind"
}

# Prints the five-container keys the .env here does not hold.
lacking() { for key in SECRET_KEY FERNET_KEY POSTGRES_PASSWORD; do [ -n "$(setting "$key")" ] || echo "$key"; done; }

# Succeeds when no .env here holds the keys to $project's database, or there is no .env here at all.
keyless() { [ ! -f .env ] || { has_database "$project" && [ -n "$(lacking)" ]; }; }

# Succeeds unless the .env here records a five-container install.
may_be_single() { [ "$(recorded_shape .)" != compose ]; }

# Prints the installs nothing runs that the .env in directory $1 may be, by the shape it records.
unclaimed() {
  case "$(recorded_shape "$1")" in
    single) echo $single_unclaimed ;;
    compose) echo $compose_unclaimed ;;
    *) echo $single_unclaimed $compose_unclaimed ;;
  esac
}

# Succeeds when nothing of install $1 runs from a directory that still exists.
homeless() {
  while read -r owner path; do
    [ "$owner" != "$1" ] || gone "$path" || return 1
  done <<EOF
$listing
EOF
}

# Looks once, in this shell so a failure stops the run, for one-container installs nothing runs: a lone data volume holding an install's secrets.
look() {
  [ -z "$looked" ] || return 0
  looked=yes
  lens=$(docker image ls -q ghcr.io/saratihq/sarati) || die "Docker could not list its images."
  lens=$(printf '%s\n' "$lens" | head -1)
  while read -r shape name vol; do
    if [ "$shape" = single ] && [ "$name" != sarati ] && homeless "$name"; then
      status=1
      if [ "$vol" = - ] || [ -z "$lens" ]; then
        status=0
      else
        docker run --rm --pull never --network none --entrypoint /bin/sh -v "$vol:/data:ro,nocopy" "$lens" -c 'test -f /data/secrets.env' >/dev/null 2>&1 && status=0 || status=$?
      fi
      [ "$status" = 0 ] || [ "$status" = 1 ] || die "Docker could not look inside the $vol volume, so this cannot tell whether it holds an install."
      [ "$status" = 1 ] || single_unclaimed="$single_unclaimed $name"
    fi
  done <<EOF
$shapes
EOF
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

# Prints, as Linux's socket table spells them in either byte order, the local addresses a bind to address $1 clashes with; none for a wildcard.
clashes() {
  printf '%s\n' "$1" | LC_ALL=C awk '
    function v4(s,   o) { split(s, o, "."); return sprintf("%02X%02X%02X%02X", o[1], o[2], o[3], o[4]) }
    function swap(h,   out, i, w) {
      for (i = 1; i <= length(h); i += 8) { w = substr(h, i, 8); out = out substr(w, 7, 2) substr(w, 5, 2) substr(w, 3, 2) substr(w, 1, 2) }
      return out
    }
    function hex4(g) { g = toupper(g); while (length(g) < 4) g = "0" g; return g }
    function v6(s,   e, head, tail, hg, tg, nh, nt, i, out, q) {
      if (index(s, ".")) { match(s, /[0-9.]+$/); q = v4(substr(s, RSTART)); s = substr(s, 1, RSTART - 1) substr(q, 1, 4) ":" substr(q, 5, 4) }
      e = index(s, "::")
      if (e) { head = substr(s, 1, e - 1); tail = substr(s, e + 2) } else head = s
      nh = head == "" ? 0 : split(head, hg, ":")
      nt = tail == "" ? 0 : split(tail, tg, ":")
      for (i = 1; i <= nh; i++) out = out hex4(hg[i])
      for (i = nh + nt; i < 8; i++) out = out "0000"
      for (i = 1; i <= nt; i++) out = out hex4(tg[i])
      return out
    }
    function both(h) { print h; print swap(h) }
    {
      zero = "00000000000000000000000000000000"
      s = $0
      sub(/^\[/, "", s)
      sub(/\]$/, "", s)
      if (s == "") exit
      if (index(s, ":") == 0) {
        if (s == "0.0.0.0") exit
        print "00000000"; both(v4(s)); print zero; both("00000000000000000000FFFF" v4(s))
        exit
      }
      h = v6(s)
      if (h == zero) exit
      print zero; both(h)
      if (substr(h, 1, 24) == "00000000000000000000FFFF") { print "00000000"; both(substr(h, 25)) }
    }'
}

# Succeeds when something listens on port $1 where a bind to the address asked for would clash: from Linux's socket table, else from nc.
listening() {
  tables=""
  for table in /proc/net/tcp /proc/net/tcp6; do [ ! -r "$table" ] || tables="$tables $table"; done
  if [ -n "$tables" ]; then
    LC_ALL=C awk -v port="$(printf '%04X' "$1")" -v want="$clashing" '
      BEGIN { n = split(want, w, " "); for (i = 1; i <= n; i++) ok[w[i]] = 1 }
      $4 == "0A" { split($2, a, ":"); if (a[2] == port "" && (n == 0 || (a[1] in ok))) found = 1 }
      END { exit !found }' $tables
  else
    command -v nc >/dev/null 2>&1 && nc -z "$probe" "$1" 2>/dev/null
  fi
}

# Succeeds when port $1 is listened on, or bound by a container, stopped or not, that free_port saw.
busy() {
  case " $(echo $bound) " in *" $1 "*) return 0 ;; esac
  listening "$1"
}

# Prints a SARATI_PORT on the address asked for whose port nothing holds.
free_port() {
  ids=$(docker ps -aq) || ids=""
  bound=""
  # A hint only: a container removed meanwhile fails the inspect, and the port this run uses is probed again before anything starts.
  [ -z "$ids" ] || bound=$(docker inspect --format '{{ range $p, $b := .HostConfig.PortBindings }}{{ range $b }} {{ .HostPort }}{{ end }}{{ end }}' $ids 2>/dev/null) || true
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

shape() { if [ "$1" = single ]; then echo one-container; else echo five-container; fi; }

# Prints the command that copies the .env in directory $1 here, as private and writable as one this writes.
copy() { printf 'cp -f %s %s/.env && chmod 600 %s/.env && ' "$(shq "$1/.env")" "$here" "$here"; }

warn_left() {
  [ -z "$left" ] || printf '%s\n' "$left" | while read -r dir; do
    others=$(printf '%s\n' "$listing" | while read -r name at; do
      if [ "$name" != "$project" ] && [ -n "$at" ] && [ "$at" -ef "$dir" ]; then printf '%s\n' "$name"; fi
    done | sort -u | paste -sd ' ' -)
    case "$others" in
      "") warn "$dir still has a docker-compose.yaml, and docker compose there would act on this install. Remove it:  rm $(shq "$dir/docker-compose.yaml")" ;;
      *" "*) warn "docker compose in $dir would act on this install, though $(listed "$others") also started there.
  Re-run this there with COMPOSE_PROJECT_NAME set to the one that belongs there." ;;
      *)
        fix=$(unlock "$dir")
        warn "docker compose in $dir would act on this install, though $others also started there.
  To name it there:  ${fix:+$fix && }$(again COMPOSE_PROJECT_NAME="$others" SARATI_DIR="$(shq "$dir")")" ;;
    esac
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
    if gone "$1"; then
      lead="The install named $project was started from $1, which no longer exists"
      [ -f .env ] || ways="
  If you moved its directory, re-run this in the one you moved it to."
    fi
    fix=$(unlock "$1")
    ! (cd "$1" 2>/dev/null && [ -z "$(setting COMPOSE_PROJECT_NAME)" ] && weighs && may_be_single) || look
    ! passes "$1" || ways="$ways
  To upgrade it there:  ${fix:+$fix && }$(again SARATI_DIR="$(shq "$1")")"
  fi
  if [ -z "$named$from" ] && (named=$project && [ -z "$(blocker)" ]); then
    if [ -z "$1" ] || { gone "$1" && [ ! -f .env ]; }; then
      top=""
      there="from its directory"
      [ -z "$1" ] || there="from the directory you moved it to"
      ways="$ways
  To move it here, move the .env and docker-compose.yaml $there into $here, then:  $private$move"
      if has_database "$project"; then
        ways="$ways
  If its directory is gone, restore its .env into $here, then:  $private$move"
      else
        ways="$ways
  If its directory is gone:  $fresh"
      fi
    elif keyless && [ -r "$1/.env" ] && [ -z "$(setting COMPOSE_PROJECT_NAME "$1")" ]; then
      top=""
      ways="$ways
  To move it here with its settings:  $(copy "$1")$move"
    elif keyless && has_database "$project"; then
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

# Prints the installs a .env naming none may be: sarati, and each other install of its shape whose data nothing runs.
candidates() {
  if printf '%s\n' "$listing" | grep -q '^sarati ' || has_data sarati; then echo sarati; fi
  for name in $(unclaimed . | tr ' ' '\n' | sort -u); do echo "$name"; done
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
# Docker Desktop labels a project started on Windows with its Windows path, which WSL reads through wslpath.
if command -v wslpath >/dev/null 2>&1; then
  listing=$(printf '%s\n' "$listing" | while read -r name dir; do
    case "$dir" in ([A-Za-z]:[\\/]*) if unix=$(wslpath -u "$dir" 2>/dev/null); then dir=$unix; fi ;; esac
    [ -z "$name" ] || printf '%s %s\n' "$name" "$dir"
  done)
fi
missing=$(printf '%s\n' "$listing" | while read -r name dir; do if absent "$dir"; then printf '%s\n' "$dir"; fi; done | sort -u)
stored=$(docker volume ls --format '{{ .Name }} {{ .Label "com.docker.compose.project" }} {{ .Label "com.docker.compose.volume" }}') ||
  die "Docker could not list its volumes, so this cannot tell which install keeps which data."
volumes=$(printf '%s\n' "$stored" | awk 'NF == 3 { print $2, $3 }')
# Each project's install shape from its volumes: sarati-N by name, else db-data with service-data, or a lone data volume to look inside.
shapes=$(printf '%s\n' "$stored" | awk 'NF == 3 { v[$2] = v[$2] " " $3; n[$2] = $1 } END {
  for (p in v) {
    named = p ~ /^sarati-[0-9]+$/
    if (v[p] ~ / db-data( |$)/ && (named || v[p] ~ / service-data( |$)/)) print "compose", p, "-"
    else if (named && v[p] ~ / data( |$)/) print "single", p, "-"
    else if (v[p] == " data") print "single", p, n[p]
  }
}')
compose_unclaimed=""
for name in $(printf '%s\n' "$shapes" | awk '$1 == "compose" { print $2 }'); do
  if [ "$name" != sarati ] && homeless "$name"; then compose_unclaimed="$compose_unclaimed $name"; fi
done
single_unclaimed=""
looked=""

existing=$DIR
while [ ! -e "$existing" ]; do existing=$(dirname "$existing"); done
top=$(cd "$existing" && pwd -P) || die "Cannot reach $existing to make $DIR."
mkdir -p "$DIR"
cd "$DIR"
made=$(pwd -P)
[ "$made" != "$top" ] || top=""
[ ! -e .env ] || [ -r .env ] || die "Cannot read $(pwd)/.env, which holds this install's settings. Re-run this as the user that owns it."
parent=$(dirname "$(pwd)")
here=$(shq "$(pwd)")

PORT=${SARATI_PORT:-$(setting SARATI_PORT)}
PORT=${PORT:-8080}
port=${PORT##*:}
bind=${PORT%"$port"}
bind=${bind%:}
badport() { die "SARATI_PORT$( [ -n "${SARATI_PORT:-}" ] || printf ' in %s/.env' "$(pwd)") takes a port, optionally after an IP address like 127.0.0.1: or [::1]:, not '$PORT'."; }
case "$port" in "" | 0* | *[!$digits]* | ??????*) badport ;; esac
[ "$port" -le 65535 ] || badport
[ -z "$bind" ] || is_ip "$bind" || badport
case "$bind" in "" | 0.0.0.0 | :: | "[::]") host=localhost ;; \[*) host=$bind ;; *:*) host="[$bind]" ;; *) host=$bind ;; esac
probe=${host#\[}
probe=${probe%\]}
clashing=$(clashes "$bind" | paste -sd ' ' -)

# The compose files pin `name: sarati`; COMPOSE_PROJECT_NAME in .env overrides it for docker compose here.
named=${COMPOSE_PROJECT_NAME:-}
remade=$(printf '%s\n' "$missing" | while read -r dir; do if [ -n "$dir" ] && [ -e "$dir" ]; then printf '%s\n' "$dir"; fi; done | head -1)
if [ -n "$remade" ] && [ -z "$named" ]; then
  revived=$(printf '%s\n' "$listing" | while read -r name dir; do if [ "$dir" = "$remade" ]; then printf '%s\n' "$name"; fi; done | sort -u | paste -sd ' ' -)
  old=$(shq "$remade")
  case "$revived" in
    *" "*)
      who="the installs named $(listed "$revived") were"
      lost="If its directory is gone, re-run this with COMPOSE_PROJECT_NAME set to the one that belongs there and SARATI_DIR=$old." ;;
    *)
      who="the install named $revived was"
      lost="If its directory is gone:  $(again "${given}COMPOSE_PROJECT_NAME=$revived" SARATI_DIR="$old")"
      ! has_database "$revived" ||
        lost="If its directory is gone, make $old again and restore its .env into it, then:  chmod 600 $old/.env && $(again COMPOSE_PROJECT_NAME="$revived" SARATI_DIR="$old")" ;;
  esac
  [ "$remade" -ef . ] || lost="$lost
  To install a separate one here:  $(again "${keep}COMPOSE_PROJECT_NAME=$(free_name "${revived%% *}")" SARATI_DIR="$here" SARATI_PORT="$(free_port)")"
  die "$remade did not exist until this run made it, but $who started there.
  If you moved that directory, re-run this in the one you moved it to, or move it back and re-run this.
  $lost"
fi
recorded=$(setting COMPOSE_PROJECT_NAME)
from=${recorded:+$(pwd)/.env}
if [ -z "$recorded" ]; then
  ! weighs || ! may_be_single || look
  recorded=$(found_here)
fi
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

move=$(again COMPOSE_PROJECT_NAME="$project" SARATI_DIR="$here")
fresh=$(again "${given}COMPOSE_PROJECT_NAME=$project" SARATI_DIR="$here")
private="chmod 600 $here/.env && "
if [ -z "$named$recorded" ] && [ -f .env ]; then
  ! may_be_single || look
  maybe=$(candidates)
  (named=$project && [ -z "$(blocker)" ]) || maybe=$(printf '%s\n' "$maybe" | sed '/^sarati$/d')
  if [ -n "$maybe" ] && { [ "$maybe" != sarati ] || [ -n "$(elsewhere)" ]; }; then
    list=""
    for name in $maybe; do
      dir=$(printf '%s\n' "$listing" | sed -n "s/^$name //p" | head -1)
      if [ -z "$dir" ]; then
        where="not running"
      elif gone "$dir"; then
        where="started from $dir, which no longer exists"
      else
        where="runs from $dir"
      fi
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
kept_stack=$(recorded_shape .)
case "$kept_stack" in
  "" | single | compose) ;;
  *) die "SARATI_STACK in $(pwd)/.env must be 'single' or 'compose', not '$kept_stack'." ;;
esac
why="$(pwd)/.env records a $(shape "$kept_stack") install"
if [ -n "$kept_stack" ] && [ -z "$(setting SARATI_STACK)" ]; then
  why="$(pwd)/.env holds a database password, which means five containers"
elif [ -z "$kept_stack" ] && has_database "$project"; then
  kept_stack=compose
  why="The install named $project keeps a five-container database"
elif [ -z "$kept_stack" ] && printf '%s\n' "$volumes" | grep -qx "$project data"; then
  kept_stack=single
  why="The install named $project keeps one-container data"
fi
held_stack=""
if has_database "$project" && ! printf '%s\n' "$volumes" | grep -qx "$project data"; then
  held_stack=compose
elif printf '%s\n' "$volumes" | grep -qx "$project data" && ! has_database "$project"; then
  held_stack=single
fi
if [ -n "$kept_stack" ] && [ -n "$held_stack" ] && [ "$kept_stack" != "$held_stack" ]; then
  if [ -n "$from" ]; then
    name=$(free_name "$project")
    die "$why, but the install named $project keeps $(shape "$held_stack") data — the two store their data differently.
  To install a $(shape "$kept_stack") one separately:  $(again "SARATI_STACK=$kept_stack ${given%%SARATI_PORT=*}COMPOSE_PROJECT_NAME=$name" SARATI_DIR="$(shq "$parent/$name")" SARATI_PORT="$(free_port)")"
  fi
  die "$why, but the install named $project keeps $(shape "$held_stack") data — the two store their data differently.
  If this .env belongs to another install, re-run this with COMPOSE_PROJECT_NAME set to its name, or to a new one:  $(again COMPOSE_PROJECT_NAME="$(free_name "$project")" SARATI_DIR="$here")"
fi

stack=${SARATI_STACK:-${kept_stack:-single}}
if [ -n "${SARATI_STACK:-}" ] && [ -n "$kept_stack" ] && [ "$SARATI_STACK" != "$kept_stack" ]; then
  name=$(free_name "$project")
  die "$why, and SARATI_STACK=$SARATI_STACK would switch it underneath its data — the two store their data differently.
  To upgrade it, re-run this without SARATI_STACK.
  To install a $(shape "$SARATI_STACK") one separately:  $(again "${keep}COMPOSE_PROJECT_NAME=$name" SARATI_DIR="$(shq "$parent/$name")" SARATI_PORT="$(free_port)")"
fi

kept_port=$(setting SARATI_PORT)
[ -z "${SARATI_PORT:-}" ] || [ -z "$kept_port" ] || [ "$SARATI_PORT" = "$kept_port" ] ||
  die "$(pwd)/.env sets SARATI_PORT=$kept_port, and SARATI_PORT=$SARATI_PORT would override it while SARATI_URL stays as it is.
  To change the port, set SARATI_PORT in that .env to $SARATI_PORT, and SARATI_URL to match, then re-run this without SARATI_PORT."

# This install's own container publishing the port is an upgrade, not a conflict.
if [ "$stack" = single ]; then front=sarati; else front=proxy; fi
own=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$front") ||
  die "Docker could not list its containers, so this cannot tell which install runs from where."
published=$(for id in $own; do docker port "$id" 8080 2>/dev/null || true; done)
case " $(echo $published) " in
  *:"$port "*) ;;
  *)
    if listening "$port"; then
      held=$(holder)
      [ -z "$held" ] || die "Port $PORT is held by the install named $held, which was also started from $(pwd).
  Run this for that install's own directory first, with COMPOSE_PROJECT_NAME=$held, then re-run this."
      [ ! -f .env ] || die "Port $PORT is already in use. Set SARATI_PORT in $(pwd)/.env to a free port, $(free_port) for example, and SARATI_URL to match, then re-run this${SARATI_PORT:+ without SARATI_PORT}."
      die "Port $PORT is already in use. Re-run with SARATI_PORT=$(free_port) (or any free port)."
    fi
    ;;
esac

if [ "$stack" = compose ] && has_database "$project" && { [ ! -f .env ] || [ -n "$(lacking)" ]; }; then
  top=""
  gone_env="its .env is gone"
  [ ! -f .env ] || gone_env="$(pwd)/.env does not hold its keys"
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
    case " $(started_here) $(remade_here) " in
      *" $project "*) erase="
  To erase that database and start over:  docker rm -f \$(docker ps -aq --filter label=com.docker.compose.project=$project) && docker volume rm ${project}_db-data" ;;
      *) erase="${where:+
  The install named $project was started from $where and still uses that database.}" ;;
    esac
  fi
  die "A Sarati database already exists on this machine, but $gone_env — new secrets would not match it.
  A new FERNET_KEY cannot decrypt credentials the old one stored. To keep them, restore that .env into $here, then:  $private$move
  To leave it alone and run a separate install beside it:  $(again "${keep}COMPOSE_PROJECT_NAME=$name" SARATI_DIR="$(shq "$parent/$name")" SARATI_PORT="$(free_port)")$erase"
fi

missing_keys=""
[ "$stack" != compose ] || [ ! -f .env ] || missing_keys=$(lacking | paste -sd ' ' -)
fix=$(unlock "$(pwd)")
if [ -n "$missing_keys" ] && [ ! -w .env ]; then
  die "$(pwd)/.env is read-only, and this needs to write $missing_keys${fix:+ and COMPOSE_PROJECT_NAME=$project} into it. Make it writable:  chmod u+w $here/.env"
fi
[ -z "$fix" ] ||
  die "$(pwd)/.env is read-only, and this needs to save COMPOSE_PROJECT_NAME=$project in it. Add that line yourself, or make it writable:  $fix"

say "Fetching the stack definition…"
base="https://raw.githubusercontent.com/${REPO}/${REF}"
# fetch <path upstream> <file here> renames the download into place whole, so a failed one leaves the file as it was.
fetch() {
  [ ! -d "$2" ] || die "$(pwd)/$2 is a directory, where this keeps a file. Remove it, then re-run this:  rmdir $(shq "$(pwd)/$2")"
  [ -w "$(dirname "$2")" ] || die "Cannot write in the directory that holds $(pwd)/$2. Re-run this as the user that owns it."
  curl -fsSL "$base/$1" -o "$2.download" || { rm -f "$2.download"; die "Could not download $1 from $base"; }
  chmod 644 "$2.download"
  # An unchanged file stays the one a running proxy's bind mount holds.
  if cmp -s "$2.download" "$2"; then rm -f "$2.download"; return 0; fi
  mv -f "$2.download" "$2" || { rm -f "$2.download"; die "Cannot replace $(pwd)/$2. Re-run this as the user that owns it."; }
}
if [ "$stack" = single ]; then
  fetch docker-compose.single.yaml docker-compose.yaml
else
  mkdir -p docker
  ondisk=$({ cksum < docker/Caddyfile; } 2>/dev/null) || ondisk=""
  for f in docker-compose.yaml docker/Caddyfile; do fetch "$f" "$f"; done
  # The proxy's label: compose recreates a container whose labels changed, never one whose mounted file did.
  SARATI_CADDYFILE_SUM=$(cksum < docker/Caddyfile)
  export SARATI_CADDYFILE_SUM
fi

# Base64url so the values are safe unquoted in an env file.
rand() { LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$1"; }
if [ -n "$missing_keys" ]; then
  say "Keeping the existing .env, and adding the keys a five-container install needs…"
  [ -z "$(tail -c 1 .env)" ] || echo >> .env
  for key in $missing_keys; do
    case "$key" in
      SECRET_KEY) echo "SECRET_KEY=$(rand 48)" ;;
      FERNET_KEY) echo "FERNET_KEY=$(rand 43)=" ;;
      POSTGRES_PASSWORD) echo "POSTGRES_PASSWORD=$(rand 32)" ;;
    esac >> .env
  done
  chmod 600 .env
  say "Wrote $missing_keys into $(pwd)/.env — back it up. Losing FERNET_KEY makes stored credentials unrecoverable."
fi
if [ -f .env ]; then
  [ -n "$missing_keys" ] || say "Keeping the existing .env — your keys and data are untouched."
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
proxy_id() { docker compose ps -q proxy 2>/dev/null | head -1; }
proxy=""
[ "$stack" != compose ] || proxy=$(proxy_id)
# Compose recreates only what changed, so a move recreates every container for each one's labels to name this directory.
if [ -n "$(elsewhere)" ]; then docker compose up -d --force-recreate; else docker compose up -d; fi
if [ -n "$proxy" ]; then
  now=$(proxy_id)
  # A proxy compose kept may run a docker/Caddyfile edited by hand, which its label cannot show.
  if [ "$now" = "$proxy" ] && [ "$ondisk" != "$SARATI_CADDYFILE_SUM" ]; then
    docker compose up -d --no-deps --force-recreate proxy
    now=$(proxy_id)
  fi
  [ "$now" = "$proxy" ] || say "Restarted the proxy, so it runs the docker/Caddyfile just fetched."
fi
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
