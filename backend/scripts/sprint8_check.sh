#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "== Sprint 8 Check (static) =="

echo "[1/4] Backend JS syntax check"
node -c src/index.js
node -c src/mqtt.js
node -c src/automation.js
node -c src/validators.js

echo "[2/4] Prisma schema validate"
npx prisma validate

echo "[3/4] Admin-web dev proxy sanity"
if grep -qE "proxy:\s*\{\s*\"/\"" ../admin-web/vite.config.ts; then
  echo "ERROR: admin-web/vite.config.ts is proxying '/' → this will break the SPA (you will see 404)."
  echo "Fix: proxy only API prefixes like /admin, /auth, /homes ..."
  exit 1
fi

echo "[4/4] Manual integration checks"
echo "See docs/SPRINT_TESTING.md section 14 for MQTT + hub integration steps."

echo "SPRINT8_CHECK: PASS (static)."
