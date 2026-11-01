#!/bin/sh
# SARATI_CHECK_THROWAWAY=1 sh docker/check-proxy-log.sh compose (from a five-container install's directory) | one <container>
set -eu

usage() {
  echo 'usage: SARATI_CHECK_THROWAWAY=1 sh docker/check-proxy-log.sh compose | one <container>' >&2
  exit 2
}
[ "${SARATI_CHECK_THROWAWAY:-}" = 1 ] || {
  echo 'This check stops the service of a five-container install and starts throwaway containers beside it: run it only on a throwaway stack, with SARATI_CHECK_THROWAWAY=1.' >&2
  exit 2
}
mode=${1:-}
case "$mode" in
  compose) [ $# -eq 1 ] || usage ;;
  one) [ $# -eq 2 ] && [ -n "$2" ] || usage ;;
  *) usage ;;
esac

fail() { echo "::error::$1" >&2; exit 1; }
rand() { od -An -N6 -tx1 /dev/urandom | tr -d ' \n'; }
mark=sarati-probe-$(rand)
visitor=check-proxy-log-$(rand)
tab=$(printf '\t')
net='' one='' down='' svc='' stopped='' created=''
cleanup() {
  [ -z "$stopped" ] || docker start "$svc" >/dev/null 2>&1 || true
  [ -z "$created" ] || docker rm -f -v $created >/dev/null 2>&1 || true
  [ -z "$one" ] || docker network disconnect "$net" "$one" >/dev/null 2>&1 || true
  [ -z "$one" ] || docker network rm "$net" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ "$mode" = compose ]; then
  proxy=$(docker compose ps -q proxy)
  svc=$(docker compose ps -q service)
  [ -n "$proxy" ] && [ -n "$svc" ] || fail 'no running proxy and service here: run this from the directory of a five-container install'
  net=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$proxy" | sed -n 1p)
  front=http://proxy:8080
  target=$front
else
  one=$2
  image=$(docker inspect -f '{{.Config.Image}}' "$one") || fail "there is no container named $one"
  net=sarati-check-proxy-log
  docker network create "$net" >/dev/null 2>&1 || true
  docker network connect "$net" "$one" 2>/dev/null || true
  proxy=$one
  front="http://$one:8080"
  # Its service never listens, so every /api request is answered 502 by its proxy alone.
  down=$one-down
  created=$down
  docker run -d --name "$down" --network "$net" -e DATABASE_URL=postgresql://nobody@127.0.0.1:9/nowhere "$image" >/dev/null
  target="http://$down:8080"
fi

created="$created $visitor"
docker run -d --name "$visitor" --network "$net" --entrypoint sleep curlimages/curl:8.10.1 900 >/dev/null
ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$visitor")
[ -n "$ip" ] || fail 'the visitor has no address'
probe() { docker exec "$visitor" curl -s -o /dev/null --max-time 20 "$@" || true; }
lines() { docker logs "$1" 2>&1 | wc -l | tr -d ' '; }
visits() { docker logs "$1" 2>&1 | tail -n "+$(($2 + 1))" | grep -F -e "\"client_ip\": \"$ip\"" -e "\"client_ip\":\"$ip\"" || true; }
count() { [ -z "$1" ] && echo 0 || printf '%s\n' "$1" | wc -l | tr -d ' '; }
result() { printf '%s{"request": {"client_ip": "%s"}, "status": %s}' "$tab" "$ip" "$1"; }

# logged <container> <its lines before the probes> <status of its one error line, or -> <statuses of its access lines...>
logged() {
  box=$1 since=$2 failed=$3
  shift 3
  want=$#
  [ "$failed" = - ] || want=$((want + 1))
  i=0
  until got=$(visits "$box" "$since") && [ "$(count "$got")" -ge "$want" ]; do
    i=$((i + 1))
    [ "$i" -lt 30 ] || fail "the proxy in $box logged $(count "$got") of the $want lines expected with the visitor's address $ip: $got"
    sleep 1
  done
  leaked=$(docker logs "$box" 2>&1 | grep -F -- "$mark" || true)
  [ -z "$leaked" ] || fail "$box logged an address, a header or where a request was redirected: $leaked"
  [ "$(count "$got")" = "$want" ] || fail "something besides the access log wrote the visitor's request in $box: $got"
  errors=0
  while IFS= read -r line; do
    case "$line" in
      *"${tab}http.log.access${tab}handled request$(result "${1:-none}")") shift ;;
      *"${tab}http.log.error${tab}"*"$(result "$failed")") errors=$((errors + 1)) ;;
      *) fail "the proxy in $box logged more of a request than its time, status and visitor, or not in the order sent: $line" ;;
    esac
  done <<EOF
$got
EOF
  [ $# -eq 0 ] && { [ "$failed" = - ] || [ "$errors" = 1 ]; } || fail "the proxy in $box did not log each request as its time, status and visitor: $got"
  echo "ok: $box logged no address, header or redirect, and each request as its time, status and visitor alone"
}

before=$(lines "$proxy")
health=$(probe -w '%{http_code}' -H "Referer: $front/join/$mark-invite" "$front/api/health?code=$mark-code&state=$mark-state")
[ "$health" = 200 ] || fail "the service did not answer (got '$health'), so this proves nothing"
page=$(probe -w '%{http_code} %{redirect_url}' "$front/check-proxy-log/$mark-page?code=$mark-redirect")
case "$page" in
  30[0-9]" "*"$mark-page"*) ;;
  *) fail "the client no longer redirects a page to one that repeats its address (got '$page'), so this cannot show the redirect stays out of the log" ;;
esac

if [ "$mode" = compose ]; then
  docker stop "$svc" >/dev/null
  stopped=1
else
  i=0
  until docker exec "$down" node -e "fetch('http://127.0.0.1:8080/api/health').then((r) => process.exit(r.status === 502 ? 0 : 1), () => process.exit(1))" 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -lt 60 ] || fail "the proxy in $down did not answer 502 for a service that never listens"
    sleep 1
  done
  from=$(lines "$down")
fi
error=$(probe -w '%{http_code}' -X POST -H 'Transfer-Encoding: chunked' -H "Referer: $front/join/$mark-invite" \
  --data-binary x "$target/api/hooks/$mark-hook/production?code=$mark-error")
case "$error" in
  502 | 504) ;;
  *) fail "a webhook to a service that is down was answered '$error', not by the proxy's own error, so this cannot show the error log keeps the address out" ;;
esac

if [ "$mode" = compose ]; then
  logged "$proxy" "$before" "$error" 200 "${page%% *}" "$error"
else
  logged "$proxy" "$before" - 200 "${page%% *}"
  logged "$down" "$from" "$error" "$error"
fi

if [ -n "$stopped" ]; then
  docker start "$svc" >/dev/null
  stopped=''
  i=0
  until [ "$(probe -w '%{http_code}' "$front/api/health")" = 200 ]; do
    i=$((i + 1))
    [ "$i" -lt 90 ] || fail 'the service did not come back after this check stopped it'
    sleep 2
  done
fi
echo "the proxy logs each request as its time, status and visitor, never its address ($mode)"
