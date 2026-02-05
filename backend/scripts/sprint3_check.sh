#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

echo "==> Backend Sprint3 check"

echo "==> 1) Node sanity"
node -v
npm -v

echo "==> 2) Syntax checks (node --check)"
node --check src/index.js
node --check src/mqtt.js

# NOTE: prisma generate requires deps installed.
echo "==> 3) Prisma schema + generate"
npx prisma validate
npx prisma generate

echo "==> 4) Migrations status (requires DATABASE_URL, prints status only)"
npx prisma migrate status || true

echo "==> 5) Quick greps"
rg -n "home/zb/\+/state" src/mqtt.js
rg -n "handleZigbeePlaneStateMessage" src/mqtt.js
rg -n "device_event_created" src/mqtt.js
rg -n "app.get\(\"/devices/:id/state\"" src/index.js
rg -n "app.get\(\"/devices/:id/events\"" src/index.js

cat <<'TXT'

Manual Sprint3 end-to-end checks:

Prereq: you must have a bound Zigbee Device in DB with Device.zigbeeIeee=<IEEE>.

A) Zigbee state ingest + SSE
  mosquitto_pub -h localhost -p 1883 -u smarthome -P smarthome123 \
    -t 'home/zb/<IEEE>/state' -r \
    -m '{"ts":1700000000000,"reported":{"relay":true,"pwm":128}}'

  Expect:
    - DB DeviceStateCurrent.state updated
    - SSE event: device_state_updated

B) Zigbee event ingest + SSE
  mosquitto_pub -h localhost -p 1883 -u smarthome -P smarthome123 \
    -t 'home/zb/<IEEE>/event' \
    -m '{"ts":1700000000100,"type":"motion.detected","data":{"level":1}}'

  Expect:
    - DB DeviceEvent appended
    - SSE event: device_event_created

C) Zigbee cmd_result updates Command + SSE
  1) Create a command for the device (API will publish to home/zb/<IEEE>/set if protocol=ZIGBEE)
  2) Publish cmd_result:

  mosquitto_pub -h localhost -p 1883 -u smarthome -P smarthome123 \
    -t 'home/zb/<IEEE>/cmd_result' \
    -m '{"ts":1700000000200,"cmdId":"<CMD_ID>","ok":true}'

  Expect:
    - DB Command status -> ACKED
    - SSE event: command_updated

D) APIs
  - GET /devices/:id/state
  - GET /devices/:id/events?date=YYYY-MM-DD

TXT

echo "==> Sprint3 check finished"
