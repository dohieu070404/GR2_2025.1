#!/usr/bin/env bash
set -euo pipefail

echo "[Sprint6] Static checks"

cd "$(dirname "$0")/.."

echo "Node: $(node -v)"

# 1) Syntax checks (backend)
node -c src/index.js
node -c src/mqtt.js
node -c src/validators.js
node -c src/middleware/auth.js
node -c src/middleware/admin.js

echo "[ok] Node syntax"

# 2) Prisma schema validation
npx prisma validate

echo "[ok] Prisma schema valid"

echo

echo "Next: run admin-web (optional) and follow README Sprint 6 Admin SPRINT CHECK steps."
