#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

exec scripts/e2e.sh e2e/browser-persistence.spec.ts "$@"
