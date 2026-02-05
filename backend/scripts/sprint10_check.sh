#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[Sprint 10] Backend static checks"
node -c "$ROOT_DIR/src/index.js"
node -c "$ROOT_DIR/src/mqtt.js"
node -c "$ROOT_DIR/src/zigbee.js"
node -c "$ROOT_DIR/src/prisma.js"
node -c "$ROOT_DIR/src/otaRollout.js"

if [[ -x "$ROOT_DIR/node_modules/.bin/prisma" ]]; then
  ( cd "$ROOT_DIR" && npx prisma validate )
else
  echo "[Sprint 10] NOTE: prisma binary not found in backend/node_modules; skipping 'prisma validate'."
  echo "             If you want to run it locally: cd backend && npm i && npx prisma validate"
fi

echo "[Sprint 10] Firmware structure checks"
PROJ_DIR="$ROOT_DIR/.."

# ESP8266 UI modules
[ -d "$PROJ_DIR/firmware/lock_ui_esp8266" ]
for f in \
  pins.h \
  rfid_rc522.cpp \
  keypad_4x4.cpp \
  seg7_74hc595.cpp \
  store_credentials.cpp \
  uart_protocol.cpp \
  lock_logic.cpp \
  buzzer.cpp; do
  [ -f "$PROJ_DIR/firmware/lock_ui_esp8266/$f" ]
done

# ESP32-C6 enddevice lock bridge
[ -f "$PROJ_DIR/firmware/enddevice_lock_c6/enddevice_lock_c6.ino" ]

# Docs
[ -f "$PROJ_DIR/docs/SMARTLOCK_ESP8266_C6.md" ]

# Hub host routing keywords
grep -q "lock_action" "$PROJ_DIR/firmware/arduino/hub_host_mqtt_uart/hub_host_mqtt_uart_patched.ino"
grep -q "\"zb_event\"" "$PROJ_DIR/firmware/arduino/hub_host_mqtt_uart/hub_host_mqtt_uart_patched.ino"
grep -q "\"zb_state\"" "$PROJ_DIR/firmware/arduino/hub_host_mqtt_uart/hub_host_mqtt_uart_patched.ino"

# Coordinator keywords (custom cluster)
grep -q "LOCK_CUSTOM_CLUSTER_ID" "$PROJ_DIR/firmware/arduino/zigbee_coordinator_esp32c6_uart_arduino/zigbee_coordinator_esp32c6_uart_arduino.ino"
grep -q "ESP_ZB_CORE_CMD_CUSTOM_CLUSTER_REQ_CB_ID" "$PROJ_DIR/firmware/arduino/zigbee_coordinator_esp32c6_uart_arduino/zigbee_coordinator_esp32c6_uart_arduino.ino"

echo "[Sprint 10] OK"
