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

## Services the platform owns

An environment holds services. Most of them are *derived*: the project's own
compose file declares them and the platform only reads them back. The rest are
*managed* — a database from the engine catalogue, an image, a repository of its
own, or a fragment of YAML you wrote in the dashboard.

Managed services are not merged into your compose file. They are rendered into
a second one, `managed.yml`, and compose is invoked with both:

```
docker compose --file <yours> --file managed.yml ...
```

Compose merges the two itself, so an imported project keeps its file byte for
byte and can still gain a database. Nothing has to know which "kind" a project
is, because there is no kind.

Each managed service gets its own env file, `services/<name>.env` (0600),
referenced from the fragment with `env_file:`. Compose interpolates `${VAR}`
from the single project `--env-file`, which two Postgres services in one project
would collide over; an `env_file` is per service, so they do not. Rendered
fragments therefore never contain `${...}` — a variable meant for the container
is escaped `$$VAR`.

A database's volume is named after its service (`<service>-data`), so a second
database cannot mount the first one's data. Deleting a service leaves the volume
behind: recreating it under the same name picks the data back up, and dropping a
database stays an explicit act. A compose fragment that mounts a named volume
gets that volume declared at the top of the overlay. `env_file: .env` in a
fragment is rewritten to the project env file, which is what the Environment
tab writes.

A rendered fragment declares no `networks:`, so a managed service joins the
project's default network and is reachable from its siblings at its own service
name. If your compose file puts its services on an explicit named network
instead, they are not on that default network and cannot resolve the database.
Put the managed service's name on the same network from your own file, or leave
your services on the default one.

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
clone → checkout → service-checkout → validate → pull → build → start → healthcheck → proxy → finish
```

Each step is persisted and streamed to the browser over SSE. One project deploys
at a time, enforced by a per-project lock; a second request queues behind it. A
deployment interrupted by a manager restart is marked failed on the next boot,
so the UI never shows a pipeline that nothing is running.

`service-checkout` syncs any managed service that builds from a repository of
its own, into `services/<name>/repository`, reusing the project's credential. It
only appears when the project has one, and it is its own step so that a failed
service clone reads as a failed clone rather than as an unexplained deploy
failure.

A deployment may target one compose service (`service_name` on the row). Pull,
build, up and the health wait then name that service only; proxy reconcile still
runs in full so domains stay attached. A full-project deploy leaves
`service_name` empty and still prunes services that disappeared from compose. A
scoped deploy never prunes siblings.

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

Container logs are never copied into the database: they are streamed straight
from the Docker Engine on demand.

CPU, memory, network and disk readings are recorded, because a chart has to show
what happened while nobody was watching. A sampler writes one host row and one
row per running container a minute, and the scheduler prunes anything older than
seven days, so both tables stay bounded without operator attention.

## Site analytics

A domain can count its own visits. Turning it on changes only the generated
vhost: Nginx injects `<script defer src="/_vx.js">` into HTML responses with
`sub_filter` and routes `/_vx.js` and `/_vx` to the manager. The deployed app is
never modified, the script is served from the site's own hostname, and the hits
never leave the server. Because `sub_filter` cannot rewrite a compressed body,
those vhosts ask the upstream for plain HTML and let Nginx compress the result.

The manager stores one row per hit and computes everything at read time: views,
unique visitors, sessions and their length, bounce rate, top pages, referrers,
regions, devices and custom events. There are no rollup tables to keep in sync,
and the scheduler prunes events older than ninety days, so the table stays
bounded like the metrics ones. Visitors are a daily rotating hash rather than a
cookie, which keeps the feature out of consent-banner territory but also means a
returning-visitor count is not possible by construction.

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
healthy. An opt-in cleanup records the previous compose image references before
the swap and removes only those no longer used by the new compose file, after
the health check succeeds.

Update checks read the GitHub releases list (not `/latest`, which skips
prereleases). Stable track is the default; a beta install stays on the beta
track until the operator turns it off under System → About.
