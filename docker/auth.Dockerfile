# Auth service: better-auth on Bun. It owns users and sessions; the Go manager
# only reads the session table to authenticate API requests.
#
# The install has to be the whole workspace — the lockfile is one file for all
# of it — so it happens in a stage that is thrown away. Only the bundle ships.
FROM oven/bun:1-alpine AS build

WORKDIR /app

# Manifests first so the dependency layer survives source changes.
COPY package.json bun.lock ./
COPY apps/auth/package.json ./apps/auth/
COPY apps/web/package.json ./apps/web/
RUN bun install --frozen-lockfile

COPY apps/auth ./apps/auth
RUN cd apps/auth && bun build src/server.ts --target=bun --outfile /server.js

FROM oven/bun:1-alpine

WORKDIR /app
COPY --from=build /server.js ./server.js

ENV PLATFORM_ROOT=/opt/vexdock \
    PORT=8081

EXPOSE 8081

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
    CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:8081/health'); process.exit(r.ok ? 0 : 1)"]

CMD ["bun", "server.js"]
