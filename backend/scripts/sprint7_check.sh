#!/usr/bin/env bash
set -euo pipefail

echo "[Sprint7] Static checks"

cd "$(dirname "$0")/.."

echo "Node: $(node -v)"

# 1) Syntax checks (backend)
node -c src/index.js
node -c src/mqtt.js
node -c src/validators.js
node -c src/middleware/auth.js
node -c src/middleware/admin.js
node -c src/otaRollout.js

echo "[ok] Node syntax"

# 2) Prisma schema validation (requires deps installed)
if [[ -x node_modules/.bin/prisma ]]; then
  node_modules/.bin/prisma validate
else
  echo "[FATAL] Prisma CLI not found. Run 'npm install' in backend/ first."
  exit 1
fi

echo "[ok] Prisma schema valid"

echo

echo "Next: follow docs/SPRINT_TESTING.md Sprint 7 section (Hub OTA + version tracking)."
