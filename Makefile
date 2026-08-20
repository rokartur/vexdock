.DEFAULT_GOAL := help
SHELL := /bin/sh

# Local development writes to ./.vexdock so nothing touches /opt.
PLATFORM_ROOT ?= $(CURDIR)/.vexdock
VERSION ?= dev
# Fixed on purpose: a local stack keeps its sessions across restarts. The
# installer generates a real one per install.
DEV_AUTH_SECRET ?= dev-only-not-a-secret

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-16s %s\n", $$1, $$2}'

## ---- backend ----

# The running version comes from PLATFORM_VERSION in the environment, not from
# the binary, so there is nothing to stamp in here.
.PHONY: manager
manager: ## Build the manager binary into ./bin
	cd manager && go build -trimpath -ldflags "-s -w" -o ../bin/manager ./cmd/server

.PHONY: run
run: ## Run the manager against ./.vexdock on :8080
	cd manager && PLATFORM_ROOT=$(PLATFORM_ROOT) PLATFORM_LOG_LEVEL=debug go run ./cmd/server

.PHONY: test
test: ## Run Go tests
	cd manager && go test ./...

.PHONY: lint
lint: ## Vet and format-check the Go code
	cd manager && go vet ./...
	@test -z "$$(cd manager && gofmt -l .)" || { echo "gofmt needed:"; cd manager && gofmt -l .; exit 1; }

## ---- frontend ----

.PHONY: web
web: ## Build the dashboard into apps/web/dist/client
	cd apps/web && bun run build

.PHONY: web-dev
web-dev: ## Run the dashboard dev server on :5173 with HMR (proxies /api to the stack on :3000)
	cd apps/web && bun run dev

.PHONY: web-check
web-check: ## Typecheck and test the dashboard and the auth service
	cd apps/web && bun run typecheck && bun run test
	cd apps/auth && bun run typecheck && bun run test

## ---- images ----

.PHONY: images
images: ## Build the three container images locally
	docker build -f docker/manager.Dockerfile -t vexdock-manager:$(VERSION) .
	docker build -f docker/auth.Dockerfile -t vexdock-auth:$(VERSION) .
	docker build -f docker/nginx.Dockerfile -t vexdock-nginx:$(VERSION) .

## ---- local stack ----

# Nginx serves apps/web/dist/client from the host, so the build has to exist.
.PHONY: dev-up
dev-up: web ## Build and start the full stack locally
	docker network inspect vexdock-proxy >/dev/null 2>&1 || docker network create vexdock-proxy
	mkdir -p $(PLATFORM_ROOT)/nginx/generated $(PLATFORM_ROOT)/nginx/custom $(PLATFORM_ROOT)/nginx/acme-challenge \
	         $(PLATFORM_ROOT)/certificates $(PLATFORM_ROOT)/data $(PLATFORM_ROOT)/projects $(PLATFORM_ROOT)/backups \
	         $(PLATFORM_ROOT)/secrets $(PLATFORM_ROOT)/system
	PLATFORM_ROOT=$(PLATFORM_ROOT) VERSION=dev \
	  BETTER_AUTH_SECRET=$(DEV_AUTH_SECRET) SETUP_TOKEN=dev \
	  docker compose -f compose.yml -f compose.dev.yml up -d --build

.PHONY: dev-down
dev-down: ## Stop the local stack
	PLATFORM_ROOT=$(PLATFORM_ROOT) BETTER_AUTH_SECRET=$(DEV_AUTH_SECRET) \
	  docker compose -f compose.yml -f compose.dev.yml down --remove-orphans

.PHONY: dev-logs
dev-logs: ## Follow the manager logs
	docker logs -f vexdock-manager

.PHONY: check
check: lint test web-check ## Everything CI runs
