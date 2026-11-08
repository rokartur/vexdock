# Manager image: the Rust binary plus the two CLIs it drives (git and docker
# compose). Nothing else, so the attack surface stays small.
FROM rust:1.99-alpine3.22 AS build

# musl-dev links the static binary; SQLite and ring compile their C with it.
RUN apk add --no-cache musl-dev

WORKDIR /src
COPY manager/ ./
ARG CARGO_PROFILE=release
# Builds mcp too: this stage is byte-identical to mcp.Dockerfile's, so BuildKit runs it once for both images.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --profile "$CARGO_PROFILE" --locked --bins && cp "target/$CARGO_PROFILE/manager" "target/$CARGO_PROFILE/mcp" /

FROM alpine:3.22

# docker-cli-compose provides `docker compose`; git clones project repositories.
# The manager runs as root on purpose: it drives the host's Docker socket.
RUN apk add --no-cache ca-certificates git openssh-client docker-cli docker-cli-compose tzdata

COPY --from=build /manager /usr/local/bin/manager

ENV PLATFORM_ROOT=/opt/vexdock \
    PLATFORM_LISTEN=:8080

EXPOSE 8080

# The binary probes itself, so the image needs no curl or wget.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD ["/usr/local/bin/manager", "-healthcheck"]

ENTRYPOINT ["/usr/local/bin/manager"]
