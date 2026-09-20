#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

exec pnpm exec playwright test "$@"
