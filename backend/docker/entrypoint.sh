#!/bin/sh
set -e

echo "[entry] starting (NODE_ENV=${NODE_ENV:-})"

# ----------------------
# Wait for MySQL
# ----------------------
DB_WAIT_MAX_RETRIES=${DB_WAIT_MAX_RETRIES:-60}
DB_WAIT_SLEEP_SEC=${DB_WAIT_SLEEP_SEC:-1}

echo "[entry] waiting for DB (max=${DB_WAIT_MAX_RETRIES}, sleep=${DB_WAIT_SLEEP_SEC}s)..."

# Use Prisma to check DB readiness (no extra dependencies).
# We run it as an inline ESM script because this project uses type:module.
node --input-type=module <<'NODE'
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const max = Number(process.env.DB_WAIT_MAX_RETRIES || 60);
const sleepSec = Number(process.env.DB_WAIT_SLEEP_SEC || 1);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let ok = false;
for (let i = 0; i < max; i++) {
  try {
    await prisma.$queryRaw`SELECT 1`;
    ok = true;
    console.log("[entry] DB ready");
    break;
  } catch (e) {
    console.log(`[entry] DB not ready (${i + 1}/${max})`);
    await sleep(sleepSec * 1000);
  }
}

await prisma.$disconnect();

if (!ok) {
  console.error("[entry] DB wait timeout");
  process.exit(1);
}
NODE

# ----------------------
# Migrations
# ----------------------
echo "[entry] running prisma migrate deploy..."

# prisma migrate deploy is idempotent
npx prisma migrate deploy

if [ "${RUN_LEGACY_MIGRATION:-0}" = "1" ]; then
  echo "[entry] RUN_LEGACY_MIGRATION=1 -> running legacy data fixer..."
  node prisma/migrate_legacy_data.js
fi

# ----------------------
# Start server
# ----------------------
echo "[entry] starting server..."
exec node src/index.js
