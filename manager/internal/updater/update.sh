#!/bin/sh
# Platform self-update, executed inside a short-lived container that has the
# Docker socket and the platform root mounted.
#
# Running here rather than inside the manager means the manager can be recreated
# safely: nothing is replacing the process that is driving the replacement.
set -eu

VERSION="${1:?target version required}"
CLEANUP_OLD_IMAGES="${2:-false}"
case "$CLEANUP_OLD_IMAGES" in
    true|false) ;;
    *) echo "[updater] cleanup_old_images must be true or false" >&2; exit 1 ;;
esac
ROOT="${PLATFORM_ROOT:-/opt/vexdock}"
COMPOSE_FILE="$ROOT/compose.yml"
COMPOSE_BACKUP="$ROOT/system/compose.previous.yml"
ENV_FILE="$ROOT/.env"
MANAGER="vexdock-manager"

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
            *) sleep 2 ;;
        esac
        i=$((i + 1))
    done
    return 1
}

compose() {
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

cleanup_old_images() {
    [ "$CLEANUP_OLD_IMAGES" = true ] || return 0
    if ! current_images="$(compose config --images)"; then
        log "could not identify current images; keeping previous images"
        return 0
    fi
    printf '%s\n' "$PREVIOUS_IMAGES" | while IFS= read -r image; do
        [ -n "$image" ] || continue
        if printf '%s\n' "$current_images" | grep -Fxq "$image"; then
            continue
        fi
        if docker image rm "$image"; then
            log "removed previous image $image"
        else
            log "could not remove previous image $image"
        fi
    done
}

# Every failure after the version is written must come back through here,
# otherwise `set -e` would abort with the new version recorded and the old
# containers still running.
rollback() {
    log "rolling back to $PREVIOUS"
    set_version "$PREVIOUS"
    if [ -f "$COMPOSE_BACKUP" ]; then
        cp "$COMPOSE_BACKUP" "$COMPOSE_FILE"
    fi
    compose up -d --remove-orphans || log "rollback recreate reported an error"
    if wait_healthy; then
        log "rollback to $PREVIOUS completed"
    else
        log "rollback did not become healthy - manual intervention required"
    fi
    exit 1
}

PREVIOUS_IMAGES=""
if [ "$CLEANUP_OLD_IMAGES" = true ] && ! PREVIOUS_IMAGES="$(compose config --images)"; then
    log "could not identify previous images; image cleanup will be skipped"
    CLEANUP_OLD_IMAGES=false
fi

# The new images may need a service or a variable the installed compose file has
# never heard of, so the topology has to move with the version.
cp "$COMPOSE_FILE" "$COMPOSE_BACKUP"
set_version "$VERSION"
if [ -n "${PLATFORM_RAW_BASE:-}" ]; then
    log "fetching compose.yml for $VERSION"
    if wget -qO "$COMPOSE_FILE.new" "$PLATFORM_RAW_BASE/$VERSION/compose.yml"; then
        mv "$COMPOSE_FILE.new" "$COMPOSE_FILE"
        if ! compose config -q; then
            log "the downloaded compose.yml is not valid for this install"
            rollback
        fi
    else
        rm -f "$COMPOSE_FILE.new"
        log "could not download compose.yml for $VERSION"
        rollback
    fi
fi

log "pulling images"
if ! compose pull; then
    log "pull failed"
    rollback
fi

log "recreating stack"
if ! compose up -d --remove-orphans; then
    log "recreate failed"
    rollback
fi

if wait_healthy; then
    cleanup_old_images
    log "update to $VERSION completed"
    exit 0
fi

log "health check failed"
rollback
