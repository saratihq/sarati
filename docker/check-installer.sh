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
# The last installer that left the proxy on the docker/Caddyfile it started with.
stuck=05cd32ece9e7cec3038a07febe6d0d0270d639c5
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
  used=$(docker ps -a --format '{{ .ID }} {{ .Label "com.docker.compose.project" }} {{ .Label "com.docker.compose.project.working_dir" }}' |
    while read -r id project dir; do
      case "$dir" in ("$work"/*) docker rm -f -v "$id" >/dev/null 2>&1 || true && echo "$project" ;; esac
    done | sort -u)
  for project in sarati unrelated $used $(cat "$work"/*/.env 2>/dev/null | sed -n 's/^COMPOSE_PROJECT_NAME=//p'); do
    for volume in $(docker volume ls -q --filter "label=com.docker.compose.project=$project"); do docker volume rm "$volume" >/dev/null 2>&1 || true; done
    for network in $(docker network ls -q --filter "label=com.docker.compose.project=$project"); do docker network rm "$network" >/dev/null 2>&1 || true; done
  done
  chmod -R u+rwX "$work" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

fail() { echo "::error::$1" >&2; exit 1; }
[ -n "$safe" ] || fail 'install.sh no longer sets SAFE_VERSION'
curl -fsSL "https://raw.githubusercontent.com/saratihq/sarati/$before/install.sh" -o "$work/before.sh"
curl -fsSL "https://raw.githubusercontent.com/saratihq/sarati/$stuck/install.sh" -o "$work/stuck.sh"

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
# follow <text before the command> runs the command the last refusal printed after that text, with $script for get.sarati.io.
follow() {
  cmd=$(printf '%s\n' "$out" | sed -n "s|^  $1  ||p")
  case "$cmd" in *"sh -c 'curl -fsSL https://get.sarati.io | sh'") ;; *) fail "the refusal printed no command after: $1" ;; esac
  status=0
  out=$(eval "${cmd%"sh -c 'curl -fsSL https://get.sarati.io | sh'"}sh '$script'" 2>&1) || status=$?
  printf '%s\n' "$out"
  [ "$status" = 0 ] || fail "the printed command failed: $cmd"
}
# listen <port> holds a loopback port with a process no container owns, until unlisten.
listen() {
  python3 -m http.server "$1" --bind 127.0.0.1 --directory "$(mktemp -d "$work/served.XXXXXX")" >/dev/null 2>&1 &
  listener=$!
  i=0
  until curl -fsS "http://localhost:$1/" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -lt 30 ] || fail "the listener on $1 never came up"
    sleep 1
  done
}
unlisten() {
  kill "$listener"
  listener=''
}
# installed_by <installer> <name> <port|-> [VAR=value ...] runs that earlier installer instead of this one.
installed_by() {
  script=$1
  shift
  run_installer "$@"
  script=$root/install.sh
}
before_installer() { installed_by "$work/before.sh" "$@"; }

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
# logs_code <name> <port> <tag> sends a sign-in callback's code through that install's proxy, and fails unless its log shows it.
logs_code() {
  curl -s -o /dev/null "http://localhost:$2/api/health?code=oauth-code-$3&state=oauth-state-$3" || fail "the proxy of $1 did not answer"
  id=$(on "$1" ps -q proxy)
  i=0
  until docker logs "$id" 2>&1 | grep -qF "oauth-code-$3"; do
    i=$((i + 1))
    [ "$i" -lt 30 ] || return 1
    sleep 1
  done
}
# proxy_log <name> fails unless that install's proxy logs each request as its time, status and visitor alone.
proxy_log() { (cd "$work/$1" && SARATI_CHECK_THROWAWAY=1 sh "$root/docker/check-proxy-log.sh" compose); }
started() { docker inspect --format '{{ .State.StartedAt }}' "$1"; }
image() { docker inspect --format '{{ .Image }}' "$1"; }
# still <name> <proxy id> <its image id> <why> fails with why unless that install still runs that proxy.
still() {
  id=$(on "$1" ps -q proxy)
  [ "$id" != "$2" ] || return 0
  [ -z "$id" ] || [ "$(image "$id")" = "$3" ] || fail 'caddy:2-alpine was republished between two runs, so compose recreated the proxy for its new image and this proves nothing: re-run the check'
  fail "$4"
}
loaded() { docker inspect --format '{{ index .Config.Labels "io.sarati.caddyfile" }}' "$1"; }

echo '--- SARATI_PORT takes only a port in range, after only an IP address'
for value in 0 08080 65536 ::8080 abc:def:8080 '[:]:8080' 127.0.0.01:8080 '[1.2.3.4]:8080'; do
  refused ports - SARATI_PORT="$value"
  says "takes a port, optionally after an IP address like 127.0.0.1: or [::1]:, not '$value'." "SARATI_PORT=$value was not refused"
done
for value in 1 65535 127.0.0.1:8080 '[::1]:8080' :::8080 ::ffff:127.0.0.1:8080 '[1:2:3:4:5:6:7::]:8080'; do
  refused ports - SARATI_PORT="$value" COMPOSE_PROJECT_NAME=Invalid
  says "not 'Invalid'." "SARATI_PORT=$value was refused"
done

echo '--- a port is probed as text, on the address asked for'
nowhere=0000000000000000000000000000000000000000
listen 4096
refused probe 7683 SARATI_REF=$nowhere
says 'Could not download docker-compose.single.yaml' 'a free port whose number reads like a held one was refused as in use'
refused probe 4096
says 'Port 4096 is already in use.' 'a held port was not refused'
refused probe 127.0.0.1:4096
says 'Port 127.0.0.1:4096 is already in use. Re-run with SARATI_PORT=127.0.0.1:' 'a port held on the address asked for was not refused'
refused probe 127.0.0.2:4096 SARATI_REF=$nowhere
says 'Could not download docker-compose.single.yaml' 'a port held only on another address was refused as in use'
unlisten
[ ! -e "$work/probe" ] || fail 'a refused run left its directory behind'

echo '--- a hand-made .env, before any install, takes the shape asked for'
mkdir "$work/hand"
printf 'SARATI_URL=http://localhost:8188\nSARATI_PORT=8188\n' > "$work/hand/.env"
run_installer hand - SARATI_STACK=single
[ "$(recorded hand)" = sarati ] || fail 'the hand-made .env did not record its name'
container hand >/dev/null
answers 8188
on hand down -v >/dev/null
mkdir "$work/hand5"
printf 'SARATI_URL=http://localhost:8189\nSARATI_PORT=8189\n' > "$work/hand5/.env"
run_installer hand5 - SARATI_STACK=compose COMPOSE_PROJECT_NAME=check-hand5
says 'Wrote SECRET_KEY FERNET_KEY POSTGRES_PASSWORD into' 'the hand-made .env asked for five containers did not get its keys'
never 'Restarted the proxy' 'a first install said it restarted its proxy'
answers 8189
on hand5 down -v >/dev/null

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
on five down >/dev/null
mkdir "$work/keyless"
printf 'SARATI_URL=http://localhost:8187\nSARATI_PORT=8187\n' > "$work/keyless/.env"
refused keyless - COMPOSE_PROJECT_NAME=check-five
says "A Sarati database already exists on this machine, but $work/keyless/.env does not hold its keys" 'a .env without the keys was taken for a five-container database'
[ -z "$(recorded keyless)" ] || fail 'the refused run wrote into the .env'
on five down -v >/dev/null

echo '--- five containers, left on an earlier docker/Caddyfile by the installer from before'
# v0.2.26's stack definition is that installer's but for a docker/Caddyfile that logs a sign-in callback's code and state.
installed_by "$work/stuck.sh" caddy 8199 COMPOSE_PROJECT_NAME=check-caddy SARATI_STACK=compose SARATI_REF=v0.2.26
cp "$work/caddy/docker/Caddyfile" "$work/v0.2.26.Caddyfile"
logs_code caddy 8199 old || fail "the proxy did not start on v0.2.26's docker/Caddyfile, so this does not reproduce the upgrade"
was=$(on caddy ps -q proxy)
img=$(image "$was")
installed_by "$work/stuck.sh" caddy - SARATI_REF=$stuck
grep -qF 'delete code' "$work/caddy/docker/Caddyfile" || fail "the installer from before did not fetch $stuck's docker/Caddyfile"
still caddy "$was" "$img" 'the installer from before restarted the proxy, so this does not reproduce the stuck upgrade'
logs_code caddy 8199 stuck || fail 'the proxy already drops the code, so this does not reproduce the stuck upgrade'

echo '--- ...upgraded by this one'
run_installer caddy -
says 'Restarted the proxy, so it runs the docker/Caddyfile just fetched.' 'the installer did not say it restarted the proxy'
proxy=$(on caddy ps -q proxy)
[ "$proxy" != "$was" ] || fail 'the installer left the proxy running the docker/Caddyfile it started with'
[ "$(loaded "$proxy")" = "$(cksum < "$work/caddy/docker/Caddyfile")" ] || fail 'the proxy is not labelled with the checksum of docker/Caddyfile'
proxy_log caddy || fail "the running proxy logs more than each request's time, status and visitor, so it did not load the new docker/Caddyfile"

echo '--- ...re-run with nothing changed'
since=$(started "$proxy")
img=$(image "$proxy")
inode=$(stat -c %i "$work/caddy/docker/Caddyfile")
run_installer caddy -
[ "$(stat -c %i "$work/caddy/docker/Caddyfile")" = "$inode" ] || fail 'the installer replaced an unchanged docker/Caddyfile, so the running proxy no longer holds the file on disk'
still caddy "$proxy" "$img" 'the installer recreated the proxy though docker/Caddyfile had not changed'
never 'Restarted the proxy' 'the installer restarted the proxy though docker/Caddyfile had not changed'
[ "$(started "$proxy")" = "$since" ] || fail 'the installer restarted the proxy though docker/Caddyfile had not changed'

echo '--- ...restarted by plain docker compose, then re-run over an edit to docker/Caddyfile'
plain=$(on caddy up -d 2>&1) || fail "plain docker compose up -d failed: $plain"
! printf '%s\n' "$plain" | grep -qF SARATI_CADDYFILE_SUM || fail "plain docker compose up -d warned about SARATI_CADDYFILE_SUM: $plain"
was=$(on caddy ps -q proxy)
[ "$was" != "$proxy" ] && [ -z "$(loaded "$was")" ] || fail 'plain docker compose up -d kept the proxy the installer labelled, so this does not reproduce a proxy started some other way'
printf '# an edit the installer replaces\n' >> "$work/caddy/docker/Caddyfile"
run_installer caddy -
says 'Restarted the proxy, so it runs the docker/Caddyfile just fetched.' 'the installer did not restart a proxy it had not started'
proxy=$(on caddy ps -q proxy)
[ "$proxy" != "$was" ] || fail 'the installer kept a proxy it had not started'
! grep -qF '# an edit the installer replaces' "$work/caddy/docker/Caddyfile" || fail 'the installer left an edit in docker/Caddyfile'
[ "$(loaded "$proxy")" = "$(cksum < "$work/caddy/docker/Caddyfile")" ] || fail 'the installer did not label the proxy with the checksum of the docker/Caddyfile it fetched'

echo '--- ...edited and restarted by hand, then re-run'
cp "$work/v0.2.26.Caddyfile" "$work/caddy/docker/Caddyfile"
on caddy restart proxy >/dev/null
answers 8199
logs_code caddy 8199 edit || fail 'the proxy restarted by hand did not load the edited docker/Caddyfile, so this does not reproduce a hand edit'
was=$proxy
run_installer caddy -
says 'Restarted the proxy, so it runs the docker/Caddyfile just fetched.' 'the installer did not say it restarted a proxy running a hand-edited docker/Caddyfile'
proxy=$(on caddy ps -q proxy)
[ "$proxy" != "$was" ] || fail 'the installer left the proxy running a hand-edited docker/Caddyfile'
[ "$(loaded "$proxy")" = "$(cksum < "$work/caddy/docker/Caddyfile")" ] || fail 'the installer did not label the proxy with the checksum of the docker/Caddyfile it fetched over a hand edit'
proxy_log caddy || fail "the proxy logs more than each request's time, status and visitor, so it kept the hand-edited docker/Caddyfile"

echo '--- ...refused where Docker left a directory for a missing docker/Caddyfile'
mv "$work/caddy/docker/Caddyfile" "$work/caddy.Caddyfile"
mkdir "$work/caddy/docker/Caddyfile"
refused caddy -
says "$work/caddy/docker/Caddyfile is a directory, where this keeps a file. Remove it, then re-run this:  rmdir $work/caddy/docker/Caddyfile" 'a directory where docker/Caddyfile goes was not refused'
rmdir "$work/caddy/docker/Caddyfile" || fail 'the refused run left something in the directory at docker/Caddyfile'
mv "$work/caddy.Caddyfile" "$work/caddy/docker/Caddyfile"
# Root may read and write anywhere, so these refusals show only as another user, as on GitHub's runners.
if [ "$(id -u)" != 0 ]; then
  echo '--- ...refused where it cannot write in docker/'
  chmod 555 "$work/caddy/docker"
  refused caddy -
  chmod 755 "$work/caddy/docker"
  says "Cannot write in the directory that holds $work/caddy/docker/Caddyfile. Re-run this as the user that owns it." 'a docker directory this cannot write in was not refused'
  echo '--- ...re-run under a umask that would leave what it downloads unreadable'
  printf '# an edit the installer replaces\n' >> "$work/caddy/docker/Caddyfile"
  mask=$(umask)
  umask 477
  run_installer caddy -
  umask "$mask"
  [ "$(stat -c %a "$work/caddy/docker/Caddyfile")" = 644 ] || fail 'a docker/Caddyfile fetched under umask 477 is not readable by the proxy'
fi
[ -z "$(find "$work/caddy" -name '*.download')" ] || fail 'a refused run left a download behind'
on caddy down -v >/dev/null

echo '--- a first install, by the installer from before names were saved'
before_installer first 8191
[ -z "$(recorded first)" ] || fail 'the installer from before saved a name'

echo '--- a second directory, given no name, by the installer from before'
before_installer moved 8196
moved=$(docker ps -aq --filter label=com.docker.compose.project=sarati)
[ "$(label "$moved" project.working_dir)" = "$work/moved" ] || fail 'the installer from before did not move the first install'

echo '--- moving it back onto a port something else holds'
listen 8191
refused first - COMPOSE_PROJECT_NAME=sarati
unlisten
says "Port 8191 is already in use. Set SARATI_PORT in $work/first/.env to a free port" 'a move onto a held port was not refused'
[ "$(docker ps -q --filter label=com.docker.compose.project=sarati)" = "$moved" ] || fail 'the refused move took down the running install'

echo '--- the first directory, given no name'
refused first -
says "$work/first/.env names no install, and it could belong to sarati (runs from $work/moved)." 'a .env that names no install was not asked about'

echo '--- the first directory, named'
run_installer first - COMPOSE_PROJECT_NAME=sarati
says "$work/moved still has a docker-compose.yaml, and docker compose there would act on this install." 'the move back did not warn about the directory it left'
first=$(container first)
[ "$(label "$first" project.working_dir)" = "$work/first" ] || fail 'the first install was not moved back to its own directory'
[ "$(recorded first)" = sarati ] || fail 'the first install did not record its name'
answers 8191
run_installer moved - COMPOSE_PROJECT_NAME=sarati-4
[ "$(recorded moved)" = sarati-4 ] || fail 'the second directory did not record the name it was given'
[ "$(label "$(container moved)" project)" = sarati-4 ] || fail 'the second directory is not the install it was named'
[ "$(container first)" = "$first" ] || fail 'naming the second directory touched the first install'

echo '--- a second install, named'
run_installer second 9090 COMPOSE_PROJECT_NAME=sarati-2
[ "$(recorded second)" = sarati-2 ] || fail 'the second install did not record its name'
second=$(container second)
[ "$second" != "$first" ] || fail 'docker compose in the second install acted on the first'
[ "$(label "$second" project)" = sarati-2 ] || fail 'the second install is not the project it was named'
on second down
[ "$(container first)" = "$first" ] || fail 'docker compose down in the second install stopped the first'
answers 8191

echo '--- the second install upgraded in place, given neither name nor port'
run_installer second -
says 'Sarati is running at http://localhost:9090' 'the upgrade did not check the port the second install runs on'
[ "$(label "$(container second)" project)" = sarati-2 ] || fail 're-running the second install changed its name'
[ "$(container first)" = "$first" ] || fail 're-running the second install touched the first'

echo '--- the second install, given another name'
refused second - COMPOSE_PROJECT_NAME=other
says "$work/second/.env names this install sarati-2, not other." 'a different name was not refused'
[ -z "$(docker ps -aq --filter label=com.docker.compose.project=other)" ] || fail 'the refused name started containers'

echo '--- a third directory, given no name, while the second install has 9090 and something else 9091'
listen 9091
refused stray 8193
unlisten
says "The install named sarati runs from $work/first — installing it here would take it over." 'a stray install was not refused'
says "To upgrade it there:  SARATI_DIR=$work/first sh -c" 'the refusal does not say how to upgrade the first install'
says "To install a separate one:  COMPOSE_PROJECT_NAME=sarati-3 SARATI_DIR=$work/stray SARATI_PORT=9092 sh -c" 'the refusal does not suggest a free name and port'
never 'To move it here' 'the refusal offered to move an install whose directory names it'
[ ! -e "$work/stray" ] || fail 'the refused install left its directory behind'
[ "$(container first)" = "$first" ] || fail 'the refused install touched the first'

echo '--- ...while the first and second installs are stopped'
on first stop
on second stop
refused stray 8193
says "The install named sarati runs from $work/first — installing it here would take it over." 'a stopped install was not protected'
says "SARATI_DIR=$work/stray SARATI_PORT=9091 sh -c" 'the suggested port is one a stopped install binds'
on first start
on second start
[ "$(container first)" = "$first" ] || fail 'the refused install touched the stopped first install'

echo '--- ...while the first install is removed, its data kept'
on first down
refused stray 8193
says 'The install named sarati is not running, but its data is kept — installing it here would take it over.' 'a removed install was not protected'
says "If its directory is gone:  SARATI_PORT=8193 COMPOSE_PROJECT_NAME=sarati SARATI_DIR=$work/stray sh -c" 'the refusal does not say how to start the removed install from here, on the port asked for'
[ -d "$work/stray" ] || fail 'the refusal removed the directory it said to move the install into'
mv "$work/first/.env" "$work/first/docker-compose.yaml" "$work/stray/"
follow "To move it here, move the .env and docker-compose.yaml from its directory into $work/stray, then:"
[ "$(label "$(container stray)" project.working_dir)" = "$work/stray" ] || fail 'the printed command did not move the removed install'
answers 8191
on stray down
mv "$work/stray/.env" "$work/stray/docker-compose.yaml" "$work/first/"
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
says "$work/twin could hold more than one install: sarati, sarati-5." 'a directory holding two installs was not refused'
run_installer first -
first=$(container first)
[ "$(label "$first" project.working_dir)" = "$work/first" ] || fail 'the first install, which names itself, was not moved back to its own directory'
answers 8191
says "docker compose in $work/twin would act on this install, though sarati-5 also started there." 'moving the first install back did not name the install left in the second directory'
never "rm $work/twin/docker-compose.yaml" 'moving the first install back said to remove the compose file of the second install'
follow 'To name it there:'
[ "$(recorded twin)" = sarati-5 ] || fail 'the printed command did not record the name of the second install'
twin=$(container twin)
[ "$(label "$twin" project)" = sarati-5 ] || fail 'docker compose in the second directory does not act on its own install'
answers 8197
[ "$(container first)" = "$first" ] || fail 'naming the second install touched the first'

echo '--- an install from before, removed, upgraded by this one with neither name nor port, beside an unrelated lone data volume'
on first down -v
before_installer plain 8191
[ -z "$(recorded plain)" ] || fail 'the installer from before saved a name'
on plain down
docker volume create --label com.docker.compose.project=unrelated --label com.docker.compose.volume=data unrelated_data >/dev/null
lens=$(docker image ls -q ghcr.io/saratihq/sarati | head -1)
docker run --rm --entrypoint chown -v unrelated_data:/owned "$lens" 1000:1000 /owned
run_installer plain -
[ "$(docker run --rm --entrypoint stat -v unrelated_data:/owned:ro,nocopy "$lens" -c %u:%g /owned)" = 1000:1000 ] ||
  fail 'looking inside an unrelated volume changed its owner'
docker volume rm unrelated_data >/dev/null
says 'Saved COMPOSE_PROJECT_NAME=sarati into .env' 'upgrading an install from before did not save its name'
[ "$(recorded plain)" = sarati ] || fail 'the upgraded install did not record its name'
answers 8191

echo '--- an install from before, moved by the command a refusal printed while it runs'
on plain down -v
before_installer source 8191
chmod 400 "$work/source/.env"
refused mover -
ro=''
[ -w "$work/source/.env" ] || ro="chmod u+w $work/source/.env && "
says "To upgrade it there:  ${ro}SARATI_DIR=$work/source sh -c" 'the refusal does not say how to upgrade an install whose .env is read-only'
[ -d "$work/mover" ] || fail 'the refusal removed the directory it said to copy into'
follow 'To move it here with its settings:'
[ "$(label "$(container mover)" project.working_dir)" = "$work/mover" ] || fail 'the printed command did not move the install'
[ "$(recorded mover)" = sarati ] || fail 'the moved install did not record its name'
answers 8191
says "Remove it:  rm $work/source/docker-compose.yaml" 'the move did not say how to stop the old directory acting on the install'
rm "$work/source/docker-compose.yaml"
! on source ps -q >/dev/null 2>&1 || fail 'docker compose in the old directory still acts on the moved install'
[ -n "$(container mover)" ] || fail 'the moved install stopped'

echo '--- a five-container install from before, moved by the command a refusal printed'
on mover down -v
before_installer fivesource 8191 SARATI_STACK=compose
refused fivemover -
follow 'To move it here with its settings:'
[ "$(docker ps -q --filter label=com.docker.compose.project=sarati | wc -l)" -eq 5 ] || fail 'the moved install is not five running containers'
for id in $(docker ps -aq --filter label=com.docker.compose.project=sarati); do
  [ "$(label "$id" project.working_dir)" = "$work/fivemover" ] || fail "the move left $(label "$id" service) started from another directory"
done
answers 8191

echo '--- the default install moved away, and a fresh directory given no name'
mkdir -p "$work/apps"
mv "$work/fivemover" "$work/apps/fivemover"
refused fresh -
says "The install named sarati was started from $work/fivemover, which no longer exists — installing it here would take it over." 'the refusal did not say the directory is gone'
says 'If you moved its directory, re-run this in the one you moved it to.' 'the refusal did not say where to re-run'
rm -r "$work/fresh"
run_installer apps/fivemover -
for id in $(docker ps -aq --filter label=com.docker.compose.project=sarati); do
  [ "$(label "$id" project.working_dir)" = "$work/apps/fivemover" ] || fail "the move left $(label "$id" service) labelled with the directory it left"
done
answers 8191

echo '--- a five-container second install by the installer from before, its directory moved while it runs'
before_installer apart 8198 COMPOSE_PROJECT_NAME=sarati-6 SARATI_STACK=compose
mv "$work/apart" "$work/apps/apart"
refused apart -
says "$work/apart did not exist until this run made it, but the install named sarati-6 was started there." 'the old directory of a moved install was taken for it'
says 'If you moved that directory, re-run this in the one you moved it to, or move it back and re-run this.' 'the refusal did not say to move it back'
[ ! -e "$work/apart" ] || fail 'the refusal left behind the directory it made'
refused apps/apart -
says "$work/apps/apart/.env names no install, and it could belong to sarati-6 (started from $work/apart, which no longer exists)." 'a moved install was not asked about'
mv "$work/apps/apart" "$work/apart"
run_installer apart -
[ "$(recorded apart)" = sarati-6 ] || fail 'the install moved back did not record its name'
answers 8198
mv "$work/apart" "$work/apps/apart"
run_installer apps/apart -
[ "$(docker ps -q --filter label=com.docker.compose.project=sarati-6 | wc -l)" -eq 5 ] || fail 'the moved install is not five running containers'
for id in $(docker ps -aq --filter label=com.docker.compose.project=sarati-6); do
  [ "$(label "$id" project.working_dir)" = "$work/apps/apart" ] || fail "the move left $(label "$id" service) labelled with the directory it left"
done
answers 8198

echo 'the installer warns on a version with a published advisory, and keeps each install to its own directory'
