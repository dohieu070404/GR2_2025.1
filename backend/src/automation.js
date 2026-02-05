import crypto from "crypto";

function mqttPublishAsync(client, topic, payload, opts = {}) {
  return new Promise((resolve) => {
    client.publish(topic, payload, opts, (err) => {
      if (err) return resolve({ ok: false, error: err?.message || String(err) });
      resolve({ ok: true });
    });
  });
}

function asInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function normalizeIeeeLike(v) {
  const s = (v ?? "").toString().trim().toLowerCase();
  if (!s) return null;
  // accept "0x..." or raw hex; keep as-is except strip 0x
  const cleaned = s.startsWith("0x") ? s.slice(2) : s;
  if (!/^[0-9a-f]{4,64}$/.test(cleaned)) return null;
  return cleaned;
}

function pickDataMatch(obj) {
  if (!obj) return null;
  if (typeof obj !== "object") return null;
  return obj;
}

function compileTrigger(trigger, deviceById) {
  if (!trigger || typeof trigger !== "object") return null;

  const trig = { ...trigger };
  const eventType = trig.eventType || trig.type || trig.name;
  if (typeof eventType !== "string" || !eventType) return null;

  // Prefer ieee (already-compiled)
  const ieeeIn = normalizeIeeeLike(trig.ieee || trig.deviceIeee);
  if (ieeeIn) {
    return {
      source: "ZIGBEE",
      ieee: ieeeIn,
      eventType,
      dataMatch: pickDataMatch(trig.dataMatch) || null,
    };
  }

  const devId = asInt(trig.deviceId);
  if (!devId) return null;
  const dev = deviceById.get(devId);
  if (!dev) return null;

  if (dev.protocol === "ZIGBEE") {
    const ieee = normalizeIeeeLike(dev.zigbeeIeee);
    if (!ieee) return null;
    return {
      source: "ZIGBEE",
      ieee,
      eventType,
      dataMatch: pickDataMatch(trig.dataMatch) || null,
    };
  }

  // MQTT triggers are not in Sprint 8 scope (hub rule engine focuses on Zigbee plane).
  // Keep a compiled shape for future, but hub may ignore.
  return {
    source: "MQTT",
    deviceId: dev.deviceId,
    eventType,
    dataMatch: pickDataMatch(trig.dataMatch) || null,
  };
}

function compileActions(actions, deviceById) {
  if (!Array.isArray(actions)) return null;
  const out = [];
  for (const a of actions) {
    if (!a || typeof a !== "object") continue;
    const action = a.action;
    if (typeof action !== "string" || !action) continue;

    const params = a.params ?? a.args ?? null;

    const ieeeIn = normalizeIeeeLike(a.ieee || a.deviceIeee);
    if (ieeeIn) {
      out.push({ kind: "ZIGBEE", ieee: ieeeIn, action, params });
      continue;
    }

    const devId = asInt(a.deviceId);
    if (!devId) continue;
    const dev = deviceById.get(devId);
    if (!dev) continue;

    if (dev.protocol === "ZIGBEE") {
      const ieee = normalizeIeeeLike(dev.zigbeeIeee);
      if (!ieee) continue;
      out.push({ kind: "ZIGBEE", ieee, action, params });
    } else {
      out.push({ kind: "MQTT", deviceId: dev.deviceId, action, params });
    }
  }
  return out;
}

export async function compileAutomationRulesForHome(prisma, homeId) {
  const rules = await prisma.automationRule.findMany({
    where: { homeId },
    orderBy: { id: "asc" },
    select: {
      id: true,
      name: true,
      enabled: true,
      version: true,
      triggerType: true,
      trigger: true,
      actions: true,
      executionPolicy: true,
      updatedAt: true,
    },
  });

  // Collect referenced devices for mapping.
  const deviceIds = new Set();
  for (const r of rules) {
    const t = r.trigger;
    if (t && typeof t === "object" && t.deviceId != null) {
      const n = asInt(t.deviceId);
      if (n) deviceIds.add(n);
    }
    const acts = r.actions;
    if (Array.isArray(acts)) {
      for (const a of acts) {
        if (a && typeof a === "object" && a.deviceId != null) {
          const n = asInt(a.deviceId);
          if (n) deviceIds.add(n);
        }
      }
    }
  }

  const devices = deviceIds.size
    ? await prisma.device.findMany({
        where: { id: { in: Array.from(deviceIds) } },
        select: { id: true, homeId: true, protocol: true, zigbeeIeee: true, deviceId: true },
      })
    : [];

  const deviceById = new Map();
  for (const d of devices) deviceById.set(d.id, d);

  const compiled = [];
  const errors = [];

  for (const r of rules) {
    const trig = compileTrigger(r.trigger, deviceById);
    const acts = compileActions(r.actions, deviceById);

    if (!trig || !acts || acts.length === 0) {
      errors.push({ ruleId: r.id, reason: "invalid trigger/actions" });
      continue;
    }

    compiled.push({
      id: r.id,
      name: r.name,
      enabled: !!r.enabled,
      version: r.version,
      triggerType: r.triggerType,
      trigger: trig,
      actions: acts,
      executionPolicy: r.executionPolicy ?? null,
      updatedAt: r.updatedAt.toISOString(),
    });
  }

  return { rules: compiled, errors };
}

export async function bumpAutomationVersionAndMarkDeployments(prisma, homeId, hubs, reason = "changed") {
  // Compute a single monotonic version per home.
  const [aggRules, aggDeploy] = await Promise.all([
    prisma.automationRule.aggregate({ where: { homeId }, _max: { version: true } }),
    prisma.automationDeployment.aggregate({ where: { homeId }, _max: { desiredVersion: true, appliedVersion: true } }),
  ]);

  const maxRuleV = aggRules?._max?.version ?? 0;
  const maxDeployDesired = aggDeploy?._max?.desiredVersion ?? 0;
  const maxDeployApplied = aggDeploy?._max?.appliedVersion ?? 0;
  const maxDeployV = Math.max(maxDeployDesired, maxDeployApplied, 0);
  const newVersion = Math.max(maxRuleV, maxDeployV, 0) + 1;

  // Stamp all rules with the latest home version (helps audits/debug).
  await prisma.automationRule.updateMany({ where: { homeId }, data: { version: newVersion } }).catch(() => {});

  for (const h of hubs) {
    await prisma.automationDeployment.upsert({
      where: { hubId_homeId: { hubId: h.hubId, homeId } },
      update: {
        desiredVersion: newVersion,
        status: "SYNCING",
        lastMsg: `QUEUED v=${newVersion} reason=${reason}`,
      },
      create: {
        hubId: h.hubId,
        homeId,
        desiredVersion: newVersion,
        appliedVersion: 0,
        status: "SYNCING",
        lastMsg: `QUEUED v=${newVersion} reason=${reason}`,
      },
    });
  }

  return newVersion;
}

export async function enqueueAutomationSync(prisma, mqttClient, { homeId, reason = "changed" } = {}) {
  const hubs = await prisma.hub.findMany({ where: { homeId }, select: { hubId: true, online: true } });
  if (!hubs.length) {
    return { ok: false, homeId, version: null, hubs: [], error: "No hub bound to this home" };
  }

  // DB: bump version + mark deployments SYNCING.
  const version = await bumpAutomationVersionAndMarkDeployments(prisma, homeId, hubs, reason);

  const compiled = await compileAutomationRulesForHome(prisma, homeId);

  const results = [];
  for (const h of hubs) {
    const cmdId = crypto.randomUUID();
    const topic = `home/hub/${h.hubId}/automation/sync`;
    const payload = {
      cmdId,
      homeId,
      version,
      rules: compiled.rules,
    };

    await prisma.automationDeployment
      .update({
        where: { hubId_homeId: { hubId: h.hubId, homeId } },
        data: { lastMsg: `SENT v=${version} cmdId=${cmdId} rules=${compiled.rules.length} errors=${compiled.errors.length}` },
      })
      .catch(() => {});

    const pub = await mqttPublishAsync(mqttClient, topic, JSON.stringify(payload), { qos: 1 });
    if (!pub.ok) {
      await prisma.automationDeployment
        .update({
          where: { hubId_homeId: { hubId: h.hubId, homeId } },
          data: { status: "FAILED", lastMsg: `PUBLISH_FAILED v=${version} cmdId=${cmdId} err=${pub.error}` },
        })
        .catch(() => {});
    }

    results.push({ hubId: h.hubId, topic, cmdId, ok: pub.ok, error: pub.ok ? null : pub.error });
  }

  return { ok: true, homeId, version, hubs: results, compiledErrors: compiled.errors };
}

export async function handleAutomationSyncResult(prisma, { hubId, payload }) {
  const cmdId = payload?.cmdId;
  const ok = Boolean(payload?.ok);
  const appliedVersionRaw = payload?.appliedVersion ?? payload?.version;
  const appliedVersion = Number.isFinite(Number(appliedVersionRaw)) ? Number(appliedVersionRaw) : null;
  const message = payload?.message ?? payload?.lastMsg ?? payload?.error ?? null;

  const hub = await prisma.hub.findUnique({ where: { hubId }, select: { homeId: true } });
  if (!hub) return { ok: false, error: "Hub not found" };

  const homeId = hub.homeId;

  // Upsert deployment row.
  const data = {
    appliedVersion: appliedVersion ?? undefined,
    status: ok ? "APPLIED" : "FAILED",
    lastMsg: `${ok ? "OK" : "FAILED"} cmdId=${cmdId ?? ""} v=${appliedVersion ?? ""} msg=${message ?? ""}`.slice(0, 1900),
  };

  await prisma.automationDeployment
    .upsert({
      where: { hubId_homeId: { hubId, homeId } },
      update: data,
      create: {
        hubId,
        homeId,
        desiredVersion: appliedVersion ?? 0,
        appliedVersion: appliedVersion ?? 0,
        status: ok ? "APPLIED" : "FAILED",
        lastMsg: data.lastMsg,
      },
    })
    .catch(() => {});

  return { ok: true, homeId, hubId, appliedVersion, cmdId, status: ok ? "APPLIED" : "FAILED" };
}
