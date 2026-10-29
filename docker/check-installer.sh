#!/bin/sh
# SARATI_CHECK_THROWAWAY=1 SARATI_REF=<commit> sh docker/check-installer.sh   (Linux, Docker, sudo)
set -eu

[ "${SARATI_CHECK_THROWAWAY:-}" = 1 ] || {
  echo 'This check installs throwaway instances, re-tags an image and points ghcr.io nowhere in /etc/hosts: run it only on a throwaway Linux machine, with SARATI_CHECK_THROWAWAY=1.' >&2
  exit 2
}

old=0.2.25
# The last installer that did not save an install's name.
before=387f56bb1272c871f6df05744e0b87f38fb4f063
root=$(cd "$(dirname "$0")/.." && pwd)
safe=$(sed -n 's/^SAFE_VERSION=//p' "$root/install.sh")
work=$(mktemp -d)
script=$root/install.sh
hosts_changed=''
listener=''
unblock() { sudo sed -i '/# sarati-check-installer$/d' /etc/hosts; hosts_changed=''; }
# on <name> <compose args...> runs plain docker compose in that install's directory, as its owner would.
on() {
  dir=$1
  shift
  (cd "$work/$dir" && docker compose "$@")
}
cleanup() {
  [ -z "$hosts_changed" ] || unblock
  [ -z "$listener" ] || kill "$listener" 2>/dev/null || true
  docker ps -a --format '{{ .Label "com.docker.compose.project" }} {{ .Label "com.docker.compose.project.working_dir" }}' |
    sort -u | while read -r project dir; do
      case "$dir" in "$work"/*) (cd "$dir" && docker compose -p "$project" down -v) >/dev/null 2>&1 || true ;; esac
    done
  rm -rf "$work"
}
trap cleanup EXIT

fail() { echo "::error::$1" >&2; exit 1; }
[ -n "$safe" ] || fail 'install.sh no longer sets SAFE_VERSION'
curl -fsSL "https://raw.githubusercontent.com/saratihq/sarati/$before/install.sh" -o "$work/before.sh"

# attempt <name> <port|-> [VAR=value ...] runs $script for that install, keeping what it printed in $out.
attempt() {
  name=$1 port=$2
  shift 2
  [ "$port" = - ] || set -- SARATI_PORT="$port" "$@"
  status=0
  out=$(env SARATI_DIR="$work/$name" "$@" sh "$script" 2>&1) || status=$?
  printf '%s\n' "$out"
  return $status
}
run_installer() {
  attempt "$@" || {
    docker ps -a --format '{{ .Names }} {{ .Status }} {{ .Label "com.docker.compose.project.working_dir" }}' || true
    for id in $(docker ps -aq --filter "label=com.docker.compose.project.working_dir=$work/$1"); do
      docker logs --tail 60 "$id" 2>&1 || true
    done
    fail 'the installer failed'
  }
}
refused() { ! attempt "$@" || fail 'the installer went ahead'; }
before_installer() {
  script=$work/before.sh
  run_installer "$@"
  script=$root/install.sh
}

says() { printf '%s\n' "$out" | grep -qF -- "$1" || fail "$2"; }
never() { ! printf '%s\n' "$out" | grep -qF -- "$1" || fail "$2"; }
running() {
  id=$(on "$1" ps -q "$2")
  [ -n "$id" ] || fail "$1 has no running $2 container"
  docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "$id"
}
label() { docker inspect --format "{{ index .Config.Labels \"com.docker.compose.$2\" }}" "$1"; }
recorded() { sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$work/$1/.env" | tail -1; }
container() {
  id=$(on "$1" ps -q sarati)
  [ -n "$id" ] || fail "docker compose in $1 finds no running container"
  echo "$id"
}
answers() {
  i=0
  until curl -fsS "http://localhost:$1/api/health" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -lt 90 ] || fail "nothing answers on port $1"
    sleep 2
  done
}

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
[ "$(recorded offline)" = check-offline ] || fail 'the offline install did not record its name'
on offline down -v >/dev/null

echo "--- pinned to $safe, the first version with no advisory"
run_installer safe 8185 COMPOSE_PROJECT_NAME=check-safe SARATI_VERSION=$safe
never 'warning:' "pinned to $safe, the installer warned"
[ "$(running safe sarati)" = "$safe" ] || fail "the install pinned to $safe is not running it"
on safe down -v >/dev/null

echo '--- pinned to 0.2.9, which sorts after 0.2.26 as text'
run_installer nine 8186 COMPOSE_PROJECT_NAME=check-nine SARATI_VERSION=0.2.9
says 'this install runs Sarati 0.2.9' 'pinned to 0.2.9, the installer did not warn'
[ "$(running nine sarati)" = 0.2.9 ] || fail 'the install pinned to 0.2.9 is not running it'
on nine down -v >/dev/null

echo "--- five containers, pinned to $old"
run_installer five 8184 COMPOSE_PROJECT_NAME=check-five SARATI_STACK=compose SARATI_VERSION=$old
says "this install runs Sarati $old" "five containers pinned to $old, the installer did not warn"
[ "$(running five service)" = "$old" ] || fail "the five-container install is not running $old"
[ "$(recorded five)" = check-five ] || fail 'the five-container install did not record its name'
on five down -v >/dev/null

echo '--- a first install, by the installer from before names were saved'
before_installer first 8191
[ -z "$(recorded first)" ] || fail 'the installer from before saved a name'

echo '--- a second directory, given no name, by the installer from before'
before_installer moved 8196
moved=$(docker ps -aq --filter label=com.docker.compose.project=sarati)
[ "$(label "$moved" project.working_dir)" = "$work/moved" ] || fail 'the installer from before did not move the first install'

echo '--- moving it back onto a port something else holds'
python3 -m http.server 8191 >/dev/null 2>&1 &
listener=$!
i=0
until curl -fsS http://localhost:8191/ >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 30 ] || fail 'the listener on 8191 never came up'
  sleep 1
done
refused first - COMPOSE_PROJECT_NAME=sarati
kill "$listener"
listener=''
says "Port 8191 is already in use. Set SARATI_PORT in $work/first/.env to a free port" 'a move onto a held port was not refused'
[ "$(docker ps -q --filter label=com.docker.compose.project=sarati)" = "$moved" ] || fail 'the refused move took down the running install'

echo '--- the first directory, given no name'
refused first -
says "$work/first/.env names no install, and it could belong to sarati (runs from $work/moved)." 'a .env that names no install was not asked about'

echo '--- the first directory, named'
run_installer first - COMPOSE_PROJECT_NAME=sarati
first=$(container first)
[ "$(label "$first" project.working_dir)" = "$work/first" ] || fail 'the first install was not moved back to its own directory'
[ "$(recorded first)" = sarati ] || fail 'the first install did not record its name'
answers 8191
run_installer moved - COMPOSE_PROJECT_NAME=sarati-4
[ "$(recorded moved)" = sarati-4 ] || fail 'the second directory did not record the name it was given'
[ "$(label "$(container moved)" project)" = sarati-4 ] || fail 'the second directory is not the install it was named'
[ "$(container first)" = "$first" ] || fail 'naming the second directory touched the first install'

echo '--- a second install, named'
run_installer second 8192 COMPOSE_PROJECT_NAME=sarati-2
[ "$(recorded second)" = sarati-2 ] || fail 'the second install did not record its name'
second=$(container second)
[ "$second" != "$first" ] || fail 'docker compose in the second install acted on the first'
[ "$(label "$second" project)" = sarati-2 ] || fail 'the second install is not the project it was named'
on second down
[ "$(container first)" = "$first" ] || fail 'docker compose down in the second install stopped the first'
answers 8191

echo '--- the second install upgraded in place, given neither name nor port'
run_installer second -
says 'Sarati is running at http://localhost:8192' 'the upgrade did not check the port the second install runs on'
[ "$(label "$(container second)" project)" = sarati-2 ] || fail 're-running the second install changed its name'
[ "$(container first)" = "$first" ] || fail 're-running the second install touched the first'

echo '--- the second install, given another name'
refused second - COMPOSE_PROJECT_NAME=other
says "$work/second/.env names this install sarati-2, not other." 'a different name was not refused'
[ -z "$(docker ps -aq --filter label=com.docker.compose.project=other)" ] || fail 'the refused name started containers'

echo '--- a third directory, given no name'
refused stray 8193
says "The install named sarati runs from $work/first — installing it here would take it over." 'a stray install was not refused'
says "To upgrade it there:  SARATI_DIR=$work/first sh -c" 'the refusal does not say how to upgrade the first install'
says "To install a separate one:  COMPOSE_PROJECT_NAME=sarati-3 SARATI_DIR=$work/stray SARATI_PORT=9090 sh -c" 'the refusal does not suggest a free name and port'
never 'To move it here' 'the refusal offered to move an install whose directory names it'
[ ! -e "$work/stray" ] || fail 'the refused install left its directory behind'
[ "$(container first)" = "$first" ] || fail 'the refused install touched the first'

echo '--- ...while the first install is stopped'
on first stop
refused stray 8193
says "The install named sarati runs from $work/first — installing it here would take it over." 'a stopped install was not protected'
on first start
[ "$(container first)" = "$first" ] || fail 'the refused install touched the stopped first install'

echo '--- ...while the first install is removed, its data kept'
on first down
refused stray 8193
says 'The install named sarati is not running, but its data is kept — installing it here would take it over.' 'a removed install was not protected'
says "To move it here:  COMPOSE_PROJECT_NAME=sarati SARATI_DIR=$work/stray sh -c" 'the refusal does not say how to move the removed install here'
[ ! -e "$work/stray" ] || fail 'the refused install left its directory behind'
on first up -d
answers 8191
first=$(container first)

echo '--- a second install by the installer from before, given a name'
before_installer legacy 8194 COMPOSE_PROJECT_NAME=sarati-3
[ "$(container legacy)" = "$first" ] || fail 'docker compose in the second install from before did not act on the first, so this does not reproduce the bug'
run_installer legacy -
says 'Saved COMPOSE_PROJECT_NAME=sarati-3 into .env' 'the installer did not save the name it recovered'
[ "$(recorded legacy)" = sarati-3 ] || fail 'the installer did not recover the name from its containers'
[ "$(label "$(container legacy)" project)" = sarati-3 ] || fail 'docker compose in the recovered install does not act on it'
[ "$(container first)" = "$first" ] || fail 'recovering the second install touched the first'

echo '--- the first install restarted from a second directory, as the old instructions allowed'
before_installer twin 8197 COMPOSE_PROJECT_NAME=sarati-5
! (cd "$work/twin" && docker compose up -d) || fail 'docker compose up -d in the second directory did not collide with the port its install holds'
hijacked=$(docker ps -aq --filter label=com.docker.compose.project=sarati)
[ "$(label "$hijacked" project.working_dir)" = "$work/twin" ] || fail 'docker compose up -d in the second directory did not take the first install'
[ -z "$(docker ps -q --filter label=com.docker.compose.project=sarati)" ] || fail 'the taken first install is still running'
refused twin -
says "More than one install (sarati, sarati-5) was started from $work/twin." 'a directory holding two installs was not refused'
run_installer twin - COMPOSE_PROJECT_NAME=sarati-5
[ "$(recorded twin)" = sarati-5 ] || fail 'naming the second install did not record it'
twin=$(container twin)
[ "$(label "$twin" project)" = sarati-5 ] || fail 'docker compose in the second directory does not act on its own install'
run_installer first -
first=$(container first)
[ "$(label "$first" project.working_dir)" = "$work/first" ] || fail 'the first install, which names itself, was not moved back to its own directory'
answers 8191
[ "$(container twin)" = "$twin" ] || fail 'moving the first install back touched the second'

echo '--- an install from before, upgraded by this one with neither name nor port'
on first down -v
before_installer plain 8191
[ -z "$(recorded plain)" ] || fail 'the installer from before saved a name'
run_installer plain -
says 'Saved COMPOSE_PROJECT_NAME=sarati into .env' 'upgrading an install from before did not save its name'
[ "$(recorded plain)" = sarati ] || fail 'the upgraded install did not record its name'
answers 8191

echo 'the installer warns on a version with a published advisory, and keeps each install to its own directory'
