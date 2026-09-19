# Troubleshooting

## The dashboard does not load

```sh
docker ps --filter name=vexdock
docker logs --tail 100 vexdock-manager
curl -s http://127.0.0.1:3000/api/health
```

`/api/health` answers anyone with `status` alone; the per-dependency `checks`
(`database`, `docker`, `storage`, `disk` and `nginx`) need a session, so run the
curl with your cookie or read them from the panel. A failing `nginx` check does
not make the manager unhealthy, precisely so the panel stays reachable while you
fix the proxy.

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
`ACME_STAGING=true` in `/opt/vexdock/.env` to avoid the production rate limit
of five failures per hostname per hour.

## A scheduled task does not run

Open the service's **Tasks** tab and press **logs** on the task; every attempt is
listed with its exit code and the output it produced.

- **`this service has no container yet - deploy it first`.** The task execs into
  the service's own container, so the service has to be deployed and present.
- **Nothing in the list at all.** The task is off, or its schedule has not come
  round yet. The **Next run** column says when it is due; if that reads wrong,
  the task's timezone is not the one you meant. A tick that passed while the
  manager was down is not replayed. **run now** executes it immediately and
  reports the same output the schedule would.
- **`bash: not found`.** The task asked for bash and the image only ships sh.
  Switch the task's shell, or install bash in the image.
- **`interrupted by a manager restart`.** The manager stopped mid-run. The
  command may have half finished; the next tick is unaffected.
- **The run list says the previous run is still going.** A task never overlaps
  itself. A command that takes longer than its interval is skipped, not queued,
  and one that hangs is killed after 30 minutes.

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

A successful update deletes its own container. One that failed is kept so those
logs survive, until the next update replaces it.

An install older than the `/opt/platform` to `/opt/vexdock` rename moves during
its next update, and the log says so. `could not move the state directory` means
something already occupies `/opt/vexdock`: the update carries on in the old
directory, so remove or rename the stray one and update again.

`The container name "/vexdock-manager" is already in use` means a container of
that name belongs to a different compose project than the one this install
drives, usually the leftover of a rename that stopped halfway. Since
v0.1.0-beta.68 the updater removes those containers before it recreates the
stack and logs `removing vexdock-manager held by compose project <name>`. On an
older version, `docker rm -f vexdock-manager vexdock-auth vexdock-nginx` and
update again; the stack recreates from the compose file.

Backups live in `/opt/vexdock/backups/<timestamp>/`, containing `app.db`,
`auth.db`, `master.key`, the generated proxy configuration and the certificates.
A backup created with **Config + data** also has a `volumes/<name>.tar.gz` per
application volume. Restoring one is in
[install.md](install.md#restoring-a-backup); note that `master.key` is required
to read anything encrypted in `app.db`.

## Restoring an application volume

Restoring overwrites live data, so stop the affected services first,
then unpack the archive back into the volume:

```sh
docker run --rm \
  -v p_myproject_data:/dst \
  -v /opt/vexdock/backups/2026-01-31T120000/volumes:/src:ro \
  alpine tar xzf /src/p_myproject_data.tar.gz -C /dst
```

The volume names in the archive are the real Docker volume names, so
`docker volume ls` tells you where each one belongs.

## Starting over without losing applications

```sh
cd /opt/vexdock && docker compose down
curl -fsSL https://raw.githubusercontent.com/rokartur/vexdock/main/installer/install.sh | sudo sh
```

Applications keep running throughout: they are independent compose projects and
do not depend on the manager being up.
