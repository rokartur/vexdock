#!/bin/sh
# Platform self-update, executed inside a short-lived container that has the
# Docker socket and the platform root mounted.
#
# Running here rather than inside the manager means the manager can be recreated
# safely: nothing is replacing the process that is driving the replacement.
set -eu

VERSION="${1:?target version required}"
ROOT="${PLATFORM_ROOT:-/opt/platform}"
COMPOSE_FILE="$ROOT/compose.yml"
ENV_FILE="$ROOT/.env"
MANAGER="platform-manager"

log() { echo "[updater] $*"; }

cd "$ROOT"

PREVIOUS="latest"
if [ -f "$ENV_FILE" ] && grep -q '^VERSION=' "$ENV_FILE"; then
    PREVIOUS="$(grep '^VERSION=' "$ENV_FILE" | head -n1 | cut -d= -f2)"
fi
log "current=$PREVIOUS target=$VERSION"

set_version() {
    if [ -f "$ENV_FILE" ] && grep -q '^VERSION=' "$ENV_FILE"; then
        sed -i "s/^VERSION=.*/VERSION=$1/" "$ENV_FILE"
    else
        echo "VERSION=$1" >> "$ENV_FILE"
    fi
}

# Waits for the manager container to report healthy; the manager binary
# implements its own healthcheck, so no extra tooling is needed here.
wait_healthy() {
    i=0
    while [ "$i" -lt 60 ]; do
        status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$MANAGER" 2>/dev/null || echo missing)"
        case "$status" in
            healthy|running) return 0 ;;
            unhealthy) sleep 2 ;;
            *) sleep 2 ;;
        esac
        i=$((i + 1))
    done
    return 1
}

set_version "$VERSION"
log "pulling images"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" pull

log "recreating stack"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --remove-orphans

if wait_healthy; then
    log "update to $VERSION completed"
    exit 0
fi

log "health check failed, rolling back to $PREVIOUS"
set_version "$PREVIOUS"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --remove-orphans
if wait_healthy; then
    log "rollback to $PREVIOUS completed"
else
    log "rollback did not become healthy - manual intervention required"
fi
exit 1
