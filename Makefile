## Bobivolve canonical commands.
##
## Stable named entrypoints for the common workflows. The underlying
## tool (currently pnpm) may change; the names here do not. See
## PROCESS.md "Canonical commands".
##
## Run `make` (no target) for the list.

.PHONY: help install dev build preview check format lint typecheck test e2e sim clean

help: ## Show this help
	@grep -E '^[a-zA-Z][a-zA-Z0-9_-]*:.*?##' $(MAKEFILE_LIST) \
		| awk -F ':.*?##' '{printf "  \033[1m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies (and wire git hooks)
	pnpm install

dev: ## Start the dev server (dashboard at http://localhost:5173)
	pnpm dev

build: ## Production build of the dashboard
	pnpm build

preview: ## Preview the production build locally
	pnpm preview

check: ## Format-check + lint + typecheck + unit tests
	pnpm check

format: ## Auto-format the codebase
	pnpm format

lint: ## Lint the codebase
	pnpm lint

typecheck: ## TypeScript --noEmit pass
	pnpm typecheck

test: ## Unit tests (vitest)
	pnpm test

e2e: ## End-to-end tests (Playwright)
	pnpm test:e2e

sim: ## Run the headless sim CLI (pass FLAGS=... for arguments)
	pnpm sim $(FLAGS)

clean: ## Remove build output
	rm -rf dist

.DEFAULT_GOAL := help
