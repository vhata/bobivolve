#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

for gate in fmt-check lint typecheck test; do
  echo "Checking $gate"
  if ! "scripts/$gate.sh"; then
    echo "check: $gate failed" >&2
    exit 1
  fi
done
