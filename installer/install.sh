#!/bin/sh
# Platform installer.
#
#   curl -fsSL https://raw.githubusercontent.com/rokartur/vexdock/main/installer/install.sh | sudo sh
#   curl -fsSL https://raw.githubusercontent.com/rokartur/vexdock/main/installer/install.sh | sudo sh -s update
#   curl -fsSL https://raw.githubusercontent.com/rokartur/vexdock/main/installer/install.sh | sudo sh -s uninstall
#
# POSIX sh only: Debian's /bin/sh is dash.
set -eu

# REPO is the single source of truth for where this install pulls from: a fork
# only has to set PLATFORM_REPO and both the compose file and the images follow.
REPO="${PLATFORM_REPO:-rokartur/vexdock}"
RAW_BASE="${PLATFORM_RAW_BASE:-https://raw.githubusercontent.com/$REPO}"
REGISTRY="${PLATFORM_REGISTRY:-ghcr.io/${REPO%%/*}}"
# Installs made before the directory was renamed still live in /opt/platform,
# and their deployed projects bind-mount paths inside it, so they are adopted
# where they are rather than moved under the running containers.
if [ -n "${PLATFORM_ROOT:-}" ]; then
    ROOT="$PLATFORM_ROOT"
elif [ -f /opt/platform/compose.yml ]; then
    ROOT=/opt/platform
else
    ROOT=/opt/vexdock
fi
PROXY_NETWORK="vexdock-proxy"
DASHBOARD_PORT="${DASHBOARD_PORT:-3000}"
VERSION="${PLATFORM_VERSION:-latest}"
ACTION="${1:-install}"

RED=''
GREEN=''
YELLOW=''
DIM=''
RESET=''
if [ -t 1 ]; then
    RED=$(printf '\033[31m'); GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m')
    DIM=$(printf '\033[2m'); RESET=$(printf '\033[0m')
fi

ok()   { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
info() { printf '%s•%s %s\n' "$DIM" "$RESET" "$1"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()  { printf '%s✗%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }

require_root() {
    [ "$(id -u)" -eq 0 ] || die "This installer must run as root. Try: curl -fsSL … | sudo sh"
}

# random_hex prints 32 random bytes as hex, for the session signing key and the
# setup token. openssl is not guaranteed on a minimal Debian, /dev/urandom is.
random_hex() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32
    else
        od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
    fi
}

# os_release reads one field without sourcing the file into this shell:
# /etc/os-release defines VERSION, which would otherwise silently overwrite the
# platform version being installed.
os_release() {
    # shellcheck disable=SC1091
    (. /etc/os-release && eval "printf '%s' \"\${$1:-}\"")
}

detect_os() {
    [ -r /etc/os-release ] || die "Cannot detect the operating system (/etc/os-release is missing)."
    OS_ID="$(os_release ID)"
    [ -n "$OS_ID" ] || OS_ID=unknown
    OS_NAME="$(os_release PRETTY_NAME)"
    [ -n "$OS_NAME" ] || OS_NAME="$OS_ID"
    case "$OS_ID" in
        ubuntu|debian) ok "System supported: $OS_NAME" ;;
        *) warn "Untested system: $OS_NAME. Ubuntu LTS and Debian stable are supported." ;;
    esac
}

# The published images are linux/amd64 only, so an arm server has to fail here
# with a sentence rather than on a manifest error three steps later.
detect_arch() {
    ARCH="$(uname -m)"
    case "$ARCH" in
        x86_64|amd64) ARCH=amd64 ;;
        *) die "Unsupported architecture: $ARCH. Only amd64 images are published." ;;
    esac
    ok "Architecture: $ARCH"
}

check_resources() {
    mem_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
    if [ "$mem_kb" -gt 0 ] && [ "$mem_kb" -lt 900000 ]; then
        warn "Less than 1 GB of RAM detected. Builds may fail; deploy prebuilt images instead."
    fi
    disk_mb="$(df -Pm / | awk 'NR==2 {print $4}')"
    [ "$disk_mb" -ge 2048 ] || die "At least 2 GB of free disk space is required (found ${disk_mb} MB)."
    ok "Resources checked"
}

# port_owner prints "PID NAME" for whoever is listening on $1, or nothing.
port_owner() {
    port="$1"
    if command -v ss >/dev/null 2>&1; then
        ss -lntpH "sport = :$port" 2>/dev/null | sed -n 's/.*users:((\"\([^\"]*\)\",pid=\([0-9]*\).*/\2 \1/p' | head -n1
    elif command -v lsof >/dev/null 2>&1; then
        lsof -nP -iTCP:"$port" -sTCP:LISTEN -Fpc 2>/dev/null | awk '/^p/{pid=substr($0,2)} /^c/{print pid, substr($0,2); exit}'
    fi
}

check_ports() {
    busy=0
    for port in 80 443 "$DASHBOARD_PORT"; do
        owner="$(port_owner "$port" || true)"
        if [ -n "$owner" ]; then
            # Our own nginx re-binding during an update is expected.
            case "$owner" in
                *docker*|*nginx*)
                    if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx vexdock-nginx; then
                        continue
                    fi
                    ;;
            esac
            printf '%s✗%s Port %s is already in use.\n' "$RED" "$RESET" "$port" >&2
            printf '  Process: PID %s\n' "$owner" >&2
            busy=1
        fi
    done
    [ "$busy" -eq 0 ] || die "Installation cannot continue while ports 80, 443 or $DASHBOARD_PORT are taken."
    ok "Ports 80, 443 and $DASHBOARD_PORT are free"
}

install_docker() {
    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
        ok "Docker ready"
    else
        info "Installing Docker…"
        curl -fsSL https://get.docker.com | sh >/dev/null 2>&1 || die "Docker installation failed."
        systemctl enable --now docker >/dev/null 2>&1 || true
        docker info >/dev/null 2>&1 || die "Docker is installed but the daemon is not running."
        ok "Docker installed"
    fi

    if docker compose version >/dev/null 2>&1; then
        ok "Docker Compose ready"
    else
        die "Docker Compose v2 is required. Install the docker-compose-plugin package."
    fi
}

create_directories() {
    for dir in "" /data /projects /nginx /nginx/generated /nginx/custom /nginx/acme-challenge \
               /certificates /backups /system; do
        mkdir -p "$ROOT$dir"
    done
    chmod 755 "$ROOT"
    mkdir -p "$ROOT/secrets"
    chmod 700 "$ROOT/secrets"
    chmod 700 "$ROOT/data" "$ROOT/backups"
    ok "Directories created under $ROOT"
}

create_network() {
    if docker network inspect "$PROXY_NETWORK" >/dev/null 2>&1; then
        ok "Proxy network present"
    else
        docker network create "$PROXY_NETWORK" >/dev/null
        ok "Proxy network created"
    fi
}

# `latest` is a floating image tag, but the dashboard decides whether an update
# exists by comparing the recorded version against the newest release by semver.
# Recording "latest" would offer an update forever, so resolve it to a tag once.
resolve_version() {
    if [ "$VERSION" != latest ]; then
        return 0
    fi
    tag=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null |
        sed -n 's/.*"tag_name"[ ]*:[ ]*"\([^"]*\)".*/\1/p') || tag=""
    if [ -n "$tag" ]; then
        VERSION="$tag"
    fi
}

# The compose file must come from the same ref as the images it references, or a
# pinned install runs new images against main's topology.
# An update stops the stack before it gets here, so writing compose.yml in place
# would let a dead transfer truncate the only file that can start the platform
# again. Land it beside the live one and move it over once it is whole.
fetch_compose() {
    if [ -n "${PLATFORM_LOCAL_COMPOSE:-}" ]; then
        cp "$PLATFORM_LOCAL_COMPOSE" "$ROOT/compose.yml.new" \
            || die "Could not copy compose.yml from $PLATFORM_LOCAL_COMPOSE"
    else
        ref=main
        [ "$VERSION" = latest ] || ref="$VERSION"
        curl -fsSL "$RAW_BASE/$ref/compose.yml" -o "$ROOT/compose.yml.new" \
            || { rm -f "$ROOT/compose.yml.new"; die "Could not download compose.yml from $RAW_BASE/$ref"; }
    fi
    [ -s "$ROOT/compose.yml.new" ] \
        || { rm -f "$ROOT/compose.yml.new"; die "Downloaded compose.yml is empty"; }
    mv "$ROOT/compose.yml.new" "$ROOT/compose.yml"
    ok "System compose downloaded"
}

# env_set adds a key only when it is absent, so an update can introduce a new
# option without overwriting a generated secret or a hand-edited value.
env_set() {
    grep -q "^$1=" "$ROOT/.env" 2>/dev/null && return 0
    printf '%s=%s\n' "$1" "$2" >> "$ROOT/.env"
}

write_env() {
    env_file="$ROOT/.env"
    if [ ! -f "$env_file" ]; then
        : > "$env_file"
    fi
    chmod 600 "$env_file"
    env_set VERSION "$VERSION"
    env_set REGISTRY "$REGISTRY"
    env_set PLATFORM_ROOT "$ROOT"
    env_set DASHBOARD_PORT "$DASHBOARD_PORT"
    env_set ACME_EMAIL "${ACME_EMAIL:-}"
    env_set ACME_STAGING "${ACME_STAGING:-false}"
    env_set PUBLIC_URL "${PUBLIC_URL:-}"
    # Signs every session cookie. Generated per install: a shared default would
    # let anyone mint a valid session for every Vexdock on the internet.
    env_set BETTER_AUTH_SECRET "$(random_hex)"
    # Guards the one-time administrator sign-up until an account exists.
    env_set SETUP_TOKEN "$(random_hex)"
    ok "Configuration written"
}

setup_token() {
    sed -n 's/^SETUP_TOKEN=//p' "$ROOT/.env"
}

compose_cmd() {
    docker compose -f "$ROOT/compose.yml" --env-file "$ROOT/.env" "$@"
}

start_stack() {
    info "Pulling images…"
    # A fresh server has no local copies, so a failed pull is fatal and the
    # registry's own message is the only useful diagnostic.
    compose_cmd pull || die "Could not pull the platform images from $REGISTRY."
    compose_cmd up -d --remove-orphans >/dev/null || die "The platform stack failed to start."
    ok "Manager, auth and Nginx started"
}

# The manager implements its own health check, so the container status is the
# authoritative signal. Probing the published port is only a fallback, since it
# is not reachable when the installer itself runs inside a container.
container_healthy() {
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' vexdock-manager 2>/dev/null || echo missing)"
    [ "$status" = "healthy" ] || [ "$status" = "running" ]
}

wait_healthy() {
    info "Waiting for the health check…"
    i=0
    while [ "$i" -lt 60 ]; do
        if container_healthy; then
            ok "Health check passed"
            return 0
        fi
        if curl -fsS "http://127.0.0.1:$DASHBOARD_PORT/api/health" >/dev/null 2>&1; then
            ok "Health check passed"
            return 0
        fi
        i=$((i + 1))
        sleep 2
    done
    printf '\n%sThe platform did not become healthy in time.%s\n' "$RED" "$RESET" >&2
    docker logs --tail 40 vexdock-manager 2>&1 || true
    exit 1
}

detect_ip() {
    ip="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
    if [ -z "$ip" ]; then
        ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    fi
    [ -n "$ip" ] || ip="localhost"
    printf '%s' "$ip"
}

do_install() {
    printf '\n%sInstalling the platform…%s\n\n' "$DIM" "$RESET"
    require_root
    detect_os
    detect_arch
    check_resources
    check_ports
    install_docker
    resolve_version
    create_directories
    create_network
    fetch_compose
    write_env
    # env_set only inserts missing keys, so a retry after a partial install
    # would keep the previous VERSION=latest and pull tags that do not exist.
    if [ "$VERSION" != latest ]; then
        sed -i "s/^VERSION=.*/VERSION=$VERSION/" "$ROOT/.env"
    fi
    start_stack
    wait_healthy

    ip="$(detect_ip)"
    printf '\n%sInstallation complete%s\n\n' "$GREEN" "$RESET"

    printf 'Dashboard:\nhttp://%s:%s\n\n' "$ip" "$DASHBOARD_PORT"
    printf 'Setup token (needed once, to create the administrator):\n%s\n\n' "$(setup_token)"
    printf 'Kept in %s/.env if you lose it.\n\n' "$ROOT"
}

do_update() {
    require_root
    [ -f "$ROOT/compose.yml" ] || die "The platform is not installed at $ROOT."
    resolve_version
    # First: an install made by an older version has none of the keys added
    # since, and every compose command below needs them to interpolate.
    write_env

    info "Backing up configuration…"
    stamp="$(date -u +%Y-%m-%dT%H%M%S)"
    mkdir -p "$ROOT/backups/$stamp"
    # Both SQLite databases are copied cold: a file copy of a live WAL database
    # is not guaranteed to restore, and this backup is the only way back.
    compose_cmd stop >/dev/null 2>&1 || true
    cp -a "$ROOT/data" "$ROOT/backups/$stamp/data" 2>/dev/null || true
    cp -a "$ROOT/nginx" "$ROOT/backups/$stamp/nginx" 2>/dev/null || true
    cp -a "$ROOT/certificates" "$ROOT/backups/$stamp/certificates" 2>/dev/null || true
    cp -a "$ROOT/secrets" "$ROOT/backups/$stamp/secrets" 2>/dev/null || true
    # compose.yml is the file this update replaces, so a backup without it can
    # restore the data but not the topology that ran against it.
    cp -a "$ROOT/compose.yml" "$ROOT/backups/$stamp/compose.yml" 2>/dev/null || true
    ok "Backup written to $ROOT/backups/$stamp"
    # Keep the five most recent; unbounded update backups fill a small VPS disk.
    # The stamps are ISO, so the glob is already in chronological order.
    set -- "$ROOT"/backups/*/
    while [ "$#" -gt 5 ]; do
        rm -rf "$1"
        shift
    done

    fetch_compose
    if [ "$VERSION" != "latest" ]; then
        sed -i "s/^VERSION=.*/VERSION=$VERSION/" "$ROOT/.env"
    fi
    start_stack
    wait_healthy
    printf '\n%sUpdate complete%s\n\n' "$GREEN" "$RESET"
}

do_uninstall() {
    require_root
    [ -f "$ROOT/compose.yml" ] || die "The platform is not installed at $ROOT."

    printf '\nRemove the platform:\n'
    printf '  1. Remove the platform, keep projects and data (default)\n'
    printf '  2. Remove the platform and all platform metadata\n\n'
    choice="${PLATFORM_UNINSTALL_MODE:-}"
    if [ -z "$choice" ]; then
        printf 'Choice [1]: '
        read -r choice </dev/tty || choice=1
    fi
    [ -n "$choice" ] || choice=1

    compose_cmd down --remove-orphans >/dev/null 2>&1 || true
    ok "Platform containers stopped"

    if [ "$choice" = "2" ]; then
        rm -rf "$ROOT/data" "$ROOT/nginx" "$ROOT/certificates" "$ROOT/secrets" "$ROOT/system" "$ROOT/compose.yml" "$ROOT/.env"
        ok "Platform metadata removed"
        warn "Project directories under $ROOT/projects and their containers were left untouched."
    else
        ok "All data kept in $ROOT"
    fi
    printf '\nDeployed applications are still running. Remove them with docker compose if you no longer need them.\n\n'
}

case "$ACTION" in
    install)   do_install ;;
    update)    do_update ;;
    uninstall) do_uninstall ;;
    *) die "Unknown action '$ACTION'. Use install, update or uninstall." ;;
esac
