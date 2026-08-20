#!/usr/bin/env bash
# End-to-end smoke test against a running stack.
#
# Exercises the path a real user takes: first-run setup, create a project from a
# compose file, deploy it, attach a domain, and reach the app through the proxy.
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

step 'cross-origin protection'
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" -X POST -H 'Origin: https://evil.example.com' \
    -H 'Content-Type: application/json' -d '{"name":"x","source_type":"compose"}' "$API/projects")
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
project=$(auth_post -d '{"name":"Smoke Test","source_type":"compose","compose_content":"services:\n  web:\n    image: nginx:alpine\n"}' "$API/projects")
PROJECT_ID=$(echo "$project" | json "d['id']")
pass "project created: $PROJECT_ID"

step 'deployment'
deployment=$(auth_post -X POST "$API/projects/$PROJECT_ID/deploy")
DEPLOYMENT_ID=$(echo "$deployment" | json "d['id']")
for _ in $(seq 1 60); do
    state=$(curl -fsS -b "$COOKIES" "$API/deployments/$DEPLOYMENT_ID" | json "d['deployment']['status']")
    case "$state" in
        success) break ;;
        failed|cancelled)
            curl -fsS -b "$COOKIES" "$API/deployments/$DEPLOYMENT_ID" | head -c 2000
            fail "deployment finished as $state"
            ;;
    esac
    sleep 2
done
[ "$state" = "success" ] || fail "deployment did not succeed in time (last state: $state)"
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
auth_post -d "{\"project_id\":\"$PROJECT_ID\",\"service\":\"web\",\"hostname\":\"smoke.test\",\"container_port\":80,\"https_enabled\":false,\"redirect_https\":false}" \
    "$API/domains" >/dev/null
pass 'domain added'

proxy_code=$(docker run --rm --network vexdock-internal curlimages/curl:latest \
    -s -o /dev/null -w '%{http_code}' -H 'Host: smoke.test' http://vexdock-nginx/)
[ "$proxy_code" = "200" ] || fail "the proxy returned $proxy_code for the new domain"
pass 'the application answers through the proxy'

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

# The default environment keeps its service; the new one starts empty.
staging_services=$(curl -fsS -b "$COOKIES" "$API/projects/$PROJECT_ID/services?environment=$ENVIRONMENT_ID" | json 'len(d)')
[ "$staging_services" = "0" ] || fail "staging inherited $staging_services services"
default_services=$(curl -fsS -b "$COOKIES" "$API/projects/$PROJECT_ID/services" | json 'len(d)')
[ "$default_services" != "0" ] || fail 'the default environment lost its services'
pass 'services are scoped to their environment'

curl -fsS -b "$COOKIES" -H "Origin: $ORIGIN" -X DELETE "$API/environments/$ENVIRONMENT_ID?volumes=true" >/dev/null
pass 'environment removed'

step 'cleanup'
curl -fsS -b "$COOKIES" -H "Origin: $ORIGIN" -X DELETE "$API/projects/$PROJECT_ID?volumes=true" >/dev/null
pass 'project removed'

printf '\nSmoke test passed.\n'
