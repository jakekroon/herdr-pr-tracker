#!/usr/bin/env bash
# Offline verification: no network, no gh, no running Herdr.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== bun test =="
bun test
echo "== typecheck =="
bunx tsc --noEmit
echo "== manifest parses =="
bun run tests/manifest.ts
echo "all green"
