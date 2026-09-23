# API

The dashboard is a client of the same REST API you can use from CI. This
document is the description of it; `manager/internal/api/api.go` is the routing
table it is written from.

## Authentication

Everything under `/api/auth` is served by the better-auth service; the rest is
the Go manager. Two credentials are accepted.

**Session cookie.** `POST /api/auth/sign-in/email` sets an HttpOnly cookie named
`better-auth.session_token`. The manager validates it against better-auth's
session table. Because browsers attach cookies to cross-site requests as well, a
mutation must come from the dashboard's own origin; a foreign `Origin` header is
answered `403`. There is no CSRF token to send.

The three endpoints the dashboard uses are `POST /api/auth/sign-in/email`,
`POST /api/auth/sign-up/email` (first administrator only, and it requires the
installer's token in `X-Setup-Token`) and `GET /api/auth/platform-status`.

**Bearer token.** Create one under **System → Settings → API tokens**; the value
is shown once. Browsers never send it automatically, so no CSRF header is
required.

```sh
curl -H "Authorization: Bearer $PLATFORM_TOKEN" https://panel.example.com/api/projects
```

`GET /api/me` returns the account behind whichever credential was used.

**From a script or an agent.** There is no CLI; the token and this document
are the whole interface (`skills/vexdock-api/` packages it as an agent skill). Export the two values once and every endpoint below
is one `curl` away, including a command inside a running service:

```sh
export VEXDOCK_URL=https://panel.example.com
export VEXDOCK_TOKEN=...   # the value POST /api/tokens showed once

vx() { curl -sS -H "Authorization: Bearer $VEXDOCK_TOKEN" -H 'Content-Type: application/json' "$VEXDOCK_URL$@"; }

vx /api/projects
vx /api/services/$SERVICE/deploy -X POST
vx /api/services/$SERVICE/exec -d '{"command":"ls -la /app"}'
```

**API tokens.** They are managed through the API as well, and the raw value is
returned exactly once, by the call that creates it. Only a hash is stored, so a
lost token is replaced rather than recovered.

| Endpoint | Does |
|---|---|
| `GET /api/tokens` | The tokens that exist, by name and prefix |
| `POST /api/tokens` | `{"name"}`; answers `201` with `{"token", "value"}` |
| `DELETE /api/tokens/{id}` | Revokes one |

## Health

`GET /api/health` is public and takes no credential; the installer, the updater
and Docker's own healthcheck all read it. Publicly it reports `{"status"}`
alone: `healthy` with `200`, or `unhealthy` with `503`. An authenticated request
also gets `checks`, which covers the database, the Docker socket, storage
writability, free disk and Nginx, because free disk and a broken socket are
facts about the machine that a stranger has no business reading. Any of the
first four failing makes the status `unhealthy`; a failing Nginx is reported but
does not, because the panel has to stay reachable to fix it.

## Errors

Every error uses one envelope:

```json
{ "error": { "code": "INVALID_REQUEST", "message": "a wildcard needs a Cloudflare token" } }
```

| Code | Status | Meaning |
|---|---|---|
| `INVALID_REQUEST` | 400 | Validation failed; `message` is safe to show a user |
| `UNAUTHORIZED` | 401 | No valid session or token |
| `CROSS_ORIGIN` | 403 | Cookie session used from another origin |
| `NOT_FOUND` | 404 | No such resource |
| `SETUP_TOKEN_INVALID` | 403 | First sign-up without the installer's setup token (from the auth service) |
| `SETUP_CLOSED` | 409 | An administrator already exists (from the auth service) |
| `CONFIRMATION_REQUIRED` | 428 | Destructive action needs `confirm=true` |
| `CERTIFICATE_FAILED` | 502 | ACME issuance failed; `message` explains why |
| `INTERNAL` | 500 | Unexpected failure |

Too many requests are answered `429` by Nginx or by better-auth before the
manager sees them, so that status does not use this envelope.

## Streams

Realtime data is Server-Sent Events, except the terminal which is a WebSocket.

| Endpoint | Events |
|---|---|
| `GET /api/deployments/{id}/events` | `snapshot`, `log`, `step.*`, `deployment.*` |
| `GET /api/services/{id}/logs` | `log`, `end` |
| `GET /api/services/{id}/stats` | `stats` |
| `GET /api/docker/containers/{id}/logs` | `log`, `end` |
| `GET /api/system/stats` | `stats` |
| `GET /api/system/events` | `container.*`, `deployment.*` |
| `GET /api/services/{id}/terminal` | WebSocket, `{type:"input"}` / `{type:"resize"}`; `POST .../exec` is the one-shot form for scripts |

`/api/system/events` is what keeps the dashboard current instead of polling, so
its event names are a contract: `deployment.queued`, `deployment.success`,
`deployment.failed`, `deployment.cancelled`, `container.start`, `container.die`,
`container.stop`, `container.destroy` and `container.health_status: healthy` /
`unhealthy`. `EventSource` has no wildcard, so a new name has to be added to
`systemEvents` in `apps/web/src/lib/sse.ts` to reach the panel.

## Projects

| Endpoint | Does |
|---|---|
| `GET /api/projects` | Every project with its environments, counts, domains and latest deployment |
| `POST /api/projects` | `{"name", "tags"?}`. `201` |
| `GET /api/projects/{id}` | One project, same shape |
| `PATCH /api/projects/{id}` | Any of `name`, `tags`; omitted fields are left alone |
| `DELETE /api/projects/{id}` | Stops every environment and drops the project; `?volumes=true` takes its data too. An environment that will not stop is `500` and the project stays, because dropping the row would strand its containers |

## Environments

A project deploys into an environment. Every environment has its own compose
project name, its own checkout on disk and its own services, so production and
staging never share a container, a volume or a network alias.

Project routes act on one environment, chosen with `?environment={id}`. Leaving
it off means the project's default environment, which is what makes an older
client keep working: on upgrade each project gained a default environment that
carries the project's own id and namespace, so nothing on disk moved.

| Endpoint | Does |
|---|---|
| `GET \| POST /api/projects/{id}/environments` | List, or add one |
| `GET \| PATCH /api/environments/{id}` | Read it, or rename it and change its branch |
| `DELETE /api/environments/{id}` | Stop its containers and drop it; `?volumes=true` takes its data too |
| `GET \| PUT /api/environments/{id}/variables` | Variables only this environment gets |
| `GET \| PUT /api/projects/{id}/variables` | Variables every environment of the project gets |

Both sets land in the same `.env`, with the environment's own winning on a
collision. The default environment cannot be deleted; `DELETE` answers `400`.

An environment's `branch` overrides every git service's for its own deploys.
Empty means each service follows the branch it names itself. A push deploys
every service on that repository and branch, in whichever environment, so one
delivery can deploy staging and production separately.

These take `?environment={id}`: `deploy`, `stop`, `services`,
`services/export` and `deployments`. `POST /api/domains` takes an
`environment_id` in its body for the same reason.

## Services

A project's services are listed by `GET /api/projects/{id}/services`. A project
is a grouping and nothing more: where code comes from is answered one service at
a time. A service belongs to one environment, and a name is free again in each
of them.

Each listed service carries its live container alongside the stored record:
`state`, `status`, `health`, `running_image`, `restart_count`, `created_unix`,
and `cpu_percent` with `memory_usage` from the sampler's newest reading. Usage
is zero when the service is not running or when nothing was recorded in the
last three minutes, so the list never shows a dead container's last numbers.

| Endpoint | Does |
|---|---|
| `POST /api/projects/{id}/services` | Adds a service |
| `POST /api/projects/{id}/services/template` | Installs a [template](#templates) |
| `GET /api/projects/{id}/services/export` | The project's services as a base64 blob |
| `PATCH /api/services/{id}` | Changes its provider, repository, image or fragment |
| `DELETE /api/services/{id}` | Removes it; its named volume is kept, its generated password is not |
| `POST /api/services/{id}/duplicate` | `{"name", "environment_id"?}`; copies the service with its variables and scheduled tasks, by default beside the original |
| `POST /api/services/{id}/move` | `{"environment_id"}`; hands it to another environment with its volume data, domains and tasks |
| `GET /api/services/{id}/database` | Connection details, database services only |
| `GET \| PUT /api/services/{id}/variables` | Its own variables |
| `POST /api/services/{id}/deploy` | Deploy this service only |
| `POST /api/services/{id}/start\|stop\|restart` | Container lifecycle without a pipeline |
| `POST /api/services/{id}/exec` | `{"command", "shell"?}`; runs it in the container, answers `{"exit_code", "output"}`. Same rules as a [task](#scheduled-tasks): `sh` or `bash`, output keeps its tail, ten minutes then the process is abandoned |
| `GET /api/services/{id}/metrics` | Recorded usage over `?window=`, the same windows as `/api/system/metrics` |
| `GET \| POST /api/services/{id}/tasks` | Its [scheduled tasks](#scheduled-tasks) |
| `GET \| POST /api/services/{id}/redirects`, `DELETE .../redirects/{redirectId}` | Its [redirects](#redirects-basic-auth-and-ports) |
| `GET \| POST /api/services/{id}/basic-auth`, `DELETE .../basic-auth/{userId}` | Its [basic-auth users](#redirects-basic-auth-and-ports) |
| `GET \| POST /api/services/{id}/ports`, `DELETE .../ports/{portId}` | Its [published ports](#redirects-basic-auth-and-ports) |

`provider` is `unconfigured`, one of the five git providers (`github`, `gitlab`,
`bitbucket`, `gitea`, `git`), `image`, or `raw` for a pasted compose fragment.
The git providers clone the same way and differ only in webhook dialect and
label. A git service carries its own `repository_url`, `branch`, `build_path`
and credentials: `credential_kind` is `none`, `token` or `ssh_key`, and
`credential_secret` is write-only, encrypted at rest and never returned.
`git_provider_id` points at a [connection](#git-providers) instead, and then
`owner` and `repository` name the repository on it rather than a URL: the
connection's token clones it and its repository list is what the name was picked
from. Setting a connection clears the service's own `repository_url` and
credential; clearing it (`""`) drops `owner` and `repository` and hands the URL
and credential fields back. Sending
a `database` object instead picks the engine catalog: the image, the volume
and the credentials are generated for you, and `provider` is forced to `image`.

`auto_deploy` arms the service for [provider deliveries](#webhooks): a push to its
repository and branch redeploys it only when it is on. It is off on a new
service and toggled through `PATCH /api/services/{id}`.

`prune_build_cache` sweeps dangling build cache right after this service's build
step succeeds, logged into that step. The builder keeps one cache for the whole
host, so the switch decides when a sweep runs, not what it covers: the sweep
spares the layers the next incremental build reuses but is not scoped to this
service. Off on a new service, toggled the same way, and a service that declares
no build context never triggers it.

`build_type` decides how a git service becomes an image, set through `PATCH`.
`dockerfile` (the default) builds `build_path` with the file named by
`dockerfile`, relative to that context and `Dockerfile` when empty, stopping at
the stage in `build_target` when one is set. `static` ignores both and serves
`build_path` with nginx on port 80, falling back to `index.html` for any path
it does not find, so a single-page app's routes resolve.

An `image` service pulling from a private registry sets `registry_url` (empty is
Docker Hub), `registry_username` and the write-only `registry_password`; the
deploy runs `docker login` before its pull step. The password is encrypted at
rest and never returned; omitting it keeps the stored one, and an empty
`registry_username` clears the login.

`container_name` is what the container is called on the host. Left out, the
manager names it after the project and the service, `rokartur-db`, with the
environment in between when it is not the default one. It is unique across the
whole host, so a name another service already holds is a 400. Services created
before the manager named containers keep compose's own name until they are
recreated, and a `raw` service is never renamed because its fragment is the
user's own YAML.

`unconfigured` is an application that is so far only a name. It is skipped when
the compose file is written, so it neither deploys nor breaks the deploy of its
siblings. `PATCH` with a `provider` settles it, and the same request must carry
the `repository_url` (or a connection and `repository`), `image` or
`compose_fragment` that goes with it. An
application may change provider later; a database answers `400`, because its
volume and credentials were rendered from the engine it was created with.

The catalog itself is readable, which is what the dashboard's engine and
version pickers use:

| Endpoint | Does |
|---|---|
| `GET /api/engines` | The engine catalog |
| `GET /api/engines/{slug}/versions` | `{"versions": [...], "live": true}` |

Versions come from the registry, so the endpoint is a suggestion rather than a
constraint: `version` stays free text and an unpublished tag still deploys. The
curated versions come first, then whatever the registry adds, most recently
pushed first rather than highest version. When
the registry cannot be reached the curated list is returned on its own with
`live` set to `false`, so the picker degrades instead of emptying. An unknown
slug is `404`; `custom` is `400`, because an image the catalog has never seen
has no version list to offer.

The `database` object takes `engine`, `version`, `name`, `user` and `password`,
all optional except `engine`; what you leave out is defaulted or generated. The
`custom` engine takes `image` and `data_path` instead of `version`, since the
catalog knows neither for an image it has never seen.

`libsql` takes three more: `sqld_node` (`primary`, the default, `replica` or
`standalone`), `sqld_primary_url`, which a replica needs and nothing else reads,
and `sqld_namespaces`. They end up in the service's environment as `SQLD_NODE`,
`SQLD_PRIMARY_URL` and `SQLD_ENABLE_NAMESPACES`, and `user` and `password`
become the one value sqld understands, `SQLD_HTTP_AUTH`. `SQLD_ENABLE_NAMESPACES`
is the manager's own: sqld takes namespaces as a command-line flag, so the
variable is what the overlay reads to decide whether to pass it, and editing it
in the Environment tab changes the flag on the next deploy. Namespaces also open
sqld's admin API on `5000`, the only way a namespace is created.

`GET /api/services/{id}/database` answers with the connection panel, and for
`libsql` two fields more: `node`, and `replication_url` on a primary, the gRPC
endpoint on `5001` a replica is pointed at through `sqld_primary_url`. The gRPC
listener has no auth of its own, so that URL carries no credentials.

`image` is accepted for every engine, not only `custom`, and it wins over
`version` when both are sent. That is what lets an export be replayed without
re-resolving anything. A stored service keeps the exact image it was created
with, so a later change to a catalog default never moves a running database.

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $PLATFORM_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"db","database":{"engine":"postgres","version":"17-alpine"}}' \
  https://panel.example.com/api/projects/$PROJECT_ID/services
```

Create and edit do not start a container. `POST /api/services/{id}/deploy` runs
the pipeline for that service; `POST /api/projects/{id}/deploy` queues one such
deployment per service of the environment (used by CI and the dashboard's
Deploy all).

A duplicate is the same definition on its own storage: the row, the variables
and the scheduled tasks are copied, the volumes are not, and neither are the
domains, since a hostname answers in one place only. A move keeps the service's
id and its name, and copies its volume data under the target environment's
compose project name; the originals stay where they are. It also removes the
container it leaves behind, so the service is down until the next deploy. Both
refuse a name the target environment already uses.

### Templates

A template is a curated application: the compose services it takes to run it,
the values it needs generated, and the port its hostname reaches.

| Endpoint | Does |
|---|---|
| `GET /api/templates` | The application catalog |
| `POST /api/projects/{id}/services/template` | `{"slug", "hostname"}`; installs one |

Installing does three things in one request: the values the stack needs are
seeded as the environment's variables (a key the environment already holds keeps
its value), each compose service becomes a `raw` service, and the hostname is
pointed at the service the catalog says serves it. The answer is
`{"services": [...], "domain": {...}}`.

The hostname is required, because these applications write their own URL into
their configuration on first boot. Fragments reach their generated values
through `${VAR}`, which compose interpolates from the same `.env` the
[environment](#environments) writes, so two services of one template share a
password and the user can change it afterwards.

Nothing records that a service came from a template: the result is ordinary
services, editable like any pasted fragment, and deploying them is
`POST /api/projects/{id}/deploy` like anything else. A name already taken in the
environment is `400`, and the services that were already created are removed
again rather than left as half a stack. A `warning` alongside the services means
they exist but the domain or its certificate did not come up, which is expected
when DNS does not point here yet.

### Moving services between projects

`GET /api/projects/{id}/services/export` returns
`{"payload": "<base64>", "secrets": false}`. Decoded, the payload is
`{"version": 2, "project": "...", "services": [...]}`. Each service is flat:
`name`, `provider`, `repository_url`, `git_provider_id`, `owner`, `repository`,
`branch`, `build_path`, `image`, `engine`, `data_path`, `compose_fragment` and
`env` all sit at the top level. A `git_provider_id` only resolves on a server
that has that connection, the same limitation credentials have.
That is the blob's own shape, not a request body: `POST .../services` nests
`engine`, `image` and `data_path` under `database`, takes no `env`, and rejects
unknown fields outright, so a client has to map the two rather than forward one
as the other. Credentials are never exported: a git service arrives at its new
project with `credential_kind` of `none` and has to be given its secret again.

Secret values are withheld unless `?secrets=true` is passed, and are exported as
their keys with empty values otherwise. Base64 is encoding, not encryption: a
payload taken with `secrets=true` is as sensitive as the database it came from,
and that request is recorded in the audit log even though it is a `GET`.

There is no import endpoint. The dashboard decodes the payload, shows what it
would add, and then creates each service through `POST .../services` and
`PUT .../variables`, so an imported service is validated exactly as a typed
one is. Variables that arrive without a value are not replayed, which leaves a
generated password in place rather than blanking it.

### Redirects, basic auth and ports

Redirects and basic-auth users apply in the proxy on every domain of the
service, and each write reconciles nginx before it answers. A rule nginx
rejects is removed again and the call fails with `400`, so one bad rule cannot
stop later reconciles.

- `POST .../redirects` takes `{"regex", "replacement", "permanent"}`. The
  regex is matched against the full URL, `https://host/path?query`, and must
  compile as RE2. `$1` or `${1}` in the replacement is a capture group; no other
  `$` is allowed. `permanent` answers `301`, otherwise `302`. A redirect whose
  result equals the requested URL is skipped, which keeps the www preset from
  looping.
- `POST .../basic-auth` takes `{"username", "password"}` and answers the user
  without its password. A username taken on the service is `409 CONFLICT`.
- `POST .../ports` takes `{"published", "target", "protocol"}`, `tcp` or `udp`.
  It lands in the compose overlay on the next deploy. `80` and `443` belong to
  the proxy, a host port already published by any service is `409 CONFLICT`,
  and a `raw` service declares ports in its own fragment, so it gets `400`.

## Scheduled tasks

A scheduled task is a cron expression and a shell line that runs inside one
service's container. The manager ticks once a minute; there is no separate cron
daemon and nothing is replayed for ticks missed while the manager was down.

| Endpoint | Does |
|---|---|
| `GET /api/tasks` | Every task on the server, each naming the service it runs in |
| `GET \| POST /api/services/{id}/tasks` | The service's tasks; create one |
| `PATCH /api/tasks/{id}` | Change any writable field; omitted fields are left alone |
| `DELETE /api/tasks/{id}` | Remove it and its run history |
| `POST /api/tasks/{id}/run` | Run it now, answering with the finished run |
| `GET /api/tasks/{id}/runs` | Recent runs, newest first, `?limit=` up to 100 |

A task carries `name`, `description`, `schedule`, `timezone`, `command`, `shell`
and `enabled`, plus two fields the manager derives on read: `last_run`, absent
until it has run once, and `next_run`, absent while the task is disabled or its
expression never comes round again. A run carries `started_at`, `finished_at`,
`exit_code` and `output`; output over 64 KB keeps its tail, which is the half
that says why a command failed. The `last_run` on a task listing carries no
`output`, which `runs` carries instead, so a list of tasks stays small. Both lists
carry `service_name`, `project_id` and `project_name` on top, so a row names and
links its owner without a request per row.

`timezone` is an IANA name such as `Europe/Warsaw`, defaulting to `UTC`, and it
is the wall clock the expression is read against: `0 3 * * *` in Warsaw fires at
03:00 there, whichever side of a daylight-saving change the day falls on. An
unknown zone is rejected with `400`. `shell` is `sh` or `bash`, defaulting to
`sh`, which is the one an Alpine image is guaranteed to have.

Schedules are five fields: minute, hour, day of month, month, day of week.
Each field takes `*`, a
number, `a-b`, a `/step` suffix and comma separated lists; months and weekdays
also take their three letter names, and `@hourly`, `@daily`, `@weekly`,
`@monthly` and `@yearly` work as shorthands. When both day fields are
restricted, either one matching fires the task, as in every other cron. An
expression that does not parse is rejected at write time with `400`.

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $PLATFORM_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"prune","schedule":"0 3 * * *","timezone":"Europe/Warsaw","command":"php artisan model:prune"}' \
  https://panel.example.com/api/services/$SERVICE_ID/tasks
```

The command is handed to `/bin/sh -c`, or `/bin/bash -c`, in the service's
container, so shell syntax works and nothing runs on the host. A run that finishes non-zero is still
a `200`: the run happened, and its exit code is in the payload. A task whose
previous run has not finished is not started again, from the tick or from
`run`, which answers `409 TASK_RUNNING` instead, and one still going after 30
minutes is killed. Runs are kept 20 deep per task, a task with no container yet
records the failure rather than disappearing, and a run cut short by a manager
restart is closed out on the next boot instead of showing as forever running.
`run` does not hand the command the request's lifetime either: closing the
connection does not cancel it.

## Platform version

| Endpoint | Does |
|---|---|
| `GET /api/system/version` | Installed tag, latest on the chosen track, `beta`, `cleanup_old_images`, `update_available`, `release_url` (public) |
| `PUT /api/system/version` | `{"beta", "cleanup_old_images"}`, both update preferences, sent together; returns the same payload |
| `POST /api/system/version/check` | Same payload, but queries GitHub instead of the cache |
| `POST /api/system/update` | Start an in-place upgrade to `{"version"}` or to latest on the track |
| `GET /api/system/update/status` | Progress of the running or last update |

`cleanup_old_images` defaults to `false`. It only targets images referenced by
the previous system compose file; application images are not included.

`beta` defaults from the installed tag (a prerelease stays on prereleases) until
the operator sets it explicitly. Draft GitHub releases are never offered.
`release_url` points at the latest release's notes on GitHub, empty when no
release is known.

The release lookup is cached for two minutes per track, so `GET` can answer
with a result up to that old; `checked_at` is when that answer was fetched, and
is empty when no lookup has ever succeeded. `POST /api/system/version/check`
drops the cache and asks GitHub again. It is authenticated while the `GET` is
public, because it turns a request into an outbound one against a rate-limited
API.

`POST /api/system/update` refuses with `409 UNHEALTHY` while any `/api/health`
check fails, naming the failing checks in the message and carrying the full
`checks` map in `details`. Recreating the stack on a platform that is already
broken is how an update becomes an outage.

`update/status` reads `system/update-state.json`, which the manager writes when
an update starts and the updater script rewrites as it moves:
`{"phase", "target", "previous", "error", "at"}`. `phase` walks
`backup → pulling → restarting` and settles on `done` or `rolled-back`
(`error` says why); `idle` means no update was ever started, and an active
phase older than 30 minutes also reads as `idle`, an updater that died without
finishing. After a rollback the payload adds `log`, the tail of the
kept updater container. The manager is recreated during `restarting`, so the
panel treats a failing poll in an active phase as that step, not as an error,
and keeps polling until the manager returns.

## System

| Endpoint | Does |
|---|---|
| `GET /api/system/info` | Host and Docker facts, project and container counts, the twenty most recent deployments |
| `GET /api/system/metrics` | Recorded host usage over `?window=`, which seeds the charts before live samples arrive |
| `GET \| PUT /api/system/settings` | Dashboard domain, ACME email, Cloudflare token |
| `GET /api/system/certificates` | Every issued certificate |
| `POST /api/system/backup` | Takes a snapshot; `?volumes=true` includes volume archives. `201` |
| `GET /api/system/backups` | The snapshots on disk |
| `DELETE /api/system/backups/{name}` | Removes one snapshot directory |

`?window=` is `30m`, `1h`, `6h`, `24h` or `7d`, and anything else is `30m`. The
range is reduced to at most 240 points, so a wider window returns coarser
buckets rather than more rows.

Settings are written whole, like the other settings screens. Within them
`cloudflare_api_token` is write-only: leave it out to keep the stored token,
send `""` to clear it. A read reports only `cloudflare_token_set`.

A volume backup can run for minutes and reach many gigabytes, so it is asked for
per call rather than being the default. A snapshot contains the master key,
which makes it as sensitive as the server.

## Docker resources

The platform does not hide the daemon it runs on. Containers it did not create
are listed too, with `managed` false, rather than being left out.

| Endpoint | Does |
|---|---|
| `GET /api/docker/containers` | Every container, with its compose project, service and last half hour of usage |
| `POST /api/docker/containers/{id}/{action}` | `start`, `stop`, `restart` or `remove`; remove takes `?force=true` |
| `GET /api/docker/images` | Images with their size and how many containers use them |
| `POST /api/docker/images/pull` | `{"reference"}`; answers with the daemon's output once the pull has finished |
| `DELETE /api/docker/images/{id}` | Removes one; `?force=true` when it is tagged or in use |
| `GET /api/docker/volumes` | Volumes; `size` and `ref_count` are `-1` when Docker reported no usage |
| `DELETE /api/docker/volumes/{name}` | Requires `?confirm=true` |
| `GET /api/docker/networks` | Networks and the containers on them |
| `GET /api/docker/cleanup` | What a cleanup would reclaim, in bytes, touching nothing |
| `POST /api/docker/cleanup/{kind}` | `containers`, `images`, `volumes`, `networks` or `build-cache` |

Each container carries `cpu_percent`, `memory_usage`, `memory_limit` and a
`cpu_series` of the last 30 minutes, read out of `container_metrics` in one
grouped query rather than by asking the daemon. The sampler writes a row a
minute, so a container younger than that, or one the sampler has not seen since
it stopped, answers `null`.

Nothing is pruned on a schedule; the one automatic sweep is a service with
`prune_build_cache` on, after its own build. A cleanup answers
`{"kind", "removed", "space_reclaimed"}`. `cleanup/volumes` wants `?confirm=true`
just as the single delete does, because an unused volume is a stopped project's
data rather than junk; the other kinds can be rebuilt and ask for nothing.

## Git providers

A git provider is a connection to one host, stored as a parent row and a detail
row for the host it is: `github`, `gitlab`, `bitbucket` or `gitea`. Every service
that sets `git_provider_id` clones through it, which is how a repository gets
picked from a list instead of pasted as a URL.

| Endpoint | Does |
|---|---|
| `GET /api/git-providers` | `{"git_providers": [...]}`; the only secret in the answer is the token inside `webhook_url` |
| `GET /api/git-providers/{id}` | One connection with its detail |
| `PATCH /api/git-providers/{id}` | `{"name"}` |
| `DELETE /api/git-providers/{id}` | Removes one; `409 GIT_PROVIDER_IN_USE` while services still clone through it |
| `GET /api/git-providers/{id}/repositories` | `{"repositories": [{"name", "owner", "url"}]}` |
| `GET /api/git-providers/{id}/branches` | `?owner=&repository=` → `{"branches": [...]}` |
| `POST /api/git-providers/github` | `{"name", "github_url", "organization"}` → `{"git_provider_id", "manifest", "manifest_url"}`. `201` |
| `POST \| PUT /api/git-providers[/{id}]/gitlab` | `{"name", "gitlab_url", "application_id", "secret", "group_name"}` → `{"git_provider_id", "authorize_url"}` |
| `POST \| PUT /api/git-providers[/{id}]/gitea` | `{"name", "gitea_url", "client_id", "client_secret", "organization_name"}` → `{"git_provider_id", "authorize_url"}` |
| `POST \| PUT /api/git-providers[/{id}]/bitbucket` | `{"name", "bitbucket_username", "app_password", "bitbucket_email", "api_token", "bitbucket_workspace_name"}` |
| `GET /api/providers/github/callback` | Where GitHub returns once the App exists. Redirects |
| `GET /api/providers/github/installed` | Where GitHub returns once it is installed. Redirects |
| `GET /api/providers/{provider}/callback` | Where GitLab and Gitea return with an authorization code. Redirects |

Every connection answers `connected`, which is false until the handshake with
the host finished. Nothing can be listed before then, so the repository picker
only offers connected ones. Listing repositories is also the honest test of
whether a connection still works: a revoked grant surfaces as
`502 GIT_PROVIDER_ERROR` there rather than mid-deployment.

A `POST` without an id creates the connection; a `PUT` with one re-registers its
credentials, which is how a rotated secret is replaced. `409` on delete is
deliberate: removing a connection services depend on would leave them unable to
deploy with nothing in the UI explaining why.

### GitHub

The App is created through GitHub's manifest flow, so nothing is typed by hand.
`POST /api/git-providers/github` writes the empty connection and returns the
manifest with the URL the browser posts it to; GitHub creates the App and
returns to `/api/providers/github/callback` with a one-time code, which is
exchanged for the App's id, private key, client secret and webhook secret; the
browser then goes to GitHub's install screen, where the owner picks all
repositories or a few, and returns to `/api/providers/github/installed`, which
records the installation. Clones use an installation token minted on demand and
cached until it expires.

### GitLab and Gitea

Both are OAuth applications the owner registers on the host, which is why the
request takes a client id and secret rather than creating anything. The response
carries `authorize_url`; visiting it and approving returns to
`/api/providers/{provider}/callback` with a code that is exchanged for an access
and refresh token pair. Both hosts expire the access token, so the pair is
stored and refreshed on use. GitLab's `group_name` and Gitea's
`organization_name` narrow the repository list to one group.

### Bitbucket

Bitbucket takes a credential pair instead of an app, so there is no handshake and
the connection is usable the moment it is saved: either a username with an app
password, or an email with an API token. When both are given the API token wins.

Every connection's secrets are encrypted at rest, and the only one any endpoint
returns is the token inside `webhook_url`, which the operator has to be able to
paste into the host.

The address a host redirects back to is `PLATFORM_PUBLIC_URL` when it is set and
the address the browser reached the panel on otherwise, so connecting
works before a panel domain is configured. GitHub still requires that address to
be reachable over https, which is its own rule, not the panel's. All three
redirect handlers are ordinary
session-authenticated routes and answer with a redirect back to
**System → Settings → Git**, carrying `?error=` when something went wrong.

An app account stores no long-lived token. Its private key signs a JWT that
mints an installation token lasting an hour, cached until shortly before it
expires and minted again for the next listing or clone. Repositories come from
the installation rather than from the user, so the list is exactly what the owner
granted; changing that selection later is the same install screen again, reached
from the account's row.

The repository list is one page of a hundred, most recently active first, and
entries whose clone URL would not pass the same validation as a hand-typed one
are dropped. Branches are the same: one page of a hundred, and a name that git
would not accept as a ref is dropped. `repository` is interpolated into the
provider's URL path, so it must be an `owner/name` of the characters a provider
uses and is rejected otherwise. Deleting an account clears it off its services, which then have no
credential and fail their next deployment rather than deploying a stale checkout.

## Registries

| Endpoint | Does |
|---|---|
| `GET /api/registries` | Configured registries; the token is never returned |
| `POST /api/registries` | `{"name", "url", "username", "password"}`. `201` |
| `DELETE /api/registries/{id}` | Removes one |

Creating one verifies the credentials by logging the daemon in, so a typo is
caught here rather than in the middle of a deployment, and a registry whose
login fails is not kept. The token is encrypted before storage and piped to
`docker login` on stdin, so it never appears in a process listing.

## Deployments

| Endpoint | Does |
|---|---|
| `POST /api/projects/{id}/deploy` | One deployment per service of the environment. `202` with the array, `400` when it has no service |
| `POST /api/projects/{id}/redeploy` | The same call under the name the dashboard uses |
| `POST /api/projects/{id}/stop` | `docker compose down` for the environment; volumes stay |
| `GET /api/projects/{id}/deployments` | The environment's history, newest first, fifty deep |
| `GET /api/deployments/{id}` | `{"deployment", "steps"}` |
| `POST /api/deployments/{id}/cancel` | Withdraws a queued deployment or stops a running one; `400` once it has finished |
| `POST /api/deployments/{id}/rollback` | Redeploys the commit that deployment recorded, scoped to the same service; `202`, or `400` when it recorded none |

One environment deploys one pipeline at a time; a second request queues behind
the first and can still be canceled while it waits.

## Deploy from CI

Whole project:

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $PLATFORM_TOKEN" \
  https://panel.example.com/api/projects/$PROJECT_ID/deploy
```

One service:

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $PLATFORM_TOKEN" \
  https://panel.example.com/api/services/$SERVICE_ID/deploy
```

A service deploy returns `202` with the deployment, a project deploy `202` with
one deployment per service; every deployment carries the `service_name` it ran
for. Poll `GET /api/deployments/{id}` for the outcome, or subscribe to its event
stream. Rollback redeploys the same service at the recorded commit.

## Domains

| Endpoint | Does |
|---|---|
| `GET /api/domains` | Every domain on the server |
| `GET /api/projects/{id}/domains` | One project's, across its environments |
| `POST /api/domains` | Adds one. `201` |
| `PATCH /api/domains/{id}` | Changes `hostname`, `container_port`, `https_enabled`, `redirect_https`, `certificate_source`, `certificate_pem`, `private_key_pem` |
| `DELETE /api/domains/{id}` | Removes it, its certificate and its vhost |
| `POST /api/domains/{id}/certificate` | Issues or renews its certificate now; answers the certificate, or `502 CERTIFICATE_FAILED` |

A domain takes `project_id`, `service`, `hostname`, `container_port`,
`https_enabled`, `redirect_https`, and optionally `environment_id`
(the default environment when omitted) and `certificate_source`, which is
`letsencrypt` or `custom`. A custom source takes `certificate_pem` and
`private_key_pem` with it; the pair is validated against the hostname before
anything is stored. A domain never changes project, environment or service
after it is created, so `PATCH` rejects those three like any other unknown
field. Create and update both answer `{"domain"}`, and add a
`warning` when the mapping was saved but the certificate could not be issued,
so the domain serves over HTTP and TLS can be retried through `certificate`.

## Webhooks

Auto deploy runs through the connection, not through a per-project URL: `POST
/api/deploy/{provider}`, one per host, with `{provider}` being `github`,
`gitlab`, `bitbucket` or `gitea`. Each names repositories and signs deliveries
its own way, which is why there is an endpoint each rather than one. All four
are public.

A GitHub App is wired to its endpoint when it is created, so there is nothing to
configure per project: the delivery names its installation, which selects the
connection whose webhook secret must have signed it, and an unsigned or wrongly
signed delivery is `401` and never reaches a deployment.

The other three are added as a project- or repository-level webhook on the host,
and the URL to add carries a `?token=` the connection generated. Those hosts do
not sign App-style deliveries and Bitbucket Cloud has no secret field at all, so
the query parameter is the one transport all three can carry; a delivery with a
missing or wrong token is `401` `SIGNATURE_INVALID`. `GET /api/git-providers`
and `GET /api/git-providers/{id}` return the whole address as `webhook_url`,
which is what the settings page shows, and GitHub never has one. A connection
made before the token existed is given one on the next boot, so its old hook URL
stops deploying until the new one is pasted in.

A verified push is offered to every service with auto deploy on: both the
repository it came from and the branch have to be the service's, and an
environment with its own branch matches on that instead. The response carries a
`deployment_ids` array, one entry per service that matched, and a push no
service follows is answered `202 ignored` so the provider does not disable the
hook. A monorepo deploys once per service that tracks it, since a deployment is
always one service.
