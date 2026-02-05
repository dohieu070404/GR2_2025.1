#!/usr/bin/env bash
set -euo pipefail

# Sprint 1 check helper (non-interactive parts)
# - validate prisma schema
# - generate prisma client
# - apply migrations
# - run seed
# Note: `npm run dev` is intentionally not executed because it blocks.

cd "$(dirname "$0")/.."

echo "== Sprint1: npm install =="
npm install

echo "== Sprint1: prisma validate =="
npx prisma validate

echo "== Sprint1: prisma generate =="
npx prisma generate

echo "== Sprint1: prisma migrate dev =="
npx prisma migrate dev

echo "== Sprint1: prisma db seed =="
npx prisma db seed

echo "== Sprint1: syntax check =="
node --check src/index.js

cat <<'EOF'

OK. Next manual checks:
- Start server: npm run dev
- API: POST /hubs/activate -> expect mqtt creds + HubInventory.status=BOUND
- API: POST /devices/claim -> expect productModel descriptor
EOF
