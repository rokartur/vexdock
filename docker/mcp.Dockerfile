# MCP server image: one static binary that talks to the manager over the
# internal network. It holds no state and no secret.
FROM rust:1.99-alpine3.22 AS build

RUN apk add --no-cache musl-dev

WORKDIR /src
COPY manager/ ./
ARG CARGO_PROFILE=release
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --profile "$CARGO_PROFILE" --locked --bin mcp && cp "target/$CARGO_PROFILE/mcp" /mcp

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /mcp /usr/local/bin/mcp

ENV MCP_LISTEN=:8090
EXPOSE 8090

ENTRYPOINT ["/usr/local/bin/mcp"]
