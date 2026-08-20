# Security model

## Trust boundary

The manager holds the Docker socket, which is equivalent to root on the host.
Everything in front of it is therefore treated as untrusted input.

- The manager listens only on the internal Docker network. Nginx is the sole
  public entry point.
- Accounts, password hashing and sessions belong to better-auth, running as its
  own service with its own SQLite database. The manager never issues a
  credential; it validates the session cookie by reading that database.
- Sessions are HttpOnly cookies with `SameSite=Lax`, signed with a
  `BETTER_AUTH_SECRET` the installer generates per install. There is no default:
  the auth service refuses to start without it.
- The `Secure` attribute follows `PUBLIC_URL`. It is off until you declare an
  `https://` origin for the panel, because a fresh install is reached over plain
  HTTP on port 3000 and a browser would discard the cookie.
- Every cookie-authenticated mutation must carry an `Origin` matching the host
  the request was addressed to. Browsers cannot forge either, so this is the
  CSRF defence, on both the manager and the auth service.
- Creating the first administrator additionally requires the setup token the
  installer generated and printed. Without it a panel that is publicly reachable
  before its owner reaches it would be claimed by whoever found it first.
- Sign-up closes permanently once the first administrator exists.
- Credential endpoints are rate limited twice: better-auth allows five attempts
  a minute per client, and Nginx throttles the same paths independently.
- Every state-changing API call is recorded in an audit log with the actor, the
  path, the resulting status, the credential type and the client address.
  Rejected cross-origin attempts are recorded too.

## Command execution

The platform shells out to `git`, `docker` and `docker compose`. It never builds
a shell string: every argument is a separate slice element, so no user value can
be reinterpreted as a flag or a command.

Values that reach a command line are validated first:

- **Repository URLs** must be `http`, `https`, `ssh` or `user@host:path`.
  `file://` and `ext::` are rejected, since either would let a repository URL
  read host files or execute a command during clone. Secrets in the URL are
  rejected too.
- **Git refs** reject anything starting with `-` and any shell metacharacter.
- **Compose paths** are resolved against the project directory and rejected if
  the result escapes it.
- **Build paths** must stay inside the checkout: `..`, backslashes and anything
  a path clean would rewrite are rejected, on create and on edit alike, so a
  build context cannot be aimed at an arbitrary host directory.
- **Image references and volume mount points** are matched against a narrow
  pattern before being written into the generated compose file. Both are user
  values that end up in YAML, where a space or a `#` is enough to change which
  image runs or where the volume lands.
- **Hostnames** are validated per DNS label. A wildcard is accepted only with a
  Cloudflare token configured, since HTTP-01 cannot validate one and DNS-01 can.

## Secrets

- Environment variables are encrypted with AES-256-GCM before they touch SQLite.
  A fresh nonce per value means two identical secrets are not linkable.
- The master key is a 0600 file under `/opt/platform/secrets`, never in the
  database it protects.
- Git credentials never reach the command line. Tokens go through `GIT_ASKPASS`
  and SSH keys through a 0600 temporary file removed when the clone finishes.
- The variable editors (`/variables` on a project, an environment or a service)
  return stored values, because showing them is the point of the page. What
  protects a secret is the write side: a value that comes back as the mask means
  "unchanged" and never overwrites the real one, so editing one variable cannot
  silently blank another. A database service's connection panel
  (`GET /api/services/{id}/database`) and a service export asked for with
  `?secrets=true` return values too. All sit behind the same session or token
  guard, and the export is recorded in the audit log.
- The generated project `.env` is written with 0600 permissions, and so is each
  managed service's own `services/<name>.env`. A generated database password is
  stored there and nowhere else, scoped to that one service.
- A service name becomes a file name, so it is validated against
  `[a-zA-Z0-9][a-zA-Z0-9._-]*` first and cannot escape the project directory.
- `/opt/platform/.env` holds the session secret and the setup token and is 0600.
- A service export withholds secret values by default, sending their keys with
  empty values. `?secrets=true` includes them, and that request is written to
  the audit log even though it is a read, because it is the one route that hands
  over plaintext in bulk. The payload is base64, which is encoding and not
  encryption, so one taken with secrets is as sensitive as the database it came
  from.
- A backup snapshot contains `master.key`, because without it the encrypted
  values in the snapshot cannot be read back. Treat a snapshot as being as
  sensitive as the server.

## Destructive actions

Nothing is pruned or deleted on a schedule. The updater removes previous system
image tags only when the operator selects that option, and only after the new
manager is healthy. Removing a volume requires an explicit `confirm=true`, and
every cleanup screen shows what will be reclaimed before anything is removed.
Uninstalling keeps application data by default.

## Proxy configuration

Generated Nginx configuration is validated with `nginx -t` before a reload. If
validation fails, the previous configuration is restored byte for byte and the
error is surfaced to the user, so an invalid domain cannot take down every other
site on the server.

## Reporting a vulnerability

Open a private security advisory on the repository rather than a public issue.
