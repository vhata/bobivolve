#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

exec pnpm exec tsx test/bench/snapshot-cadence.ts "$@"
