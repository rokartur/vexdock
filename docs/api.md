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

## Services

A project's services are listed by `GET /api/projects/{id}/services`. The ones
the project's own compose file declares are read-only; the ones the platform
owns can be created, changed and removed.

| Endpoint | Does |
|---|---|
| `POST /api/projects/{id}/services` | Adds a managed service |
| `GET /api/projects/{id}/services/export` | The project's managed services as a base64 blob |
| `PATCH /api/services/{id}` | Changes its source, image or fragment |
| `DELETE /api/services/{id}` | Removes it; its named volume is kept, its generated password is not |
| `GET /api/services/{id}/database` | Connection details, database services only |
| `GET \| PUT /api/services/{id}/environment` | Its own variables |

`source_type` is `unconfigured`, `git`, `image` or `compose`. Sending a
`database` object instead picks the engine catalogue: the image, the volume and
the credentials are generated for you, and `source_type` is ignored.

`unconfigured` is an application that is so far only a name. It is skipped when
the overlay is written, so it neither deploys nor breaks the deploy of its
siblings. `PATCH` with a `source_type` of `git` or `image` settles it, and the
same request must carry the `repository_url` or `image` that goes with it. That
is a one-way edit: a service whose source is already set answers `400`, because
its checkout, volume and env file all hang off what it already is.

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

None of these start a container. Deploy the project to apply them.

### Moving services between projects

`GET /api/projects/{id}/services/export` returns
`{"payload": "<base64>", "secrets": false}`. Decoded, the payload is
`{"version": 1, "project": "...", "services": [...]}`. Each service is flat:
`name`, `source_type`, `repository_url`, `branch`, `build_path`, `image`,
`engine`, `data_path`, `compose_fragment` and `env` all sit at the top level.
That is the blob's own shape, not a request body: `POST .../services` nests
`engine`, `image` and `data_path` under `database`, takes no `env`, and rejects
unknown fields outright, so a client has to map the two rather than forward one
as the other. Services the project's own compose file declares are left out;
they already travel inside that file.

Secret values are withheld unless `?secrets=true` is passed, and are exported as
their keys with empty values otherwise. Base64 is encoding, not encryption: a
payload taken with `secrets=true` is as sensitive as the database it came from,
and that request is recorded in the audit log even though it is a `GET`.

There is no import endpoint. The dashboard decodes the payload, shows what it
would add, and then creates each service through `POST .../services` and
`PUT .../environment`, so an imported service is validated exactly as a typed
one is. Variables that arrive without a value are not replayed, which leaves a
generated password in place rather than blanking it.

## Deploy from CI

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $PLATFORM_TOKEN" \
  https://panel.example.com/api/projects/$PROJECT_ID/deploy
```

The call returns `202` with the deployment id as soon as the pipeline is queued.
Poll `GET /api/deployments/{id}` for the outcome, or subscribe to its event
stream.

## Webhooks

Each Git project exposes an auto-deploy URL containing a random token, shown in
**Project → Settings**. Point your provider at it and enable auto deploy.

- A push to another branch is answered `202 ignored` so the provider does not
  disable the hook.
- GitHub `ping` events are answered `202 pong`.
- When a webhook secret is configured, `X-Hub-Signature-256` is verified before
  anything else happens.
