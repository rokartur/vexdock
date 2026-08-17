# Architecture

## Components

```
                      ┌────────────────────────────┐
   80 / 443 / 3000 →  │  platform-nginx            │
                      │  proxy + static dashboard  │
                      └────┬──────────────────┬────┘
                           │ /api             │ proxy_pass by Host
                           ▼                  ▼
                      ┌──────────────┐   ┌──────────────────────┐
                      │ platform-    │   │ your services        │
                      │ manager (Go) │   │ (compose projects)   │
                      └──────┬───────┘   └──────────────────────┘
                             │ docker.sock
                             ▼
                        Docker Engine
```

The manager is the only component with access to the Docker socket. It is not
published on any host port; Nginx is the sole entry point.

## Why Nginx and not Traefik

Traefik configures itself from container labels, which is elegant until a label
is wrong: the failure is silent and invisible. The platform generates explicit
Nginx configuration, runs `nginx -t` against it, and reloads only if it passes.
A rejected configuration is rolled back byte for byte, so a bad domain can never
take the proxy down. The generated files are readable and greppable, which
matters at 3am.

## Why compose projects instead of a custom scheduler

Every application is a plain `docker compose` project with a generated project
name (`p_<ULID>`). The platform never reimplements Compose semantics: it shells
out to the official CLI with one argument per slice element. If the platform is
removed, `docker compose up` in the project directory still works.

## Networking

Services that have a domain are attached to the shared `platform-proxy` network
under a stable alias, `p_<project-id>_<service>`. Container IDs and IPs change on
every recreate; the alias does not.

The generated vhost resolves that alias at request time through Docker's
embedded DNS:

```nginx
resolver 127.0.0.11 valid=10s ipv6=off;
set $upstream http://p_01jabc_web:3000;
proxy_pass $upstream;
```

Without the variable, Nginx would resolve the name once at startup and keep
serving a dead IP after a redeploy.

## Deployment pipeline

```
clone → checkout → validate → pull → build → start → healthcheck → proxy → finish
```

Each step is persisted and streamed to the browser over SSE. One project deploys
at a time, enforced by a per-project lock; a second request queues behind it. A
deployment interrupted by a manager restart is marked failed on the next boot,
so the UI never shows a pipeline that nothing is running.

`healthcheck` waits for containers to be running and, where a healthcheck is
declared, for Docker to report them healthy. A container that exits non-zero
fails the deployment immediately rather than after the timeout.

## Reconciliation

Docker events and a two-minute sweep both trigger the same reconcile pass:
re-attach every domain's container to the proxy network under its alias, render
the complete set of vhosts, validate, reload. Reconciliation is a full
convergence rather than an incremental patch, so a missed event self-heals.

## State

SQLite in WAL mode with a single writer connection, which removes lock
contention entirely for a single-node management plane. Schema migrations are
embedded in the binary and applied on start.

Container logs and metrics are never copied into the database: they are streamed
straight from the Docker Engine on demand.

## Certificates

HTTP-01 through the same Nginx that serves the application. The challenge token
is written to a shared directory that every generated vhost exposes at
`/.well-known/acme-challenge/`, including the HTTPS block, so renewals keep
working after the redirect is enabled. A renewal sweep runs six-hourly and
renews anything inside 30 days of expiry.

## Self-update

The manager cannot replace its own container from inside itself without being
killed mid-swap. Instead it takes a backup and launches a detached updater
container that pulls the new images, recreates the stack, waits for the manager's
own health check and rolls back to the previous version if it never turns
healthy.
