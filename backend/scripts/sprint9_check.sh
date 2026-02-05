#!/usr/bin/env bash
set -euo pipefail

echo "[Sprint 9] Static checks"

# Syntax checks
node -c src/index.js
node -c src/mqtt.js
node -c src/validators.js

echo "[Sprint 9] Prisma schema validate"
# NOTE: requires prisma CLI (npx) available in environment
npx prisma validate

echo "[Sprint 9] OK (static)"

echo
echo "Next: run the manual integration checks described in docs/SPRINT_TESTING.md (Sprint 9 Check)."
