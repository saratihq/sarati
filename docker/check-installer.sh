#!/bin/sh
# The installer warns when the version it starts has a published security advisory, and only then:
# pinned to one, upgraded past it, left on one by a failed download, and on five containers.
# FOR CI OR A THROWAWAY LINUX MACHINE ONLY: it installs throwaway instances, re-tags an image and
# points ghcr.io nowhere in /etc/hosts while it runs. Needs Docker, sudo, and
# SARATI_CHECK_THROWAWAY=1 to say so:
#   SARATI_CHECK_THROWAWAY=1 SARATI_REF=<commit> sh docker/check-installer.sh
set -eu

[ "${SARATI_CHECK_THROWAWAY:-}" = 1 ] || {
  echo 'This check installs throwaway instances, re-tags an image and edits /etc/hosts: run it only on a throwaway machine, with SARATI_CHECK_THROWAWAY=1.' >&2
  exit 2
}

old=0.2.25
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
made=''
hosts_changed=''
unblock() { sudo sed -i '/# sarati-check-installer$/d' /etc/hosts; hosts_changed=''; }
# on <name> <compose args...> runs docker compose against that install's own project.
on() {
  project=$1
  shift
  (cd "$work/$project" && COMPOSE_PROJECT_NAME="check-$project" docker compose "$@")
}
cleanup() {
  [ -z "$hosts_changed" ] || unblock
  for name in $made; do on "$name" down -v >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

fail() { echo "::error::$1" >&2; exit 1; }

# run_installer <name> <port> [VAR=value ...] runs the installer and keeps what it printed in $out.
run_installer() {
  name=$1 port=$2
  shift 2
  made="$made $name"
  if ! out=$(env SARATI_DIR="$work/$name" SARATI_PORT="$port" COMPOSE_PROJECT_NAME="check-$name" "$@" \
    sh "$root/install.sh" 2>&1); then
    printf '%s\n' "$out"
    on "$name" logs --no-color | tail -60 || true
    fail "the installer failed"
  fi
  printf '%s\n' "$out"
}

says() { printf '%s\n' "$out" | grep -qF -- "$1" || fail "$2"; }
never() { ! printf '%s\n' "$out" | grep -qF -- "$1" || fail "$2"; }
running() {
  id=$(on "$1" ps -q "$2")
  [ -n "$id" ] || fail "$1 has no running $2 container"
  docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "$id"
}

echo "--- pinned to $old"
run_installer pinned 8181 SARATI_VERSION=$old
says "this install runs Sarati $old" "pinned to $old, the installer did not warn"
says 'https://github.com/saratihq/sarati/security/advisories' 'the warning does not link the advisories'
says "set SARATI_VERSION in $work/pinned/.env to latest" 'the warning does not say how to upgrade'
never 'could not be downloaded' 'the warning blamed a download that worked'

echo '--- upgraded the way the warning says'
sed -i 's/^SARATI_VERSION=.*/SARATI_VERSION=latest/' "$work/pinned/.env"
run_installer pinned 8181
never 'warning:' 'the upgraded install still warned'
now=$(running pinned sarati)
[ -n "$now" ] && [ "$now" != "$old" ] || fail "the upgrade left '$now' running"
on pinned down -v >/dev/null

echo "--- left on $old by a failed download"
docker tag "ghcr.io/saratihq/sarati:$old" ghcr.io/saratihq/sarati:latest
echo '0.0.0.0 ghcr.io # sarati-check-installer' | sudo tee -a /etc/hosts >/dev/null
hosts_changed=1
run_installer offline 8183
unblock
says "this install runs Sarati $old" "left on $old by a failed download, the installer did not warn"
says 'could not be downloaded' 'the warning does not say the download failed'
[ "$(running offline sarati)" = "$old" ] || fail "the offline install is not running $old"
on offline down -v >/dev/null

echo "--- five containers, pinned to $old"
run_installer five 8184 SARATI_STACK=compose SARATI_VERSION=$old
says "this install runs Sarati $old" "five containers pinned to $old, the installer did not warn"
[ "$(running five service)" = "$old" ] || fail "the five-container install is not running $old"

echo "the installer warns on a version with a published advisory, and only on one"
