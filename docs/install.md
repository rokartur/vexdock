# Installing

## Requirements

- Ubuntu 22.04 LTS or newer, or Debian 12 or newer. Other distributions may work
  but are untested; the installer warns and continues.
- amd64 or arm64.
- 1 GB RAM minimum. Building images on the server needs 2 GB.
- 2 GB free disk space.
- Ports 80, 443 and 3000 free. The installer refuses to continue otherwise and
  names the process holding the port.

## Install

```sh
curl -fsSL https://get.vexdock.dev | sudo sh
```

The installer:

1. Checks the operating system, architecture, memory, disk and ports.
2. Installs Docker and the Compose plugin if they are missing.
3. Creates `/opt/platform` and the shared `vexdock-proxy` network.
4. Downloads `compose.yml`, writes `.env` and starts the stack.
5. Waits for the health check and prints the dashboard URL.

Open `http://YOUR_SERVER_IP:3000` and create the administrator account. That
form closes permanently once an account exists.

### Options

Environment variables understood by the installer:

| Variable | Default | Meaning |
|---|---|---|
| `PLATFORM_ROOT` | `/opt/platform` | State directory |
| `DASHBOARD_PORT` | `3000` | Port the dashboard listens on |
| `PLATFORM_VERSION` | `latest` | Version to install |
| `ACME_EMAIL` | empty | Contact address for Let's Encrypt |
| `ACME_STAGING` | `false` | Use the Let's Encrypt staging directory |
| `PUBLIC_URL` | empty | Public dashboard origin, used to build webhook URLs |

```sh
curl -fsSL https://get.vexdock.dev | sudo ACME_EMAIL=me@example.com sh
```

## Putting the dashboard on a domain

1. Point an A record at the server.
2. In the dashboard open **System → Settings**.
3. Enter the hostname, keep "Request a certificate" checked, save.

The platform generates the vhost, obtains a certificate and reloads Nginx. Port
3000 keeps working as a fallback.

## Updating

From the dashboard: **System → Update**. A configuration backup is taken first,
then a short-lived updater container pulls the new images and recreates the
stack. If the manager does not become healthy, the previous version is restored
automatically.

From the shell:

```sh
curl -fsSL https://get.vexdock.dev | sudo sh -s update
```

## Uninstalling

```sh
curl -fsSL https://get.vexdock.dev | sudo sh -s uninstall
```

You are asked whether to keep the data:

1. Remove the platform, keep projects and data (default).
2. Remove the platform and all platform metadata.

Deployed applications keep running in either case. They are ordinary compose
projects under `/opt/platform/projects`, so `docker compose down` in a project
directory removes one, and nothing else depends on the platform being installed.

## Firewall

Only 80, 443 and the dashboard port need to be reachable. With ufw:

```sh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3000/tcp
```

Once the dashboard has its own domain on 443 you can close 3000.
