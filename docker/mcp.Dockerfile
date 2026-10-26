# MCP server image: one static binary that talks to the manager over the
# internal network. It holds no state and no secret.
FROM golang:1.25-alpine AS build

WORKDIR /src
COPY manager/go.mod manager/go.sum ./
RUN go mod download

COPY manager/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/mcp ./cmd/mcp

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/mcp /usr/local/bin/mcp

ENV MCP_LISTEN=:8090
EXPOSE 8090

ENTRYPOINT ["/usr/local/bin/mcp"]
