# Platform

Self-hosted deployment platform for a single Linux server. One command installs
it, one screen deploys your app, and your own domain gets HTTPS automatically.

```sh
curl -fsSL https://get.vexdock.dev | sudo sh
```

Open `http://YOUR_SERVER_IP:3000`, create the administrator account, point a
project at a Git repository, press Deploy.

## What it does

- **Deploy from Git or Docker Compose.** Push to your branch, the platform
  clones, validates, builds, starts and health checks the stack. Every step is
  streamed live.
- **Domains with HTTPS.** Add `app.example.com`, choose the service and port.
  Nginx is generated, validated and reloaded. Let's Encrypt issues and renews
  the certificate, or you upload your own and the platform leaves it alone.
- **Instant rollback.** Every deployment records its commit. Redeploy any
  previous one from the history.
- **Full Docker visibility.** Containers, images, volumes and networks on the
  host, including stacks the platform did not create.
- **Logs, metrics and a terminal.** Live container logs, CPU/RAM/network stats
  and an interactive shell, all in the browser.
- **Templates.** PostgreSQL, MySQL, MariaDB, Valkey, MongoDB and MinIO as
  ordinary compose projects you can edit.
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
| `platform-manager` | Go binary. Owns the Docker socket, SQLite state, the deploy pipeline, Nginx generation and ACME. |
| `platform-auth` | better-auth on Bun. Owns accounts and sessions; the manager only validates them. |
| `platform-nginx` | Reverse proxy for every application plus the static dashboard. |

Applications are ordinary compose projects joined to a shared `platform-proxy`
network under a stable alias, so a recreated container keeps serving without
touching the proxy configuration.

State lives in `/opt/platform`:

```
/opt/platform
├── compose.yml          system stack
├── .env                 installed version and options
├── data/app.db          SQLite: projects, domains, deployments
├── data/auth.db         SQLite: accounts and sessions (better-auth)
├── projects/<id>/       one directory per project (repository + .env)
├── nginx/generated/     one .conf per domain, written by the manager
├── certificates/        Let's Encrypt certificates and the account key
├── secrets/master.key   AES key protecting secrets in the database (0600)
└── backups/             configuration snapshots
```

More detail in [docs/architecture.md](docs/architecture.md).

## Requirements

- Ubuntu 22.04+ or Debian 12+, amd64 or arm64
- 1 GB RAM (2 GB if you build images on the server)
- Ports 80, 443 and 3000 free
- Docker is installed by the installer if missing

## Development

```sh
make check      # go vet, go test, typecheck
make dev-up     # build both images and run the whole stack locally
make run        # manager only, against ./.platform
make web-dev    # dashboard on :5173, proxying /api to :8080
./scripts/smoke-test.sh
```

- `manager/` Go manager. Standard library HTTP, SQLite, Docker SDK.
- `apps/auth/` authentication. better-auth on Bun, its own SQLite database.
- `apps/web/` dashboard. TanStack Start in SPA mode with shadcn/ui, built to static files.
- `docker/` image definitions and the Nginx base configuration.
- `installer/` the install, update and uninstall script.

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
