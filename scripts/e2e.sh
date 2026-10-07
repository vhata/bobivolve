#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p test-results
evidence="$(mktemp -d "$PWD/test-results/run.XXXXXXXX")"
echo "Browser evidence: $evidence"
exec pnpm exec playwright test "$@" --output "$evidence"
