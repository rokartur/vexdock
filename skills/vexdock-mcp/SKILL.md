---
name: vexdock-mcp
description: Operate a Vexdock server (self-hosted deployment platform) through its MCP server. Use when the vexdock MCP tools are connected, when asked to deploy, inspect, restart, configure or debug anything on a Vexdock host, or when asked to connect an agent to Vexdock.
---

# Vexdock MCP server

Every Vexdock panel serves a Model Context Protocol server on `/mcp`, beside
the dashboard: `https://panel.example.com/mcp`, or `http://<server-ip>:3000/mcp`
before the panel has a domain. Transport is streamable HTTP. The server holds no
credential: every tool call runs as the bearer token the client sends, so it can
do exactly what that token can.

## Connecting

Create a token in the dashboard under **System → Settings → API tokens**. The
value is shown once. Pick the narrowest scope the work needs (see
[Permissions](#permissions)).

Claude Code:

```sh
claude mcp add --transport http vexdock https://panel.example.com/mcp \
  --header "Authorization: Bearer $VEXDOCK_TOKEN"
```

A client that takes a JSON server list with headers (Cursor and most others):

```json
{
  "mcpServers": {
    "vexdock": {
      "url": "https://panel.example.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

A missing or revoked token fails the connection itself with `401`. Treat the
token as a secret: it goes in the client's config or an environment variable,
never in a reply, a commit or a log.

**OAuth, without a token.** Clients that cannot send a header (claude.ai,
ChatGPT) add the server by its URL alone. The `401` points them at the panel's
OAuth metadata; they register themselves, open the panel's consent screen,
where the administrator picks full access or projects and levels, and refresh
their own access token from then on. This works only once the panel has an
`https://` address set as `PUBLIC_URL`. The grant appears beside the tokens,
named after the client, and is revoked there.

## Permissions

A token is one of:

- **admin**: every tool, every project, as a dashboard session.
- **project token**: a list of projects, each at `read` or `write`.
  - `read`: projects, services, environments, logs, stats, deployments,
    domains, tasks. Variable values, database credentials and SQL stay out of
    reach.
  - `write`: everything inside the project, including deploy, exec, variables,
    `query_database` and editing services and domains. Where a service comes
    from (provider, repository, Git connection, credentials, image, compose
    fragment, registry login) stays admin only; branch and build settings do not.
  - `docker_cleanup` is admin only, whatever the projects.

`whoami` answers which kind this token is and, for a project token, the
`project_id` and `level` of each grant. Call it first. A project token sees only
its own projects in `list_projects`, and an id outside them answers
`FORBIDDEN`, exactly like an id that does not exist.

## Tools

Ids come from the read tools: `list_projects` gives project ids, `get_project`
gives environment, service and domain ids, `get_service` gives task ids.
`environment_id` is optional wherever it appears; leaving it out means the
project's default environment (production).

| Tool | Level | Does |
|---|---|---|
| `whoami` | any | The account and this token's grants |
| `list_projects` | read | Projects this token reaches, with environments and container counts |
| `get_project` | read | One environment of a project: services with state, domains, last ten deployments |
| `get_service` | read | One service's configuration and its scheduled tasks |
| `service_logs` | read | Last lines of the container's output (`tail`, default 200); stderr lines start `[stderr]` |
| `service_stats` | read | One live CPU, memory, network and disk sample; fails on a stopped container |
| `list_deployments` | read | Last fifty deployments of an environment |
| `get_deployment` | read | A deployment and its steps, each step's output cut to its last fifty lines |
| `list_templates` | read | Application templates: the services each adds and the one its domain reaches |
| `deploy` | write | Deploys a project's environment (`project_id`) or one service (`service_id`), waits up to 15 minutes, answers each deployment's status, the deciding step and its log tail |
| `cancel_deployment` | write | Stops a queued or running deployment |
| `rollback` | write | Redeploys the image a past successful deployment built, and waits |
| `service_action` | write | `start`, `stop` or `restart` the container without building |
| `service_exec` | write | Runs a command in the running container: exit code and output, not interactive, ten-minute limit |
| `get_variables` | write | One layer's variables in clear: `scope` is `project`, `environment` or `service`, `id` is that thing's id |
| `set_variables` | write | Adds or changes keys (`set`), deletes keys (`remove`), marks new keys secret (`secret_keys`); untouched keys stay |
| `add_service_from_template` | write | Adds a template's services with generated passwords; deploy afterwards |
| `update_service` | write | Changes service fields by their `get_service` names; takes effect on the next deploy. Source fields need admin |
| `add_domain` | write | Routes a hostname to a compose service and container port; `https_enabled` issues a certificate |
| `remove_domain` | write | Stops routing a hostname |
| `run_task` | write | Runs a scheduled task now and answers its output |
| `query_database` | write | Runs one SQL statement against a database service, writes included |
| `docker_cleanup` | admin | Prunes `containers`, `images`, `networks` or `build-cache` |

Variables merge at deploy time: project, then environment, then service, the
narrowest winning. A change to variables or service fields reaches the
container on the next `deploy`.

When `deploy` answers `still_running`, the pipeline outlived the wait; follow
each id with `get_deployment` until its status is `success`, `failed` or
`cancelled`.

Deleting a project, an environment, a service or a volume is not a tool. Those
happen in the dashboard, by a person.

## Errors

A tool error carries the API's status and code, `403 FORBIDDEN: ...`:

| Code | Meaning |
|---|---|
| `FORBIDDEN` | Outside this token's grants, or no such id. Check `whoami` |
| `NOT_FOUND` | No such resource, seen by an admin token |
| `INVALID_REQUEST` | The message says which argument is wrong; it is safe to show |
| `CONFLICT` | The name or hostname is taken |
| `DATABASE_NOT_RUNNING` | `query_database` on a stopped database; deploy or start it first |

## Working style

1. `whoami`, then resolve ids with the read tools; report names beside ids.
2. Narrowest action first: a service deploy over a project deploy,
   `service_exec` or `service_action` over a redeploy.
3. Read before writing: `get_variables` before `set_variables`, `get_service`
   before `update_service`.
4. Before `query_database` with a write, `service_exec` that changes data, or
   `remove_domain`, say what it changes and get a yes.
5. After a deploy, report each service's status; on failure, the step name and
   the lines of its log tail that explain it.
6. Variable values, database credentials and anything `service_exec` prints
   from a secret stay out of replies unless the user asked for that value.
