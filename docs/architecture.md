# Architecture

## Components

```
                      ┌────────────────────────────┐
   80 / 443 / 3000 →  │  vexdock-nginx             │
                      │  proxy + static dashboard  │
                      └────┬──────────────────┬────┘
                           │ /api             │ proxy_pass by Host
                           ▼                  ▼
                      ┌──────────────┐   ┌──────────────────────┐
                      │ vexdock-     │   │ your services        │
                      │ manager (Go) │   │ (compose projects)   │
                      └──────┬───────┘   └──────────────────────┘
                             │ docker.sock
                             ▼
                        Docker Engine
```

The manager is the only component with access to the Docker socket. It is not
published on any host port; Nginx is the sole entry point.

A third container runs better-auth, which owns accounts and sessions in its own
SQLite file. Nginx routes `/api/auth` there and everything else to the manager,
which opens that file read-only to authenticate requests. Authentication is
therefore implemented once, by a library built for it, rather than twice.

## Why Nginx and not Traefik

Traefik configures itself from container labels, which is elegant until a label
is wrong: the failure is silent and invisible. The platform generates explicit
Nginx configuration, runs `nginx -t` against it, and reloads only if it passes.
A rejected configuration is rolled back byte for byte, so a bad domain can never
take the proxy down. The generated files are readable and greppable, which
matters at 3am.

## Why compose projects instead of a custom scheduler

Every environment is a plain `docker compose` project with a generated project
name (`p_<ULID>`). The platform never reimplements Compose semantics: it shells
out to the official CLI with one argument per slice element. If the platform is
removed, `docker compose up` in the environment's directory still works.

## Environments

A project deploys into one or more environments. The environment, not the
project, owns the compose project name, the directory it builds from and the
services inside it, so production and staging never share a container, a volume
or a network alias. Each one can pin its own branch; empty means it follows the
project's, and a push deploys every environment that is on the branch.

Every project has a default environment that cannot be deleted. It carries the
project's own id and namespace, which is what made adding environments a
metadata change on existing installs: nothing on disk moved and nothing
redeployed.

Variables come from two places and land in one `.env`: the project's, which
every environment gets, and the environment's own, which win on a collision.

## Services

An environment holds services, and each one answers where it comes from on its
own: a `provider` of `github`, `gitlab`, `bitbucket`, `gitea` or plain `git`
clones a repository, `image` runs a published image (which is what the engine
catalog's databases are), `raw` is a fragment of YAML you pasted, and
`unconfigured` is an application that is still only a name. A project is a
grouping; it has no source of its own.

Every configured service is rendered into one generated compose file,
`managed.yml`, and that is the only file compose is given:

```
docker compose --file managed.yml ...
```

An `unconfigured` service is skipped, so a half-finished service neither deploys
nor breaks the deploy of its siblings.

Each service gets its own env file, `services/<name>.env` (0600),
referenced from the fragment with `env_file:`. Compose interpolates `${VAR}`
from the single project `--env-file`, which two Postgres services in one project
would collide over; an `env_file` is per service, so they do not. Rendered
fragments therefore never contain `${...}`; a variable meant for the container
is escaped `$$VAR`.

A database's volume is named after its service (`<service>-data`), so a second
database cannot mount the first one's data. Deleting a service leaves the volume
behind: recreating it under the same name picks the data back up, and dropping a
database stays an explicit act. A compose fragment that mounts a named volume
gets that volume declared at the top of the overlay. `env_file: .env` in a
fragment is rewritten to the project env file, and the service's own env file
is appended last to its `env_file`, so its variables reach the container and
win a collision.

A rendered service declares no `networks:`, so it joins the environment's
default network and is reachable from its siblings at its own service name. A
pasted `raw` fragment that names an explicit network opts out of that, and then
nothing else in the environment can resolve it.

## Networking

Services that have a domain are attached to the shared `vexdock-proxy` network
under a stable alias, `p_<environment-id>_<service>`. Container IDs and IPs
change on every recreate; the alias does not. The alias is keyed on the
environment because two of them can both run a service called `web`.

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
at a time, enforced by a per-environment lock; a second request for the same
environment queues behind it, while production and staging of one project may
deploy at once, since they share no directory and no container. A
deployment interrupted by a manager restart is marked failed on the next boot,
so the UI never shows a pipeline that nothing is running.

`clone` and `checkout` sync the repository of the service being deployed into
`services/<name>/repository` with its own credential, and record the commit on
the deployment. Both steps are skipped when the service does not come from a
repository.

A deployment always targets one compose service (`service_name` on the row):
pull, build, up and the health wait name that service only, and proxy reconcile
still runs in full so domains stay attached. Deploying an environment is one
deployment per service, queued behind each other by the environment lock. No
deploy prunes siblings, so removing a service's container is the delete
handler's job.

A service built from git is tagged `<project>/<environment>/<service>:latest`
with `pull_policy: never`, so `docker images` reads like the dashboard and the
pull step skips an image no registry has. Published ports are overlay `ports:`
and land on the next deploy; redirects and basic auth are proxy config and land
as soon as they are saved.

`healthcheck` waits for containers to be running and, where a healthcheck is
declared, for Docker to report them healthy. A container that exits non-zero
fails the deployment immediately rather than after the timeout.

## Reconciliation

Docker events and a two-minute sweep both trigger the same reconcile pass:
re-attach every domain's container to the proxy network under its alias, render
the complete set of vhosts, validate, reload. Reconciliation is a full
convergence rather than an incremental patch, so a missed event self-heals.

The same Docker events, plus the deployment engine's own, go onto the in-process
bus and out of `/api/system/events`. The dashboard holds one subscription for
the whole authenticated shell and invalidates its query cache when something
moves, so no page polls for state the server can announce.
What no event can describe stays on a timer: the live visitor count, a cron
task's countdown to its next run, the upstream release check, and the update
phase, whose whole job is to notice the manager going away.

## State

SQLite in WAL mode with a single writer connection, which removes lock
contention entirely for a single-node management plane. Schema migrations are
embedded in the binary and applied on start.

Container logs are never copied into the database: they are streamed straight
from the Docker Engine on demand.

CPU, memory, network and disk readings are recorded, because a chart has to show
what happened while nobody was watching. A sampler writes one host row and one
row per running container a minute, and the scheduler prunes anything older than
seven days, so both tables stay bounded without operator attention. Deployment
records are bounded the same way, at the newest fifty per service.

## Scheduled tasks

A service can carry cron jobs that run inside its own container. They live in
the manager for the same reason everything else does: it is the only component
holding the Docker socket, so scheduling them anywhere else would mean handing
that socket to a second process. There is no cron daemon and no crontab on the
host. One goroutine wakes on the wall clock minute, reads that instant in each
enabled task's own timezone, and execs the ones whose expression matches; a task
whose previous run has not finished is skipped rather than stacked, and a tick
missed while the manager was down is not replayed. The timezone is the task's,
not the server's, because a nightly backup means local night; tzdata ships in
the manager image for that reason. Each run stores its exit code and the tail of
its output, pruned to the newest twenty per task by the same scheduler that
prunes metrics. Runs left open by a restart are closed on boot, the same way
interrupted deployments are, so the UI never shows an execution nothing is
running.

## Certificates

A domain either gets its certificate from Let's Encrypt or you upload one. Both
end up as `fullchain.pem` and `privkey.pem` under `certificates/<hostname>/`, so
the proxy and the vhost generator do not care which it was.

An uploaded pair is validated before it touches disk: the key must match the
certificate, the certificate must cover the hostname, and it must be inside its
validity window. Nginx would refuse to reload on any of those, so the error
belongs in the form. A rejected upload leaves the previous certificate in place.
The renewal sweep never touches an uploaded certificate; it logs a warning when
one is inside the renewal window, because only you can replace it.

Let's Encrypt issuance is HTTP-01 by default, through the same Nginx that serves
the application. The challenge token
is written to a shared directory that every generated vhost exposes at
`/.well-known/acme-challenge/`, including the HTTPS block, so renewals keep
working after the redirect is enabled. Configuring a Cloudflare API token
switches issuance to DNS-01, which is the only way to obtain a wildcard.

A renewal sweep runs six-hourly and renews anything inside 30 days of expiry.
The dashboard's own hostname is a setting rather than a domain row, so the sweep
renews it as a separate step; without that the panel would be the one host on
the server whose certificate expires.

## Self-update

The manager cannot replace its own container from inside itself without being
killed mid-swap. Instead it takes a backup and launches a detached updater
container that pulls the new images, recreates the stack, waits for the manager's
own health check and rolls back to the previous version if it never turns
healthy. An update is refused while the platform is unhealthy: the same checks
that back `/api/health` gate `POST /api/system/update`. An opt-in cleanup
records the previous compose image references before the swap and removes only
those no longer used by the new compose file, after the health check succeeds.

Progress crosses the manager's own restart through a file: the manager writes
`system/update-state.json` when an update starts and the updater script
rewrites the phase as it moves (`backup → pulling → restarting → done` or
`rolled-back`). The manager only serves the file back over
`GET /api/system/update/status`; while it is being recreated the panel treats
the failing poll as the restart step and waits for it to return.

Update checks read the GitHub releases list (not `/latest`, which skips
prereleases). Stable track is the default; a beta install stays on the beta
track until the operator turns it off under System → About.
