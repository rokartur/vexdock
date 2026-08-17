# Manager image: the Go binary plus the two CLIs it drives (git and docker
# compose). Nothing else, so the attack surface stays small.
FROM golang:1.25-alpine AS build

WORKDIR /src
COPY manager/go.mod manager/go.sum ./
RUN go mod download

COPY manager/ ./
ARG VERSION=dev
# CGO stays off: modernc.org/sqlite is pure Go, so the binary is static.
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/manager ./cmd/server

FROM alpine:3.22

# docker-cli-compose provides `docker compose`; git clones project repositories.
RUN apk add --no-cache ca-certificates git openssh-client docker-cli docker-cli-compose tzdata \
    && adduser -D -u 10001 platform

COPY --from=build /out/manager /usr/local/bin/manager

ENV PLATFORM_ROOT=/opt/platform \
    PLATFORM_LISTEN=:8080

EXPOSE 8080

# The binary probes itself, so the image needs no curl or wget.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD ["/usr/local/bin/manager", "-healthcheck"]

ENTRYPOINT ["/usr/local/bin/manager"]
