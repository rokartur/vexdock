# Nginx image: the reverse proxy plus the prebuilt dashboard as static files.
# There is no JavaScript runtime in production.
FROM oven/bun:1-alpine AS web

WORKDIR /app
# Manifests first so the dependency layer is cached across source changes.
COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/
RUN bun install --frozen-lockfile

COPY apps/web ./apps/web
RUN cd apps/web && bun run build

FROM nginx:1.29-alpine

COPY docker/nginx/nginx.conf /etc/nginx/nginx.conf
COPY docker/nginx/dashboard.conf /etc/nginx/dashboard/dashboard.conf
COPY --from=web /app/apps/web/dist/client /usr/share/nginx/html

# Mount points for platform state; the directories must exist even when empty
# so `nginx -t` succeeds on a fresh install.
RUN mkdir -p /etc/nginx/generated /etc/nginx/custom /acme-challenge /certificates

EXPOSE 80 443 3000

HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
    CMD ["nginx", "-t"]
