# Security model

## Trust boundary

The manager holds the Docker socket, which is equivalent to root on the host.
Everything in front of it is therefore treated as untrusted input.

- The manager listens only on the internal Docker network. Nginx is the sole
  public entry point.
- Accounts, password hashing and sessions belong to better-auth, running as its
  own service with its own SQLite database. The manager never issues a
  credential; it validates the session cookie by reading that database.
- Sessions are HttpOnly cookies with `SameSite=Lax`.
- Every cookie-authenticated mutation must carry an `Origin` matching the
  dashboard. Browsers cannot forge it, so this is the CSRF defence.
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
- **Hostnames** are validated per DNS label. Wildcards are rejected because
  HTTP-01 cannot validate them.

## Secrets

- Environment variables are encrypted with AES-256-GCM before they touch SQLite.
  A fresh nonce per value means two identical secrets are not linkable.
- The master key is a 0600 file under `/opt/platform/secrets`, never in the
  database it protects.
- Git credentials never reach the command line. Tokens go through `GIT_ASKPASS`
  and SSH keys through a 0600 temporary file removed when the clone finishes.
- API responses mask secret values. Saving a masked value back is a no-op, so
  editing one variable cannot silently overwrite another.
- The generated project `.env` is written with 0600 permissions.

## Destructive actions

Nothing is pruned or deleted on a schedule. Removing a volume requires an
explicit `confirm=true`, and every cleanup screen shows what will be reclaimed
before anything is removed. Uninstalling keeps application data by default.

## Proxy configuration

Generated Nginx configuration is validated with `nginx -t` before a reload. If
validation fails, the previous configuration is restored byte for byte and the
error is surfaced to the user, so an invalid domain cannot take down every other
site on the server.

## Reporting a vulnerability

Open a private security advisory on the repository rather than a public issue.
