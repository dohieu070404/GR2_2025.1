#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

echo "==> Backend Sprint4 check"

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

echo "==> 4) Quick grep asserts"
grep -R "action-based commands" -n src/index.js >/dev/null
grep -R "device_event_created" -n src/mqtt.js >/dev/null

cat <<'TXT'

SPRINT 4 manual happy-path checks (hardware required)

A) Setup / inventory
  - Seed DB. Prisma seed prints:
      zigbee_device serial: zb-gate-001 setupCode: 00000000 (modelId: GATE_PIR_V1)
  - Claim device inventory:
      POST /devices/claim { serial: "zb-gate-001", setupCode: "00000000", homeId, protocol: "ZIGBEE" }
  - Open pairing (SERIAL_FIRST):
      POST /zigbee/pairing/open { homeId, hubId: "hub-demo", mode: "SERIAL_FIRST", claimedSerial: "zb-gate-001" }
  - Power on/join the end-device (ESP32-C6) + ensure it reports fingerprint model = GATE_PIR_V1.
  - Confirm pairing:
      POST /zigbee/pairing/confirm { token, ieee }

B) Command API (action-based)
  - From mobile or curl, call:
      POST /devices/:id/command { action: "gate.open", params: { source: "mobile" } }
    Expect:
      - MQTT publish to home/zb/<ieee>/set with { cmdId, ts, action, args }
      - Hub host -> UART -> coordinator -> end-device executes
      - MQTT cmd_result: home/zb/<ieee>/cmd_result { cmdId, ok:true }
      - UI realtime update via SSE device_state_updated

C) Motion events
  - PIR triggers:
      - MQTT event: home/zb/<ieee>/event { type:"motion.detected", ... }
      - Backend events API: GET /devices/:id/events?date=YYYY-MM-DD includes motion.detected

TXT

echo "==> Sprint4 check finished"
