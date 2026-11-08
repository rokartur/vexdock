#!/usr/bin/env bash
# End-to-end smoke test against a running stack.
#
# Exercises the path a real user takes: first-run setup, create a project, add a
# service to it, deploy it, attach a domain, and reach the app through the proxy.
#
#   make dev-up && ./scripts/smoke-test.sh
set -euo pipefail

ORIGIN="${ORIGIN:-http://127.0.0.1:3000}"
API="$ORIGIN/api"
COOKIES="$(mktemp)"
EMAIL="smoke@example.com"
PASSWORD="smoke-test-password"
# Matches SETUP_TOKEN in the dev stack; a real install prints its own.
SETUP_TOKEN="${SETUP_TOKEN:-dev}"
trap 'rm -f "$COOKIES"' EXIT

pass() { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1" >&2; exit 1; }

json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

step() { printf '\n%s\n' "$1"; }

step 'health'
# `docker compose up -d` returns before the stack serves traffic, so poll instead
# of probing once: Nginx answers on the published port while the manager is still
# starting, which shows up as a connection reset.
for _ in $(seq 1 60); do
    curl -fsS "$API/health" 2>/dev/null | grep -q '"status":"healthy"' && break
    sleep 2
done
curl -fsS "$API/health" | grep -q '"status":"healthy"' || fail 'manager is not healthy'
pass 'manager reports healthy'

step 'authentication'
# Login belongs to the better-auth service, which Nginx serves on the same origin.
status=$(curl -fsS "$API/auth/platform-status")
if echo "$status" | grep -q '"needs_setup":true'; then
    code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -H "Origin: $ORIGIN" \
        -H 'x-setup-token: wrong' \
        -d "{\"email\":\"squatter@example.com\",\"password\":\"$PASSWORD\",\"name\":\"squatter\"}" \
        "$API/auth/sign-up/email")
    [ "$code" = "403" ] || fail "sign-up with a wrong setup token returned $code, expected 403"
    pass 'the setup token gates the first account'

    curl -fsS -c "$COOKIES" -H 'Content-Type: application/json' -H "Origin: $ORIGIN" \
        -H "x-setup-token: $SETUP_TOKEN" \
        -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"smoke\"}" \
        "$API/auth/sign-up/email" >/dev/null
    pass 'administrator created'
else
    curl -fsS -c "$COOKIES" -H 'Content-Type: application/json' -H "Origin: $ORIGIN" \
        -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$API/auth/sign-in/email" >/dev/null
    pass 'signed in'
fi

principal=$(curl -fsS -b "$COOKIES" "$API/me" | json "d['user']['email']")
[ "$principal" = "$EMAIL" ] || fail "the manager resolved the session to '$principal'"
pass 'the manager validates the better-auth session'

auth_post() { curl -fsS -b "$COOKIES" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' "$@"; }

wait_for_deployment() {
    for _ in $(seq 1 240); do
        state=$(curl -fsS -b "$COOKIES" "$API/deployments/$1" | json "d['deployment']['status']")
        case "$state" in
            success) return ;;
            failed|cancelled)
                curl -fsS -b "$COOKIES" "$API/deployments/$1" | head -c 2000
                fail "deployment finished as $state"
                ;;
        esac
        sleep 0.5
    done
    fail "deployment did not succeed in time (last state: $state)"
}

step 'cross-origin protection'
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" -X POST -H 'Origin: https://evil.example.com' \
    -H 'Content-Type: application/json' -d '{"name":"x"}' "$API/projects")
[ "$code" = "403" ] || fail "a cross-origin mutation returned $code, expected 403"
pass 'cross-origin mutations are rejected'

# The auth service has its own origin check; echoing the caller's Origin back
# would make it accept this.
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
    -H 'Origin: https://evil.example.com' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$API/auth/sign-in/email")
[ "$code" != "200" ] || fail 'the auth service accepted a cross-origin sign-in'
pass 'cross-origin sign-in is rejected'

step 'sign-up is closed'
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -H "Origin: $ORIGIN" \
    -H "x-setup-token: $SETUP_TOKEN" \
    -d '{"email":"second@example.com","password":"another-password","name":"second"}' "$API/auth/sign-up/email")
[ "$code" = "409" ] || fail "a second sign-up returned $code, expected 409"
pass 'only one administrator can be created'

step 'project'
project=$(auth_post -d '{"name":"Smoke Test"}' "$API/projects")
PROJECT_ID=$(echo "$project" | json "d['id']")
pass "project created: $PROJECT_ID"

# A project is a grouping; what runs is one service with its own provider.
auth_post -d '{"name":"web","provider":"image","image":"nginx:alpine"}' \
    "$API/projects/$PROJECT_ID/services" >/dev/null
pass 'image service added'

step 'deployment'
# A deployment is always one service, so deploying the project returns one per
# service it owns.
deployment=$(auth_post -X POST "$API/projects/$PROJECT_ID/deploy")
DEPLOYMENT_ID=$(echo "$deployment" | json "d[0]['id']")
[ "$(echo "$deployment" | json "d[0]['service_name']")" = "web" ] ||
    fail 'the queued deployment is not scoped to the service'
wait_for_deployment "$DEPLOYMENT_ID"
pass 'deployment succeeded'

steps=$(curl -fsS -b "$COOKIES" "$API/deployments/$DEPLOYMENT_ID" | json "' '.join(s['name'] for s in d['steps'])")
for expected in validate start healthcheck proxy finish; do
    echo "$steps" | grep -q "$expected" || fail "pipeline is missing the $expected step"
done
pass "pipeline ran: $steps"

step 'services'
service_state=$(curl -fsS -b "$COOKIES" "$API/projects/$PROJECT_ID/services" | json "d[0]['state']")
[ "$service_state" = "running" ] || fail "service state is $service_state, expected running"
pass 'service is running'

step 'domain and proxy'
DOMAIN_ID=$(auth_post -d "{\"project_id\":\"$PROJECT_ID\",\"service\":\"web\",\"hostname\":\"smoke.test\",\"container_port\":80,\"https_enabled\":false,\"redirect_https\":false}" \
    "$API/domains" | json "d['domain']['id']")
pass 'domain added'

# `nginx -s reload` returns once signalled, before new workers serve the new server block.
for _ in $(seq 1 10); do
    proxy_code=$(docker run --rm --network vexdock-internal curlimages/curl:latest \
        -s -o /dev/null -w '%{http_code}' -H 'Host: smoke.test' http://vexdock-nginx/)
    [ "$proxy_code" = "200" ] && break
    sleep 1
done
[ "$proxy_code" = "200" ] || fail "the proxy returned $proxy_code for the new domain"
pass 'the application answers through the proxy'

step 'analytics'
beacon=$(docker run --rm --network vexdock-internal curlimages/curl:latest -s -o /dev/null -w '%{http_code}' \
    -H 'Host: smoke.test' http://vexdock-nginx/_vx/script.js)
[ "$beacon" = "200" ] || fail "the domain served the analytics script with $beacon"
docker run --rm --network vexdock-internal curlimages/curl:latest -s -o /dev/null -H 'Host: smoke.test' \
    -A 'Mozilla/5.0 (X11; Linux x86_64) Firefox/128.0' \
    -d '{"kind":"pageview","visitor":"smoke-visitor","session":"smoke-session","path":"/"}' \
    http://vexdock-nginx/_vx/event
visitors=$(curl -fsS -b "$COOKIES" "$API/domains/$DOMAIN_ID/analytics?range=24h" | json "d['report']['visitors']")
[ "$visitors" = "1" ] || fail "the report counts $visitors visitors after one pageview, expected 1"
pass 'a pageview through the proxy lands in the report'

step 'redeploy'
# An application with no port or volume starts beside the old container and the
# proxy switches to it at once: through a redeploy from nginx to httpd every
# answer is a 200, and once httpd answers, nginx never answers again.
docker run -d --name vexdock-smoke-probe --network vexdock-internal --entrypoint sh curlimages/curl:latest -c '
    while :; do
        r=$(curl -s -w " %{http_code}" -H "Host: smoke.test" http://vexdock-nginx/)
        case "$r" in *nginx*) build=old ;; *"It works"*) build=new ;; *) build=other ;; esac
        echo "$build ${r##* }"
        sleep 0.05
    done' >/dev/null
trap 'rm -f "$COOKIES"; docker rm -f vexdock-smoke-probe >/dev/null 2>&1' EXIT
until docker logs vexdock-smoke-probe 2>&1 | grep -q .; do sleep 0.2; done
web_service=$(curl -fsS -b "$COOKIES" "$API/projects/$PROJECT_ID/services" | json "d[0]['id']")
auth_post -X PATCH -d '{"image":"httpd:alpine"}' "$API/services/$web_service" >/dev/null
wait_for_deployment "$(auth_post -X POST "$API/services/$web_service/deploy" | json "d['id']")"
sleep 1
answers=$(docker logs vexdock-smoke-probe 2>&1)
docker rm -f vexdock-smoke-probe >/dev/null
summary=$(echo "$answers" | sort | uniq -c | xargs)
echo "$answers" | grep -qv ' 200$' && fail "the proxy answered $summary during the redeploy, expected only 200"
order=$(echo "$answers" | cut -d' ' -f1 | uniq | xargs)
[ "$order" = 'old new' ] || fail "the builds answered in the order '$order', expected 'old new'"
pass "the proxy switched builds once with no error: $summary"
container_name=$(curl -fsS -b "$COOKIES" "$API/projects/$PROJECT_ID/services" | json "d[0]['container_name']")
[ "$(docker ps -q --filter "name=^${container_name}\$" | wc -l | xargs)" = 1 ] ||
    fail "no single running container is named $container_name after the redeploy"
pass "one container named $container_name runs after the redeploy"

step 'variables'
auth_post -X PUT -d '{"variables":[{"key":"SECRET_TOKEN","value":"top-secret","is_secret":true,"updated_at":""}]}' \
    "$API/projects/$PROJECT_ID/variables" >/dev/null
stored=$(curl -fsS -b "$COOKIES" "$API/projects/$PROJECT_ID/variables" | json "d[0]['value']")
# The editor is exempt from masking on purpose (docs/security.md): showing the
# value is the point of the page. What protects a secret is the write side,
# where a masked value means 'unchanged' and must not overwrite the real one.
[ "$stored" = "top-secret" ] || fail "the variables editor returned $stored, not the stored value"
pass 'the editor returns the stored value'

auth_post -X PUT -d '{"variables":[{"key":"SECRET_TOKEN","value":"••••••••••••","is_secret":true,"updated_at":""}]}' \
    "$API/projects/$PROJECT_ID/variables" >/dev/null
kept=$(curl -fsS -b "$COOKIES" "$API/projects/$PROJECT_ID/variables" | json "d[0]['value']")
[ "$kept" = "top-secret" ] || fail 'saving a masked value overwrote the secret'
pass 'saving a masked value back is a no-op'

step 'environments'
ENVIRONMENT_ID=$(auth_post -d '{"name":"Staging","branch":"main"}' "$API/projects/$PROJECT_ID/environments" | json "d['id']")
[ -n "$ENVIRONMENT_ID" ] || fail 'creating an environment returned no id'
# Its own docker namespace is the whole point: sharing one would mean a staging
# deploy stopping production's containers.
namespace=$(curl -fsS -b "$COOKIES" "$API/environments/$ENVIRONMENT_ID" | json "d['compose_project_name']")
[ "$namespace" != "p_$(printf '%s' "$PROJECT_ID" | tr '[:upper:]' '[:lower:]')" ] ||
    fail 'the new environment shares the default one'\''s compose project'
pass "staging has its own namespace: $namespace"

# A new environment starts as a copy of the default one, but the copies are its
# own rows: deploying staging must never touch production's containers.
staging_service=$(curl -fsS -b "$COOKIES" "$API/projects/$PROJECT_ID/services?environment=$ENVIRONMENT_ID" | json "d[0]['id']")
default_service=$(curl -fsS -b "$COOKIES" "$API/projects/$PROJECT_ID/services" | json "d[0]['id']")
[ -n "$staging_service" ] || fail 'staging inherited no services'
[ "$staging_service" != "$default_service" ] || fail 'staging shares the default environment'\''s service row'
pass 'services are copied into the new environment and scoped to it'

step 'studio'
db_service=$(auth_post -d '{"name":"db","database":{"engine":"postgres","version":"17-alpine"}}' \
    "$API/projects/$PROJECT_ID/services?environment=$ENVIRONMENT_ID" | json "d['id']")
wait_for_deployment "$(auth_post -X POST "$API/services/$db_service/deploy" | json "d['id']")"
schemas=$(curl -fsS -b "$COOKIES" "$API/services/$db_service/studio" | json "' '.join(s['name'] for s in d['schemas'])")
echo "$schemas" | grep -qw public || fail "studio listed schemas '$schemas', expected public"
auth_post -d '{"schema":"public","query":"create table smoke (id int primary key, note text)"}' \
    "$API/services/$db_service/studio/query" >/dev/null
auth_post -d '{"schema":"public","table":"smoke","inserts":[{"id":"1","note":"hi"}]}' \
    "$API/services/$db_service/studio/changes" >/dev/null
note=$(curl -fsS -b "$COOKIES" "$API/services/$db_service/studio/rows?schema=public&table=smoke" | json "d['rows'][0][1]")
[ "$note" = "hi" ] || fail "studio read back '$note' after inserting 'hi'"
pass 'studio reads and writes an unpublished database'

# The manager joined staging's network for Studio; compose down fails unless it leaves first.
curl -fsS -b "$COOKIES" -H "Origin: $ORIGIN" -X DELETE "$API/environments/$ENVIRONMENT_ID?volumes=true" >/dev/null
pass 'environment removed'

step 'project token and mcp'
token_json=$(auth_post -d "{\"name\":\"smoke\",\"projects\":[{\"project_id\":\"$PROJECT_ID\",\"level\":\"read\"}]}" "$API/tokens")
TOKEN=$(printf '%s' "$token_json" | json "d['value']")
TOKEN_ID=$(printf '%s' "$token_json" | json "d['token']['id']")
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$API/projects/$PROJECT_ID")
[ "$code" = 200 ] || fail "a read token got $code on its own project"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$API/tokens")
[ "$code" = 403 ] || fail "a project token got $code on an admin route, expected 403"
pass 'a project token reaches its project and nothing else'

mcp_call() {
    curl -s -H "Authorization: Bearer $1" -H 'Content-Type: application/json' \
        -H 'Accept: application/json, text/event-stream' -d "$2" "$ORIGIN/mcp"
}
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{}' "$ORIGIN/mcp")
[ "$code" = 401 ] || fail "mcp without a token answered $code, expected 401"
reply=$(mcp_call "$TOKEN" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"get_project\",\"arguments\":{\"project_id\":\"$PROJECT_ID\"}}}")
printf '%s' "$reply" | grep -q "$PROJECT_ID" || fail "mcp get_project did not answer the project: ${reply:0:500}"
reply=$(mcp_call "$TOKEN" '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"docker_cleanup","arguments":{"kind":"images"}}}')
printf '%s' "$reply" | grep -q 'FORBIDDEN' || fail "mcp let a project token prune images: ${reply:0:500}"
pass 'mcp answers with the token'\''s own permissions'
curl -fsS -b "$COOKIES" -H "Origin: $ORIGIN" -X DELETE "$API/tokens/$TOKEN_ID" >/dev/null

step 'cleanup'
curl -fsS -b "$COOKIES" -H "Origin: $ORIGIN" -X DELETE "$API/services/$default_service" >/dev/null
curl -fsS -b "$COOKIES" -H "Origin: $ORIGIN" -X DELETE "$API/projects/$PROJECT_ID" >/dev/null
pass 'project removed'

printf '\nSmoke test passed.\n'
