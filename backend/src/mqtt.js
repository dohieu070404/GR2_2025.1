import mqtt from "mqtt";
import crypto from "crypto";
import { prisma } from "./prisma.js";
import { emitToHome } from "./sse.js";
import { normalizeIeee, suggestModelsByFingerprint, guessDeviceTypeFromModelId } from "./zigbee.js";
import { handleAutomationSyncResult } from "./automation.js";

function nowIso() {
  return new Date().toISOString();
}

function log(level, msg, extra) {
  const base = `[MQTT] ${msg}`;
  if (!extra) {
    // eslint-disable-next-line no-console
    console[level](base);
    return;
  }
  // eslint-disable-next-line no-console
  console[level](base, extra);
}

function getEnv(name, fallback) {
  const v = process.env[name];
  return v == null || v === "" ? fallback : v;
}

function parseMqttUrl(url) {
  try {
    const u = new URL(url);
    const tls = u.protocol === "mqtts:" || u.protocol === "wss:";
    const host = u.hostname;
    const port = u.port ? Number(u.port) : tls ? 8883 : 1883;
    return { ok: true, host, port, tls };
  } catch {
    return { ok: false, host: null, port: null, tls: false };
  }
}

export function topicPrefixForDevice({ homeId, deviceId }) {
  return `home/${homeId}/device/${deviceId}`;
}

export function topicPrefixForHub(hubId) {
  return `home/hub/${hubId}`;
}

export function publishCommand(client, { homeId, deviceId, cmdId, payload }) {
  const topic = `${topicPrefixForDevice({ homeId, deviceId })}/set`;
  const body = {
    cmdId,
    ts: Date.now(),
    payload,
  };

  client.publish(topic, JSON.stringify(body), { qos: 1 }, (err) => {
    if (err) log("warn", `publish failed topic=${topic}`, { err: err?.message || String(err) });
  });
}

export function publishMgmtCommand(client, { homeId, deviceId, cmdId, action, reason }) {
  publishCommand(client, {
    homeId,
    deviceId,
    cmdId,
    payload: {
      mgmt: {
        action,
        reason: reason ?? null,
      },
    },
  });
}

function safeJsonParse(buf) {
  const text = buf?.toString?.("utf8") ?? "";
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err, text };
  }
}

function parseDeviceTopic(topic) {
  // home/<homeId>/device/<deviceId>/<channel>
  const parts = topic.split("/");
  if (parts.length < 5) return null;
  if (parts[0] !== "home") return null;
  const homeId = Number(parts[1]);
  if (!Number.isInteger(homeId) || homeId <= 0) return null;
  if (parts[2] !== "device") return null;
  const deviceId = parts[3];
  const channel = parts[4];
  return { homeId, deviceId, channel };
}

function parseHubTopic(topic) {
  // home/hub/<hubId>/<channel...>
  const parts = topic.split("/");
  if (parts.length < 4) return null;
  if (parts[0] !== "home" || parts[1] !== "hub") return null;
  const hubId = parts[2];
  const rest = parts.slice(3); // e.g. ["status"] or ["zigbee","discovered"]
  return { hubId, rest };
}


function parseZigbeePlaneTopic(topic) {
  // home/zb/<ieee>/{state|event|cmd_result}
  const parts = topic.split("/");
  if (parts.length < 4) return null;
  if (parts[0] !== "home" || parts[1] !== "zb") return null;
  const ieee = normalizeIeee(parts[2]);
  if (!ieee) return null;
  const channel = parts[3];
  if (!["state", "event", "cmd_result"].includes(channel)) return null;
  return { ieee, channel };
}

async function ensureDeviceActive(deviceDbId) {
  // If this device is bound and we received traffic, it is effectively ACTIVE.
  await prisma.device
    .updateMany({
      where: {
        id: deviceDbId,
        lifecycleStatus: { in: ["FACTORY_NEW", "CLAIMING", "BOUND"] },
      },
      data: { lifecycleStatus: "ACTIVE" },
    })
    .catch(() => {});
}

async function handleStateMessage({ homeId, deviceId }, payloadObj) {
  const now = new Date();
  const ts = payloadObj?.ts ?? null;
  let state = payloadObj?.state;
  if (state === undefined) {
    if (payloadObj && typeof payloadObj === "object") {
      const { ts: _ts, ...rest } = payloadObj;
      state = rest;
    } else {
      state = payloadObj;
    }
  }

  const device = await prisma.device.findFirst({
    where: { homeId, deviceId },
    select: { id: true, homeId: true, deviceId: true },
  });
  if (!device) return;

  const current = await prisma.deviceStateCurrent.findUnique({
    where: { deviceId: device.id },
    select: { state: true, firstSeenAt: true },
  });
  const prevStateJson = current?.state ? JSON.stringify(current.state) : null;
  const newStateJson = JSON.stringify(state);

  const updateData = { state, lastSeen: now, online: true };
  if (!current?.firstSeenAt) {
    updateData.firstSeenAt = now;
    updateData.everOnline = true;
  }

  await prisma.deviceStateCurrent.upsert({
    where: { deviceId: device.id },
    update: updateData,
    create: {
      deviceId: device.id,
      state,
      lastSeen: now,
      online: true,
      firstSeenAt: now,
      everOnline: true,
    },
  });

  if (prevStateJson !== newStateJson) {
    await prisma.deviceStateHistory.create({
      data: { deviceId: device.id, state, online: true, lastSeen: now },
    });
  }

  await ensureDeviceActive(device.id);

  emitToHome(device.homeId, "device_state_updated", {
    homeId: device.homeId,
    deviceDbId: device.id,
    deviceId: device.deviceId,
    ts,
    state,
    updatedAt: now.toISOString(),
  });
}

async function handleStatusMessage({ homeId, deviceId }, raw) {
  const now = new Date();

  let online = null;
  const parsed = safeJsonParse(raw);
  if (parsed.ok && parsed.value && typeof parsed.value === "object") {
    if (typeof parsed.value.online === "boolean") online = parsed.value.online;
    if (typeof parsed.value.status === "string") online = parsed.value.status.toLowerCase() === "online";
  }
  if (online === null) {
    const s = (raw?.toString?.("utf8") ?? "").trim().toLowerCase();
    if (s === "online" || s === "1" || s === "true") online = true;
    else if (s === "offline" || s === "0" || s === "false") online = false;
  }
  if (online === null) return;

  const device = await prisma.device.findFirst({
    where: { homeId, deviceId },
    select: { id: true, homeId: true, deviceId: true },
  });
  if (!device) return;

  const current = await prisma.deviceStateCurrent.findUnique({
    where: { deviceId: device.id },
    select: { online: true, firstSeenAt: true },
  });
  const prevOnline = current?.online;

  const updateData = { online, lastSeen: now };
  if (online && !current?.firstSeenAt) {
    updateData.firstSeenAt = now;
    updateData.everOnline = true;
  }

  await prisma.deviceStateCurrent.upsert({
    where: { deviceId: device.id },
    update: updateData,
    create: {
      deviceId: device.id,
      state: null,
      online,
      lastSeen: now,
      firstSeenAt: online ? now : null,
      everOnline: online ? true : false,
    },
  });

  if (prevOnline === null || prevOnline === undefined || prevOnline !== online) {
    await prisma.deviceStateHistory.create({
      data: { deviceId: device.id, state: null, online, lastSeen: now },
    });
  }

  await ensureDeviceActive(device.id);

  emitToHome(device.homeId, "device_status_changed", {
    homeId: device.homeId,
    deviceDbId: device.id,
    deviceId: device.deviceId,
    online,
    lastSeen: now.toISOString(),
  });
}

async function handleAckMessage({ homeId, deviceId }, payloadObj) {
  const now = new Date();
  const cmdId = payloadObj?.cmdId;
  if (!cmdId || typeof cmdId !== "string") return;
  const ok = Boolean(payloadObj?.ok);
  const error = payloadObj?.error ?? null;

  const device = await prisma.device.findFirst({
    where: { homeId, deviceId },
    select: { id: true, homeId: true, deviceId: true },
  });
  if (!device) return;

  // Update the generic command if it exists.
  const existing = await prisma.command.findUnique({
    where: { deviceId_cmdId: { deviceId: device.id, cmdId } },
    select: { id: true, status: true, sentAt: true },
  });
  if (existing && ["PENDING", "TIMEOUT"].includes(existing.status)) {
    const newStatus = ok ? "ACKED" : "FAILED";
    const errorText = ok ? null : String(error ?? "FAILED");

    await prisma.command.update({
      where: { id: existing.id },
      data: { status: newStatus, ackedAt: now, error: errorText },
    });

    emitToHome(device.homeId, "command_updated", {
      homeId: device.homeId,
      deviceDbId: device.id,
      deviceId: device.deviceId,
      cmdId,
      status: newStatus,
      sentAt: existing.sentAt?.toISOString?.() ?? null,
      ackedAt: now.toISOString(),
      error: errorText,
    });
  }

  // Update ResetRequest if it exists.
  const rr = await prisma.resetRequest
    .findUnique({
      where: { deviceId_cmdId: { deviceId: device.id, cmdId } },
      select: { id: true, status: true },
    })
    .catch(() => null);
  if (rr && ["PENDING", "SENT", "TIMEOUT"].includes(rr.status)) {
    const newStatus = ok ? "ACKED" : "FAILED";
    const errorText = ok ? null : String(error ?? "FAILED");
    await prisma.resetRequest.update({
      where: { id: rr.id },
      data: { status: newStatus, ackedAt: now, error: errorText },
    });

    emitToHome(device.homeId, "reset_request_updated", {
      homeId: device.homeId,
      deviceDbId: device.id,
      deviceId: device.deviceId,
      cmdId,
      status: newStatus,
      ackedAt: now.toISOString(),
      error: errorText,
    });
  }
}

async function handleHubStatus({ hubId }, raw) {
  const parsed = safeJsonParse(raw);
  let online = null;
  let firmwareVersion = null;
  let mac = null;
  let ip = null;
  let rssi = null;

  if (parsed.ok && parsed.value && typeof parsed.value === "object") {
    if (typeof parsed.value.online === "boolean") online = parsed.value.online;
    // Backward/forward compatible keys (firmware field naming changed across hub firmware revisions).
    if (typeof parsed.value.fw === "string") firmwareVersion = parsed.value.fw;
    if (typeof parsed.value.fwVersion === "string") firmwareVersion = parsed.value.fwVersion;
    if (typeof parsed.value.firmwareVersion === "string") firmwareVersion = parsed.value.firmwareVersion;

    // Sprint 6: best-effort hub runtime metadata
    if (typeof parsed.value.mac === "string") mac = parsed.value.mac;
    if (typeof parsed.value.ip === "string") ip = parsed.value.ip;
    if (typeof parsed.value.rssi === "number" && Number.isFinite(parsed.value.rssi)) rssi = Math.round(parsed.value.rssi);
  }
  if (online === null) {
    const s = (raw?.toString?.("utf8") ?? "").trim().toLowerCase();
    if (s === "online") online = true;
    else if (s === "offline") online = false;
  }
  if (online === null) return;

  // Normalize MAC to lowercase colon format (e.g., aa:bb:cc:dd:ee:ff)
  const normalizeMac = (m) => {
    if (!m) return null;
    const hex = String(m)
      .trim()
      .toLowerCase()
      .replace(/[^0-9a-f]/g, "");
    if (hex.length !== 12) return String(m).trim().toLowerCase();
    return hex.match(/../g).join(":");
  };
  const macNorm = normalizeMac(mac);

  const now = new Date();

  // Sprint 9: always upsert HubRuntime, even when unbound (admin can see `unbound` hubs)
  const existingRuntime = await prisma.hubRuntime.findUnique({ where: { hubId }, select: { firstSeenAt: true } });
  const updateData = {
    online,
    lastSeenAt: now,
    fwVersion: firmwareVersion ?? undefined,
    mac: macNorm ?? undefined,
    ip: ip ?? undefined,
    rssi: rssi ?? undefined,
  };
  if (online && !existingRuntime?.firstSeenAt) {
    updateData.firstSeenAt = now;
    updateData.everOnline = true;
  }

  await prisma.hubRuntime.upsert({
    where: { hubId },
    update: updateData,
    create: {
      hubId,
      online,
      lastSeenAt: now,
      fwVersion: firmwareVersion ?? null,
      mac: macNorm ?? null,
      ip: ip ?? null,
      rssi: rssi ?? null,
      firstSeenAt: online ? now : null,
      everOnline: online ? true : false,
    },
  });

  // Update bound hub record (legacy runtime fields live on Hub too)
  const hub = await prisma.hub.findUnique({ where: { hubId }, select: { id: true, homeId: true } });
  if (hub) {
    await prisma.hub.update({
      where: { hubId },
      data: {
        online,
        lastSeen: now,
        firmwareVersion: firmwareVersion ?? undefined,
        mac: macNorm ?? undefined,
        ip: ip ?? undefined,
        rssi: rssi ?? undefined,
      },
    });

    emitToHome(hub.homeId, "hub_status_changed", {
      homeId: hub.homeId,
      hubId,
      online,
      lastSeen: now.toISOString(),
      firmwareVersion: firmwareVersion ?? null,
      mac: macNorm,
      ip,
      rssi,
    });
  }
}

async function handleHubZigbeeVersion({ hubId }, payloadObj) {
  // expected: { ts, fwVersion, buildTime? }
  if (!payloadObj || typeof payloadObj !== "object") return;
  const fwVersion = typeof payloadObj.fwVersion === "string" ? payloadObj.fwVersion.slice(0, 50) : null;
  const buildTime = typeof payloadObj.buildTime === "string" ? payloadObj.buildTime.slice(0, 80) : null;
  if (!fwVersion) return;

  const hub = await prisma.hub.findUnique({ where: { hubId }, select: { homeId: true } });
  if (!hub) return;

  await prisma.hub.update({
    where: { hubId },
    data: {
      coordinatorFirmwareVersion: fwVersion,
      coordinatorBuildTime: buildTime ?? undefined,
    },
  });

  emitToHome(hub.homeId, "hub_zigbee_version", {
    homeId: hub.homeId,
    hubId,
    fwVersion,
    buildTime: buildTime ?? null,
    ts: payloadObj.ts ?? null,
  });
}

async function handleHubOtaCmdResult({ hubId }, payloadObj) {
  // expected: { ts, cmdId, ok, code?, message?, version }
  if (!payloadObj || typeof payloadObj !== "object") return;
  const cmdId = payloadObj.cmdId;
  if (!cmdId || typeof cmdId !== "string") return;
  const ok = Boolean(payloadObj.ok);
  const version = typeof payloadObj.version === "string" ? payloadObj.version.slice(0, 60) : null;
  const code = payloadObj.code != null ? String(payloadObj.code).slice(0, 60) : null;
  const message = payloadObj.message != null ? String(payloadObj.message).slice(0, 500) : null;
  const now = new Date();

  // Find a matching rollout progress by cmdId (unique per attempt).
  const progress = await prisma.firmwareRolloutProgress.findFirst({
    where: {
      hubId,
      cmdId,
      state: { in: ["DOWNLOADING", "APPLYING"] },
    },
    select: { rolloutId: true, hubId: true },
  });

  if (progress) {
    await prisma.firmwareRolloutProgress.update({
      where: { rolloutId_hubId: { rolloutId: progress.rolloutId, hubId: progress.hubId } },
      data: {
        state: ok ? "SUCCESS" : "FAILED",
        ackedAt: now,
        lastMsg: message || code || (ok ? "OK" : "FAILED"),
      },
    });

    // If all targets reached terminal state, mark rollout DONE.
    const all = await prisma.firmwareRolloutProgress.findMany({
      where: { rolloutId: progress.rolloutId },
      select: { state: true, attempt: true },
    });
    const MAX_ATTEMPTS = Number(process.env.OTA_ROLLOUT_MAX_ATTEMPTS || 3);
    const terminal = all.every((p) => p.state === "SUCCESS" || (p.state === "FAILED" && p.attempt >= MAX_ATTEMPTS));
    if (terminal) {
      await prisma.firmwareRollout.update({
        where: { id: progress.rolloutId },
        data: { status: "DONE" },
      });
    }
  }

  // Also expose as diagnostics/SSE for admins (optional)
  const hub = await prisma.hub.findUnique({ where: { hubId }, select: { homeId: true } });
  if (hub) {
    emitToHome(hub.homeId, "hub_ota_result", {
      homeId: hub.homeId,
      hubId,
      cmdId,
      ok,
      version,
      code,
      message,
      ts: payloadObj.ts ?? null,
    });
  }
}

async function handleZigbeeDiscovered({ hubId }, payloadObj) {
  // expected: { token, ieee, shortAddr, manufacturer, model, swBuildId? }
  if (!payloadObj?.token || !payloadObj?.ieee) return;

  const normIeee = normalizeIeee(payloadObj.ieee);
  if (!normIeee) return;

  const session = await prisma.zigbeePairingSession.findUnique({ where: { token: payloadObj.token } });
  if (!session) return;
  if (session.expiresAt && Date.now() > session.expiresAt.getTime()) return;
  if (session.hubId !== hubId) return;

  // Map hubId -> homeId via Hub binding (required for production-style flow)
  const hub = await prisma.hub.findUnique({ where: { hubId }, select: { homeId: true, home: { select: { ownerId: true } } } });
  if (!hub) return;

  const ownerId = hub.home?.ownerId ?? session.ownerId;
  const homeId = hub.homeId;

  const manufacturer = payloadObj.manufacturer ?? null;
  const model = payloadObj.model ?? null;
  const swBuildId = payloadObj.swBuildId ?? null;

  // Suggest ProductModel by fingerprint (best-effort)
  const candidateModels = await prisma.productModel.findMany({
    where: {
      protocol: "ZIGBEE",
      OR: [{ fingerprintManuf: { not: null } }, { fingerprintModel: { not: null } }],
    },
    select: {
      id: true,
      name: true,
      manufacturer: true,
      protocol: true,
      fingerprintManuf: true,
      fingerprintModel: true,
    },
  });
  const suggestions = suggestModelsByFingerprint({ manufacturer, model }, candidateModels);
  const suggestedModelId = suggestions[0]?.modelId ?? null;
  const suggestedType = suggestedModelId ? guessDeviceTypeFromModelId(suggestedModelId) : (payloadObj.suggestedType ?? null);

  await prisma.zigbeeDiscoveredDevice.upsert({
    where: { hubId_ieee: { hubId, ieee: normIeee } },
    update: {
      pairingToken: payloadObj.token,
      shortAddr: payloadObj.shortAddr ?? null,
      model,
      manufacturer,
      swBuildId,
      suggestedModelId,
      suggestedType,
      status: "PENDING",
      homeId,
      ownerId,
    },
    create: {
      ownerId,
      homeId,
      hubId,
      pairingToken: payloadObj.token,
      ieee: normIeee,
      shortAddr: payloadObj.shortAddr ?? null,
      model,
      manufacturer,
      swBuildId,
      suggestedModelId,
      suggestedType,
      status: "PENDING",
    },
  });

  // SERIAL_FIRST: create/update provisional Device (bind IEEE -> DeviceInventory.deviceUuid)
  if (session.mode === "SERIAL_FIRST" && session.claimedSerial) {
    const inv = await prisma.deviceInventory.findUnique({ where: { serial: session.claimedSerial } }).catch(() => null);
    if (inv && inv.protocol === "ZIGBEE" && inv.status === "CLAIMED" && inv.claimedHomeId === homeId) {
      const modelId = inv.modelId || suggestedModelId || null;
      const type = inv.typeDefault || guessDeviceTypeFromModelId(modelId) || "relay";
      const name = inv.model || model || `zigbee-${inv.serial}`;
      const legacyTopicBase = `home/zb/${normIeee}`;

      // If IEEE already belongs to another device, don't override.
      const existing = await prisma.device.findUnique({ where: { zigbeeIeee: normIeee }, select: { deviceId: true } }).catch(() => null);
      if (!existing || existing.deviceId === inv.deviceUuid) {
        const now = new Date();
        const dev = await prisma.device.upsert({
          where: { deviceId: inv.deviceUuid },
          update: {
            homeId,
            name,
            type,
            protocol: "ZIGBEE",
            serial: inv.serial,
            modelId,
            zigbeeIeee: normIeee,
            hubId,
            legacyTopicBase,
            lifecycleStatus: "CLAIMING",
            lastProvisionedAt: now,
          },
          create: {
            name,
            type,
            protocol: "ZIGBEE",
            deviceId: inv.deviceUuid,
            homeId,
            createdById: ownerId,
            serial: inv.serial,
            modelId,
            zigbeeIeee: normIeee,
            hubId,
            legacyTopicBase,
            lifecycleStatus: "CLAIMING",
            lastProvisionedAt: now,
          },
          select: { id: true },
        });

        await prisma.deviceStateCurrent.upsert({
          where: { deviceId: dev.id },
          update: {},
          create: { deviceId: dev.id, state: null, online: false },
        });
      }
    }
  }

  emitToHome(homeId, "zigbee_discovered", {
    homeId,
    hubId,
    ieee: normIeee,
    model,
    manufacturer,
    swBuildId,
    suggestedModelId,
    suggestedType,
    suggestions: suggestions.slice(0, 5),
  });
}


async function findSingleDeviceByZigbeeIeee(ieee) {
  const rows = await prisma.device.findMany({
    where: { zigbeeIeee: ieee },
    select: { id: true, homeId: true, deviceId: true, zigbeeIeee: true },
    take: 2,
  });

  if (rows.length === 1) return rows[0];
  if (rows.length > 1) {
    log("warn", `[ZB] ambiguous zigbeeIeee='${ieee}', matches=${rows.length} (ignored)`);
  }
  return null;
}

function extractStateFromPayload(payloadObj) {
  // Accept both canonical {ts, reported:{...}} and older {relay:true} style
  if (payloadObj && typeof payloadObj === "object") {
    if (payloadObj.reported && typeof payloadObj.reported === "object") return payloadObj.reported;
    if (payloadObj.state !== undefined) return payloadObj.state;
    const { ts: _ts, ...rest } = payloadObj;
    return rest;
  }
  return payloadObj;
}

async function handleZigbeePlaneStateMessage({ ieee }, payloadObj) {
  const device = await findSingleDeviceByZigbeeIeee(ieee);
  if (!device) return;

  const now = new Date();
  const ts = payloadObj?.ts ?? null;
  const state = extractStateFromPayload(payloadObj);

  // Sprint 7: fwVersion tracking for enddevices (reported.fwVersion)
  let fwVersion = null;
  if (state && typeof state === "object") {
    if (typeof state.fwVersion === "string") fwVersion = state.fwVersion;
    else if (typeof state.firmwareVersion === "string") fwVersion = state.firmwareVersion;
  }
  if (fwVersion && typeof fwVersion === "string") {
    const trimmed = fwVersion.slice(0, 50);
    await prisma.device.update({ where: { id: device.id }, data: { firmwareVersion: trimmed } }).catch(() => {});
  }

  const current = await prisma.deviceStateCurrent.findUnique({
    where: { deviceId: device.id },
    select: { state: true, firstSeenAt: true },
  });
  const prevStateJson = current?.state ? JSON.stringify(current.state) : null;
  const newStateJson = JSON.stringify(state);

  await prisma.deviceStateCurrent.upsert({
    where: { deviceId: device.id },
    update: { state, lastSeen: now, online: true, firstSeenAt: current?.firstSeenAt || now, everOnline: true },
    create: { deviceId: device.id, state, lastSeen: now, online: true, firstSeenAt: now, everOnline: true },
  });

  if (prevStateJson !== newStateJson) {
    await prisma.deviceStateHistory.create({
      data: { deviceId: device.id, state, online: true, lastSeen: now },
    });
  }

  if (fwVersion && typeof fwVersion === "string") {
    await prisma.device.update({
      where: { id: device.id },
      data: { firmwareVersion: fwVersion.slice(0, 50) },
    }).catch(() => {});
  }

  await ensureDeviceActive(device.id);

  emitToHome(device.homeId, "device_state_updated", {
    homeId: device.homeId,
    deviceDbId: device.id,
    deviceId: device.deviceId,
    ieee,
    ts,
    state,
    updatedAt: now.toISOString(),
    protocol: "ZIGBEE",
  });
}

async function handleZigbeePlaneEventMessage({ ieee }, payloadObj) {
  const device = await findSingleDeviceByZigbeeIeee(ieee);
  if (!device) return;

  const now = new Date();
  const ts = payloadObj?.ts ?? null;
  const type = payloadObj?.type ?? payloadObj?.eventType ?? payloadObj?.name;

  if (!type || typeof type !== "string") return;

  const data = payloadObj?.data ?? null;
  const sourceAt = typeof ts === "number" && Number.isFinite(ts) ? new Date(ts) : null;

  const created = await prisma.deviceEvent.create({
    data: {
      deviceId: device.id,
      type: type.slice(0, 120),
      data,
      sourceAt,
    },
    select: { id: true, type: true, data: true, createdAt: true, sourceAt: true },
  });

  // Sprint 11: Identify-confirm "claimed" badge
  // Hub publishes: home/zb/<ieee>/event {type:"device.claimed"}
  if (type === "device.claimed") {
    await prisma.device.update({ where: { id: device.id }, data: { claimed: true } }).catch(() => {});
    emitToHome(device.homeId, "device_updated", {
      homeId: device.homeId,
      deviceDbId: device.id,
      deviceId: device.deviceId,
      ieee,
      patch: { claimed: true },
    });
  }

  // Mark device as online when events arrive.
  const prev = await prisma.deviceStateCurrent.findUnique({ where: { deviceId: device.id }, select: { firstSeenAt: true } }).catch(() => null);
  await prisma.deviceStateCurrent.upsert({
    where: { deviceId: device.id },
    update: { lastSeen: now, online: true, firstSeenAt: prev?.firstSeenAt || now, everOnline: true },
    create: { deviceId: device.id, state: null, lastSeen: now, online: true, firstSeenAt: now, everOnline: true },
  });

  await ensureDeviceActive(device.id);

  emitToHome(device.homeId, "device_event_created", {
    homeId: device.homeId,
    deviceDbId: device.id,
    deviceId: device.deviceId,
    ieee,
    event: {
      id: created.id,
      type: created.type,
      data: created.data,
      createdAt: created.createdAt.toISOString(),
      sourceAt: created.sourceAt ? created.sourceAt.toISOString() : null,
    },
  });
}

async function handleZigbeePlaneCmdResultMessage({ ieee }, payloadObj) {
  const device = await findSingleDeviceByZigbeeIeee(ieee);
  if (!device) return;

  const now = new Date();
  const cmdId = payloadObj?.cmdId;
  if (!cmdId || typeof cmdId !== "string") return;

  const ok = Boolean(payloadObj?.ok);
  const error = payloadObj?.error ?? null;

  const existing = await prisma.command.findUnique({
    where: { deviceId_cmdId: { deviceId: device.id, cmdId } },
    // payload is needed for Sprint 5 SmartLock side-effects
    select: { id: true, status: true, sentAt: true, payload: true },
  });

  if (existing && ["PENDING", "TIMEOUT"].includes(existing.status)) {
    const newStatus = ok ? "ACKED" : "FAILED";
    const errorText = ok ? null : String(error ?? "FAILED");

    await prisma.command.update({
      where: { id: existing.id },
      data: { status: newStatus, ackedAt: now, error: errorText },
    });

    emitToHome(device.homeId, "command_updated", {
      homeId: device.homeId,
      deviceDbId: device.id,
      deviceId: device.deviceId,
      ieee,
      cmdId,
      status: newStatus,
      sentAt: existing.sentAt?.toISOString?.() ?? null,
      ackedAt: now.toISOString(),
      error: errorText,
      protocol: "ZIGBEE",
    });
  }

  // Sprint 5: SmartLock credential sync side-effects.
  // When a lock.* credential command succeeds, we update LockCredential + LockSyncState
  // and append an audit event (DeviceEvent type="credential_changed").
  if (ok && existing?.payload && typeof existing.payload === "object") {
    const action = existing.payload?.action;
    const args = existing.payload?.args ?? existing.payload?.params ?? null;

    if (typeof action === "string" && action.startsWith("lock.") && args && typeof args === "object") {
      const slotRaw = args?.slot;
      const slot = Number.isInteger(slotRaw) ? slotRaw : Number.isFinite(Number(slotRaw)) ? Math.floor(Number(slotRaw)) : null;
      const label = args?.label != null ? String(args.label).slice(0, 80) : null;
      const secretHash = args?.secretHash != null ? String(args.secretHash) : null;

      // Only handle the credential mgmt actions in scope.
      const isAddPin = action === "lock.add_pin";
      const isDelPin = action === "lock.delete_pin";
      const isAddRfid = action === "lock.add_rfid";
      const isDelRfid = action === "lock.delete_rfid";

      if ((isAddPin || isDelPin || isAddRfid || isDelRfid) && slot !== null && slot >= 0 && slot <= 255) {
        try {
          const result = await prisma.$transaction(async (tx) => {
            const sync = await tx.lockSyncState.upsert({
              where: { deviceId: device.id },
              update: { version: { increment: 1 } },
              create: { deviceId: device.id, version: 1 },
            });

            const credType = isAddPin || isDelPin ? "PIN" : "RFID";
            if (isAddPin || isAddRfid) {
              if (!secretHash || secretHash.length < 20) {
                // Should not happen, but avoid writing invalid hashes.
                throw new Error("missing secretHash in stored command payload");
              }
              await tx.lockCredential.upsert({
                where: { deviceId_type_slot: { deviceId: device.id, type: credType, slot } },
                update: {
                  label,
                  secretHash,
                  revokedAt: null,
                  syncVersion: sync.version,
                },
                create: {
                  deviceId: device.id,
                  type: credType,
                  slot,
                  label,
                  secretHash,
                  revokedAt: null,
                  syncVersion: sync.version,
                },
              });
            } else {
              // delete => mark revoked (best-effort)
              await tx.lockCredential.updateMany({
                where: { deviceId: device.id, type: credType, slot, revokedAt: null },
                data: { revokedAt: now, syncVersion: sync.version },
              });
            }

            const created = await tx.deviceEvent.create({
              data: {
                deviceId: device.id,
                type: "credential_changed",
                data: {
                  action,
                  credType,
                  slot,
                  label,
                  version: sync.version,
                  cmdId,
                },
              },
              select: { id: true, type: true, data: true, createdAt: true, sourceAt: true },
            });

            return { sync, event: created };
          });

          emitToHome(device.homeId, "device_event_created", {
            homeId: device.homeId,
            deviceDbId: device.id,
            deviceId: device.deviceId,
            ieee,
            event: {
              id: result.event.id,
              type: result.event.type,
              data: result.event.data,
              createdAt: result.event.createdAt.toISOString(),
              sourceAt: result.event.sourceAt ? result.event.sourceAt.toISOString() : null,
            },
          });
        } catch (e) {
          log("warn", `[ZB] lock credential side-effect failed action=${action}`, { err: e?.message || String(e) });
        }
      }
    }
  }

  // Mark device as online when cmd_result arrives.
  const prev = await prisma.deviceStateCurrent.findUnique({ where: { deviceId: device.id }, select: { firstSeenAt: true } }).catch(() => null);
  await prisma.deviceStateCurrent.upsert({
    where: { deviceId: device.id },
    update: { lastSeen: now, online: true, firstSeenAt: prev?.firstSeenAt || now, everOnline: true },
    create: { deviceId: device.id, state: null, lastSeen: now, online: true, firstSeenAt: now, everOnline: true },
  });

  await ensureDeviceActive(device.id);
}

async function handleLegacyStateMessage(topic, raw) {
  // Legacy: <legacyTopicBase>/state
  const suffix = "/state";
  if (!topic.endsWith(suffix)) return;
  const legacyTopicBase = topic.slice(0, -suffix.length);

  const matches = await prisma.device.findMany({
    where: { legacyTopicBase },
    select: { id: true, homeId: true, deviceId: true },
  });
  if (matches.length !== 1) {
    if (matches.length > 1) {
      log("warn", `[LEGACY] ambiguous legacyTopicBase='${legacyTopicBase}', matches=${matches.length} (ignored)`);
    }
    return;
  }

  const device = matches[0];
  const now = new Date();
  const parsed = safeJsonParse(raw);
  if (!parsed.ok) {
    log("warn", "[LEGACY] invalid JSON", { topic });
    return;
  }

  const obj = parsed.value;
  const ts = obj?.ts ?? null;
  let state = obj?.state;
  if (state === undefined) {
    if (obj && typeof obj === "object") {
      const { ts: _ts, ...rest } = obj;
      state = rest;
    } else {
      state = obj;
    }
  }

  const current = await prisma.deviceStateCurrent.findUnique({
    where: { deviceId: device.id },
    select: { state: true },
  });
  const prevStateJson = current?.state ? JSON.stringify(current.state) : null;
  const newStateJson = JSON.stringify(state);

  await prisma.deviceStateCurrent.upsert({
    where: { deviceId: device.id },
    update: { state, lastSeen: now, online: true },
    create: { deviceId: device.id, state, lastSeen: now, online: true },
  });

  if (prevStateJson !== newStateJson) {
    await prisma.deviceStateHistory.create({
      data: { deviceId: device.id, state, online: true, lastSeen: now },
    });
  }

  emitToHome(device.homeId, "device_state_updated", {
    homeId: device.homeId,
    deviceDbId: device.id,
    deviceId: device.deviceId,
    ts,
    state,
    updatedAt: now.toISOString(),
    legacyTopicBase,
  });
}

async function subscribeLegacyDeviceStates(client) {
  const rows = await prisma.device.findMany({
    where: { legacyTopicBase: { not: null } },
    select: { legacyTopicBase: true },
  });
  const unique = new Set(rows.map((r) => r.legacyTopicBase).filter(Boolean));
  for (const base of unique) {
    client.subscribe(`${base}/state`, { qos: 0 }, (err) => {
      if (err) log("warn", "subscribe legacy state failed", { base, err: err?.message || String(err) });
    });
  }
}

export function subscribeIngestTopics(client) {
  // Device topics
  client.subscribe("home/+/device/+/state", { qos: 0 }, (err) => err && log("warn", "subscribe state failed", err));
  client.subscribe("home/+/device/+/status", { qos: 0 }, (err) => err && log("warn", "subscribe status failed", err));
  client.subscribe("home/+/device/+/ack", { qos: 0 }, (err) => err && log("warn", "subscribe ack failed", err));

  // Hub topics
  client.subscribe("home/hub/+/status", { qos: 0 }, (err) => err && log("warn", "subscribe hub status failed", err));
  client.subscribe("home/hub/+/zigbee/discovered", { qos: 0 }, (err) => err && log("warn", "subscribe zigbee discovered failed", err));
  // Sprint 7: Hub OTA + Zigbee coordinator fwVersion
  client.subscribe("home/hub/+/ota/cmd_result", { qos: 0 }, (err) => err && log("warn", "subscribe hub ota cmd_result failed", err));
  client.subscribe("home/hub/+/zigbee/version", { qos: 0 }, (err) => err && log("warn", "subscribe hub zigbee version failed", err));

  // Sprint 8: Automation rules sync_result ingest
  client.subscribe("home/hub/+/automation/sync_result", { qos: 0 }, (err) => err && log("warn", "subscribe hub automation sync_result failed", err));

  // Zigbee data plane (Sprint 3)
  client.subscribe("home/zb/+/state", { qos: 0 }, (err) => err && log("warn", "subscribe zb state failed", err));
  client.subscribe("home/zb/+/event", { qos: 0 }, (err) => err && log("warn", "subscribe zb event failed", err));
  client.subscribe("home/zb/+/cmd_result", { qos: 0 }, (err) => err && log("warn", "subscribe zb cmd_result failed", err));

  // Diagnostics
  client.subscribe("diagnostics/#", { qos: 0 }, (err) => err && log("warn", "subscribe diagnostics failed", err));
}

export function connectMqttClient() {
  const url = getEnv("MQTT_URL", "mqtt://localhost:1883");
  const clientId = getEnv("MQTT_CLIENT_ID", `smarthome-backend-${crypto.randomUUID().slice(0, 8)}`);
  const username = getEnv("MQTT_USERNAME", "");
  const password = getEnv("MQTT_PASSWORD", "");

  const opts = {
    clientId,
    clean: true,
    keepalive: 30,
    reconnectPeriod: 0, // we handle backoff manually
    connectTimeout: 10_000,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    will: {
      topic: "diagnostics/backend/status",
      payload: JSON.stringify({ online: false, ts: Date.now(), clientId }),
      qos: 0,
      retain: false,
    },
  };

  const client = mqtt.connect(url, opts);

  const state = {
    url,
    clientId,
    connected: false,
    lastConnectAt: null,
    reconnectCount: 0,
    lastError: null,
    nextReconnectAt: null,
    backoffMs: 1000,
    lastEventAt: nowIso(),
  };

  const backoffMax = 30_000;
  let reconnectTimer = null;

  function scheduleReconnect(reason) {
    if (reconnectTimer) return;
    const jitter = Math.floor(Math.random() * 250);
    const waitMs = Math.min(backoffMax, state.backoffMs) + jitter;
    state.nextReconnectAt = new Date(Date.now() + waitMs).toISOString();
    state.lastEventAt = nowIso();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      try {
        state.reconnectCount += 1;
        state.backoffMs = Math.min(backoffMax, Math.floor(state.backoffMs * 1.8));
        client.reconnect();
      } catch (err) {
        state.lastError = err?.message || String(err);
        scheduleReconnect("reconnect-exception");
      }
    }, waitMs);
    reconnectTimer.unref?.();
    log("warn", `scheduled reconnect in ${waitMs}ms`, { reason });
  }

  client.on("connect", async () => {
    state.connected = true;
    state.lastConnectAt = nowIso();
    state.lastError = null;
    state.backoffMs = 1000;
    state.nextReconnectAt = null;
    state.lastEventAt = nowIso();
    log("log", `connected url=${url} clientId=${clientId}`);

    // announce backend presence (best-effort)
    client.publish("diagnostics/backend/status", JSON.stringify({ online: true, ts: Date.now(), clientId }), { qos: 0 }, () => {});

    subscribeIngestTopics(client);

    try {
      await subscribeLegacyDeviceStates(client);
    } catch (err) {
      log("warn", "subscribe legacy topics failed", { err: err?.message || String(err) });
    }
  });

  client.on("reconnect", () => {
    state.lastEventAt = nowIso();
    log("warn", "reconnect event");
  });

  client.on("close", () => {
    if (state.connected) log("warn", "connection closed");
    state.connected = false;
    state.lastEventAt = nowIso();
    scheduleReconnect("close");
  });

  client.on("offline", () => {
    state.connected = false;
    state.lastEventAt = nowIso();
    log("warn", "offline");
    scheduleReconnect("offline");
  });

  client.on("error", (err) => {
    state.connected = false;
    state.lastError = err?.message || String(err);
    state.lastEventAt = nowIso();

    // Helpful hint for common auth failures
    const msg = String(state.lastError || "");
    if (msg.toLowerCase().includes("not authorized") || msg.toLowerCase().includes("authorization")) {
      log("error", "Not authorized: check MQTT_USERNAME/MQTT_PASSWORD and mosquitto passwordfile/acl.");
    } else {
      log("error", "error", { err: state.lastError });
    }
    scheduleReconnect("error");
  });

  client.on("message", async (topic, message) => {
    try {
      // Diagnostics: let tests listen for these
      if (topic.startsWith("diagnostics/")) {
        // no-op
        return;
      }

      const devParsed = parseDeviceTopic(topic);
      if (devParsed) {
        if (devParsed.channel === "state") {
          const pj = safeJsonParse(message);
          if (!pj.ok) return;
          await handleStateMessage(devParsed, pj.value);
          return;
        }
        if (devParsed.channel === "status") {
          await handleStatusMessage(devParsed, message);
          return;
        }
        if (devParsed.channel === "ack") {
          const pj = safeJsonParse(message);
          if (!pj.ok) return;
          await handleAckMessage(devParsed, pj.value);
          return;
        }
        return;
      }

      const hubParsed = parseHubTopic(topic);
      if (hubParsed) {
        if (hubParsed.rest.length === 1 && hubParsed.rest[0] === "status") {
          await handleHubStatus(hubParsed, message);
          return;
        }
        if (hubParsed.rest.length === 2 && hubParsed.rest[0] === "zigbee" && hubParsed.rest[1] === "discovered") {
          const pj = safeJsonParse(message);
          if (!pj.ok) return;
          await handleZigbeeDiscovered(hubParsed, pj.value);
          return;
        }
        if (hubParsed.rest.length === 2 && hubParsed.rest[0] === "zigbee" && hubParsed.rest[1] === "version") {
          const pj = safeJsonParse(message);
          if (!pj.ok) return;
          await handleHubZigbeeVersion(hubParsed, pj.value);
          return;
        }
        if (hubParsed.rest.length === 2 && hubParsed.rest[0] === "ota" && hubParsed.rest[1] === "cmd_result") {
          const pj = safeJsonParse(message);
          if (!pj.ok) return;
          await handleHubOtaCmdResult(hubParsed, pj.value);
          return;
        }
        if (hubParsed.rest.length === 2 && hubParsed.rest[0] === "automation" && hubParsed.rest[1] === "sync_result") {
          const pj = safeJsonParse(message);
          if (!pj.ok) return;
          await handleAutomationSyncResult(prisma, { hubId: hubParsed.hubId, payload: pj.value });
          // Optional: push SSE to home for admin-web dashboards.
          const hub = await prisma.hub.findUnique({ where: { hubId: hubParsed.hubId }, select: { homeId: true } }).catch(() => null);
          if (hub?.homeId) {
            emitToHome(hub.homeId, "automation_sync_result", { hubId: hubParsed.hubId, payload: pj.value });
          }
          return;
        }
      }

      const zbParsed = parseZigbeePlaneTopic(topic);
      if (zbParsed) {
        const pj = safeJsonParse(message);
        if (!pj.ok) return;

        if (zbParsed.channel === "state") {
          await handleZigbeePlaneStateMessage(zbParsed, pj.value);
          return;
        }
        if (zbParsed.channel === "event") {
          await handleZigbeePlaneEventMessage(zbParsed, pj.value);
          return;
        }
        if (zbParsed.channel === "cmd_result") {
          await handleZigbeePlaneCmdResultMessage(zbParsed, pj.value);
          return;
        }
      }


      // Legacy
      await handleLegacyStateMessage(topic, message);
    } catch (err) {
      log("warn", "message handler failed", { topic, err: err?.message || String(err) });
    }
  });

  async function mqttRoundtripTest({ timeoutMs = 4000 } = {}) {
    const nonce = crypto.randomUUID();
    const topic = `diagnostics/roundtrip/${nonce}`;
    const payload = { nonce, ts: Date.now() };
    if (!client.connected) {
      return { ok: false, error: "MQTT client not connected" };
    }

    let timer = null;
    const started = Date.now();

    return await new Promise((resolve) => {
      const onMsg = (t, msg) => {
        if (t !== topic) return;
        const pj = safeJsonParse(msg);
        if (!pj.ok) return;
        if (pj.value?.nonce !== nonce) return;
        cleanup();
        resolve({ ok: true, latencyMs: Date.now() - started, topic });
      };

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        client.off("message", onMsg);
        client.unsubscribe(topic, () => {});
      };

      timer = setTimeout(() => {
        cleanup();
        resolve({ ok: false, error: `TIMEOUT after ${timeoutMs}ms`, topic });
      }, timeoutMs);

      client.on("message", onMsg);

      client.subscribe(topic, { qos: 0 }, (err) => {
        if (err) {
          cleanup();
          resolve({ ok: false, error: err?.message || String(err), topic });
          return;
        }
        client.publish(topic, JSON.stringify(payload), { qos: 0 }, (err2) => {
          if (err2) {
            cleanup();
            resolve({ ok: false, error: err2?.message || String(err2), topic });
          }
        });
      });
    });
  }

  function getDiagnosticsState() {
    const u = parseMqttUrl(state.url);
    return {
      ...state,
      broker: {
        url: state.url,
        host: u.ok ? u.host : null,
        port: u.ok ? u.port : null,
        tls: u.ok ? u.tls : null,
        username: username || null,
      },
    };
  }

  return { client, state, mqttRoundtripTest, getDiagnosticsState };
}

export function createMqttClient() {
  // Backward compatibility: return just the client.
  return connectMqttClient().client;
}
