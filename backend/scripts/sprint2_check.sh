#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

echo "==> Backend Sprint2 check"

echo "==> 1) Node sanity"
node -v
npm -v

echo "==> 2) Lint-ish syntax checks (node --check)"
node --check src/index.js
node --check src/mqtt.js
node --check src/validators.js
node --check src/zigbee.js

echo "==> 3) Prisma schema + generate"
npx prisma validate
npx prisma generate

echo "==> 4) Migrations (prints status)"
# Note: migrate dev requires a DB; we only show status here.
# If you have DATABASE_URL set, you can run:
#   npx prisma migrate dev
#   npx prisma db seed
npx prisma migrate status || true

echo "==> 5) Quick grep asserts"
rg -n "ZigbeePairingMode" prisma/schema.prisma
rg -n "suggestedModelId" prisma/schema.prisma
rg -n "SERIAL_FIRST" src/index.js src/mqtt.js
rg -n "TYPE_FIRST" src/index.js src/mqtt.js

cat <<'TXT'

Manual happy-path checks (local):

A) Serial-first Zigbee flow
  1) Seed DB and note the zigbee_device serial/setupCode printed by prisma seed.
  2) POST /devices/claim (protocol=ZIGBEE) -> inventory status should become CLAIMED.
  3) POST /zigbee/pairing/open with {hubId, mode: "SERIAL_FIRST", claimedSerial}
  4) When a Zigbee device announces, backend should create a provisional Device with lifecycleStatus CLAIMING.
  5) POST /zigbee/pairing/confirm with {token, ieee} -> inventory -> BOUND and device -> BOUND.

B) Type-first Zigbee flow
  1) POST /zigbee/pairing/open with {hubId, mode: "TYPE_FIRST", expectedModelId: "TH_SENSOR_V1"}
  2) Device announces + reports fingerprint -> GET /zigbee/discovered should include suggestions[].
  3) POST /zigbee/pairing/confirm with {token, ieee} (and modelId override if suggested != expected)

C) MQTT discovered payload now includes fingerprint fields
  - hub_host publishes to home/hub/<hubId>/zigbee/discovered:
      { token, ieee, shortAddr, manufacturer, model, swBuildId }

TXT

echo "==> Sprint2 check finished"
