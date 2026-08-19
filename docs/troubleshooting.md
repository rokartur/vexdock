# Troubleshooting

## The dashboard does not load

```sh
docker ps --filter name=vexdock
docker logs --tail 100 vexdock-manager
curl -s http://127.0.0.1:3000/api/health
```

`/api/health` reports each dependency separately: `database`, `docker`,
`storage`, `disk` and `nginx`. A failing `nginx` check does not make the manager
unhealthy, precisely so the panel stays reachable while you fix the proxy.

## A deployment fails

Open the deployment and read the step that failed. The step name says where:

| Step | Usual cause |
|---|---|
| `clone` | Wrong URL, wrong branch, or a private repository without credentials |
| `validate` | The compose file is invalid; the exact compose error is shown |
| `build` | The build failed, or the server ran out of memory |
| `start` | A port is already taken, or an image is missing |
| `healthcheck` | The container exits or its healthcheck never turns healthy |

For `healthcheck` failures, open the service's Logs tab: the application's own
output is almost always the answer.

## A domain returns 502

1. Is the service running? Project → Services.
2. Is the container port right? It is the port *inside* the container, not a
   published host port.
3. Does DNS point at this server? `dig +short app.example.com`.

The proxy resolves the service by network alias at request time, so a redeployed
container recovers on its own within seconds. If it does not, the reconcile
sweep runs every two minutes; the manager log records each pass.

## A certificate is not issued

Let's Encrypt must reach `http://your-domain/.well-known/acme-challenge/` from
the public internet. Check that:

- The A record points at this server and has propagated.
- Ports 80 and 443 are open in the firewall and in your provider's security
  group.
- No other service is bound to port 80.

The failure reason is stored with the certificate and shown on the project's
Domains tab. Use **renew** to retry after fixing the cause. While testing, set
`ACME_STAGING=true` in `/opt/platform/.env` to avoid the production rate limit
of five failures per hostname per hour.

## Disk is full

**System → Cleanup** shows what each category would reclaim. Unused images and
build cache are usually the bulk of it. Nothing is ever pruned automatically.

## The update did not finish

The updater runs as a separate container and rolls back automatically when the
new version does not become healthy:

```sh
docker logs vexdock-updater
docker ps --filter name=vexdock
```

The updater container is kept after it exits so those logs survive; the next
update replaces it.

Backups live in `/opt/platform/backups/<timestamp>/`, containing `app.db`,
`auth.db`, `master.key`, the generated proxy configuration and the certificates.
A backup created with **Include volumes** also has a `volumes/<name>.tar.gz` per
application volume. Restoring one is in
[install.md](install.md#restoring-a-backup); note that `master.key` is required
to read anything encrypted in `app.db`.

## Restoring an application volume

Restoring overwrites live data, so stop the project first (**Project → Stop**),
then unpack the archive back into the volume:

```sh
docker run --rm \
  -v p_myproject_data:/dst \
  -v /opt/platform/backups/2026-01-31T120000/volumes:/src:ro \
  alpine tar xzf /src/p_myproject_data.tar.gz -C /dst
```

The volume names in the archive are the real Docker volume names, so
`docker volume ls` tells you where each one belongs.

## Starting over without losing applications

```sh
cd /opt/platform && docker compose down
curl -fsSL https://raw.githubusercontent.com/rokartur/vexdock/main/installer/install.sh | sudo sh
```

Applications keep running throughout: they are independent compose projects and
do not depend on the manager being up.
