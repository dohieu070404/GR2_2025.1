import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function upsertProductModels() {
  const models = [
    {
      id: "HUB_V1",
      name: "SmartHome Hub v1",
      manufacturer: "SmartHome",
      protocol: "HUB",
      capabilities: {
        role: "hub",
        features: ["zigbee_gateway", "mqtt_bridge"],
      },
      uiSchema: {
        screens: [{ type: "hub_status", title: "Hub" }],
      },
      defaultConfig: {
        zigbee: { permitJoinDefaultSec: 60 },
      },
    },
    {
      id: "TH_SENSOR_V1",
      name: "Temp/Humidity Sensor v1",
      manufacturer: "SmartHome",
      protocol: "ZIGBEE",
      fingerprintManuf: "SmartHome",
      fingerprintModel: "TH_SENSOR_V1",
      capabilities: {
        // Sprint 12: Device Descriptor + Plugin registry
        // NOTE: Zigbee TH state uses keys: reported.temperature / reported.humidity
        plugins: ["sensor.temperature_humidity"],
        sensors: ["temperature", "humidity"],
        units: { temperature: "°C", humidity: "%" },
        history: {
          kind: "state_history_daily",
          metrics: ["temperature", "humidity"],
        },
        actions: [{ action: "identify", title: "Identify", params: { time: 4 } }],
        stateMap: {
          temperature: { path: "temperature", unit: "°C", decimals: 2 },
          humidity: { path: "humidity", unit: "%", decimals: 2 },
        },
      },
      uiSchema: {
        version: 1,
        title: "TH Sensor",
        sections: [
          { id: "realtime", plugin: "sensor.temperature_humidity", view: "realtime", title: "Realtime" },
          { id: "history", plugin: "sensor.temperature_humidity", view: "history_daily", title: "History" },
        ],
      },
      defaultConfig: {
        reportIntervalSec: 60,
      },
    },
    {
      id: "DIMMER_V1",
      name: "Dimmer v1",
      manufacturer: "SmartHome",
      protocol: "MQTT",
      capabilities: { actuators: ["dimmer"], range: { min: 0, max: 255 } },
      uiSchema: { controls: [{ type: "slider", key: "pwm", min: 0, max: 255 }] },
      defaultConfig: { pwm: 0 },
    },
    {
      id: "LOCK_V2_DUALMCU",
      name: "SmartLock v2 (dual MCU)",
      manufacturer: "SmartHome",
      protocol: "ZIGBEE",
      fingerprintManuf: "SmartHome",
      fingerprintModel: "LOCK_V2_DUALMCU",
      capabilities: {
        // Sprint 12: Device Descriptor + Plugin registry
        plugins: ["lock.core", "lock.history", "lock.credentials"],
        actuators: ["lock"],
        events: ["lock.lock", "lock.unlock", "credential_changed"],
        actions: [
          { action: "identify", title: "Identify", params: { time: 4 } },
          { action: "lock.add_pin", title: "Add PIN" },
          { action: "lock.delete_pin", title: "Delete PIN" },
          { action: "lock.add_rfid", title: "Add RFID" },
          { action: "lock.delete_rfid", title: "Delete RFID" },
          { action: "lock.set_master", title: "Set Master" },
        ],
        stateMap: {
          lockState: { path: "lock.state" },
          lockoutUntil: { path: "lock.lockoutUntil" },
          lastAction: { path: "lastAction" },
        },
      },
      uiSchema: {
        version: 1,
        title: "Smart Lock",
        sections: [
          { id: "status", plugin: "lock.core", view: "status", title: "Status" },
          { id: "history", plugin: "lock.history", view: "history", title: "History" },
          { id: "credentials", plugin: "lock.credentials", view: "credentials", title: "Credentials" },
        ],
      },
      defaultConfig: { autoRelockSec: 10 },
    },
    {
      id: "GATE_PIR_V1",
      name: "ServoGate + PIR v1",
      manufacturer: "SmartHome",
      protocol: "ZIGBEE",
      fingerprintManuf: "SmartHome",
      fingerprintModel: "GATE_PIR_V1",
      capabilities: {
        // Sprint 12: Device Descriptor + Plugin registry
        plugins: ["gate.core", "motion.sensor", "light.switch"],
        actuators: ["gate", "light"],
        sensors: ["motion"],
        events: ["motion.detected", "gate.state", "light.state"],
        actions: [
          { action: "identify", title: "Identify", params: { time: 4 } },
          { action: "gate.open", title: "Open Gate", params: { source: "mobile" } },
          { action: "gate.close", title: "Close Gate", params: { source: "mobile" } },
          { action: "light.set", title: "Light", params: { on: true } },
          { action: "light.set_timeout", title: "Light timeout", params: { sec: 30 } },
        ],
        stateMap: {
          gateOpen: { path: "gate.open" },
          lightOn: { path: "light.on" },
          motionLastAt: { path: "motion.lastAt" },
        },
      },
      uiSchema: {
        version: 1,
        title: "Gate + Motion + Light",
        sections: [
          { id: "gate", plugin: "gate.core", view: "control", title: "Gate" },
          { id: "light", plugin: "light.switch", view: "control", title: "Light" },
          { id: "light_timeout", plugin: "light.switch", view: "timeout", title: "Light timeout" },
          { id: "motion", plugin: "motion.sensor", view: "history", title: "Motion history" },
        ],
      },
      defaultConfig: { gateOpenMs: 1500 },
    },
  ];

  for (const m of models) {
    await prisma.productModel.upsert({
      where: { id: m.id },
      update: {
        name: m.name,
        manufacturer: m.manufacturer,
        protocol: m.protocol,
        fingerprintManuf: m.fingerprintManuf ?? null,
        fingerprintModel: m.fingerprintModel ?? null,
        capabilities: m.capabilities ?? null,
        uiSchema: m.uiSchema ?? null,
        defaultConfig: m.defaultConfig ?? null,
      },
      create: {
        id: m.id,
        name: m.name,
        manufacturer: m.manufacturer,
        protocol: m.protocol,
        fingerprintManuf: m.fingerprintManuf ?? null,
        fingerprintModel: m.fingerprintModel ?? null,
        capabilities: m.capabilities ?? null,
        uiSchema: m.uiSchema ?? null,
        defaultConfig: m.defaultConfig ?? null,
      },
    });
  }
}

async function main() {
  // --- Demo user ---
  const demoEmail = "demo@example.com";
  const demoPassword = "demo123";
  const passwordHash = await bcrypt.hash(demoPassword, 10);

  const user = await prisma.user.upsert({
    where: { email: demoEmail },
    update: {
      name: "Demo User",
      passwordHash,
      isAdmin: false,
    },
    create: {
      name: "Demo User",
      email: demoEmail,
      passwordHash,
      isAdmin: false,
    },
  });

  // --- Admin user (Sprint 6 RBAC) ---
  // For local/dev only. Change credentials in production.
  const adminEmail = "admin@example.com";
  const adminPassword = "admin123";
  const adminPasswordHash = await bcrypt.hash(adminPassword, 10);
  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      name: "Admin",
      passwordHash: adminPasswordHash,
      isAdmin: true,
    },
    create: {
      name: "Admin",
      email: adminEmail,
      passwordHash: adminPasswordHash,
      isAdmin: true,
    },
  });

  // --- Sprint 9: user profiles (minimal identity) ---
  await prisma.userProfile.upsert({
    where: { userId: user.id },
    update: { displayName: "Demo User", avatarUrl: null },
    create: { userId: user.id, displayName: "Demo User", avatarUrl: null },
  });

  await prisma.userProfile.upsert({
    where: { userId: admin.id },
    update: { displayName: "Admin", avatarUrl: null },
    create: { userId: admin.id, displayName: "Admin", avatarUrl: null },
  });

  // --- ProductModel catalog ---
  await upsertProductModels();

  // --- Demo home ---
  let home = await prisma.home.findFirst({ where: { ownerId: user.id, name: "Demo Home" } });
  if (!home) {
    home = await prisma.home.create({
      data: {
        name: "Demo Home",
        ownerId: user.id,
      },
    });
  }

  // membership (OWNER)
  await prisma.homeMember.upsert({
    where: { homeId_userId: { homeId: home.id, userId: user.id } },
    update: { role: "OWNER" },
    create: { homeId: home.id, userId: user.id, role: "OWNER" },
  });

  // --- Demo room ---
  const room = await prisma.room.upsert({
    where: { homeId_name: { homeId: home.id, name: "Living Room" } },
    update: {},
    create: { homeId: home.id, name: "Living Room" },
  });

  // --- Demo hub (bound) ---
  await prisma.hub.upsert({
    where: { hubId: "hub-demo" },
    update: { homeId: home.id, name: "Demo Hub" },
    create: {
      hubId: "hub-demo",
      homeId: home.id,
      name: "Demo Hub",
      online: false,
    },
  });

  // --- Demo MQTT device (for mqtt-smoke + docs) ---
  await prisma.device.upsert({
    where: { deviceId: "dev-001" },
    update: {
      homeId: home.id,
      roomId: room.id,
      name: "Demo Dimmer",
      type: "dimmer",
      protocol: "MQTT",
      modelId: "DIMMER_V1",
      lifecycleStatus: "ACTIVE",
    },
    create: {
      deviceId: "dev-001",
      homeId: home.id,
      roomId: room.id,
      name: "Demo Dimmer",
      type: "dimmer",
      protocol: "MQTT",
      modelId: "DIMMER_V1",
      lifecycleStatus: "ACTIVE",
      boundAt: new Date(),
    },
  });

  // --- Inventory demo rows (stable codes for Sprint testing) ---
  // NOTE: Setup codes are stored hashed. These plaintext values are printed for local testing.
  const HUB_SERIAL = "hub-demo";
  const HUB_SETUP = "00000000";

  // Sprint 9: hub inventory demo for mapping/runtime tests
  // Matches: HUB id derived from MAC suffix c5:54:94 -> hub-c55494
  const HUB_SPRINT9_SERIAL = "hub-c55494";
  const HUB_SPRINT9_SETUP = "12345678";
  const DEVICE_SERIAL = "dev-serial-001";
  const DEVICE_SETUP = "00000000";

  // Zigbee device inventory (for Sprint 2 SERIAL_FIRST flow)
  const ZB_DEVICE_SERIAL = "zb-serial-001";
  const ZB_DEVICE_SETUP = "00000000";

  // Sprint 4: Zigbee ServoGate + PIR + Light
  const ZB_GATE_SERIAL = "zb-gate-001";
  const ZB_GATE_SETUP = "00000000";

  // Sprint 5: SmartLock v2 (dual MCU)
  const ZB_LOCK_SERIAL = "zb-lock-001";
  const ZB_LOCK_SETUP = "00000000";

  await prisma.hubInventory.upsert({
    where: { serial: HUB_SERIAL },
    update: {
      setupCodeHash: await bcrypt.hash(HUB_SETUP, 10),
      status: "NEW",
      modelId: "HUB_V1",
    },
    create: {
      serial: HUB_SERIAL,
      setupCodeHash: await bcrypt.hash(HUB_SETUP, 10),
      status: "NEW",
      modelId: "HUB_V1",
    },
  });

  await prisma.hubInventory.upsert({
    where: { serial: HUB_SPRINT9_SERIAL },
    update: {
      setupCodeHash: await bcrypt.hash(HUB_SPRINT9_SETUP, 10),
      status: "NEW",
      modelId: "HUB_V1",
    },
    create: {
      serial: HUB_SPRINT9_SERIAL,
      setupCodeHash: await bcrypt.hash(HUB_SPRINT9_SETUP, 10),
      status: "NEW",
      modelId: "HUB_V1",
    },
  });

  await prisma.deviceInventory.upsert({
    where: { serial: DEVICE_SERIAL },
    update: {
      deviceUuid: "dev-001",
      typeDefault: "dimmer",
      protocol: "MQTT",
      model: "dimmer-v1",
      modelId: "DIMMER_V1",
    },
    create: {
      serial: DEVICE_SERIAL,
      deviceUuid: "dev-001",
      typeDefault: "dimmer",
      protocol: "MQTT",
      model: "dimmer-v1",
      setupCodeHash: await bcrypt.hash(DEVICE_SETUP, 10),
      status: "FACTORY_NEW",
      modelId: "DIMMER_V1",
    },
  });

  await prisma.deviceInventory.upsert({
    where: { serial: ZB_DEVICE_SERIAL },
    update: {
      deviceUuid: "dev-zb-001",
      typeDefault: "sensor",
      protocol: "ZIGBEE",
      model: "th-sensor-v1",
      modelId: "TH_SENSOR_V1",
    },
    create: {
      serial: ZB_DEVICE_SERIAL,
      deviceUuid: "dev-zb-001",
      typeDefault: "sensor",
      protocol: "ZIGBEE",
      model: "th-sensor-v1",
      setupCodeHash: await bcrypt.hash(ZB_DEVICE_SETUP, 10),
      status: "FACTORY_NEW",
      modelId: "TH_SENSOR_V1",
    },
  });

  await prisma.deviceInventory.upsert({
    where: { serial: ZB_GATE_SERIAL },
    update: {
      deviceUuid: "dev-zb-gate-001",
      typeDefault: "relay",
      protocol: "ZIGBEE",
      model: "gate-pir-v1",
      modelId: "GATE_PIR_V1",
    },
    create: {
      serial: ZB_GATE_SERIAL,
      deviceUuid: "dev-zb-gate-001",
      typeDefault: "relay",
      protocol: "ZIGBEE",
      model: "gate-pir-v1",
      setupCodeHash: await bcrypt.hash(ZB_GATE_SETUP, 10),
      status: "FACTORY_NEW",
      modelId: "GATE_PIR_V1",
    },
  });

  await prisma.deviceInventory.upsert({
    where: { serial: ZB_LOCK_SERIAL },
    update: {
      deviceUuid: "dev-zb-lock-001",
      typeDefault: "relay",
      protocol: "ZIGBEE",
      model: "lock-v2-dualmcu",
      modelId: "LOCK_V2_DUALMCU",
    },
    create: {
      serial: ZB_LOCK_SERIAL,
      deviceUuid: "dev-zb-lock-001",
      typeDefault: "relay",
      protocol: "ZIGBEE",
      model: "lock-v2-dualmcu",
      setupCodeHash: await bcrypt.hash(ZB_LOCK_SETUP, 10),
      status: "FACTORY_NEW",
      modelId: "LOCK_V2_DUALMCU",
    },
  });

  // Ensure current state row exists for demo device
  const demoDevice = await prisma.device.findUnique({ where: { deviceId: "dev-001" }, select: { id: true } });
  if (demoDevice) {
    await prisma.deviceStateCurrent.upsert({
      where: { deviceId: demoDevice.id },
      update: {},
      create: {
        deviceId: demoDevice.id,
        state: { pwm: 0 },
        online: false,
      },
    });
  }

  console.log("Seed complete:");
  console.log(`- User: ${demoEmail} / ${demoPassword}`);
  console.log(`- Admin: ${adminEmail} / ${adminPassword}`);
  console.log(`- Home: id=${home.id} name=${home.name}`);

  console.log("\nTest inventory credentials (Sprint 1):");
  console.table([
    { kind: "hub", hubSerial: HUB_SERIAL, setupCode: HUB_SETUP, modelId: "HUB_V1" },
    { kind: "device", deviceSerial: DEVICE_SERIAL, setupCode: DEVICE_SETUP, modelId: "DIMMER_V1" },
    { kind: "zigbee_device", deviceSerial: ZB_DEVICE_SERIAL, setupCode: ZB_DEVICE_SETUP, modelId: "TH_SENSOR_V1" },
    { kind: "zigbee_device", deviceSerial: ZB_GATE_SERIAL, setupCode: ZB_GATE_SETUP, modelId: "GATE_PIR_V1" },
    { kind: "zigbee_device", deviceSerial: ZB_LOCK_SERIAL, setupCode: ZB_LOCK_SETUP, modelId: "LOCK_V2_DUALMCU" },
  ]);

  console.log("\nUseful topics:");
  console.log(`- Device MQTT: home/${home.id}/device/dev-001/*`);
  console.log(`- Hub status:  home/hub/hub-demo/status`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });