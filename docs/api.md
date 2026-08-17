# API

The dashboard is a client of the same REST API you can use from CI. The full
machine-readable description is served at `GET /api/openapi.json`.

## Authentication

Two credentials are accepted.

**Session cookie.** `POST /api/auth/login` sets an HttpOnly cookie and returns a
CSRF token. Every non-GET request made with the cookie must carry that token in
the `X-CSRF-Token` header.

**Bearer token.** Create one under **System → Settings → API tokens**; the value
is shown once. Browsers never send it automatically, so no CSRF header is
required.

```sh
curl -H "Authorization: Bearer $PLATFORM_TOKEN" https://panel.example.com/api/projects
```

## Errors

Every error uses one envelope:

```json
{ "error": { "code": "INVALID_REQUEST", "message": "wildcard domains are not supported" } }
```

| Code | Status | Meaning |
|---|---|---|
| `INVALID_REQUEST` | 400 | Validation failed; `message` is safe to show a user |
| `UNAUTHORIZED` | 401 | No valid session or token |
| `CSRF_INVALID` | 403 | Cookie session without a matching CSRF token |
| `NOT_FOUND` | 404 | No such resource |
| `SETUP_CLOSED` | 409 | An administrator already exists |
| `CONFIRMATION_REQUIRED` | 428 | Destructive action needs `confirm=true` |
| `RATE_LIMITED` | 429 | Too many login attempts |
| `CERTIFICATE_FAILED` | 502 | ACME issuance failed; `message` explains why |
| `INTERNAL` | 500 | Unexpected failure |

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
