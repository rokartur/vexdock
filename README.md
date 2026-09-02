# Vexdock

Self-hosted deployment platform for a single Linux server. One command installs
it, one screen deploys your app, and your own domain gets HTTPS automatically.

## Install

On a fresh Ubuntu 22.04+ or Debian 12+ server, as root:

```sh
curl -fsSL https://raw.githubusercontent.com/rokartur/vexdock/main/installer/install.sh | sudo sh
```

It installs Docker if missing, starts the stack and prints the dashboard
address together with a one-time setup token. Open the address, enter the
token and create the administrator account.

[docs/install.md](docs/install.md) covers options, updating and uninstalling.

## What it does

- **Deploy from Git or Docker Compose.** Push to your branch, the platform
  clones, validates, builds, starts and health checks the stack. Every step is
  streamed live.
- **Domains with HTTPS.** Add `app.example.com`, choose the service and port.
  Nginx is generated, validated and reloaded. Let's Encrypt issues and renews
  the certificate, or you upload your own and the platform leaves it alone.
  Add a Cloudflare API token to switch to the DNS-01 challenge and issue
  `*.example.com`.
- **Deploy notifications.** One webhook URL, posted to when a deployment
  succeeds or fails. Discord and Slack are detected automatically.
- **Backups.** Snapshots of both databases, the proxy config, the certificates
  and the master key, with application volumes included on request.
- **Instant rollback.** Every deployment records its commit. Redeploy any
  previous one from the history.
- **Full Docker visibility.** Containers, images, volumes and networks on the
  host, including stacks the platform did not create.
- **Logs, metrics and a terminal.** Live container logs, CPU/RAM/network stats
  and an interactive shell, all in the browser.
- **Scheduled tasks.** A cron expression, a timezone and a command per service,
  run inside its container. No crontab on the host; every run keeps its exit
  code and output. One page lists every task on the server, with what is due
  next and what failed last.
- **Managed databases.** PostgreSQL, MySQL, MariaDB, MongoDB and Valkey added
  to a project with their image, volume and credentials generated, or any other
  image you name.
- **Site analytics.** Flip a switch on a domain and Nginx starts counting page
  views, unique visitors, who is reading what right now, visit length, bounce
  rate, referrers, regions, devices and your own events. No script tag in your
  app, no cookie, no third party.
- **API tokens.** The same REST API the dashboard uses, for CI.
- **Audit log.** Who changed what, when, and from where.

## What it deliberately does not do

Kubernetes, multi-server orchestration, autoscaling, a plugin system and a
managed control plane are all out of scope. Everything runs as plain Docker
Compose projects on one host, so nothing is locked in: `docker compose up` still
works if the platform is removed.

## Architecture

Three containers.

| Component | Role |
|---|---|
| `vexdock-manager` | Go binary. Owns the Docker socket, SQLite state, the deploy pipeline, Nginx generation and ACME. |
| `vexdock-auth` | better-auth on Bun. Owns accounts and sessions; the manager only validates them. |
| `vexdock-nginx` | Reverse proxy for every application plus the static dashboard. |

Applications are ordinary compose projects joined to a shared `vexdock-proxy`
network under a stable alias, so a recreated container keeps serving without
touching the proxy configuration.

State lives in `/opt/vexdock`:

```
/opt/vexdock
├── compose.yml          system stack
├── .env                 version, options, session secret, setup token (0600)
├── data/app.db          SQLite: projects, domains, deployments
├── data/auth.db         SQLite: accounts and sessions (better-auth)
├── projects/<id>/       one directory per environment (.env, managed.yml and
│                     services/ with a checkout and an env file per service);
│                     a project's default environment uses the project's id
├── nginx/generated/     one .conf per domain, written by the manager
├── certificates/        Let's Encrypt certificates and the account key
├── secrets/             master.key, the AES key protecting secrets in the
│                     database (0600), and known_hosts for SSH clones
├── system/              update script, previous compose.yml, update-state.json
│                     (the update progress the panel polls) and docker/, the
│                     registry logins `docker login` keeps
└── backups/<stamp>/     both databases, master key, proxy config,
                         certificates, volumes/
```

More detail in [docs/architecture.md](docs/architecture.md).

## Requirements

- Ubuntu 22.04+ or Debian 12+, amd64 (the published images are amd64 only)
- 1 GB RAM (2 GB if you build images on the server)
- Ports 80, 443 and 3000 free
- Docker is installed by the installer if missing

## Development

```sh
make check      # go vet, go test, typecheck
make dev-up     # build the three images and run the whole stack locally
make run        # manager only, against ./.vexdock
make web        # rebuild the dashboard; the running stack serves it at once
make web-dev    # dashboard on :5173 with HMR, proxying /api to the stack
./scripts/smoke-test.sh
```

- `manager/` Go manager. Standard library HTTP, SQLite, Docker SDK.
- `apps/auth/` authentication. better-auth on Bun, its own SQLite database.
- `apps/web/` dashboard. TanStack Start in SPA mode with shadcn/ui, built to static files.
- `docker/` image definitions and the Nginx base configuration.
- `installer/install.sh` install, update and uninstall in one script.

## Documentation

- [docs/install.md](docs/install.md) installing, updating, uninstalling
- [docs/architecture.md](docs/architecture.md) how the pieces fit together
- [docs/api.md](docs/api.md) REST API and API tokens
- [docs/security.md](docs/security.md) the security model
- [docs/troubleshooting.md](docs/troubleshooting.md) when something breaks
- [CONTRIBUTING.md](CONTRIBUTING.md)

## License

[AGPL-3.0](LICENSE). Running a modified version as a network service obliges
you to publish those modifications.
