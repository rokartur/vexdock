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
and Docker's own healthcheck all read it. It reports `{"status", "checks"}`,
where `checks` covers the database, the Docker socket, storage writability, free
disk and Nginx. `status` is `healthy` with `200`, or `unhealthy` with `503` when
any of the first four fails. A failing Nginx is reported but does not make the
manager unhealthy, because the panel has to stay reachable to fix it.

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
| `GET /api/services/{id}/terminal` | WebSocket, `{type:"input"}` / `{type:"resize"}` |

`/api/system/events` is what keeps the dashboard current instead of polling, so
its event names are a contract: `deployment.queued`, `deployment.success`,
`deployment.failed`, `deployment.cancelled`, `container.start`, `container.die`,
`container.stop`, `container.destroy` and `container.health_status: healthy` /
`unhealthy`. `EventSource` has no wildcard, so a new name has to be added to
`systemEvents` in `apps/web/src/lib/sse.ts` to reach the panel.

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
Empty means each service follows the branch it names itself. A push triggers
every environment with a service on that repository and branch, so one webhook
can deploy staging and production separately.

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
| `GET /api/projects/{id}/services/export` | The project's services as a base64 blob |
| `PATCH /api/services/{id}` | Changes its provider, repository, image or fragment |
| `DELETE /api/services/{id}` | Removes it; its named volume is kept, its generated password is not |
| `GET /api/services/{id}/database` | Connection details, database services only |
| `GET \| PUT /api/services/{id}/variables` | Its own variables |
| `POST /api/services/{id}/deploy` | Deploy this service only |
| `POST /api/services/{id}/start\|stop\|restart` | Container lifecycle without a pipeline |
| `GET /api/services/{id}/metrics` | Recorded usage over `?window=`, the same windows as `/api/system/metrics` |
| `GET \| POST /api/services/{id}/tasks` | Its [scheduled tasks](#scheduled-tasks) |

`provider` is `unconfigured`, one of the five git providers (`github`, `gitlab`,
`bitbucket`, `gitea`, `git`), `image`, or `raw` for a pasted compose fragment.
The git providers clone the same way and differ only in webhook dialect and
label. A git service carries its own `repository_url`, `branch`, `build_path`
and credentials: `credential_kind` is `none`, `token` or `ssh_key`, and
`credential_secret` is write-only, encrypted at rest and never returned.
`git_account_id` points at a [connected account](#git-accounts) instead, whose
token then clones the service and whose repositories it is picked from; setting
one clears the service's own credential, and clearing it (`""`) hands the
credential fields back. Sending
a `database` object instead picks the engine catalogue: the image, the volume
and the credentials are generated for you, and `provider` is forced to `image`.

`unconfigured` is an application that is so far only a name. It is skipped when
the compose file is written, so it neither deploys nor breaks the deploy of its
siblings. `PATCH` with a `provider` settles it, and the same request must carry
the `repository_url`, `image` or `compose_fragment` that goes with it. An
application may change provider later; a database answers `400`, because its
volume and credentials were rendered from the engine it was created with.

The catalogue itself is readable, which is what the dashboard's engine and
version pickers use:

| Endpoint | Does |
|---|---|
| `GET /api/engines` | The engine catalogue |
| `GET /api/engines/{slug}/versions` | `{"versions": [...], "live": true}` |

Versions come from the registry, so the endpoint is a suggestion rather than a
constraint: `version` stays free text and an unpublished tag still deploys. The
curated versions come first, then whatever the registry adds, most recently
pushed first rather than highest version. When
the registry cannot be reached the curated list is returned on its own with
`live` set to `false`, so the picker degrades instead of emptying. An unknown
slug is `404`; `custom` is `400`, because an image the catalogue has never seen
has no version list to offer.

The `database` object takes `engine`, `version`, `name`, `user` and `password`,
all optional except `engine`; what you leave out is defaulted or generated. The
`custom` engine takes `image` and `data_path` instead of `version`, since the
catalogue knows neither for an image it has never seen.

`image` is accepted for every engine, not only `custom`, and it wins over
`version` when both are sent. That is what lets an export be replayed without
re-resolving anything. A stored service keeps the exact image it was created
with, so a later change to a catalogue default never moves a running database.

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $PLATFORM_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"db","database":{"engine":"postgres","version":"17-alpine"}}' \
  https://panel.example.com/api/projects/$PROJECT_ID/services
```

Create and edit do not start a container. `POST /api/services/{id}/deploy` runs
the pipeline for that service alone; `POST /api/projects/{id}/deploy` still
deploys every service in the project (used by CI, webhooks, and the dashboard's
Deploy all, which it offers while a project has no services yet).

### Moving services between projects

`GET /api/projects/{id}/services/export` returns
`{"payload": "<base64>", "secrets": false}`. Decoded, the payload is
`{"version": 2, "project": "...", "services": [...]}`. Each service is flat:
`name`, `provider`, `repository_url`, `branch`, `build_path`, `image`,
`engine`, `data_path`, `compose_fragment` and `env` all sit at the top level.
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
`output` — read `runs` for that — so a list of tasks stays small. Both lists
carry `service_name`, `project_id` and `project_name` on top, so a row names and
links its owner without a request per row.

`timezone` is an IANA name such as `Europe/Warsaw`, defaulting to `UTC`, and it
is the wall clock the expression is read against: `0 3 * * *` in Warsaw fires at
03:00 there, whichever side of a daylight-saving change the day falls on. An
unknown zone is rejected with `400`. `shell` is `sh` or `bash`, defaulting to
`sh`, which is the one an Alpine image is guaranteed to have.

Schedules are five fields — minute, hour, day of month, month, day of week.
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
| `PUT /api/system/version` | `{"beta", "cleanup_old_images"}` — both update preferences, sent together; returns the same payload |
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
`checks` map in `details` — recreating the stack on a platform that is already
broken is how an update becomes an outage.

`update/status` reads `system/update-state.json`, which the manager writes when
an update starts and the updater script rewrites as it moves:
`{"phase", "target", "previous", "error", "at"}`. `phase` walks
`backup → pulling → restarting` and settles on `done` or `rolled-back`
(`error` says why); `idle` means no update was ever started, and an active
phase older than 30 minutes also reads as `idle` — an updater that died
without finishing. After a rollback the payload adds `log`, the tail of the
kept updater container. The manager is recreated during `restarting`, so the
panel treats a failing poll in an active phase as that step, not as an error,
and keeps polling until the manager returns.

## System

| Endpoint | Does |
|---|---|
| `GET /api/system/info` | Host and Docker facts, project and container counts, the ten most recent deployments |
| `GET /api/system/metrics` | Recorded host usage over `?window=`, which seeds the charts before live samples arrive |
| `GET \| PUT /api/system/settings` | Dashboard domain, ACME email, notification webhook, brand colour, Cloudflare token |
| `GET /api/system/certificates` | Every issued certificate |
| `GET /api/system/audit` | The hundred most recent state-changing calls |
| `POST /api/system/backup` | Takes a snapshot; `?volumes=true` includes volume archives. `201` |
| `GET /api/system/backups` | The snapshots on disk |

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
| `GET /api/docker/containers` | Every container, with its compose project and service |
| `POST /api/docker/containers/{id}/{action}` | `start`, `stop`, `restart` or `remove`; remove takes `?force=true` |
| `GET /api/docker/images` | Images with their size and how many containers use them |
| `POST /api/docker/images/pull` | `{"reference"}`; answers with the daemon's output once the pull has finished |
| `DELETE /api/docker/images/{id}` | Removes one; `?force=true` when it is tagged or in use |
| `GET /api/docker/volumes` | Volumes; `size` and `ref_count` are `-1` when Docker reported no usage |
| `DELETE /api/docker/volumes/{name}` | Requires `?confirm=true` |
| `GET /api/docker/networks` | Networks and the containers on them |
| `GET /api/docker/cleanup` | What a cleanup would reclaim, in bytes, touching nothing |
| `POST /api/docker/cleanup/{kind}` | `containers`, `images`, `volumes`, `networks` or `build-cache` |

Nothing is pruned on a schedule. A cleanup answers
`{"kind", "removed", "space_reclaimed"}`. `cleanup/volumes` wants `?confirm=true`
just as the single delete does, because an unused volume is a stopped project's
data rather than junk; the other kinds can be rebuilt and ask for nothing.

## Git accounts

| Endpoint | Does |
|---|---|
| `GET /api/git-accounts` | Connected accounts; the token is never returned |
| `POST /api/git-accounts` | `{"provider", "name", "host", "token"}`. `201` |
| `DELETE /api/git-accounts/{id}` | Removes one |
| `GET /api/git-accounts/{id}/repositories` | `[{"full_name", "clone_url", "default_branch"}]` |
| `GET /api/git-accounts/{id}/branches` | `?repository=owner/name`; the repository's branch names |

An account is one provider token stored encrypted and reused by every service
that sets `git_account_id`, which is how a repository gets picked from a list
instead of pasted as a URL. `provider` is `github`, `gitlab` or `gitea`; `host`
is the https origin of a self-hosted instance, required for Gitea and empty for
the hosted services. Creating an account lists repositories once with the token,
so a token that cannot read them is rejected here rather than mid-deployment.

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
| `POST /api/projects/{id}/deploy` | Deploys every service of the environment. `202` with the deployment |
| `POST /api/projects/{id}/redeploy` | The same call under the name the dashboard uses |
| `POST /api/projects/{id}/stop` | `docker compose down` for the environment; volumes stay |
| `GET /api/projects/{id}/deployments` | The environment's history, newest first, fifty deep |
| `GET /api/deployments/{id}` | `{"deployment", "steps"}` |
| `POST /api/deployments/{id}/cancel` | Withdraws a queued deployment or stops a running one; `400` once it has finished |
| `POST /api/deployments/{id}/rollback` | Redeploys the commit that deployment recorded, scoped to the same service; `202`, or `400` when it recorded none |

One environment deploys one pipeline at a time; a second request queues behind
the first and can still be cancelled while it waits.

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

Both return `202` with the deployment id as soon as the pipeline is queued. A
service deploy sets `service_name` on the deployment; a project deploy leaves it
empty. Poll `GET /api/deployments/{id}` for the outcome, or subscribe to its
event stream. Rollback of a service-scoped deployment redeploys that service
only.

## Domains

| Endpoint | Does |
|---|---|
| `GET /api/domains` | Every domain on the server |
| `GET /api/projects/{id}/domains` | One project's, across its environments |
| `POST /api/domains` | Adds one. `201` |
| `PATCH /api/domains/{id}` | Changes any of the same fields |
| `DELETE /api/domains/{id}` | Removes it, its certificate and its vhost |
| `POST /api/domains/{id}/certificate` | Issues or renews its certificate now; answers the certificate, or `502 CERTIFICATE_FAILED` |

A domain takes `project_id`, `service`, `hostname`, `container_port`,
`https_enabled`, `redirect_https`, `analytics`, and optionally `environment_id`
(the default environment when omitted) and `certificate_source`, which is
`letsencrypt` or `custom`. A custom source takes `certificate_pem` and
`private_key_pem` with it; the pair is validated against the hostname before
anything is stored. Create and update both answer `{"domain"}`, and add a
`warning` when the mapping was saved but the certificate could not be issued,
so the domain serves over HTTP and TLS can be retried through `certificate`.

## Analytics

`GET /api/analytics/{hostname}?range=24h|7d|30d` returns the domain and every
section the analytics page shows, in one response. An unknown range is a day.
`bucket` is the series' step in seconds (900 for 24h, 3600 for 7d, 21600 for
30d); a bucket with no events is left out of `series`, so a chart fills its own
gaps.

```json
{
  "domain": { "hostname": "app.example.com", "analytics": true },
  "traffic": {
    "views": 1840,
    "visitors": 612,
    "online": 7,
    "visits": 733,
    "avg_duration": 96,
    "bounce_rate": 0.41,
    "previous": { "views": 1640, "visitors": 548, "visits": 690, "avg_duration": 102, "bounce_rate": 0.44 },
    "bucket": 900,
    "series": [{ "at": 1738000800, "views": 42, "visitors": 31 }],
    "pages": [{ "name": "/pricing", "count": 210, "visitors": 180 }],
    "referrers": [], "countries": [], "devices": [], "browsers": [],
    "systems": [], "events": [], "online_pages": []
  }
}
```

`visits` are sessions: a gap of more than thirty minutes starts a new one.
`avg_duration` is their mean length in seconds and `bounce_rate` the share with
a single page view, 0 to 1. `online` counts visitors whose latest event in the
last five minutes was not a `leave`, and `online_pages` is the page each of them
is on. Every breakdown carries both `count` (hits) and `visitors`
(distinct people) and is capped at twenty rows. `previous` repeats the headline
numbers for the window of the same length immediately before this one, which is
where the dashboard's trend percentages come from.

`GET /api/analytics/{hostname}/activity` returns four weeks of hourly buckets,
`{ "series": [{ "at": 1738000800, "views": 42, "visitors": 31 }] }`, in the same
sparse shape. It is what the dashboard's weekday heatmap folds into local days
and hours; the server stays in unix seconds because only the browser knows the
reader's timezone.

`DELETE /api/analytics/{hostname}` erases every event of that site and answers
`{ "deleted": 1840 }`. It is not scoped to a range, there is no undo, and other
domains keep their history. Collection stays on.

Collection is off until a domain sets `analytics: true`. The generated vhost
then serves two paths from the site itself, both public and neither part of the
panel API:

- `GET /_vx.js` the beacon, injected into HTML responses before `</head>`.
- `POST /_vx` one hit: `{"k":"pageview","p":"/pricing","r":"…","tz":"Europe/Warsaw"}`.
  Always answered `204`, including for an unknown host or a bot.

Nginx proxies the two to `/api/collect.js` and `/api/collect` on the manager,
which is why they are unauthenticated: they are called by every visitor to a
site, not by the panel. Both are rate limited by Nginx, and events age out after
ninety days. Do not call the `/api/collect` form directly; the site's own path
is the contract.

`k` is `pageview`, `ping` (a heartbeat the beacon sends every minute while the
tab is visible, which is what visit duration is measured from), `leave` (the tab
went hidden or closed, which ends the visitor's presence) or a custom event
name. Fire one with `vx('signup', { plan: 'pro' })`; the payload is capped at
1 KB and stored as sent.

## Webhooks

Each Git project exposes an auto-deploy URL containing a random token, shown in
**Project → Settings**. It is `POST /api/webhooks/projects/{token}`, and the
token is the only credential: no session or bearer token is involved. Point your
provider at it and enable auto deploy.

- The push is matched against every git service of every environment: both the
  repository it came from and the branch have to be the service's, so a push to
  one repository never redeploys a service built from another. An environment
  with its own branch matches on that instead of the service's. The response
  carries a `deployment_ids` array, one entry per environment that matched.
- A push no service follows is answered `202 ignored` so the provider does not
  disable the hook.
- GitHub `ping` events are answered `202 pong`.
- When a webhook secret is configured, `X-Hub-Signature-256` is verified before
  anything else happens.
