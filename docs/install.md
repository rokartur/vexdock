# Installing

## Requirements

- Ubuntu 22.04 LTS or newer, or Debian 12 or newer. Other distributions may work
  but are untested; the installer warns and continues.
- amd64. The published images are amd64 only and the installer stops on anything
  else rather than failing later on a missing manifest.
- 1 GB RAM minimum. Building images on the server needs 2 GB.
- 2 GB free disk space.
- Ports 80, 443 and 3000 free. The installer refuses to continue otherwise and
  names the process holding the port.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/rokartur/vexdock/main/installer/install.sh | sudo sh
```

The installer:

1. Checks the operating system, architecture, memory, disk and ports.
2. Installs Docker and the Compose plugin if they are missing.
3. Creates `/opt/vexdock` and the shared `vexdock-proxy` network.
4. Downloads `compose.yml`, writes `.env` with a generated session secret and
   setup token, and starts the stack.
5. Waits for the health check, then prints the dashboard URL and the setup
   token.

Open `http://YOUR_SERVER_IP:3000`, enter the setup token and create the
administrator account. The form closes permanently once an account exists.

The token is what stops a stranger who finds the panel before you do from
claiming it, so the dashboard is not usable until you paste it. If you lose the
printed copy it is in `/opt/vexdock/.env` as `SETUP_TOKEN`.

### Options

Environment variables understood by the installer:

| Variable | Default | Meaning |
|---|---|---|
| `PLATFORM_ROOT` | `/opt/vexdock` | State directory. An install made before the rename still sits in `/opt/platform`; its next update moves it and leaves a symlink behind for projects that bind-mount paths inside the old root |
| `DASHBOARD_PORT` | `3000` | Port the dashboard listens on |
| `PLATFORM_VERSION` | `latest` | Version to install |
| `ACME_EMAIL` | empty | Contact address for Let's Encrypt |
| `ACME_STAGING` | `false` | Use the Let's Encrypt staging directory |
| `PUBLIC_URL` | empty | Public dashboard origin. Also sets `Secure` on session cookies once it is an `https://` URL |
| `PLATFORM_REPO` | `rokartur/vexdock` | Repository the compose file and images come from |
| `PLATFORM_REGISTRY` | `ghcr.io/<repo owner>` | Image namespace, derived from `PLATFORM_REPO` |

```sh
curl -fsSL https://raw.githubusercontent.com/rokartur/vexdock/main/installer/install.sh \
  | sudo ACME_EMAIL=me@example.com sh
```

## Putting the dashboard on a domain

1. Point an A record at the server.
2. In the dashboard open **System → Settings**.
3. Enter the hostname, keep "Request a certificate" checked, save.

The platform generates the vhost, obtains a certificate and reloads Nginx, and
renews that certificate on the same schedule as any other domain. Port 3000
keeps working as a fallback.

Session cookies are only marked `Secure` when the panel has an HTTPS origin it
knows about, so once the domain works set `PUBLIC_URL` and restart:

```sh
sudo sed -i 's|^PUBLIC_URL=.*|PUBLIC_URL=https://panel.example.com|' /opt/vexdock/.env
cd /opt/vexdock && sudo docker compose up -d
```

Close port 3000 in the firewall afterwards, or the plaintext fallback stays
reachable.

## Updating

From the dashboard: **System → Settings → About**. A backup is taken first, then
a short-lived updater container fetches the new `compose.yml`, pulls the new
images and recreates the stack. If the manager does not become healthy, the
previous version and compose file are restored automatically. Enable **Remove
previous version images after a successful update** to reclaim those image tags
only after rollback is no longer needed; it is off by default.

From the shell:

```sh
curl -fsSL https://raw.githubusercontent.com/rokartur/vexdock/main/installer/install.sh | sudo sh -s update
```

A shell update writes its own pre-update copy under
`/opt/vexdock/backups/.updates/<stamp>/` and prunes old ones
([security.md](security.md#destructive-actions)). That directory is separate
from the snapshots you take in the panel; an update leaves those alone. A copy
that fails stops the update instead of replacing the stack without a way back.

## Restoring a backup

A snapshot from **System → Backups** is a directory under
`/opt/vexdock/backups/`, named for the UTC time it was taken. It contains
`app.db`, `auth.db`, `master.key`, the `nginx/` directory, the certificates, and
the system compose file and `.env` as `config-compose.yml` and `config-env`
(copy those back only to return to that version). The manager prunes old
snapshots on a schedule ([security.md](security.md#destructive-actions)), so
copy off the server any you need longer. Restoring is a file copy onto a stopped
stack:

```sh
cd /opt/vexdock
sudo docker compose down
SNAPSHOT=/opt/vexdock/backups/2025-01-31T120000
sudo cp "$SNAPSHOT"/app.db "$SNAPSHOT"/auth.db data/
sudo cp "$SNAPSHOT"/master.key secrets/master.key
sudo cp -a "$SNAPSHOT"/nginx/. nginx/
sudo cp -a "$SNAPSHOT"/certificates/. certificates/
sudo docker compose up -d
```

A backup taken with volumes also has a `volumes/` directory holding one
`.tar.gz` per managed named volume. Those are application data, not platform
state, and restoring them is per volume: extract one into a fresh volume of
the same name before bringing the stack up.

`master.key` decrypts every stored environment variable and git credential, so a
snapshot is as sensitive as the server itself. Keep it somewhere private, and
keep it: without that file the restored database is unreadable.

## Moving a project from Dokploy

`scripts/migrate-dokploy.ts` moves one Dokploy project per run, data
included, from a laptop:

```bash
export DOKPLOY_URL=https://dokploy.example.com DOKPLOY_API_KEY=...
export VEXDOCK_URL=https://vexdock.example.com VEXDOCK_TOKEN=...
export DOKPLOY_SSH=root@old-server VEXDOCK_SSH=root@new-server   # only for named volumes
export VEXDOCK_GIT_PROVIDER=<GitHub connection id>   # for GitHub apps
bun scripts/migrate-dokploy.ts "my project"
```

It recreates each application, compose service and Postgres database with its
variables, domains, published ports and database credentials, then stops the
project's applications on Dokploy. Each Postgres database is started on vexdock
and filled by a `pg_dump` of Dokploy's through its external port, which the
Dokploy database must have. Named volumes of applications and compose services
cross with `tar` over ssh, as a user in the `docker` group on both servers.
Then the Dokploy databases stop and the project deploys.
Dokploy's copy is stopped, not deleted, so starting it again is the way back.
Move DNS once the deploy is green. It refuses what it cannot carry over (other
database engines, build args, bind mounts) and prints what it dropped, such as
a domain with a path, since vexdock routes whole hostnames.

## Uninstalling

```sh
curl -fsSL https://raw.githubusercontent.com/rokartur/vexdock/main/installer/install.sh | sudo sh -s uninstall
```

You are asked whether to keep the data:

1. Remove the platform, keep projects and data (default).
2. Remove the platform and all platform metadata.

Without a terminal the answer is 1. To pick 2 unattended, set it up front:

```sh
curl -fsSL https://raw.githubusercontent.com/rokartur/vexdock/main/installer/install.sh | sudo PLATFORM_UNINSTALL_MODE=2 sh -s uninstall
```

Either way `/opt/vexdock/backups` stays, and every copy in it holds `master.key`
(panel snapshots hold the system `.env` too, as `config-env`). Delete it
yourself to remove them.

Deployed applications keep running in either case. They are ordinary compose
projects under `/opt/vexdock/projects`, so `docker compose down` in a project
directory removes one, and nothing else depends on the platform being installed.

## Firewall

Only 80, 443 and the dashboard port need to be reachable. With ufw:

```sh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3000/tcp
```

Once the dashboard has its own domain on 443 you can close 3000.
