#!/usr/bin/env bash
set -euo pipefail

echo "[Sprint5] Static checks"

cd "$(dirname "$0")/.."

echo "Node: $(node -v)"

# 1) Syntax checks
node -c src/index.js
node -c src/mqtt.js
node -c src/validators.js

echo "[ok] Node syntax"

# 2) Prisma schema validation
npx prisma validate

echo "[ok] Prisma schema valid"

echo

echo "Next: follow docs/SPRINT_TESTING.md (Sprint 5) for manual integration steps."
