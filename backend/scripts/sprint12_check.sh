#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "[Sprint12] 1) Node syntax checks"
node -c src/index.js
node -c src/mqtt.js
node -c src/descriptor.js

echo "[Sprint12] 2) Prisma schema validate"
if [ -x "node_modules/.bin/prisma" ]; then
  node_modules/.bin/prisma validate > /dev/null
else
  echo "[Sprint12] WARN: prisma CLI not installed (run 'npm install' in backend/). Skipping prisma validate."
fi

echo "[Sprint12] 3) Descriptor endpoints exist"
grep -q '"/devices/:id/descriptor"' src/index.js
grep -q '"/homes/:homeId/devices"' src/index.js

echo "[Sprint12] 4) ProductModel seeds include Sprint12 plugins"
grep -q 'sensor.temperature_humidity' prisma/seed.js
grep -q 'lock.credentials' prisma/seed.js
grep -q 'motion.sensor' prisma/seed.js

echo "[Sprint12] 5) Mobile plugin registry + generic device details"
test -f ../mobile/src/plugins/registry.ts
test -f ../mobile/src/plugins/temperatureHumidity.tsx
test -f ../mobile/src/plugins/lockCore.tsx
test -f ../mobile/src/plugins/gateCore.tsx

# plugin ids are defined in each plugin module
grep -q 'sensor.temperature_humidity' ../mobile/src/plugins/temperatureHumidity.tsx
grep -q 'lock.core' ../mobile/src/plugins/lockCore.tsx
grep -q 'gate.core' ../mobile/src/plugins/gateCore.tsx
test -f ../mobile/src/screens/DeviceDetailsScreen.tsx
grep -q 'apiGetDeviceDescriptor' ../mobile/src/screens/DeviceDetailsScreen.tsx
grep -q 'plugins/registry' ../mobile/src/screens/DeviceDetailsScreen.tsx

echo "PASS"