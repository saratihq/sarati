#!/bin/sh
# Rate limits count per visitor through the REAL bundled Caddy, and a visitor cannot choose the
# address they count against. FOR CI OR A THROWAWAY STACK ONLY: it registers the first account,
# stores a placeholder Anthropic key and recreates the proxy. Needs Docker, a fresh install, and
# SARATI_CHECK_THROWAWAY=1 to say so:
#   SARATI_CHECK_THROWAWAY=1 sh docker/check-client-address.sh compose          five containers, from their directory
#   SARATI_CHECK_THROWAWAY=1 sh docker/check-client-address.sh one <container>  one container
set -eu

mode=${1:?compose or one}
[ "${SARATI_CHECK_THROWAWAY:-}" = 1 ] || {
  echo 'This check registers an account and changes the proxy: run it only on a throwaway stack, with SARATI_CHECK_THROWAWAY=1.' >&2
  exit 2
}
created=''
proxy_changed=''
cleanup() {
  [ -z "$created" ] || docker rm -f $created >/dev/null 2>&1 || true
  [ -z "$proxy_changed" ] || docker compose up -d proxy >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ "$mode" = compose ]; then
  net=sarati_default
  front=http://proxy:8080
else
  one=${2:?name the container of the one-container install}
  net=sarati-check-client-address
  docker network create "$net" >/dev/null 2>&1 || true
  docker network connect "$net" "$one" 2>/dev/null || true
  front="http://$one:8080"
fi

# A long-lived container per visitor, so each keeps one address for the whole check.
visitor() {
  docker run -d --name "$1" --network "$net" --entrypoint sleep curlimages/curl:8.10.1 900 >/dev/null
  created="$created $1"
}
address() { docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1"; }

# Statuses of $3 failed sign-ins by visitor $1 at $2; `spoof` sends a new X-Forwarded-For each time.
signins() {
  out=''
  i=1
  while [ "$i" -le "$3" ]; do
    if [ "${4:-}" = spoof ]; then
      code=$(docker exec "$1" curl -s -o /dev/null -w '%{http_code}' -X POST "$2/api/auth/local/login" \
        -H 'content-type: application/json' -H "X-Forwarded-For: 198.51.100.$i" \
        -d '{"email":"nobody@example.test","password":"wrong-password"}')
    else
      code=$(docker exec "$1" curl -s -o /dev/null -w '%{http_code}' -X POST "$2/api/auth/local/login" \
        -H 'content-type: application/json' -d '{"email":"nobody@example.test","password":"wrong-password"}')
    fi
    out="$out$code "
    i=$((i + 1))
  done
  echo "${out% }"
}

expect() {
  [ "$2" = "$3" ] || { echo "::error::$1: expected '$3', got '$2'"; exit 1; }
  echo "ok: $1 — $2"
}

THROTTLED='401 401 401 401 401 429 429'

# One visitor's sign-ins never use up another's, and rotating X-Forwarded-For buys nothing.
visitor v-spoofer
visitor v-other
expect 'a spoofer rotating X-Forwarded-For is still throttled' "$(signins v-spoofer "$front" 7 spoof)" "$THROTTLED"
expect 'another visitor keeps their own sign-in limit' "$(signins v-other "$front" 1)" '401'

# The composer reads the key per visitor: junk calls from one cannot switch it off for another.
token=$(docker exec v-other curl -s -X POST "$front/api/auth/local/register" -H 'content-type: application/json' \
  -d '{"email":"owner@check.test","password":"a-long-enough-passphrase","name":"Owner"}' |
  sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$token" ] || { echo '::error::could not register the first account'; exit 1; }
docker exec v-other curl -fsS -o /dev/null -X PUT "$front/api/platform-keys/anthropic_api_key" \
  -H "Authorization: Bearer $token" -H 'content-type: application/json' -d '{"value":"sk-ant-placeholder"}'
status() { docker exec v-other curl -s "$front/api/composer/status" -H "Authorization: Bearer $token"; }
expect 'the owner sees the composer on' "$(status)" '{"status":"ok"}'
i=1
while [ "$i" -le 61 ]; do
  docker exec v-spoofer curl -s -o /dev/null "$front/api/composer/status" -H 'Authorization: Bearer junk'
  i=$((i + 1))
done
expect "61 junk composer calls from another visitor leave it on for the owner" "$(status)" '{"status":"ok"}'

if [ "$mode" = compose ]; then
  # An edge that appends to X-Forwarded-For, as Cloudflare does, in front of the bundled proxy.
  edgefile=$(mktemp)
  printf '{\n\tservers {\n\t\ttrusted_proxies static 0.0.0.0/0 ::/0\n\t}\n}\n:8080 {\n\treverse_proxy proxy:8080\n}\n' >"$edgefile"
  docker run -d --name v-edge --network "$net" -v "$edgefile:/etc/caddy/Caddyfile:ro" caddy:2-alpine >/dev/null
  created="$created v-edge"
  edge=$(address v-edge)
  sleep 2
  visitor v-edge-a
  visitor v-edge-b
  expect 'through an untrusted edge, a spoofer is still throttled' "$(signins v-edge-a http://v-edge:8080 7 spoof)" "$THROTTLED"
  expect 'through an untrusted edge, visitors share its one limit, as documented' "$(signins v-edge-b http://v-edge:8080 1)" '429'

  proxy_changed=1
  SARATI_TRUSTED_PROXIES="$edge/32" docker compose up -d proxy >/dev/null 2>&1
  i=0
  until docker exec v-other curl -fsS -o /dev/null "$front/api/health" 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -le 30 ] || { echo '::error::the proxy did not come back'; exit 1; }
    sleep 1
  done
  visitor v-edge-c
  visitor v-edge-d
  expect 'with the edge listed, a spoofer behind it is still throttled' "$(signins v-edge-c http://v-edge:8080 7 spoof)" "$THROTTLED"
  expect 'with the edge listed, each visitor behind it has their own limit' "$(signins v-edge-d http://v-edge:8080 1)" '401'
else
  # Only the bundled proxy reaches the service and the composer inside the container.
  for port in 8001 8010; do
    code=$(docker exec v-other curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://$one:$port/api/health" || true)
    expect "port $port answers nothing from outside the container" "$code" '000'
  done
fi
echo "client addresses: per visitor through the bundled proxy ($mode)"
