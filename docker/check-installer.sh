#!/bin/sh
# SARATI_CHECK_THROWAWAY=1 SARATI_REF=<commit> sh docker/check-installer.sh   (Linux, Docker, sudo)
set -eu

[ "${SARATI_CHECK_THROWAWAY:-}" = 1 ] || {
  echo 'This check installs throwaway instances, re-tags an image and points ghcr.io nowhere in /etc/hosts: run it only on a throwaway Linux machine, with SARATI_CHECK_THROWAWAY=1.' >&2
  exit 2
}

old=0.2.25
root=$(cd "$(dirname "$0")/.." && pwd)
safe=$(sed -n 's/^SAFE_VERSION=//p' "$root/install.sh")
work=$(mktemp -d)
made=''
hosts_changed=''
unblock() { sudo sed -i '/# sarati-check-installer$/d' /etc/hosts; hosts_changed=''; }
# on <name> <compose args...> runs plain docker compose in that install's directory, as its owner would.
on() {
  dir=$1
  shift
  (cd "$work/$dir" && docker compose "$@")
}
cleanup() {
  [ -z "$hosts_changed" ] || unblock
  for name in $made; do on "$name" down -v >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

fail() { echo "::error::$1" >&2; exit 1; }
[ -n "$safe" ] || fail 'install.sh no longer sets SAFE_VERSION'

# attempt <name> <port> [VAR=value ...] runs the installer and keeps what it printed in $out.
attempt() {
  name=$1 port=$2
  shift 2
  made="$made $name"
  status=0
  out=$(env SARATI_DIR="$work/$name" SARATI_PORT="$port" "$@" sh "$root/install.sh" 2>&1) || status=$?
  printf '%s\n' "$out"
  return $status
}
run_installer() {
  attempt "$@" || {
    on "$1" logs --no-color | tail -60 || true
    fail 'the installer failed'
  }
}
refused() { ! attempt "$@" || fail 'the installer went ahead'; }

says() { printf '%s\n' "$out" | grep -qF -- "$1" || fail "$2"; }
never() { ! printf '%s\n' "$out" | grep -qF -- "$1" || fail "$2"; }
running() {
  id=$(on "$1" ps -q "$2")
  [ -n "$id" ] || fail "$1 has no running $2 container"
  docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "$id"
}
label() { docker inspect --format "{{ index .Config.Labels \"com.docker.compose.$2\" }}" "$1"; }
recorded() { sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$work/$1/.env" | tail -1; }

echo "--- pinned to $old"
run_installer pinned 8181 COMPOSE_PROJECT_NAME=check-pinned SARATI_VERSION=$old
says "this install runs Sarati $old" "pinned to $old, the installer did not warn"
says 'https://github.com/saratihq/sarati/security/advisories' 'the warning does not link the advisories'
says "set SARATI_VERSION in $work/pinned/.env to latest" 'the warning does not say how to upgrade'
never 'Downloading the images failed' 'the warning blamed a download that worked'

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
run_installer offline 8183 COMPOSE_PROJECT_NAME=check-offline
unblock
says "this install runs Sarati $old" "left on $old by a failed download, the installer did not warn"
says 'Downloading the images failed this time: ' 'the warning does not say the download failed'
printf '%s\n' "$out" | grep -F 'Downloading the images failed this time: ' | grep -qF '0.0.0.0' || fail 'the warning does not carry the error the download gave'
[ "$(running offline sarati)" = "$old" ] || fail "the offline install is not running $old"
on offline down -v >/dev/null

echo "--- pinned to $safe, the first version with no advisory"
run_installer safe 8185 COMPOSE_PROJECT_NAME=check-safe SARATI_VERSION=$safe
never 'warning:' "pinned to $safe, the installer warned"
[ "$(running safe sarati)" = "$safe" ] || fail "the install pinned to $safe is not running it"
on safe down -v >/dev/null

echo '--- pinned to 0.2.9, which sorts after 0.2.26 as text'
run_installer nine 8186 COMPOSE_PROJECT_NAME=check-nine SARATI_VERSION=0.2.9
says 'this install runs Sarati 0.2.9' 'pinned to 0.2.9, the installer did not warn'
on nine down -v >/dev/null

echo "--- five containers, pinned to $old"
run_installer five 8184 COMPOSE_PROJECT_NAME=check-five SARATI_STACK=compose SARATI_VERSION=$old
says "this install runs Sarati $old" "five containers pinned to $old, the installer did not warn"
[ "$(running five service)" = "$old" ] || fail "the five-container install is not running $old"
[ "$(recorded five)" = check-five ] || fail 'the five-container install did not record its name'
on five down -v >/dev/null

echo '--- a first install, given no name'
run_installer first 8191
[ "$(recorded first)" = sarati ] || fail 'the first install did not record its name'
first=$(on first ps -q sarati)
[ -n "$first" ] || fail 'docker compose in the first install found nothing'

echo '--- a second install, named'
run_installer second 8192 COMPOSE_PROJECT_NAME=sarati-2
[ "$(recorded second)" = sarati-2 ] || fail 'the second install did not record its name'
second=$(on second ps -q sarati)
[ -n "$second" ] && [ "$second" != "$first" ] || fail 'docker compose in the second install acted on the first'
[ "$(label "$second" project)" = sarati-2 ] || fail 'the second install is not the project it was named'
on second down
[ "$(on first ps -q sarati)" = "$first" ] || fail 'docker compose down in the second install stopped the first'
curl -fsS http://localhost:8191/api/health >/dev/null || fail 'the first install stopped answering'

echo '--- the second install upgraded in place, given no name'
run_installer second 8192
[ "$(label "$(on second ps -q sarati)" project)" = sarati-2 ] || fail 're-running the second install changed its name'
[ "$(on first ps -q sarati)" = "$first" ] || fail 're-running the second install touched the first'

echo '--- the second install, given another name'
refused second 8192 COMPOSE_PROJECT_NAME=other
says "$work/second holds the install named sarati-2, not other." 'a different name was not refused'
[ -z "$(docker ps -aq --filter label=com.docker.compose.project=other)" ] || fail 'the refused name started containers'

echo '--- a third directory, given no name'
refused stray 8193
says "The install named sarati runs from $work/first — installing it here would take it over." 'a stray install was not refused'
says "SARATI_DIR=$work/first." 'the refusal does not say how to upgrade the first install'
[ ! -e "$work/stray/.env" ] || fail 'the refused install wrote a .env'
[ "$(on first ps -q sarati)" = "$first" ] || fail 'the refused install touched the first'

echo '--- a second install from before installs recorded their name'
run_installer legacy 8194 COMPOSE_PROJECT_NAME=sarati-3
sed -i '/^COMPOSE_PROJECT_NAME=/d' "$work/legacy/.env"
[ "$(on legacy ps -q sarati)" = "$first" ] || fail 'without its name, docker compose in a second install did not act on the first'
run_installer legacy 8194
says 'Saved COMPOSE_PROJECT_NAME=sarati-3 into .env' 'the installer did not save the name it recovered'
[ "$(recorded legacy)" = sarati-3 ] || fail 'the installer did not recover the name from its containers'
[ "$(label "$(on legacy ps -q sarati)" project)" = sarati-3 ] || fail 'docker compose in the recovered install does not act on it'
[ "$(on first ps -q sarati)" = "$first" ] || fail 'recovering the second install touched the first'

echo '--- the first install, restarted from that directory the way the old instructions allowed'
sed -i '/^COMPOSE_PROJECT_NAME=/d' "$work/legacy/.env"
(cd "$work/legacy" && SARATI_PORT=8195 docker compose up -d)
moved=$(docker ps -aq --filter label=com.docker.compose.project=sarati)
[ "$(label "$moved" project.working_dir)" = "$work/legacy" ] || fail 'the first install was not moved under the second directory'
refused legacy 8194
says "More than one install (sarati, sarati-3) was started from $work/legacy." 'a directory holding two installs was not refused'
run_installer legacy 8194 COMPOSE_PROJECT_NAME=sarati-3
[ "$(recorded legacy)" = sarati-3 ] || fail 'naming the second install did not record it'
run_installer first 8191
back=$(on first ps -q sarati)
[ "$(label "$back" project.working_dir)" = "$work/first" ] || fail 'the first install was not moved back to its own directory'
curl -fsS http://localhost:8191/api/health >/dev/null || fail 'the first install does not answer on its own port'
[ "$(label "$(on legacy ps -q sarati)" project)" = sarati-3 ] || fail 'moving the first install back touched the second'

echo 'the installer warns on a version with a published advisory, and keeps each install to its own directory'
