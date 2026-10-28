#!/usr/bin/env bash
# Offline verification: no network, no gh, no running Herdr. CI runs this.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== bun test =="
bun test
echo "== typecheck =="
bunx tsc --noEmit
echo "all green"
