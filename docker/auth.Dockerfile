# Auth service: better-auth on Bun. It owns users and sessions; the Go manager
# only reads the session table to authenticate API requests.
FROM oven/bun:1-alpine

WORKDIR /app

# Manifests first so the dependency layer survives source changes.
COPY package.json bun.lock ./
COPY apps/auth/package.json ./apps/auth/
COPY apps/web/package.json ./apps/web/
RUN bun install --frozen-lockfile

COPY apps/auth ./apps/auth

ENV PLATFORM_ROOT=/opt/platform \
    PORT=8081

EXPOSE 8081

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
    CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:8081/health'); process.exit(r.ok ? 0 : 1)"]

WORKDIR /app/apps/auth
CMD ["bun", "src/server.ts"]
