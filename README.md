<div align="center">

# Vexdock

**The open-source, self-hosted alternative to Vercel, Heroku and Netlify.**
Push to Git, get a container, a domain and HTTPS on a server you own. No per-seat pricing, no usage bills, no lock-in.

[![CI](https://img.shields.io/github/actions/workflow/status/rokartur/vexdock/ci.yml?branch=main&label=CI)](https://github.com/rokartur/vexdock/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/v/tag/rokartur/vexdock?include_prereleases&label=version)](https://github.com/rokartur/vexdock/tags)
[![License](https://img.shields.io/github/license/rokartur/vexdock)](LICENSE)
[![Go](https://img.shields.io/badge/manager-Go-00ADD8)](manager)
[![Bun](https://img.shields.io/badge/auth-Bun-000000)](apps/auth)

[Install](#install) · [Features](#features) · [Docs](#documentation) · [API](docs/api.md) · [Moving from Dokploy](docs/install.md#moving-a-project-from-dokploy)

</div>

---

Vexdock gives you the `git push` workflow of Vercel and Netlify and the
one-click databases of Heroku, running on any Linux server you rent or own.
One command installs it, one screen deploys your app, and your own domain gets
a certificate on its own. You pay for the server, not per build minute, seat or
gigabyte.

Every app is an ordinary Docker Compose project, so `docker compose up` keeps
working the day you remove Vexdock. Open source under AGPL-3.0.

## Install

On a fresh Ubuntu 22.04+ or Debian 12+ server, as root:

```sh
curl -fsSL https://raw.githubusercontent.com/rokartur/vexdock/main/installer/install.sh | sudo sh
```

Docker is installed if missing, the stack starts, and the script prints the
dashboard address with a one-time setup token. Open it, paste the token, create
the administrator. That is the whole setup.

Updates run from the dashboard in one click, or from the shell:

```sh
curl -fsSL https://raw.githubusercontent.com/rokartur/vexdock/main/installer/install.sh | sudo sh -s update
```

Options, restoring a backup and uninstalling: [docs/install.md](docs/install.md).

## Features

### Deploy

- **From anywhere.** GitHub (an App created for you through the manifest flow,
  nothing typed by hand), GitLab, Gitea, Bitbucket, any Git URL, a published
  Docker image, or a pasted Compose fragment.
- **Push to deploy.** Webhooks per Git host, signed or token-checked. Or trigger
  a deploy from CI with an API token.
- **A pipeline you can watch.** `clone → checkout → validate → pull → build →
  start → healthcheck → proxy → finish`, every step streamed live to the browser.
- **Instant rollback.** Every deployment records its commit. Redeploy any of
  them from the history.
- **Environments.** Production and staging in one project, each with its own
  branch, variables, containers, volumes and network. They never share a thing.

### Domains and HTTPS

- **Add a domain, pick a port, done.** Nginx config is generated, validated and
  reloaded. Let's Encrypt issues and renews the certificate.
- **Wildcards.** Add a Cloudflare API token to switch to DNS-01 and issue
  `*.example.com`.
- **Your own certificate** is validated against the hostname and left alone.
- **Redirects and basic auth** per service, live the moment you save.

### Databases

- **One click engines.** PostgreSQL, MySQL, MariaDB, MongoDB, Valkey and libSQL
  with the image, volume and credentials generated. Or name any other image.
- **Studio.** Browse, filter and edit rows, or run a query, straight from the
  dashboard. No published port, and the credentials never reach the browser.

### Templates

n8n, Ghost, WordPress, Umami, Metabase, Grafana, Uptime Kuma and Vaultwarden
from a catalog: services, passwords and domain in one step, ordinary services
afterwards.

### Operate

- **Logs, metrics and a terminal.** Live container logs, CPU, RAM and network
  stats, and an interactive shell, all in the browser.
- **Scheduled tasks.** A cron expression, a timezone and a command, run inside
  the service's container. Every run keeps its exit code and output, and one
  page shows what is due next and what failed last. No host crontab.
- **The whole Docker host.** Containers, images, volumes and networks,
  including stacks Vexdock did not create, with a previewed cleanup.
- **Private registries.** Credentials checked by a real `docker login` before
  they are saved.
- **Backups.** Both databases, proxy config, certificates and the master key,
  with application volumes on request.
- **Self-update** from the dashboard. A backup comes first, and an update that
  never turns healthy rolls back to the previous version on its own.

### Automate

- **REST API.** The same API the dashboard uses, with bearer tokens for CI.
- **Agent skill.** [`skills/vexdock-api`](skills/vexdock-api/SKILL.md) teaches
  an AI agent to deploy, inspect, restart and clean up a Vexdock host through
  that API.

## Why Vexdock

| | Vercel / Netlify / Heroku | Vexdock |
|---|---|---|
| Price | Per seat, build minute, bandwidth, dyno | The server you already pay for |
| Your data | On their cloud | On your disk |
| Workloads | Mostly frontends and serverless | Any container: APIs, workers, databases, cron |
| Leaving | Rewrite configs for the next platform | Plain Compose files, keep running |
| Source | Closed | Open, AGPL-3.0 |

- **Plain Compose underneath.** No custom scheduler, no proprietary format.
  Remove Vexdock and your apps still run.
- **Nginx, not Traefik.** Generated, validated before reload, and yours to
  extend in `nginx/custom/`. The reasoning is in
  [docs/architecture.md](docs/architecture.md#why-nginx-and-not-traefik).
- **Small on purpose.** Kubernetes, multi-server orchestration, autoscaling, a
  plugin system and a managed control plane are out of scope. One server, done
  well.
- **Secrets encrypted at rest** with AES under a master key only the host
  holds. The trust boundary is in [docs/security.md](docs/security.md).

## Architecture

Three containers, Nginx is the only public entry point.

| Component | Role |
|---|---|
| `vexdock-manager` | Go binary. Owns the Docker socket, SQLite state, the deploy pipeline, Nginx generation and ACME. |
| `vexdock-auth` | better-auth on Bun. Owns accounts and sessions; the manager only validates them. |
| `vexdock-nginx` | Reverse proxy for every application plus the static dashboard. |

Applications are ordinary compose projects joined to a shared `vexdock-proxy`
network under a stable alias, so a recreated container keeps serving without
touching the proxy configuration.

<details>
<summary>State lives in <code>/opt/vexdock</code></summary>

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
├── nginx/custom/        yours: .conf files Nginx includes, the manager never writes
├── certificates/        Let's Encrypt certificates and the account key
├── secrets/             master.key, the AES key protecting secrets in the
│                     database (0600), and known_hosts for SSH clones
├── system/              update script, previous compose.yml, update-state.json
│                     (the update progress the panel polls) and docker/, the
│                     registry logins `docker login` keeps
└── backups/<stamp>/     both databases, master key, config-compose.yml,
                         config-env (the system .env), nginx/, certificates,
                         volumes/ on request;
                         .updates/<stamp>/ holds what a shell update copies
                         before it replaces the stack
```

</details>

More in [docs/architecture.md](docs/architecture.md).

## Requirements

- Ubuntu 22.04+ or Debian 12+, amd64 (the published images are amd64 only)
- 1 GB RAM (2 GB if you build images on the server)
- Ports 80, 443 and 3000 free
- Docker is installed by the installer if missing

## Documentation

| | |
|---|---|
| [Install](docs/install.md) | Installing, updating, restoring, moving from Dokploy, uninstalling |
| [Architecture](docs/architecture.md) | How the pieces fit, the deploy pipeline, networking, self-update |
| [API](docs/api.md) | REST API, tokens, SSE streams, webhooks, deploy from CI |
| [Security](docs/security.md) | Trust boundary, CSRF, secrets, encryption |
| [Troubleshooting](docs/troubleshooting.md) | When something breaks |
| [Codebase](docs/codebase.md) | Layout, vocabulary, sequence diagrams of deploy, domains, reconcile, sign-in and self-update |

## Development

```sh
make check      # go vet, go test, typecheck
make dev-up     # build the three images and run the whole stack locally
make run        # manager only, against ./.vexdock
make web        # rebuild the dashboard; the running stack serves it at once
make web-dev    # dashboard on :5173 with HMR, proxying /api to the stack
./scripts/smoke-test.sh
```

| Path | What |
|---|---|
| `manager/` | Go manager. Standard library HTTP, SQLite, Docker SDK. |
| `apps/auth/` | Authentication. better-auth on Bun, its own SQLite database. |
| `apps/web/` | Dashboard. TanStack Start in SPA mode with Arc UI, built to static files. |
| `docker/` | Image definitions and the Nginx base configuration. |
| `installer/install.sh` | Install, update and uninstall in one script. |

Conventions, tests and releasing: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[AGPL-3.0](LICENSE). Running a modified version as a network service obliges
you to publish those modifications.
