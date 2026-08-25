#!/usr/bin/env bash
# Offline verification: no network, no gh, no running Herdr.
# This is what CI runs, and what `bun test` alone does not cover on its own.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== bun test =="
bun test
echo "== typecheck =="
bunx tsc --noEmit
echo "all green"
