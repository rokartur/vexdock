#!/usr/bin/env bash
# End-to-end smoke test against a running stack.
#
# Exercises the path a real user takes: first-run setup, create a project from a
# compose file, deploy it, attach a domain, and reach the app through the proxy.
#
#   make dev-up && ./scripts/smoke-test.sh
set -euo pipefail

API="${API:-http://127.0.0.1:3000/api}"
COOKIES="$(mktemp)"
EMAIL="smoke@example.com"
PASSWORD="smoke-test-password"
trap 'rm -f "$COOKIES"' EXIT

pass() { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1" >&2; exit 1; }

json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

step() { printf '\n%s\n' "$1"; }

step 'health'
curl -fsS "$API/health" | grep -q '"status":"healthy"' || fail 'manager is not healthy'
pass 'manager reports healthy'

step 'authentication'
status=$(curl -fsS "$API/auth/status")
if echo "$status" | grep -q '"needs_setup":true'; then
    curl -fsS -c "$COOKIES" -H 'Content-Type: application/json' \
        -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$API/auth/setup" >/dev/null
    pass 'administrator created'
else
    curl -fsS -c "$COOKIES" -H 'Content-Type: application/json' \
        -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$API/auth/login" >/dev/null
    pass 'signed in'
fi
CSRF=$(curl -fsS -b "$COOKIES" "$API/auth/me" | json "d['csrf_token']")

auth_post() { curl -fsS -b "$COOKIES" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' "$@"; }

step 'csrf protection'
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" -X POST \
    -H 'Content-Type: application/json' -d '{"name":"x","source_type":"compose"}' "$API/projects")
[ "$code" = "403" ] || fail "a mutation without a CSRF token returned $code, expected 403"
pass 'mutations without a CSRF token are rejected'

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

proxy_code=$(docker run --rm --network platform-internal curlimages/curl:latest \
    -s -o /dev/null -w '%{http_code}' -H 'Host: smoke.test' http://platform-nginx/)
[ "$proxy_code" = "200" ] || fail "the proxy returned $proxy_code for the new domain"
pass 'the application answers through the proxy'

step 'environment'
auth_post -X PUT -d '{"variables":[{"key":"SECRET_TOKEN","value":"top-secret","is_secret":true,"updated_at":""}]}' \
    "$API/projects/$PROJECT_ID/environment" >/dev/null
masked=$(curl -fsS -b "$COOKIES" "$API/projects/$PROJECT_ID/environment" | json "d[0]['value']")
[ "$masked" != "top-secret" ] || fail 'a secret value was returned in plaintext'
pass 'secrets are masked in API responses'

step 'cleanup'
curl -fsS -b "$COOKIES" -H "X-CSRF-Token: $CSRF" -X DELETE "$API/projects/$PROJECT_ID?volumes=true" >/dev/null
pass 'project removed'

printf '\nSmoke test passed.\n'
