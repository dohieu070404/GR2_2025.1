#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJ_DIR="$ROOT_DIR/.."

echo "[Sprint 11] Backend static checks"
node -c "$ROOT_DIR/src/index.js"
node -c "$ROOT_DIR/src/mqtt.js"
node -c "$ROOT_DIR/src/zigbee.js"

if [[ -x "$ROOT_DIR/node_modules/.bin/prisma" ]]; then
  ( cd "$ROOT_DIR" && npx prisma validate )
else
  echo "[Sprint 11] NOTE: prisma binary not found in backend/node_modules; skipping 'prisma validate'."
fi

echo "[Sprint 11] Backend endpoint keywords"
grep -q "/hubs/:hubId/pairing/open" "$ROOT_DIR/src/index.js"
grep -q "/hubs/:hubId/pairing/discovered" "$ROOT_DIR/src/index.js"
grep -q "/hubs/:hubId/pairing/confirm" "$ROOT_DIR/src/index.js"
grep -q "/devices/:id/history" "$ROOT_DIR/src/index.js"

grep -q "device.claimed" "$ROOT_DIR/src/mqtt.js"

echo "[Sprint 11] Prisma schema checks"
grep -q "claimed" "$ROOT_DIR/prisma/schema.prisma"

echo "[Sprint 11] Firmware checks"
HUB_HOST="$PROJ_DIR/firmware/arduino/hub_host_mqtt_uart/hub_host_mqtt_uart_patched.ino"
COORD="$PROJ_DIR/firmware/arduino/zigbee_coordinator_esp32c6_uart_arduino/zigbee_coordinator_esp32c6_uart_arduino.ino"

grep -q "TH_SENSOR_V1" "$HUB_HOST"
grep -q "cluster, \"temperature\"" "$HUB_HOST"
grep -q "cluster, \"humidity\"" "$HUB_HOST"
grep -q "device.claimed" "$HUB_HOST"
grep -q "identify" "$HUB_HOST"

grep -q "CMD_IDENTIFY" "$COORD"
grep -q "zb_read_basic_fingerprint" "$COORD"
grep -q "zb_identify" "$COORD"

echo "[Sprint 11] Mobile checks"
[ -f "$PROJ_DIR/mobile/src/screens/ThSensorScreen.tsx" ]
grep -q "ThSensor" "$PROJ_DIR/mobile/src/navigation/AppNavigator.tsx"
grep -q "apiHubPairingOpen" "$PROJ_DIR/mobile/src/screens/ZigbeePairingScreen.tsx"

echo "[Sprint 11] Docs checks"
[ -f "$PROJ_DIR/docs/PAIRING_TYPE_FIRST.md" ]
[ -f "$PROJ_DIR/docs/TH_SENSOR_V1.md" ]

echo "[Sprint 11] OK"
