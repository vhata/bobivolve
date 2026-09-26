#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

exec pnpm exec tsx test/bench/r2-cost-policies.ts "$@"
