import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { prisma } from "./prisma.js";
import { authRequired } from "./middleware/auth.js";
import { adminRequired } from "./middleware/admin.js";
import {
  registerSchema,
  loginSchema,
  deviceCreateSchema,
  deviceUpdateSchema,
  homeCreateSchema,
  roomCreateSchema,
  adminInventoryDeviceSchema,
  adminInventoryHubSchema,
  adminInventoryHubManualSchema,
  productModelCreateSchema,
  hubClaimSchema,
  hubActivateSchema,
  profileUpdateSchema,
  homeInviteCreateSchema,
  homeInviteAcceptSchema,
  adminMqttClearRetainedSchema,
  deviceClaimSchema,
  zigbeeOpenPairingSchema,
  zigbeePairingConfirmSchema,
  zigbeePairingRejectSchema,
  lockAddPinSchema,
  lockAddRfidSchema,
  firmwareReleaseCreateSchema,
  firmwareRolloutCreateSchema,
  automationCreateSchema,
  automationUpdateSchema,
  validateCommandForType,
} from "./validators.js";
import { connectMqttClient, publishCommand, publishMgmtCommand, topicPrefixForDevice } from "./mqtt.js";
import { startOtaRolloutEngine } from "./otaRollout.js";
import { addSseClient, removeSseClient, emitToHome, getSseStats } from "./sse.js";
import { startCommandTimeoutSweeper, startResetRequestTimeoutSweeper } from "./commandTimeout.js";
import { normalizeIeee, suggestModelsByFingerprint, guessDeviceTypeFromModelId } from "./zigbee.js";
import { enqueueAutomationSync } from "./automation.js";
import { buildDescriptorFromProductModel, buildDescriptorSummaryFromProductModel } from "./descriptor.js";

dotenv.config();

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, "..", "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });

function appendLogLine(filename, obj) {
  try {
    fs.appendFileSync(path.join(LOG_DIR, filename), JSON.stringify(obj) + "\n");
  } catch (e) {
    // never crash on logging
    console.warn("[logger] failed to write log:", e?.message || e);
  }
}

app.use((req, res, next) => {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  res.setHeader("X-Request-Id", requestId);
  res.locals.requestId = requestId;

  res.on("finish", () => {
    appendLogLine("http.log", {
      ts: new Date().toISOString(),
      requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ms: Date.now() - startedAt,
      ip: req.ip,
      ua: req.headers["user-agent"] || null,
    });
  });

  next();
});

// Serve OTA artifacts (static files)
const OTA_DIR = process.env.OTA_DIR || path.join(__dirname, "..", "ota");
app.use("/ota", express.static(OTA_DIR, { etag: true, maxAge: "1h" }));

app.disable("x-powered-by");

// Basic hardening without extra deps.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  next();
});

const CORS_ORIGIN_RAW = (process.env.CORS_ORIGIN || "*").toString();
const CORS_ORIGINS =
  CORS_ORIGIN_RAW === "*"
    ? "*"
    : CORS_ORIGIN_RAW.split(",").map((s) => s.trim()).filter(Boolean);

app.use(
  cors({
    origin: CORS_ORIGINS,
    credentials: true,
  })
);

// Prevent accidental large payloads / DoS by huge JSON bodies.
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "64kb" }));

// Simple in-memory rate limit (good enough for single-instance).
// For multi-instance, use Redis-based limiter.
function createRateLimiter({ windowMs, max }) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const ip = (req.headers["x-forwarded-for"] || req.ip || "").toString().split(",")[0].trim() || "unknown";
    const key = ip;
    const b = buckets.get(key) || { ts: now, count: 0 };
    if (now - b.ts > windowMs) {
      b.ts = now;
      b.count = 0;
    }
    b.count += 1;
    buckets.set(key, b);
    if (b.count > max) {
      return res.status(429).json({ error: "Too many requests, please try again later." });
    }
    return next();
  };
}

const authRateLimit = createRateLimiter({
  windowMs: Number(process.env.AUTH_RATE_WINDOW_MS || 60_000),
  max: Number(process.env.AUTH_RATE_MAX || 20),
});


// Minimal request log for production troubleshooting.
app.use((req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - started;
    console.log(`[HTTP] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";
const PORT = Number(process.env.PORT || 3000);

function assertProductionSafety() {
  if (process.env.NODE_ENV !== "production") return;

  // JWT secret must be set and non-trivial.
  if (!process.env.JWT_SECRET || JWT_SECRET === "dev_secret_change_me" || JWT_SECRET.length < 24) {
    console.error("[FATAL] In production you must set a strong JWT_SECRET (>= 24 chars).");
    process.exit(1);
  }

  // CORS should not be wildcard in production.
  if (CORS_ORIGINS === "*" || CORS_ORIGIN_RAW === "*") {
    console.error("[FATAL] In production you must set CORS_ORIGIN to your app domain(s), not '*'.");
    process.exit(1);
  }
}

assertProductionSafety();


const mqttService = connectMqttClient();
const mqttClient = mqttService.client;

// Sprint 7: Firmware rollout engine (Hub OTA)
if (process.env.OTA_ROLLOUT_ENGINE_DISABLE !== "1") {
  startOtaRolloutEngine(prisma, mqttClient);
}

// Command TIMEOUT sweeper (PENDING > 10s -> TIMEOUT)
startCommandTimeoutSweeper(prisma);

// ResetRequest TIMEOUT sweeper (PENDING/SENT > 12s -> TIMEOUT)
startResetRequestTimeoutSweeper(prisma);

// State history pruning
const STATE_HISTORY_MAX_DAYS = Number(process.env.STATE_HISTORY_MAX_DAYS || 30);
const STATE_HISTORY_PRUNE_INTERVAL_MS = Number(process.env.STATE_HISTORY_PRUNE_INTERVAL_MS || 6 * 60 * 60 * 1000);

setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - STATE_HISTORY_MAX_DAYS * 24 * 60 * 60 * 1000);
    const r = await prisma.deviceStateHistory.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    if (r.count) {
      appendLogLine("backend.log", {
        ts: new Date().toISOString(),
        event: "state_history_prune",
        deleted: r.count,
        cutoff: cutoff.toISOString(),
      });
    }
  } catch (e) {
    console.warn("[prune] failed:", e?.message || e);
  }
}, STATE_HISTORY_PRUNE_INTERVAL_MS);

// Command + Zigbee discovery retention cleanup (to prevent DB growing forever)
const COMMAND_RETENTION_DAYS = Number(process.env.COMMAND_RETENTION_DAYS || 30);
const ZIGBEE_DISCOVERED_RETENTION_DAYS = Number(process.env.ZIGBEE_DISCOVERED_RETENTION_DAYS || 7);
const RETENTION_PRUNE_INTERVAL_MS = Number(process.env.RETENTION_PRUNE_INTERVAL_MS || 6 * 60 * 60 * 1000);

setInterval(async () => {
  try {
    const now = Date.now();

    const cmdCutoff = new Date(now - COMMAND_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const cmdRes = await prisma.command.deleteMany({ where: { sentAt: { lt: cmdCutoff } } });

    const pendingCutoff = new Date(now - ZIGBEE_DISCOVERED_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const discPending = await prisma.zigbeeDiscoveredDevice.deleteMany({
      where: { status: "PENDING", createdAt: { lt: pendingCutoff } },
    });

    const otherCutoff = new Date(now - COMMAND_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const discOther = await prisma.zigbeeDiscoveredDevice.deleteMany({
      where: { status: { in: ["CONFIRMED", "REJECTED"] }, updatedAt: { lt: otherCutoff } },
    });

    const pairing = await prisma.zigbeePairingSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });

    if (cmdRes.count || discPending.count || discOther.count || pairing.count) {
      appendLogLine("backend.log", {
        ts: new Date().toISOString(),
        event: "retention_prune",
        commandsDeleted: cmdRes.count,
        discoveredPendingDeleted: discPending.count,
        discoveredOtherDeleted: discOther.count,
        pairingDeleted: pairing.count,
      });
    }
  } catch (e) {
    console.warn("[retention] failed:", e?.message || e);
  }
}, RETENTION_PRUNE_INTERVAL_MS).unref?.();



// -------------------------
// Health
// -------------------------

app.get("/healthz", (req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    mqttConnected: Boolean(mqttClient.connected),
    sse: getSseStats(),
  });
});

app.get("/readyz", async (req, res) => {
  try {
    // DB readiness check
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: "ok", mqttConnected: Boolean(mqttClient.connected) });
  } catch (err) {
    res.status(503).json({ ok: false, db: "fail", error: err?.message || String(err) });
  }
});

// -------------------------
// MQTT diagnostics (roundtrip)
// -------------------------
app.get("/diagnostics/mqtt", authRequired, async (req, res) => {
  try {
    const diag = mqttService.getDiagnosticsState();
    const test = await mqttService.mqttRoundtripTest({ timeoutMs: Number(process.env.MQTT_DIAG_TIMEOUT_MS || 4000) });
    res.json({ ok: true, diag, test });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

const ROLE_RANK = { OWNER: 3, ADMIN: 2, MEMBER: 1, GUEST: 0 };
function roleAtLeast(role, minRole) {
  return (ROLE_RANK[role] || 0) >= (ROLE_RANK[minRole] || 0);
}

async function getMembership(userId, homeId) {
  return prisma.homeMember.findUnique({
    where: { homeId_userId: { homeId, userId } },
    select: { homeId: true, userId: true, role: true },
  });
}

async function requireHomeRole(req, res, homeId, minRole = "MEMBER") {
  const m = await getMembership(req.user.id, homeId);
  if (!m) {
    res.status(403).json({ error: "Not a member of this home" });
    return null;
  }
  if (!roleAtLeast(m.role, minRole)) {
    res.status(403).json({ error: `Requires role ${minRole} (you have ${m.role})` });
    return null;
  }
  return m;
}

// Sprint 8: allow global admins to manage any home when using admin-web.
// For normal users, keep the strict HomeMember-based access control.
async function requireHomeRoleOrAdmin(req, res, homeId, minRole = "MEMBER") {
  if (req.user?.isAdmin) {
    return { role: "ADMIN", homeId, userId: req.user.id };
  }
  return await requireHomeRole(req, res, homeId, minRole);
}

async function ensureDefaultHomeForUser(user) {
  // Prefer the smallest owned home
  let home = await prisma.home.findFirst({ where: { ownerId: user.id }, orderBy: { id: "asc" } });
  if (!home) {
    home = await prisma.home.create({
      data: {
        name: `Home of ${user.name || user.email}`,
        ownerId: user.id,
      },
    });
  }

  // Ensure owner membership exists
  await prisma.homeMember.upsert({
    where: { homeId_userId: { homeId: home.id, userId: user.id } },
    update: { role: "OWNER" },
    create: { homeId: home.id, userId: user.id, role: "OWNER" },
  });

  return home;
}


async function pickDefaultAdminHomeId(userId) {
  // Pick the first home where user is OWNER/ADMIN.
  const m = await prisma.homeMember.findFirst({
    where: { userId, role: { in: ["OWNER", "ADMIN"] } },
    orderBy: { homeId: "asc" },
    select: { homeId: true },
  });
  if (m) return m.homeId;

  // Fallback: owned home (should exist because we auto-create on login/register)
  const owned = await prisma.home.findFirst({
    where: { ownerId: userId },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  return owned?.id ?? null;
}

function signToken(user) {
  // Sprint 6: include isAdmin for RBAC without extra DB lookup per request.
  return jwt.sign({ id: user.id, email: user.email, isAdmin: !!user.isAdmin }, JWT_SECRET, { expiresIn: "7d" });
}

// -------------------------
// Auth
// -------------------------

app.post("/auth/register", authRateLimit, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { name, email, password } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: "Email already registered" });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({ data: { name, email, passwordHash } });

  // Create default Home and OWNER membership
  await ensureDefaultHomeForUser(user);

  const token = signToken(user);
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, isAdmin: !!user.isAdmin } });
});

app.post("/auth/login", authRateLimit, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  // Ensure the account always has at least one home
  await ensureDefaultHomeForUser(user);

  const token = signToken(user);
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, isAdmin: !!user.isAdmin } });
});

app.get("/me", authRequired, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { id: true, name: true, email: true, isAdmin: true, createdAt: true },
  });
  res.json({ user });
});

// Sprint 9: minimal user profile
app.get("/me/profile", authRequired, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { id: true, name: true, email: true },
  });
  if (!user) return res.status(404).json({ error: "User not found" });

  // Create a profile record lazily so clients can always rely on it.
  const profile = await prisma.userProfile.upsert({
    where: { userId: user.id },
    update: {},
    create: { userId: user.id, displayName: user.name || null, avatarUrl: null },
    select: { displayName: true, avatarUrl: true },
  });

  res.json({ profile: { displayName: profile.displayName, avatarUrl: profile.avatarUrl } });
});

app.put("/me/profile", authRequired, async (req, res) => {
  const body = profileUpdateSchema.parse(req.body);
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { id: true, name: true },
  });
  if (!user) return res.status(404).json({ error: "User not found" });

  const profile = await prisma.userProfile.upsert({
    where: { userId: user.id },
    update: {
      displayName: body.displayName,
      avatarUrl: body.avatarUrl,
    },
    create: {
      userId: user.id,
      displayName: body.displayName ?? user.name ?? null,
      avatarUrl: body.avatarUrl ?? null,
    },
    select: { displayName: true, avatarUrl: true },
  });

  res.json({ profile: { displayName: profile.displayName, avatarUrl: profile.avatarUrl } });
});

// JWT is stateless. This endpoint exists for client convenience.
app.post("/auth/logout", authRequired, async (req, res) => {
  res.json({ ok: true });
});

// -------------------------
// Admin / inventory / fleet (Sprint 6)
// -------------------------
// NOTE: Admin routes require `user.isAdmin` from JWT.
// Optional DEV shortcut: `x-admin-token: <ADMIN_TOKEN>` (see README warnings).

function generateSetupCode() {
  // 8-digit numeric (manual code). You can also print as QR later.
  const n = crypto.randomInt(0, 100_000_000);
  return String(n).padStart(8, "0");
}

// Sprint 9: unified QR payload for hub onboarding (serial + setupCode + model)
function makeHubQrPayload({ serial, setupCode, model }) {
  return JSON.stringify({ serial, setupCode, model });
}

function csvEscape(v) {
  const s = v == null ? "" : String(v);
  if (/[\",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function ensureProductModelExists(modelId) {
  if (!modelId) return;
  const pm = await prisma.productModel.findUnique({ where: { id: modelId }, select: { id: true } });
  if (!pm) {
    const err = new Error("Unknown modelId");
    // @ts-ignore
    err.httpStatus = 400;
    throw err;
  }
}

async function generateUniqueId({ prefix, existsFn }) {
  const p = (prefix || "").trim();
  for (let i = 0; i < 50; i++) {
    const candidate = `${p}${crypto.randomBytes(4).toString("hex")}`;
    // eslint-disable-next-line no-await-in-loop
    const exists = await existsFn(candidate);
    if (!exists) return candidate;
  }
  throw new Error("Failed to generate unique id (too many collisions)");
}

// -------------------------
// ProductModel catalog
// -------------------------

async function listProductModelsHandler(req, res) {
  const models = await prisma.productModel.findMany({ orderBy: { id: "asc" } });
  res.json({ models });
}

async function createProductModelHandler(req, res) {
  const parsed = productModelCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const exists = await prisma.productModel.findUnique({ where: { id: parsed.data.id } });
  if (exists) return res.status(409).json({ error: "Model already exists" });

  const model = await prisma.productModel.create({
    data: {
      id: parsed.data.id,
      name: parsed.data.name,
      manufacturer: parsed.data.manufacturer,
      protocol: parsed.data.protocol,
      fingerprintManuf: parsed.data.fingerprintManuf ?? null,
      fingerprintModel: parsed.data.fingerprintModel ?? null,
      capabilities: parsed.data.capabilities ?? null,
      uiSchema: parsed.data.uiSchema ?? null,
      defaultConfig: parsed.data.defaultConfig ?? null,
    },
  });

  res.status(201).json({ model });
}

// Admin routes
app.get("/admin/models", authRequired, adminRequired, listProductModelsHandler);
app.post("/admin/models", authRequired, adminRequired, createProductModelHandler);

// Client-facing alias (kept for pairing UX)
app.get("/inventory/models", authRequired, listProductModelsHandler);
// Legacy/dev alias (still admin guarded)
app.post("/inventory/models", authRequired, adminRequired, createProductModelHandler);


// -------------------------
// Inventory management
// -------------------------

app.get("/admin/inventory/hubs", authRequired, adminRequired, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const offset = Math.max(Number(req.query.offset || 0), 0);

  const status = typeof req.query.status === "string" && req.query.status.trim() ? req.query.status.trim() : null;
  const everOnlineQ = typeof req.query.everOnline === "string" ? req.query.everOnline.trim() : null;
  const boundQ = typeof req.query.bound === "string" ? req.query.bound.trim() : null;

  const where = {};
  if (status) where.status = status;
  if (boundQ === "true") where.binding = { isNot: null };
  if (boundQ === "false") where.binding = { is: null };

  // everOnline needs runtime join (and unbound runtime may map via serial==hubId)
  // Fetch a larger window then filter in-memory for a good admin UX.
  const take = everOnlineQ != null ? 500 : limit;
  const skip = everOnlineQ != null ? 0 : offset;

  const rows = await prisma.hubInventory.findMany({
    where,
    orderBy: { id: "desc" },
    take,
    skip,
    include: {
      productModel: { select: { id: true, name: true, protocol: true } },
      claimedHome: { select: { id: true, name: true } },
      claimedByUser: { select: { id: true, email: true, name: true } },
      binding: { select: { hubId: true, homeId: true, ownerId: true, activatedAt: true } },
    },
  });

  const candidateHubIds = new Set();
  for (const r of rows) {
    candidateHubIds.add(r.serial);
    if (r.binding?.hubId) candidateHubIds.add(r.binding.hubId);
  }

  const runtimes = await prisma.hubRuntime.findMany({
    where: { hubId: { in: Array.from(candidateHubIds) } },
    select: {
      hubId: true,
      online: true,
      everOnline: true,
      firstSeenAt: true,
      lastSeenAt: true,
      fwVersion: true,
      mac: true,
      ip: true,
      rssi: true,
    },
  });
  const runtimeByHubId = new Map(runtimes.map((rt) => [rt.hubId, rt]));

  const mapped = rows.map((r) => {
    const boundHubId = r.binding?.hubId ?? null;
    const runtime = boundHubId ? runtimeByHubId.get(boundHubId) || null : runtimeByHubId.get(r.serial) || null;
    const boundHomeId = r.binding?.homeId ?? null;
    const tags = [];
    if (runtime?.everOnline && !boundHomeId) tags.push("unbound");

    return {
      id: r.id,
      // Backward compatible alias: some admin UIs may still show "hubId"
      hubId: r.serial,
      serial: r.serial,
      status: r.status,
      modelId: r.modelId ?? null,
      productModel: r.productModel ?? null,
      claimedAt: r.claimedAt ? r.claimedAt.toISOString() : null,
      claimedHome: r.claimedHome ?? null,
      claimedBy: r.claimedByUser ?? null,
      createdAt: r.createdAt.toISOString(),
      boundHomeId,
      runtimeHubId: boundHubId,
      everOnline: !!runtime?.everOnline,
      firstSeenAt: runtime?.firstSeenAt ? runtime.firstSeenAt.toISOString() : null,
      lastSeenAt: runtime?.lastSeenAt ? runtime.lastSeenAt.toISOString() : null,
      tags,
      runtime: runtime
        ? {
            hubId: runtime.hubId,
            online: !!runtime.online,
            everOnline: !!runtime.everOnline,
            // Backward compatible aliases for existing UIs
            firstSeen: runtime.firstSeenAt ? runtime.firstSeenAt.toISOString() : null,
            lastSeen: runtime.lastSeenAt ? runtime.lastSeenAt.toISOString() : null,
            firmwareVersion: runtime.fwVersion ?? null,
            firstSeenAt: runtime.firstSeenAt ? runtime.firstSeenAt.toISOString() : null,
            lastSeenAt: runtime.lastSeenAt ? runtime.lastSeenAt.toISOString() : null,
            fwVersion: runtime.fwVersion ?? null,
            mac: runtime.mac ?? null,
            ip: runtime.ip ?? null,
            rssi: runtime.rssi ?? null,
          }
        : null,
    };
  });

  let items = mapped;
  if (everOnlineQ === "true") items = items.filter((i) => i.everOnline === true);
  if (everOnlineQ === "false") items = items.filter((i) => i.everOnline === false);

  if (everOnlineQ != null) {
    items = items.slice(offset, offset + limit);
  }

  res.json({ items, limit, offset });
});

async function upsertHubInventoryManual({ serial, setupCodePlaintext, modelId }) {
  await ensureProductModelExists(modelId);

  const setupCodeHash = await bcrypt.hash(setupCodePlaintext, 10);

  const existing = await prisma.hubInventory.findUnique({ where: { serial } });
  if (existing && existing.status !== "NEW") {
    const err = new Error("Hub inventory exists and is not NEW");
    // @ts-ignore
    err.httpStatus = 409;
    throw err;
  }

  const row = existing
    ? await prisma.hubInventory.update({
        where: { serial },
        data: {
          setupCodeHash,
          modelId: modelId ?? null,
          status: "NEW",
        },
      })
    : await prisma.hubInventory.create({
        data: {
          serial,
          setupCodeHash,
          status: "NEW",
          modelId: modelId ?? null,
        },
      });

  const qrPayload = makeHubQrPayload({ serial: row.serial, setupCode: setupCodePlaintext, model: row.modelId ?? null });
  return { row, setupCodePlaintext, qrPayload };
}

// Sprint 9: Manual hub inventory create (admin)
app.post("/admin/inventory/hubs/manual", authRequired, adminRequired, async (req, res) => {
  const parsed = adminInventoryHubManualSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const modelId = parsed.data.model ?? parsed.data.modelId ?? "HUB_V1";
    const { row, setupCodePlaintext, qrPayload } = await upsertHubInventoryManual({
      serial: parsed.data.serial,
      setupCodePlaintext: parsed.data.setupCode,
      modelId,
    });

    return res.status(201).json({
      serial: row.serial,
      hubId: row.serial,
      setupCodePlaintext,
      model: row.modelId ?? null,
      modelId: row.modelId ?? null,
      qrPayload,
    });
  } catch (e) {
    const status = e?.httpStatus || 500;
    return res.status(status).json({ error: e.message || "Server error" });
  }
});

app.post("/admin/inventory/hubs", authRequired, adminRequired, async (req, res) => {
  // Backward compatible manual-create (admin-web Sprint 8): {serial|hubId, setupCode, modelId?}
  if (req.body && typeof req.body.setupCode === "string" && (typeof req.body.serial === "string" || typeof req.body.hubId === "string")) {
    const serial = (req.body.serial || req.body.hubId).toString();
    const modelId = (req.body.modelId || req.body.model || "HUB_V1").toString();
    try {
      const { row, setupCodePlaintext, qrPayload } = await upsertHubInventoryManual({
        serial,
        setupCodePlaintext: req.body.setupCode,
        modelId,
      });
      return res.status(201).json({
        serial: row.serial,
        hubId: row.serial,
        setupCodePlaintext,
        model: row.modelId ?? null,
        modelId: row.modelId ?? null,
        qrPayload,
      });
    } catch (e) {
      const status = e?.httpStatus || 500;
      return res.status(status).json({ error: e.message || "Server error" });
    }
  }

  // Backward compatible single-create body: {hubIdOrSerial, modelId?}
  if (req.body && typeof req.body.hubIdOrSerial === "string") {
    const parsed = adminInventoryHubSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const serial = parsed.data.hubIdOrSerial;
    const modelId = parsed.data.modelId ?? "HUB_V1";

    await ensureProductModelExists(modelId);

    const existing = await prisma.hubInventory.findUnique({ where: { serial } });
    if (existing) return res.status(409).json({ error: "Hub already exists" });

    const setupCodePlaintext = generateSetupCode();
    const setupCodeHash = await bcrypt.hash(setupCodePlaintext, 10);

    const row = await prisma.hubInventory.create({
      data: {
        serial,
        setupCodeHash,
        status: "NEW",
        modelId: modelId ?? null,
      },
    });

    const qrPayload = makeHubQrPayload({ serial: row.serial, setupCode: setupCodePlaintext, model: row.modelId ?? null });

    return res.status(201).json({
      serial: row.serial,
      hubId: row.serial,
      setupCodePlaintext,
      model: row.modelId ?? null,
      modelId: row.modelId ?? null,
      qrPayload,
    });
  }

  // Batch generate: {count, prefix?, modelId?}
  const count = Number(req.body?.count || 0);
  if (!Number.isInteger(count) || count <= 0 || count > 200) {
    return res.status(400).json({ error: "count must be an integer 1..200" });
  }
  const prefix = (req.body?.prefix || "hub-").toString().trim();
  const modelId = (req.body?.modelId || "HUB_V1").toString();
  await ensureProductModelExists(modelId);

  const created = [];
  for (let i = 0; i < count; i++) {
    // eslint-disable-next-line no-await-in-loop
    const serial = await generateUniqueId({
      prefix,
      existsFn: async (candidate) => {
        const row = await prisma.hubInventory.findUnique({ where: { serial: candidate }, select: { id: true } });
        return !!row;
      },
    });
    const setupCodePlaintext = generateSetupCode();
    // eslint-disable-next-line no-await-in-loop
    const setupCodeHash = await bcrypt.hash(setupCodePlaintext, 10);
    // eslint-disable-next-line no-await-in-loop
    const row = await prisma.hubInventory.create({
      data: {
        serial,
        setupCodeHash,
        status: "NEW",
        modelId: modelId ?? null,
      },
    });
    const qrPayload = makeHubQrPayload({ serial: row.serial, setupCode: setupCodePlaintext, model: row.modelId ?? null });
    created.push({ serial: row.serial, hubId: row.serial, setupCodePlaintext, model: row.modelId ?? null, modelId: row.modelId ?? null, qrPayload });
  }

  res.status(201).json({ items: created });
});


app.get("/admin/inventory/devices", authRequired, adminRequired, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const offset = Math.max(Number(req.query.offset || 0), 0);

  const rows = await prisma.deviceInventory.findMany({
    orderBy: { id: "desc" },
    take: limit,
    skip: offset,
    include: {
      productModel: { select: { id: true, name: true, protocol: true } },
      claimedHome: { select: { id: true, name: true } },
      claimedByUser: { select: { id: true, email: true, name: true } },
    },
  });

  const uuids = rows.map((r) => r.deviceUuid);
  const devices = await prisma.device.findMany({
    where: { deviceId: { in: uuids } },
    select: { deviceId: true, id: true, homeId: true, protocol: true, zigbeeIeee: true, updatedAt: true },
  });
  const devByUuid = new Map(devices.map((d) => [d.deviceId, d]));

  const items = rows.map((r) => {
    const bound = devByUuid.get(r.deviceUuid) || null;
    return {
      id: r.id,
      serial: r.serial,
      deviceUuid: r.deviceUuid,
      protocol: r.protocol,
      typeDefault: r.typeDefault ?? null,
      model: r.model ?? null,
      modelId: r.modelId ?? null,
      productModel: r.productModel ?? null,
      status: r.status,
      claimedAt: r.claimedAt ? r.claimedAt.toISOString() : null,
      claimedHome: r.claimedHome ?? null,
      claimedBy: r.claimedByUser ?? null,
      createdAt: r.createdAt.toISOString(),
      boundDevice: bound
        ? { deviceDbId: bound.id, homeId: bound.homeId, protocol: bound.protocol, ieee: bound.zigbeeIeee ?? null, updatedAt: bound.updatedAt.toISOString() }
        : null,
    };
  });

  res.json({ items, limit, offset });
});

app.post("/admin/inventory/devices", authRequired, adminRequired, async (req, res) => {
  // Backward compatible single-create body: {serial, type?, protocol?, model?, modelId?}
  if (req.body && typeof req.body.serial === "string") {
    const parsed = adminInventoryDeviceSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { serial, type, protocol, model, modelId } = parsed.data;
    await ensureProductModelExists(modelId);

    const existing = await prisma.deviceInventory.findUnique({ where: { serial } });
    if (existing) return res.status(409).json({ error: "Serial already exists" });

    const setupCodePlaintext = generateSetupCode();
    const setupCodeHash = await bcrypt.hash(setupCodePlaintext, 10);
    const deviceUuid = crypto.randomUUID();

    const row = await prisma.deviceInventory.create({
      data: {
        serial,
        deviceUuid,
        typeDefault: type ?? null,
        protocol,
        model: model ?? null,
        modelId: modelId ?? null,
        setupCodeHash,
        status: "FACTORY_NEW",
      },
    });

    return res.json({ serial: row.serial, deviceUuid: row.deviceUuid, setupCodePlaintext });
  }

  // Batch generate: {count, prefix?, protocol?, type?, model?, modelId?}
  const count = Number(req.body?.count || 0);
  if (!Number.isInteger(count) || count <= 0 || count > 500) {
    return res.status(400).json({ error: "count must be an integer 1..500" });
  }
  const prefix = (req.body?.prefix || "SN-").toString().trim();
  const protocol = (req.body?.protocol || "MQTT").toString();
  const type = req.body?.type ?? null;
  const model = req.body?.model ?? null;
  const modelId = req.body?.modelId ?? null;

  if (!(["MQTT", "ZIGBEE"].includes(protocol))) {
    return res.status(400).json({ error: "protocol must be MQTT or ZIGBEE" });
  }
  if (type != null && !(["relay", "dimmer", "rgb", "sensor"].includes(type))) {
    return res.status(400).json({ error: "type must be relay|dimmer|rgb|sensor" });
  }
  await ensureProductModelExists(modelId);

  const created = [];
  for (let i = 0; i < count; i++) {
    // eslint-disable-next-line no-await-in-loop
    const serial = await generateUniqueId({
      prefix,
      existsFn: async (candidate) => {
        const row = await prisma.deviceInventory.findUnique({ where: { serial: candidate }, select: { id: true } });
        return !!row;
      },
    });
    const setupCodePlaintext = generateSetupCode();
    // eslint-disable-next-line no-await-in-loop
    const setupCodeHash = await bcrypt.hash(setupCodePlaintext, 10);
    const deviceUuid = crypto.randomUUID();

    // eslint-disable-next-line no-await-in-loop
    const row = await prisma.deviceInventory.create({
      data: {
        serial,
        deviceUuid,
        typeDefault: type ?? null,
        protocol,
        model: model ?? null,
        modelId: modelId ?? null,
        setupCodeHash,
        status: "FACTORY_NEW",
      },
    });

    created.push({ serial: row.serial, deviceUuid: row.deviceUuid, setupCodePlaintext });
  }

  res.status(201).json({ items: created });
});


app.post("/admin/inventory/export", authRequired, adminRequired, async (req, res) => {
  const kind = (req.body?.kind || "").toString();
  const format = (req.body?.format || "json").toString();

  if (!(["models", "hubs", "devices"].includes(kind))) {
    return res.status(400).json({ error: "kind must be models|hubs|devices" });
  }
  if (!(["json", "csv"].includes(format))) {
    return res.status(400).json({ error: "format must be json|csv" });
  }

  let items = [];
  if (kind === "models") {
    items = await prisma.productModel.findMany({ orderBy: { id: "asc" } });
  } else if (kind === "hubs") {
    items = await prisma.hubInventory.findMany({ orderBy: { id: "asc" } });
  } else if (kind === "devices") {
    items = await prisma.deviceInventory.findMany({ orderBy: { id: "asc" } });
  }

  if (format === "json") {
    return res.json({ kind, format, items });
  }

  // CSV
  if (kind === "models") {
    const header = ["id", "name", "manufacturer", "protocol", "fingerprintManuf", "fingerprintModel", "createdAt", "updatedAt"];
    const lines = [header.join(",")];
    for (const r of items) {
      lines.push(
        [
          r.id,
          r.name,
          r.manufacturer,
          r.protocol,
          r.fingerprintManuf ?? "",
          r.fingerprintModel ?? "",
          r.createdAt?.toISOString?.() ?? "",
          r.updatedAt?.toISOString?.() ?? "",
        ]
          .map(csvEscape)
          .join(",")
      );
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=export_models_${Date.now()}.csv`);
    return res.send(lines.join("\n"));
  }

  if (kind === "hubs") {
    // hubId is kept as an alias to serial for backward compatibility.
    const header = ["serial", "hubId", "modelId", "status", "claimedAt", "claimedHomeId", "claimedByUserId", "createdAt"];
    const lines = [header.join(",")];
    for (const r of items) {
      lines.push(
        [
          r.serial,
          r.serial,
          r.modelId ?? "",
          r.status,
          r.claimedAt?.toISOString?.() ?? "",
          r.claimedHomeId ?? "",
          r.claimedByUserId ?? "",
          r.createdAt?.toISOString?.() ?? "",
        ]
          .map(csvEscape)
          .join(",")
      );
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=export_hubs_${Date.now()}.csv`);
    return res.send(lines.join("\n"));
  }

  // devices
  const header = ["serial", "deviceUuid", "protocol", "typeDefault", "model", "modelId", "status", "claimedAt", "claimedHomeId", "claimedByUserId", "createdAt"];
  const lines = [header.join(",")];
  for (const r of items) {
    lines.push(
      [
        r.serial,
        r.deviceUuid,
        r.protocol,
        r.typeDefault ?? "",
        r.model ?? "",
        r.modelId ?? "",
        r.status,
        r.claimedAt?.toISOString?.() ?? "",
        r.claimedHomeId ?? "",
        r.claimedByUserId ?? "",
        r.createdAt?.toISOString?.() ?? "",
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=export_devices_${Date.now()}.csv`);
  return res.send(lines.join("\n"));
});

// -------------------------
// Admin tools
// -------------------------

// Sprint 9: Tools endpoint to clear retained MQTT messages
app.post("/admin/tools/mqtt/clear-retained", authRequired, adminRequired, async (req, res) => {
  if (!mqttClient.connected) {
    return res.status(503).json({ error: "MQTT not connected" });
  }

  const { topics } = adminMqttClearRetainedSchema.parse(req.body);

  const results = [];
  for (const topic of topics) {
    try {
      await new Promise((resolve, reject) => {
        mqttClient.publish(topic, "", { qos: 1, retain: true }, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
      results.push({ topic, ok: true });
    } catch (err) {
      results.push({ topic, ok: false, error: err?.message || String(err) });
    }
  }

  res.json({ ok: results.every((r) => r.ok), results });
});


// -------------------------
// Fleet dashboard + health
// -------------------------

app.get("/admin/fleet/hubs", authRequired, adminRequired, async (req, res) => {
  const status = (req.query.status || "").toString();
  const where = {};
  if (status === "online") where.online = true;
  if (status === "offline") where.online = false;

  const hubs = await prisma.hub.findMany({
    where,
    orderBy: { id: "asc" },
    select: {
      id: true,
      hubId: true,
      homeId: true,
      online: true,
      lastSeen: true,
      firmwareVersion: true,
      coordinatorFirmwareVersion: true,
      coordinatorBuildTime: true,
      mac: true,
      ip: true,
      rssi: true,
    },
  });

  const hubIds = hubs.map((h) => h.hubId);
  const bindings = await prisma.hubBinding.findMany({
    where: { hubId: { in: hubIds } },
    select: {
      hubId: true,
      inventorySerial: true,
      inventory: { select: { modelId: true } },
    },
  });
  const bindingByHubId = new Map(bindings.map((b) => [b.hubId, b]));

  const items = hubs.map((h) => {
    const binding = bindingByHubId.get(h.hubId) || null;
    return {
      hubId: h.hubId,
      hubDbId: h.id,
      serial: binding?.inventorySerial ?? null,
      modelId: binding?.inventory?.modelId ?? null,
      boundHomeId: h.homeId,
      online: !!h.online,
      lastSeen: h.lastSeen ? h.lastSeen.toISOString() : null,
      fwVersion: h.firmwareVersion ?? null,
      coordinatorFwVersion: h.coordinatorFirmwareVersion ?? null,
      coordinatorBuildTime: h.coordinatorBuildTime ?? null,
      mac: h.mac ?? null,
      ip: h.ip ?? null,
      rssi: h.rssi ?? null,
    };
  });

  res.json({ items });
});

app.get("/admin/fleet/devices", authRequired, adminRequired, async (req, res) => {
  const homeIdRaw = req.query.homeId;
  const homeId = homeIdRaw != null && homeIdRaw !== "" ? Number(homeIdRaw) : null;
  if (homeIdRaw != null && (!Number.isInteger(homeId) || homeId <= 0)) {
    return res.status(400).json({ error: "Invalid homeId" });
  }
  const modelId = req.query.modelId ? String(req.query.modelId) : null;
  const onlineRaw = req.query.online;
  const online = onlineRaw != null && onlineRaw !== "" ? (String(onlineRaw) === "true") : null;

  const where = {
    ...(homeId ? { homeId } : {}),
    ...(modelId ? { modelId } : {}),
  };

  const devices = await prisma.device.findMany({
    where,
    orderBy: { id: "asc" },
    select: {
      id: true,
      deviceId: true,
      zigbeeIeee: true,
      modelId: true,
      protocol: true,
      homeId: true,
      stateCurrent: { select: { updatedAt: true, online: true } },
    },
  });

  const filtered = online === null ? devices : devices.filter((d) => !!d.stateCurrent?.online === online);
  const ids = filtered.map((d) => d.id);
  const lastEvents = await prisma.deviceEvent.groupBy({
    by: ["deviceId"],
    where: { deviceId: { in: ids } },
    _max: { createdAt: true },
  });
  const lastEventByDeviceId = new Map(lastEvents.map((e) => [e.deviceId, e._max.createdAt]));

  const items = filtered.map((d) => {
    const lastStateAt = d.stateCurrent?.updatedAt ?? null;
    const lastEventAt = lastEventByDeviceId.get(d.id) || null;
    return {
      deviceDbId: d.id,
      deviceId: d.deviceId,
      ieee: d.zigbeeIeee ?? null,
      modelId: d.modelId ?? null,
      protocol: d.protocol,
      homeId: d.homeId,
      online: !!d.stateCurrent?.online,
      lastStateAt: lastStateAt ? lastStateAt.toISOString() : null,
      lastEventAt: lastEventAt ? lastEventAt.toISOString() : null,
    };
  });

  res.json({ items });
});


// -------------------------
// Pairing monitor
// -------------------------

app.get("/admin/pairing/sessions", authRequired, adminRequired, async (req, res) => {
  const hubId = req.query.hubId ? String(req.query.hubId) : null;
  const where = hubId ? { hubId } : {};

  const sessions = await prisma.zigbeePairingSession.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: {
      token: true,
      ownerId: true,
      hubId: true,
      homeId: true,
      mode: true,
      claimedSerial: true,
      expectedModelId: true,
      createdAt: true,
      expiresAt: true,
    },
  });

  const tokens = sessions.map((s) => s.token);
  const counts = await prisma.zigbeeDiscoveredDevice.groupBy({
    by: ["pairingToken"],
    where: { pairingToken: { in: tokens } },
    _count: { _all: true },
  });
  const countByToken = new Map(counts.map((c) => [c.pairingToken, c._count._all]));

  const items = sessions.map((s) => ({
    token: s.token,
    hubId: s.hubId,
    homeId: s.homeId ?? null,
    ownerId: s.ownerId,
    mode: s.mode,
    claimedSerial: s.claimedSerial ?? null,
    expectedModelId: s.expectedModelId ?? null,
    createdAt: s.createdAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    expired: Date.now() > s.expiresAt.getTime(),
    discoveredCount: countByToken.get(s.token) || 0,
  }));

  res.json({ items });
});

app.get("/admin/pairing/sessions/:id/discovered", authRequired, adminRequired, async (req, res) => {
  const token = String(req.params.id);
  const devices = await prisma.zigbeeDiscoveredDevice.findMany({
    where: { pairingToken: token },
    orderBy: { createdAt: "desc" },
  });
  res.json({ items: devices });
});

app.post("/admin/pairing/sessions/:id/expire", authRequired, adminRequired, async (req, res) => {
  const token = String(req.params.id);
  const session = await prisma.zigbeePairingSession.findUnique({ where: { token } });
  if (!session) return res.status(404).json({ error: "Session not found" });
  const now = new Date();
  const updated = await prisma.zigbeePairingSession.update({ where: { token }, data: { expiresAt: now } });
  res.json({ ok: true, token: updated.token, expiresAt: updated.expiresAt.toISOString() });
});


// -------------------------
// Events explorer + Command center
// -------------------------

app.get("/admin/events", authRequired, adminRequired, async (req, res) => {
  const homeIdRaw = req.query.homeId;
  const deviceIdRaw = req.query.deviceId;
  const date = req.query.date ? String(req.query.date) : null;
  const type = req.query.type ? String(req.query.type) : null;
  const limit = Math.min(Number(req.query.limit || 100), 1000);
  const offset = Math.max(Number(req.query.offset || 0), 0);

  let homeId = null;
  if (homeIdRaw != null && homeIdRaw !== "") {
    homeId = Number(homeIdRaw);
    if (!Number.isInteger(homeId) || homeId <= 0) return res.status(400).json({ error: "Invalid homeId" });
  }

  let deviceDbId = null;
  if (deviceIdRaw != null && deviceIdRaw !== "") {
    const asNum = Number(deviceIdRaw);
    if (Number.isInteger(asNum) && asNum > 0) deviceDbId = asNum;
  }

  let start = null;
  let end = null;
  if (date) {
    const startDate = new Date(`${date}T00:00:00.000Z`);
    if (isNaN(startDate.getTime())) return res.status(400).json({ error: "Invalid date (expected YYYY-MM-DD)" });
    start = startDate;
    end = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
  }

  const where = {
    ...(deviceDbId ? { deviceId: deviceDbId } : {}),
    ...(type ? { type } : {}),
    ...(start ? { createdAt: { gte: start, lt: end } } : {}),
    ...(homeId ? { device: { homeId } } : {}),
  };

  const items = await prisma.deviceEvent.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    skip: offset,
    include: {
      device: { select: { id: true, deviceId: true, name: true, homeId: true, zigbeeIeee: true, modelId: true, protocol: true } },
    },
  });

  res.json({ items, limit, offset });
});

app.get("/admin/commands", authRequired, adminRequired, async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const deviceIdRaw = req.query.deviceId;
  const date = req.query.date ? String(req.query.date) : null;
  const limit = Math.min(Number(req.query.limit || 100), 1000);

  let deviceDbId = null;
  if (deviceIdRaw != null && deviceIdRaw !== "") {
    const asNum = Number(deviceIdRaw);
    if (Number.isInteger(asNum) && asNum > 0) deviceDbId = asNum;
  }

  let start = null;
  let end = null;
  if (date) {
    const startDate = new Date(`${date}T00:00:00.000Z`);
    if (isNaN(startDate.getTime())) return res.status(400).json({ error: "Invalid date (expected YYYY-MM-DD)" });
    start = startDate;
    end = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
  }

  const where = {
    ...(status ? { status } : {}),
    ...(deviceDbId ? { deviceId: deviceDbId } : {}),
    ...(start ? { sentAt: { gte: start, lt: end } } : {}),
  };

  const rows = await prisma.command.findMany({
    where,
    orderBy: { sentAt: "desc" },
    take: limit,
    include: { device: { select: { id: true, deviceId: true, homeId: true, protocol: true, zigbeeIeee: true, name: true } } },
  });

  const items = rows.map((c) => ({
    id: c.id,
    deviceDbId: c.deviceId,
    device: c.device,
    cmdId: c.cmdId,
    status: c.status,
    sentAt: c.sentAt.toISOString(),
    ackedAt: c.ackedAt ? c.ackedAt.toISOString() : null,
    latencyMs: c.ackedAt ? Math.max(c.ackedAt.getTime() - c.sentAt.getTime(), 0) : null,
    error: c.error ?? null,
    payload: c.payload,
  }));

  res.json({ items, limit });
});

app.post("/admin/commands/:cmdId/retry", authRequired, adminRequired, async (req, res) => {
  const idOrCmdId = String(req.params.cmdId);
  const asNum = Number(idOrCmdId);

  const command = Number.isInteger(asNum) && asNum > 0
    ? await prisma.command.findUnique({ where: { id: asNum }, include: { device: true } })
    : await prisma.command.findFirst({ where: { cmdId: idOrCmdId }, orderBy: { sentAt: "desc" }, include: { device: true } });

  if (!command) return res.status(404).json({ error: "Command not found" });
  if (!mqttClient.connected) return res.status(503).json({ error: "MQTT not connected" });

  const device = command.device;
  if (!device) return res.status(500).json({ error: "Command missing device relation" });

  // Prevent retry of sensitive commands that cannot be reproduced from DB safely.
  const action = command.payload?.action;
  if (action === "lock.add_pin" || action === "lock.add_rfid") {
    return res.status(400).json({ error: "Cannot retry lock.add_* commands because secrets are not stored. Re-issue the command with plaintext secret." });
  }

  const now = new Date();
  await prisma.command.update({
    where: { id: command.id },
    data: { status: "PENDING", sentAt: now, ackedAt: null, error: null },
  });

  if (device.protocol === "ZIGBEE") {
    if (!device.zigbeeIeee) return res.status(400).json({ error: "Zigbee device missing ieee" });
    if (!command.payload?.action) return res.status(400).json({ error: "Command payload missing action" });
    const args = command.payload?.args ?? {};
    const topic = `home/zb/${device.zigbeeIeee}/set`;
    const body = { cmdId: command.cmdId, ts: Date.now(), action: command.payload.action, args, params: args };
    mqttClient.publish(topic, JSON.stringify(body), { qos: 1 }, (err) => {
      if (err) console.warn("[MQTT] retry publish zigbee set failed:", err?.message || err);
    });
  } else {
    // MQTT-device plane
    publishCommand(mqttClient, {
      homeId: device.homeId,
      deviceId: device.deviceId,
      cmdId: command.cmdId,
      payload: command.payload,
    });
  }

  emitToHome(device.homeId, "command_updated", {
    homeId: device.homeId,
    deviceDbId: device.id,
    deviceId: device.deviceId,
    ieee: device.zigbeeIeee ?? null,
    cmdId: command.cmdId,
    status: "PENDING",
    sentAt: now.toISOString(),
    ackedAt: null,
    error: null,
    protocol: device.protocol,
    retry: true,
  });

  res.json({ ok: true, cmdId: command.cmdId, status: "PENDING" });
});


// -------------------------
// Firmware releases + rollouts (Sprint 7)
// -------------------------

app.get("/admin/firmware/releases", authRequired, adminRequired, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const items = await prisma.firmwareRelease.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  res.json({ items, limit });
});

app.post("/admin/firmware/releases", authRequired, adminRequired, async (req, res) => {
  const parsed = firmwareReleaseCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const release = await prisma.firmwareRelease.create({
    data: {
      targetType: parsed.data.targetType,
      version: parsed.data.version,
      url: parsed.data.url,
      sha256: parsed.data.sha256,
      size: parsed.data.size ?? null,
      notes: parsed.data.notes ?? null,
    },
  });
  res.status(201).json({ release });
});

app.get("/admin/firmware/rollouts", authRequired, adminRequired, async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const rows = await prisma.firmwareRollout.findMany({
    where: { ...(status ? { status } : {}) },
    orderBy: { updatedAt: "desc" },
    take: limit,
    include: {
      release: true,
      progress: { select: { state: true } },
    },
  });

  const items = rows.map((r) => {
    const counts = r.progress.reduce((acc, p) => {
      acc[p.state] = (acc[p.state] || 0) + 1;
      return acc;
    }, {});
    return {
      id: r.id,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      startedAt: r.startedAt ? r.startedAt.toISOString() : null,
      pausedAt: r.pausedAt ? r.pausedAt.toISOString() : null,
      release: r.release,
      counts,
    };
  });

  res.json({ items, limit });
});

app.post("/admin/firmware/rollouts", authRequired, adminRequired, async (req, res) => {
  const parsed = firmwareRolloutCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const release = await prisma.firmwareRelease.findUnique({ where: { id: parsed.data.releaseId } });
  if (!release) return res.status(404).json({ error: "Release not found" });
  if (release.targetType !== "HUB") return res.status(400).json({ error: "Only HUB releases are supported in Sprint 7" });

  const hubIds = Array.from(new Set(parsed.data.hubIds.map((s) => String(s).trim()).filter(Boolean)));
  if (!hubIds.length) return res.status(400).json({ error: "hubIds is required" });

  const hubs = await prisma.hub.findMany({ where: { hubId: { in: hubIds } }, select: { hubId: true } });
  const exist = new Set(hubs.map((h) => h.hubId));
  const missing = hubIds.filter((id) => !exist.has(id));
  if (missing.length) return res.status(400).json({ error: `Unknown hubs: ${missing.slice(0, 20).join(",")}` });

  const created = await prisma.$transaction(async (tx) => {
    const rollout = await tx.firmwareRollout.create({
      data: {
        releaseId: release.id,
        status: "DRAFT",
      },
    });
    await tx.firmwareRolloutTarget.createMany({
      data: hubIds.map((hubId) => ({ rolloutId: rollout.id, hubId })),
      skipDuplicates: true,
    });
    await tx.firmwareRolloutProgress.createMany({
      data: hubIds.map((hubId) => ({ rolloutId: rollout.id, hubId, state: "PENDING", attempt: 0 })),
      skipDuplicates: true,
    });
    return rollout;
  });

  res.status(201).json({ rollout: created });
});

app.post("/admin/firmware/rollouts/:id/start", authRequired, adminRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const rollout = await prisma.firmwareRollout.findUnique({ where: { id } });
  if (!rollout) return res.status(404).json({ error: "Rollout not found" });

  const now = new Date();
  const updated = await prisma.firmwareRollout.update({
    where: { id },
    data: {
      status: "RUNNING",
      startedAt: rollout.startedAt ?? now,
      pausedAt: null,
    },
  });
  res.json({ rollout: updated });
});

app.post("/admin/firmware/rollouts/:id/pause", authRequired, adminRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const rollout = await prisma.firmwareRollout.findUnique({ where: { id } });
  if (!rollout) return res.status(404).json({ error: "Rollout not found" });

  const now = new Date();
  const updated = await prisma.firmwareRollout.update({
    where: { id },
    data: {
      status: "PAUSED",
      pausedAt: now,
    },
  });
  res.json({ rollout: updated });
});

app.get("/admin/firmware/rollouts/:id", authRequired, adminRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });

  const rollout = await prisma.firmwareRollout.findUnique({
    where: { id },
    include: {
      release: true,
      progress: { include: { hub: { select: { hubId: true, homeId: true, online: true, lastSeen: true, firmwareVersion: true } } } },
    },
  });
  if (!rollout) return res.status(404).json({ error: "Rollout not found" });

  const progress = rollout.progress
    .map((p) => ({
      hubId: p.hubId,
      online: !!p.hub?.online,
      lastSeen: p.hub?.lastSeen ? p.hub.lastSeen.toISOString() : null,
      hubFwVersion: p.hub?.firmwareVersion ?? null,
      state: p.state,
      attempt: p.attempt,
      cmdId: p.cmdId ?? null,
      sentAt: p.sentAt ? p.sentAt.toISOString() : null,
      ackedAt: p.ackedAt ? p.ackedAt.toISOString() : null,
      lastMsg: p.lastMsg ?? null,
    }))
    .sort((a, b) => a.hubId.localeCompare(b.hubId));

  res.json({
    rollout: {
      id: rollout.id,
      status: rollout.status,
      createdAt: rollout.createdAt.toISOString(),
      updatedAt: rollout.updatedAt.toISOString(),
      startedAt: rollout.startedAt ? rollout.startedAt.toISOString() : null,
      pausedAt: rollout.pausedAt ? rollout.pausedAt.toISOString() : null,
    },
    release: rollout.release,
    progress,
  });
});


// -------------------------
// SSE
// -------------------------

app.get("/events", authRequired, async (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  res.write(`retry: 3000\n`);
  res.write(`: connected\n\n`);

  // Load the homes this user can see at connection time.
  const memberships = await prisma.homeMember.findMany({
    where: { userId: req.user.id },
    select: { homeId: true },
  });
  const homeIds = new Set(memberships.map((m) => m.homeId));

  // Best-effort resume for clients that reconnect.
  const lastEventId = req.headers["last-event-id"] ?? req.query.lastEventId;
  const clientId = addSseClient({ res, userId: req.user.id, homeIds, lastEventId });

  req.on("close", () => {
    removeSseClient(clientId);
  });
});

// -------------------------
// Homes / Rooms
// -------------------------

app.get("/homes", authRequired, async (req, res) => {
  const memberships = await prisma.homeMember.findMany({
    where: { userId: req.user.id },
    select: {
      role: true,
      home: { select: { id: true, name: true, ownerId: true, createdAt: true } },
    },
    orderBy: { homeId: "asc" },
  });

  const homes = memberships.map((m) => ({
    id: m.home.id,
    name: m.home.name,
    ownerId: m.home.ownerId,
    role: m.role,
    createdAt: m.home.createdAt,
  }));

  res.json({ homes });
});

app.post("/homes", authRequired, async (req, res) => {
  const parsed = homeCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const home = await prisma.home.create({
    data: {
      name: parsed.data.name,
      ownerId: req.user.id,
      members: { create: { userId: req.user.id, role: "OWNER" } },
    },
  });

  res.status(201).json({ home });
});

// Sprint 9: Home invites (minimal sharing)
app.post("/homes/:homeId/invites", authRequired, async (req, res) => {
  const homeId = Number(req.params.homeId);
  if (!Number.isInteger(homeId)) return res.status(400).json({ error: "Invalid homeId" });

  const m = await requireHomeRole(req, res, homeId, "ADMIN");
  if (!m) return;

  const parsed = homeInviteCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const role = parsed.data.role ?? "MEMBER";

  // Simple random code; human shareable.
  let code = null;
  for (let i = 0; i < 5; i++) {
    const candidate = crypto.randomBytes(6).toString("hex");
    try {
      const invite = await prisma.homeInvite.create({
        data: {
          homeId,
          code: candidate,
          role,
          createdByUserId: req.user.id,
          expiresAt: parsed.data.expiresAt ?? null,
        },
      });
      code = invite.code;
      break;
    } catch (e) {
      // retry on unique collision
      if (String(e?.code) !== "P2002") throw e;
    }
  }

  if (!code) return res.status(500).json({ error: "Failed to generate invite code" });
  res.status(201).json({ invite: { code, role } });
});

app.post("/homes/invites/accept", authRequired, async (req, res) => {
  const parsed = homeInviteAcceptSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const invite = await prisma.homeInvite.findUnique({
    where: { code: parsed.data.code },
  });
  if (!invite) return res.status(404).json({ error: "Invite not found" });
  if (invite.revokedAt) return res.status(400).json({ error: "Invite revoked" });
  if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) return res.status(400).json({ error: "Invite expired" });
  if (invite.acceptedAt) return res.status(409).json({ error: "Invite already used" });

  // If already a member, return existing membership.
  const existing = await prisma.homeMember.findUnique({
    where: { homeId_userId: { homeId: invite.homeId, userId: req.user.id } },
  });
  if (existing) {
    return res.json({ homeId: invite.homeId, role: existing.role, alreadyMember: true });
  }

  const membership = await prisma.homeMember.create({
    data: {
      homeId: invite.homeId,
      userId: req.user.id,
      role: invite.role,
    },
  });

  await prisma.homeInvite.update({
    where: { code: invite.code },
    data: { acceptedByUserId: req.user.id, acceptedAt: new Date() },
  });

  res.status(201).json({ homeId: invite.homeId, role: membership.role });
});

app.get("/homes/:homeId/rooms", authRequired, async (req, res) => {
  const homeId = Number(req.params.homeId);
  if (!Number.isInteger(homeId)) return res.status(400).json({ error: "Invalid homeId" });

  const m = await requireHomeRole(req, res, homeId, "MEMBER");
  if (!m) return;

  const rooms = await prisma.room.findMany({ where: { homeId }, orderBy: { name: "asc" } });
  res.json({ rooms });
});

app.post("/homes/:homeId/rooms", authRequired, async (req, res) => {
  const homeId = Number(req.params.homeId);
  if (!Number.isInteger(homeId)) return res.status(400).json({ error: "Invalid homeId" });

  const m = await requireHomeRole(req, res, homeId, "ADMIN");
  if (!m) return;

  const parsed = roomCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const room = await prisma.room.create({ data: { homeId, name: parsed.data.name } });
  res.status(201).json({ room });
});

/**
 * Sprint 12: Home devices list (with descriptor summary)
 *
 * This endpoint is optimized for the mobile UI to fetch all devices in a home
 * and decide which plugin renderer to use.
 */
app.get("/homes/:homeId/devices", authRequired, async (req, res) => {
  const homeId = Number(req.params.homeId);
  if (!Number.isInteger(homeId)) return res.status(400).json({ error: "Invalid homeId" });

  const roomIdRaw = req.query.roomId;
  const roomId = roomIdRaw != null ? Number(roomIdRaw) : null;
  if (roomIdRaw != null && (!Number.isInteger(roomId) || roomId <= 0)) {
    return res.status(400).json({ error: "Invalid roomId" });
  }

  const m = await requireHomeRole(req, res, homeId, "MEMBER");
  if (!m) return;

  const devices = await prisma.device.findMany({
    where: {
      homeId,
      ...(roomId ? { roomId } : {}),
    },
    include: {
      home: { select: { id: true, name: true } },
      room: { select: { id: true, name: true } },
      stateCurrent: true,
      productModel: { select: { id: true, capabilities: true } },
    },
    orderBy: { id: "asc" },
  });

  const out = devices.map((d) => {
    const pm = d.productModel ?? null;
    // Avoid returning productModel in list to keep payload stable.
    const { productModel, ...rest } = d;
    return {
      ...rest,
      descriptorSummary: pm ? buildDescriptorSummaryFromProductModel(pm) : null,
    };
  });

  res.json({ devices: out });
});

// -------------------------
// Automations (Sprint 8)
// -------------------------

app.get("/homes/:homeId/automations", authRequired, async (req, res) => {
  const homeId = Number(req.params.homeId);
  if (!Number.isInteger(homeId)) return res.status(400).json({ error: "Invalid homeId" });

  const m = await requireHomeRoleOrAdmin(req, res, homeId, "MEMBER");
  if (!m) return;

  const rules = await prisma.automationRule.findMany({ where: { homeId }, orderBy: { id: "asc" } });
  const version = rules.reduce((mx, r) => Math.max(mx, r.version || 0), 0);

  res.json({ homeId, version, rules });
});

function collectDeviceDbIdsFromAutomation({ trigger, actions }) {
  const ids = new Set();
  if (trigger && typeof trigger === "object" && trigger.deviceId != null) {
    const n = Number(trigger.deviceId);
    if (Number.isInteger(n)) ids.add(n);
  }
  if (Array.isArray(actions)) {
    for (const a of actions) {
      if (a && typeof a === "object" && a.deviceId != null) {
        const n = Number(a.deviceId);
        if (Number.isInteger(n)) ids.add(n);
      }
    }
  }
  return Array.from(ids);
}

async function validateAutomationDeviceRefs({ homeId, trigger, actions }) {
  const ids = collectDeviceDbIdsFromAutomation({ trigger, actions });
  if (!ids.length) return { ok: true };

  const devices = await prisma.device.findMany({ where: { id: { in: ids } }, select: { id: true, homeId: true, protocol: true, zigbeeIeee: true } });
  const byId = new Map(devices.map((d) => [d.id, d]));

  for (const id of ids) {
    const d = byId.get(id);
    if (!d) return { ok: false, error: `deviceId ${id} not found` };
    if (d.homeId !== homeId) return { ok: false, error: `deviceId ${id} does not belong to homeId ${homeId}` };
  }

  // For Sprint 8, hub_host executes Zigbee-plane rules. Enforce ieee presence when referenced.
  const trigDevId = trigger && typeof trigger === "object" ? Number(trigger.deviceId) : null;
  if (trigDevId && Number.isInteger(trigDevId)) {
    const d = byId.get(trigDevId);
    if (d && d.protocol === "ZIGBEE" && !d.zigbeeIeee) {
      return { ok: false, error: `trigger.deviceId ${trigDevId} is ZIGBEE but missing zigbeeIeee` };
    }
  }
  if (Array.isArray(actions)) {
    for (const a of actions) {
      const actDevId = a && typeof a === "object" ? Number(a.deviceId) : null;
      if (actDevId && Number.isInteger(actDevId)) {
        const d = byId.get(actDevId);
        if (d && d.protocol === "ZIGBEE" && !d.zigbeeIeee) {
          return { ok: false, error: `action.deviceId ${actDevId} is ZIGBEE but missing zigbeeIeee` };
        }
      }
    }
  }

  return { ok: true };
}

app.post("/homes/:homeId/automations", authRequired, async (req, res) => {
  const homeId = Number(req.params.homeId);
  if (!Number.isInteger(homeId)) return res.status(400).json({ error: "Invalid homeId" });

  const m = await requireHomeRoleOrAdmin(req, res, homeId, "ADMIN");
  if (!m) return;

  const parsed = automationCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const v = await validateAutomationDeviceRefs({ homeId, trigger: parsed.data.trigger, actions: parsed.data.actions });
  if (!v.ok) return res.status(400).json({ error: v.error });

  const rule = await prisma.automationRule.create({
    data: {
      homeId,
      name: parsed.data.name,
      enabled: parsed.data.enabled,
      triggerType: parsed.data.triggerType,
      trigger: parsed.data.trigger,
      actions: parsed.data.actions,
      executionPolicy: parsed.data.executionPolicy ?? null,
    },
  });

  const sync = await enqueueAutomationSync(prisma, mqttClient, { homeId, reason: `create rule ${rule.id}` }).catch((err) => ({ ok: false, error: err?.message || String(err) }));

  res.status(201).json({ rule, sync });
});

app.put("/automations/:id", authRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });

  const existing = await prisma.automationRule.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Automation not found" });

  const m = await requireHomeRoleOrAdmin(req, res, existing.homeId, "ADMIN");
  if (!m) return;

  const parsed = automationUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const trigger = parsed.data.trigger ?? existing.trigger;
  const actions = parsed.data.actions ?? existing.actions;
  const v = await validateAutomationDeviceRefs({ homeId: existing.homeId, trigger, actions });
  if (!v.ok) return res.status(400).json({ error: v.error });

  const rule = await prisma.automationRule.update({
    where: { id },
    data: {
      ...(parsed.data.name != null ? { name: parsed.data.name } : {}),
      ...(parsed.data.enabled != null ? { enabled: parsed.data.enabled } : {}),
      ...(parsed.data.triggerType != null ? { triggerType: parsed.data.triggerType } : {}),
      ...(parsed.data.trigger != null ? { trigger: parsed.data.trigger } : {}),
      ...(parsed.data.actions != null ? { actions: parsed.data.actions } : {}),
      ...(parsed.data.executionPolicy !== undefined ? { executionPolicy: parsed.data.executionPolicy ?? null } : {}),
    },
  });

  const sync = await enqueueAutomationSync(prisma, mqttClient, { homeId: existing.homeId, reason: `update rule ${id}` }).catch((err) => ({ ok: false, error: err?.message || String(err) }));

  res.json({ rule, sync });
});

app.delete("/automations/:id", authRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });

  const existing = await prisma.automationRule.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Automation not found" });

  const m = await requireHomeRoleOrAdmin(req, res, existing.homeId, "ADMIN");
  if (!m) return;

  await prisma.automationRule.delete({ where: { id } });
  const sync = await enqueueAutomationSync(prisma, mqttClient, { homeId: existing.homeId, reason: `delete rule ${id}` }).catch((err) => ({ ok: false, error: err?.message || String(err) }));

  res.json({ ok: true, sync });
});

app.post("/automations/:id/enable", authRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });

  const existing = await prisma.automationRule.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Automation not found" });
  const m = await requireHomeRoleOrAdmin(req, res, existing.homeId, "ADMIN");
  if (!m) return;

  const rule = await prisma.automationRule.update({ where: { id }, data: { enabled: true } });
  const sync = await enqueueAutomationSync(prisma, mqttClient, { homeId: existing.homeId, reason: `enable rule ${id}` }).catch((err) => ({ ok: false, error: err?.message || String(err) }));
  res.json({ rule, sync });
});

app.post("/automations/:id/disable", authRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });

  const existing = await prisma.automationRule.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Automation not found" });
  const m = await requireHomeRoleOrAdmin(req, res, existing.homeId, "ADMIN");
  if (!m) return;

  const rule = await prisma.automationRule.update({ where: { id }, data: { enabled: false } });
  const sync = await enqueueAutomationSync(prisma, mqttClient, { homeId: existing.homeId, reason: `disable rule ${id}` }).catch((err) => ({ ok: false, error: err?.message || String(err) }));
  res.json({ rule, sync });
});

app.get("/hubs/:hubId/automations/status", authRequired, async (req, res) => {
  const hubId = String(req.params.hubId || "");
  if (!hubId) return res.status(400).json({ error: "Invalid hubId" });

  const hub = await prisma.hub.findUnique({ where: { hubId } });
  if (!hub) return res.status(404).json({ error: "Hub not found" });

  const m = await requireHomeRoleOrAdmin(req, res, hub.homeId, "MEMBER");
  if (!m) return;

  const dep = await prisma.automationDeployment.findUnique({ where: { hubId_homeId: { hubId, homeId: hub.homeId } } });
  res.json({ hubId, homeId: hub.homeId, deployment: dep });
});

// -------------------------
// Hubs activation/binding (Inventory Serial -> Runtime hubId)

function extractMacSuffix6FromSerial(serial) {
  const s = String(serial || "").trim().toLowerCase();
  // Common format: hub-<macSuffix>
  const m1 = s.match(/hub-([0-9a-f]{6})/);
  if (m1) return m1[1];
  // Fallback: last 6 hex chars
  const m2 = s.match(/([0-9a-f]{6})$/);
  if (m2) return m2[1];
  return null;
}

function suffix6ToColon(suffix6) {
  if (!suffix6 || suffix6.length !== 6) return null;
  return suffix6.match(/../g).join(":");
}

async function findRuntimeHubForInventorySerial({ serial, installerMode }) {
  // 1) Dev mode / simplest: serial == hubId
  const direct = await prisma.hubRuntime.findUnique({ where: { hubId: serial } });
  if (direct) return direct;

  // 2) Recommended: match by MAC suffix from status payload
  const suffix6 = extractMacSuffix6FromSerial(serial);
  const suffixColon = suffix6ToColon(suffix6);
  if (suffixColon) {
    const candidates = await prisma.hubRuntime.findMany({
      where: { mac: { endsWith: suffixColon }, everOnline: true },
      orderBy: { lastSeenAt: "desc" },
      take: 5,
    });
    if (candidates.length) return candidates[0];
  }

  // 3) Installer mode (explicit flag): choose newest online unbound runtime
  if (installerMode) {
    const candidates = await prisma.hubRuntime.findMany({
      where: { online: true, binding: { is: null } },
      orderBy: { lastSeenAt: "desc" },
      take: 1,
    });
    if (candidates.length) return candidates[0];
  }

  return null;
}

async function activateHubFromInventory({ serial, setupCode, homeId, name, installerMode, userId }) {
  const inv = await prisma.hubInventory.findUnique({ where: { serial } });
  if (!inv) {
    return { ok: false, status: 404, error: "Hub serial not found in inventory" };
  }

  if (inv.status === "RETIRED") {
    return { ok: false, status: 409, error: "Hub inventory is retired" };
  }

  const passOk = await bcrypt.compare(setupCode, inv.setupCodeHash);
  if (!passOk) {
    return { ok: false, status: 401, error: "Invalid setup code" };
  }

  // Already bound?
  const existingBinding = await prisma.hubBinding.findUnique({ where: { inventorySerial: serial } });
  if (existingBinding) {
    if (existingBinding.homeId !== homeId) {
      return { ok: false, status: 409, error: "Hub already bound to another home" };
    }
    const hub = await prisma.hub.findUnique({ where: { hubId: existingBinding.hubId } });
    const runtime = await prisma.hubRuntime.findUnique({ where: { hubId: existingBinding.hubId } });
    return { ok: true, hub, runtime, binding: existingBinding, inventory: inv };
  }

  const runtime = await findRuntimeHubForInventorySerial({ serial, installerMode: !!installerMode });
  if (!runtime) {
    return {
      ok: false,
      status: 409,
      error:
        "Hub runtime not seen yet. Power on the hub and wait for it to publish home/hub/<hubId>/status (online=true).",
    };
  }

  // Prevent binding a hubId that is already bound to another inventory serial
  const bindingByHubId = await prisma.hubBinding.findUnique({ where: { hubId: runtime.hubId } });
  if (bindingByHubId) {
    return { ok: false, status: 409, error: "Hub runtime already bound" };
  }

  // Prevent cross-home hijack if Hub record already exists
  const existingHub = await prisma.hub.findUnique({ where: { hubId: runtime.hubId } });
  if (existingHub && existingHub.homeId !== homeId) {
    return { ok: false, status: 409, error: "Hub already exists and is bound to another home" };
  }

  const now = new Date();

  const binding = await prisma.hubBinding.create({
    data: { inventorySerial: serial, hubId: runtime.hubId, homeId, ownerId: userId, activatedAt: now },
  });

  const hub = await prisma.hub.upsert({
    where: { hubId: runtime.hubId },
    update: {
      homeId,
      name: name ?? undefined,
      firmwareVersion: runtime.fwVersion ?? undefined,
      mac: runtime.mac ?? undefined,
      ip: runtime.ip ?? undefined,
      rssi: runtime.rssi ?? undefined,
      online: runtime.online,
      lastSeen: runtime.lastSeenAt ?? undefined,
    },
    create: {
      hubId: runtime.hubId,
      homeId,
      name: name ?? null,
      firmwareVersion: runtime.fwVersion ?? null,
      mac: runtime.mac ?? null,
      ip: runtime.ip ?? null,
      rssi: runtime.rssi ?? null,
      online: runtime.online,
      lastSeen: runtime.lastSeenAt ?? null,
    },
  });

  const inventory = await prisma.hubInventory.update({
    where: { serial },
    data: { status: "BOUND", claimedAt: now, claimedByUserId: userId, claimedHomeId: homeId },
  });

  // MVP credential row (shared broker user). DB is ready for per-hub rotation later.
  const mqttUser = process.env.MQTT_USERNAME || "";
  const mqttPass = process.env.MQTT_PASSWORD || "";
  if (mqttUser && mqttPass) {
    const existing = await prisma.hubCredential.findFirst({
      where: { hubId: hub.hubId, revokedAt: null, username: mqttUser },
      orderBy: { id: "desc" },
    });
    if (!existing) {
      const secretHash = await bcrypt.hash(mqttPass, 10);
      await prisma.hubCredential.create({ data: { hubId: hub.hubId, username: mqttUser, secretHash } }).catch(() => {});
    }
  }

  let productModel = null;
  if (inventory.modelId) {
    productModel = await prisma.productModel.findUnique({ where: { id: inventory.modelId } });
  }

  const refreshedRuntime = await prisma.hubRuntime.findUnique({ where: { hubId: hub.hubId } });

  return {
    ok: true,
    hub,
    runtime: refreshedRuntime,
    binding,
    inventory,
    mqtt: { username: mqttUser || null, password: mqttPass || null },
    productModel,
  };
}

// -------------------------

app.post("/hubs/activate", authRequired, async (req, res) => {
  const parsed = hubActivateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { serial, hubSerial, setupCode, homeId, name, installerMode } = parsed.data;
  const resolvedSerial = (serial || hubSerial || "").trim();
  if (!resolvedSerial) return res.status(400).json({ error: "serial is required" });

  // Sprint 9: activation is MEMBER+ of that home
  const m = await requireHomeRole(req, res, homeId, "MEMBER");
  if (!m) return;

  const r = await activateHubFromInventory({
    serial: resolvedSerial,
    setupCode,
    homeId,
    name,
    installerMode,
    userId: req.user.id,
  });
  if (!r.ok) return res.status(r.status).json({ error: r.error });

  res.json({
    hubId: r.hub.hubId,
    boundHomeId: r.hub.homeId,
    inventorySerial: r.inventory?.serial || resolvedSerial,
    mqtt: r.mqtt,
    hub: r.hub,
    runtime: r.runtime
      ? {
          hubId: r.runtime.hubId,
          online: r.runtime.online,
          mac: r.runtime.mac,
          ip: r.runtime.ip,
          fwVersion: r.runtime.fwVersion,
          firstSeenAt: r.runtime.firstSeenAt,
          lastSeenAt: r.runtime.lastSeenAt,
          everOnline: r.runtime.everOnline,
        }
      : null,
    productModel: r.productModel,
  });
});

// Backward-compatible alias. /hubs/claim expects hubId, but we treat it as serial.
app.post("/hubs/claim", authRequired, async (req, res) => {
  const parsed = hubClaimSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { hubId, setupCode, homeId, name } = parsed.data;
  const m = await requireHomeRole(req, res, homeId, "MEMBER");
  if (!m) return;

  const r = await activateHubFromInventory({ serial: hubId, setupCode, homeId, name, installerMode: false, userId: req.user.id });
  if (!r.ok) return res.status(r.status).json({ error: r.error });

  // Keep original response shape.
  res.json({ hub: r.hub });
});

app.get("/hubs", authRequired, async (req, res) => {
  const homeIdRaw = req.query.homeId;
  const homeId = homeIdRaw != null ? Number(homeIdRaw) : null;
  if (!homeId || !Number.isInteger(homeId)) return res.status(400).json({ error: "homeId is required" });
  const m = await requireHomeRole(req, res, homeId, "MEMBER");
  if (!m) return;
  const hubs = await prisma.hub.findMany({ where: { homeId }, orderBy: { id: "asc" } });
  res.json({ hubs });
});

app.get("/hubs/:id", authRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
  const hub = await prisma.hub.findUnique({ where: { id } });
  if (!hub) return res.status(404).json({ error: "Hub not found" });
  const m = await requireHomeRole(req, res, hub.homeId, "MEMBER");
  if (!m) return;
  res.json({ hub });
});

// -------------------------
// Devices
// -------------------------

app.get("/devices", authRequired, async (req, res) => {
  const homeIdRaw = req.query.homeId;
  const roomIdRaw = req.query.roomId;

  const homeIdFilter = homeIdRaw != null ? Number(homeIdRaw) : null;
  const roomIdFilter = roomIdRaw != null ? Number(roomIdRaw) : null;

  if (homeIdRaw != null && (!Number.isInteger(homeIdFilter) || homeIdFilter <= 0)) {
    return res.status(400).json({ error: "Invalid homeId" });
  }

  if (roomIdRaw != null && (!Number.isInteger(roomIdFilter) || roomIdFilter <= 0)) {
    return res.status(400).json({ error: "Invalid roomId" });
  }

  let homeIds;
  if (homeIdFilter) {
    const m = await requireHomeRole(req, res, homeIdFilter, "MEMBER");
    if (!m) return;
    homeIds = [homeIdFilter];
  } else {
    const memberships = await prisma.homeMember.findMany({
      where: { userId: req.user.id },
      select: { homeId: true },
    });
    homeIds = memberships.map((m) => m.homeId);
  }

  const devices = await prisma.device.findMany({
    where: {
      homeId: { in: homeIds },
      ...(roomIdFilter ? { roomId: roomIdFilter } : {}),
    },
    include: {
      home: { select: { id: true, name: true } },
      room: { select: { id: true, name: true } },
      stateCurrent: true,
    },
    orderBy: { id: "asc" },
  });

  res.json({ devices });
});

// Deprecated: physical devices must be claimed from inventory.
app.post("/devices", authRequired, async (req, res) => {
  res.status(400).json({ error: "Use /devices/claim for physical devices (serial + setupCode)." });
});

// DEV only: create a virtual device with a random deviceId for UI testing.
app.post("/devices/virtual", authRequired, async (req, res) => {
  if (!isDevMode()) return res.status(403).json({ error: "Virtual devices are disabled in production" });
  const parsed = deviceCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { name, type, protocol, firmwareVersion } = parsed.data;

  let targetHomeId = parsed.data.homeId ?? (await pickDefaultAdminHomeId(req.user.id));
  if (!targetHomeId) return res.status(400).json({ error: "No admin home found for this user" });
  const m = await requireHomeRole(req, res, targetHomeId, "ADMIN");
  if (!m) return;

  // Resolve room
  let targetRoomId = parsed.data.roomId ?? null;
  const roomName = (parsed.data.room || "").trim();
  if (!targetRoomId && roomName) {
    const room = await prisma.room.upsert({
      where: { homeId_name: { homeId: targetHomeId, name: roomName } },
      update: {},
      create: { homeId: targetHomeId, name: roomName },
      select: { id: true },
    });
    targetRoomId = room.id;
  }
  if (targetRoomId) {
    const room = await prisma.room.findFirst({ where: { id: targetRoomId, homeId: targetHomeId }, select: { id: true } });
    if (!room) return res.status(400).json({ error: "roomId does not belong to this home" });
  }

  const deviceUuid = crypto.randomUUID();
  const device = await prisma.device.create({
    data: {
      name,
      type,
      protocol,
      firmwareVersion: firmwareVersion ?? null,
      deviceId: deviceUuid,
      homeId: targetHomeId,
      roomId: targetRoomId,
      createdById: req.user.id,
      lifecycleStatus: "BOUND",
      boundAt: new Date(),
    },
  });
  await prisma.deviceStateCurrent.upsert({
    where: { deviceId: device.id },
    update: {},
    create: { deviceId: device.id, state: null, online: false },
  });
  const prefix = topicPrefixForDevice({ homeId: device.homeId, deviceId: device.deviceId });
  res.status(201).json({ device, mqtt: { prefix, set: `${prefix}/set`, ack: `${prefix}/ack`, state: `${prefix}/state`, status: `${prefix}/status` } });
});

// Real onboarding: claim a physical device by serial + setupCode.
app.post("/devices/claim", authRequired, async (req, res) => {
  const parsed = deviceClaimSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { serial, setupCode, homeId, name, type, protocol, roomId, room } = parsed.data;
  const m = await requireHomeRole(req, res, homeId, "ADMIN");
  if (!m) return;

  const inv = await prisma.deviceInventory.findUnique({ where: { serial } });
  if (!inv) return res.status(404).json({ error: "Serial not found in inventory" });

  const ok = await bcrypt.compare(setupCode, inv.setupCodeHash);
  if (!ok) return res.status(401).json({ error: "Invalid setup code" });
  if (inv.status === "REVOKED") return res.status(409).json({ error: "Inventory is revoked" });
  if ((inv.status === "CLAIMED" || inv.status === "BOUND") && inv.claimedHomeId && inv.claimedHomeId !== homeId) {
    return res.status(409).json({ error: "Device already claimed by another home" });
  }

  const resolvedRoomId = await resolveRoomId(homeId, roomId ?? null, room ?? null);
  if (resolvedRoomId) {
    const okRoom = await prisma.room.findFirst({ where: { id: resolvedRoomId, homeId }, select: { id: true } });
    if (!okRoom) return res.status(400).json({ error: "roomId does not belong to this home" });
  }

  const effectiveProtocol = protocol ?? inv.protocol;

  // Lookup descriptor early so Zigbee SERIAL_FIRST can return it without provisioning
  let productModel = null;
  if (inv.modelId) {
    productModel = await prisma.productModel.findUnique({ where: { id: inv.modelId } });
  }

  // Sprint 2 (SERIAL_FIRST): claiming a Zigbee device serial should NOT mark it BOUND yet.
  // The IEEE binding + finalization happens at /zigbee/pairing/confirm.
  if (effectiveProtocol === "ZIGBEE") {
    if (inv.status === "BOUND") {
      return res.status(409).json({ error: "Device inventory is already bound" });
    }

    await prisma.deviceInventory.update({
      where: { serial },
      data: {
        status: "CLAIMED",
        claimedAt: new Date(),
        claimedByUserId: req.user.id,
        claimedHomeId: homeId,
      },
    });

    return res.json({
      ok: true,
      inventory: {
        serial,
        protocol: "ZIGBEE",
        modelId: inv.modelId ?? null,
        status: "CLAIMED",
      },
      productModel,
      next: {
        zigbee: {
          mode: "SERIAL_FIRST",
          claimedSerial: serial,
          hint: "Call /zigbee/pairing/open with mode=SERIAL_FIRST then power-on/join device to bind IEEE.",
        },
      },
    });
  }

  const device = await prisma.device.upsert({
    where: { deviceId: inv.deviceUuid },
    update: {
      homeId,
      roomId: resolvedRoomId,
      name: name ?? `${inv.typeDefault || "device"}-${serial}`,
      type: (type ?? inv.typeDefault ?? "relay"),
      protocol: (protocol ?? inv.protocol),
      serial,
      modelId: inv.modelId ?? null,
      lifecycleStatus: "BOUND",
      boundAt: new Date(),
      unboundAt: null,
      lastProvisionedAt: new Date(),
    },
    create: {
      name: name ?? `${inv.typeDefault || "device"}-${serial}`,
      type: (type ?? inv.typeDefault ?? "relay"),
      protocol: (protocol ?? inv.protocol),
      deviceId: inv.deviceUuid,
      homeId,
      roomId: resolvedRoomId,
      createdById: req.user.id,
      serial,
      modelId: inv.modelId ?? null,
      lifecycleStatus: "BOUND",
      boundAt: new Date(),
      lastProvisionedAt: new Date(),
    },
  });

  await prisma.deviceStateCurrent.upsert({
    where: { deviceId: device.id },
    update: {},
    create: { deviceId: device.id, state: null, online: false },
  });

  await prisma.deviceInventory.update({
    where: { serial },
    data: {
      status: "BOUND",
      claimedAt: new Date(),
      claimedByUserId: req.user.id,
      claimedHomeId: homeId,
    },
  });

  // MVP credential row (shared broker user)
  const mqttUser = process.env.MQTT_USERNAME || "";
  const mqttPass = process.env.MQTT_PASSWORD || "";
  if (mqttUser && mqttPass) {
    const secretHash = await bcrypt.hash(mqttPass, 10);
    await prisma.deviceCredential.create({ data: { deviceId: device.id, username: mqttUser, secretHash } }).catch(() => {});
  }

  // productModel already fetched above

  const publicHost = process.env.MQTT_PUBLIC_HOST || parsePublicMqttHost();
  const publicPort = Number(process.env.MQTT_PUBLIC_PORT || 1883);
  const prefix = topicPrefixForDevice({ homeId: device.homeId, deviceId: device.deviceId });

  res.json({
    device,
    productModel,
    provisioning: {
      homeId: device.homeId,
      deviceId: device.deviceId,
      mqttHost: publicHost,
      mqttPort: publicPort,
      mqttUsername: mqttUser || null,
      mqttPassword: mqttPass || null,
      topics: {
        prefix,
        set: `${prefix}/set`,
        ack: `${prefix}/ack`,
        state: `${prefix}/state`,
        status: `${prefix}/status`,
      },
    },
  });
});

// -------------------------
// Reset flows
// -------------------------

async function publishMgmtAndMarkSent({ homeId, deviceUuid, deviceDbId, resetRequestId, cmdId, action, reason }) {
  return await new Promise((resolve) => {
    const topic = `${topicPrefixForDevice({ homeId, deviceId: deviceUuid })}/set`;
    const body = { cmdId, ts: Date.now(), payload: { mgmt: { action, reason: reason ?? null } } };
    mqttClient.publish(topic, JSON.stringify(body), { qos: 1 }, async (err) => {
      if (err) {
        await prisma.resetRequest.update({ where: { id: resetRequestId }, data: { status: "FAILED", ackedAt: new Date(), error: err?.message || String(err) } }).catch(() => {});
        return resolve({ ok: false, error: err?.message || String(err) });
      }
      await prisma.resetRequest.update({ where: { id: resetRequestId }, data: { status: "SENT" } }).catch(() => {});
      emitToHome(homeId, "reset_request_updated", { homeId, deviceDbId, deviceId: deviceUuid, cmdId, status: "SENT", ackedAt: null, error: null });
      return resolve({ ok: true });
    });
  });
}

app.post("/devices/:id/reset-connection", authRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
  const device = await prisma.device.findUnique({ where: { id }, select: { id: true, homeId: true, deviceId: true } });
  if (!device) return res.status(404).json({ error: "Device not found" });
  const m = await requireHomeRole(req, res, device.homeId, "MEMBER");
  if (!m) return;

  const cmdId = crypto.randomUUID();
  const resetRequest = await prisma.resetRequest.create({
    data: {
      deviceId: device.id,
      cmdId,
      type: "RECONNECT",
      status: "PENDING",
      requestedByUserId: req.user.id,
    },
  });

  const pub = await publishMgmtAndMarkSent({ homeId: device.homeId, deviceUuid: device.deviceId, deviceDbId: device.id, resetRequestId: resetRequest.id, cmdId, action: "reset_connection" });
  res.json({ ok: true, resetRequest, publish: pub });
});

app.post("/devices/:id/factory-reset", authRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
  const device = await prisma.device.findUnique({ where: { id }, select: { id: true, homeId: true, deviceId: true, serial: true } });
  if (!device) return res.status(404).json({ error: "Device not found" });
  const m = await requireHomeRole(req, res, device.homeId, "ADMIN");
  if (!m) return;

  const cmdId = crypto.randomUUID();
  const resetRequest = await prisma.resetRequest.create({
    data: {
      deviceId: device.id,
      cmdId,
      type: "FACTORY_RESET",
      status: "PENDING",
      requestedByUserId: req.user.id,
    },
  });

  const now = new Date();

  // Revoke credential rows (MVP)
  await prisma.deviceCredential.updateMany({ where: { deviceId: device.id, revokedAt: null }, data: { revokedAt: now } }).catch(() => {});

  // Soft unbind the device (keep row for audit/history)
  await prisma.device.update({ where: { id: device.id }, data: { lifecycleStatus: "UNBOUND", unboundAt: now } }).catch(() => {});

  // Return inventory back to FACTORY_NEW so it can be claimed into another home.
  if (device.serial) {
    await prisma.deviceInventory
      .update({
        where: { serial: device.serial },
        data: { status: "FACTORY_NEW", claimedAt: null, claimedByUserId: null, claimedHomeId: null },
      })
      .catch(() => {});
  }

  const pub = await publishMgmtAndMarkSent({ homeId: device.homeId, deviceUuid: device.deviceId, deviceDbId: device.id, resetRequestId: resetRequest.id, cmdId, action: "factory_reset" });
  res.json({ ok: true, resetRequest, publish: pub });
});


app.put("/devices/:id", authRequired, async (req, res) => {
  const deviceId = Number(req.params.id);
  if (!Number.isInteger(deviceId)) return res.status(400).json({ error: "Invalid id" });

  const parsed = deviceUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) return res.status(404).json({ error: "Not found" });

  const m = await requireHomeRole(req, res, device.homeId, "ADMIN");
  if (!m) return;

  const updateData = { ...parsed.data };

  // Resolve room by name (optional)
  const roomName = (updateData.room || "").trim();
  if (roomName) {
    const room = await prisma.room.upsert({
      where: { homeId_name: { homeId: device.homeId, name: roomName } },
      update: {},
      create: { homeId: device.homeId, name: roomName },
      select: { id: true },
    });
    updateData.roomId = room.id;
  }
  delete updateData.room;

  if (updateData.roomId) {
    const room = await prisma.room.findFirst({ where: { id: updateData.roomId, homeId: device.homeId } });
    if (!room) return res.status(400).json({ error: "roomId does not belong to this home" });
  }

  const updated = await prisma.device.update({ where: { id: deviceId }, data: updateData });
  res.json({ device: updated });
});


app.delete("/devices/:id", authRequired, async (req, res) => {
  const deviceId = Number(req.params.id);
  if (!Number.isInteger(deviceId)) return res.status(400).json({ error: "Invalid id" });

  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) return res.status(404).json({ error: "Not found" });

  const m = await requireHomeRole(req, res, device.homeId, "ADMIN");
  if (!m) return;

  await prisma.device.delete({ where: { id: deviceId } });
  res.json({ ok: true });
});

// -------------------------
// Commands (tracking: cmdId + ACK + TIMEOUT)
// -------------------------

async function createAndPublishZigbeeActionCommand({ device, action, argsForDb, argsForPublish }) {
  if (device.protocol !== "ZIGBEE") {
    throw new Error("createAndPublishZigbeeActionCommand requires ZIGBEE device");
  }
  if (!device.zigbeeIeee) {
    throw new Error("Zigbee device missing zigbeeIeee");
  }
  if (!mqttClient.connected) {
    const err = new Error("MQTT not connected");
    // @ts-ignore
    err.httpStatus = 503;
    throw err;
  }

  const cmdId = crypto.randomUUID();
  const payloadDb = { action, args: argsForDb ?? {} };

  const created = await prisma.command.create({
    data: {
      deviceId: device.id,
      cmdId,
      payload: payloadDb,
      status: "PENDING",
    },
    select: { sentAt: true },
  });

  const topic = `home/zb/${device.zigbeeIeee}/set`;
  const argsOut = argsForPublish ?? argsForDb ?? {};
  // Sprint 5: publish both `args` (contract v1) and `params` (alias) to be safe.
  const body = { cmdId, ts: Date.now(), action, args: argsOut, params: argsOut };

  mqttClient.publish(topic, JSON.stringify(body), { qos: 1 }, (err) => {
    if (err) console.warn("[MQTT] publish zigbee set failed:", err?.message || err);
  });

  // Emit immediate PENDING update so clients can update UI instantly
  emitToHome(device.homeId, "command_updated", {
    homeId: device.homeId,
    deviceDbId: device.id,
    deviceId: device.deviceId,
    ieee: device.zigbeeIeee,
    cmdId,
    status: "PENDING",
    sentAt: created.sentAt.toISOString(),
    ackedAt: null,
    error: null,
    protocol: "ZIGBEE",
  });

  return { cmdId, status: "PENDING" };
}

app.post("/devices/:id/command", authRequired, async (req, res) => {
  const deviceDbId = Number(req.params.id);
  if (!Number.isInteger(deviceDbId)) return res.status(400).json({ error: "Invalid device id" });

  const device = await prisma.device.findUnique({
    where: { id: deviceDbId },
    select: { id: true, homeId: true, deviceId: true, type: true, protocol: true, zigbeeIeee: true },
  });
  if (!device) return res.status(404).json({ error: "Device not found" });

  const m = await requireHomeRole(req, res, device.homeId, "MEMBER");
  if (!m) return;

  // Payload validation and translation
  // - Legacy (MQTT-device plane): type-based { relay | pwm | rgb | mgmt | ota }
  // - Sprint 4 (Zigbee): action-based { action, params } (also accepts { action, args })
  let payload;
  const body = req.body || {};
  if (typeof body.action === "string" && body.action.trim() !== "") {
    if (device.protocol !== "ZIGBEE") {
      return res.status(400).json({ error: "action-based commands are only supported for Zigbee devices" });
    }
    const action = body.action.trim();
    const params = body.params ?? body.args ?? {};
    if (params != null && (typeof params !== "object" || Array.isArray(params))) {
      return res.status(400).json({ error: "params must be an object" });
    }
    payload = { action, args: params };
  } else {
    const validation = validateCommandForType(device.type, body);
    if (!validation.ok) return res.status(400).json({ error: validation.error });
    payload = validation.payload;
  }

  if (!mqttClient.connected) {
    return res.status(503).json({ error: "MQTT not connected" });
  }

  // Sprint 4+: Zigbee action-based commands use the canonical Zigbee plane envelope.
  // Reuse the same helper as Sprint 5 SmartLock endpoints to avoid duplicated logic.
  if (device.protocol === "ZIGBEE" && payload?.action) {
    try {
      let argsForDb = payload.args ?? {};
      let argsForPublish = payload.args ?? {};

      // If someone uses the generic /command endpoint for SmartLock actions,
      // keep DB safe (store secretHash) while still publishing plaintext to the device.
      if (payload.action === "lock.add_pin") {
        const parsed = lockAddPinSchema.safeParse(argsForPublish);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.flatten() });
        }
        const secretHash = await bcrypt.hash(String(parsed.data.pin), 10);
        argsForDb = { slot: parsed.data.slot, label: parsed.data.label ?? null, secretHash };
      }
      if (payload.action === "lock.add_rfid") {
        const parsed = lockAddRfidSchema.safeParse(argsForPublish);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.flatten() });
        }
        const secretHash = await bcrypt.hash(String(parsed.data.uid).toLowerCase(), 10);
        argsForDb = { slot: parsed.data.slot, label: parsed.data.label ?? null, secretHash };
      }

      const r = await createAndPublishZigbeeActionCommand({
        device,
        action: payload.action,
        argsForDb,
        argsForPublish,
      });
      return res.status(201).json(r);
    } catch (e) {
      const httpStatus = e?.httpStatus || e?.statusCode || null;
      if (Number.isInteger(httpStatus)) {
        return res.status(httpStatus).json({ error: e?.message || "failed" });
      }
      console.warn("[command] zigbee publish failed:", e?.message || e);
      return res.status(500).json({ error: "Failed to send Zigbee command" });
    }
  }

  const cmdId = crypto.randomUUID();
  // payload resolved above

  const created = await prisma.command.create({
    data: {
      deviceId: device.id,
      cmdId,
      payload,
      status: "PENDING",
    },
    select: { sentAt: true },
  });

  // Publish QoS1
  if (device.protocol === "ZIGBEE" && device.zigbeeIeee) {
    // Zigbee plane: home/zb/<ieee>/set
    // Sprint 5: also include params alias for firmwares that expect params.
    const topic = `home/zb/${device.zigbeeIeee}/set`;
    const argsOut = payload?.args ?? {};
    const body = { cmdId, ts: Date.now(), ...payload, params: argsOut };
    mqttClient.publish(topic, JSON.stringify(body), { qos: 1 }, (err) => {
      if (err) console.warn("[MQTT] publish zigbee set failed:", err?.message || err);
    });
  } else {
    // MQTT-device plane: home/<homeId>/device/<deviceId>/set
    publishCommand(mqttClient, {
      homeId: device.homeId,
      deviceId: device.deviceId,
      cmdId,
      payload,
    });
  }

  // Emit immediate PENDING update so clients can update UI instantly
  // (ACK/TIMEOUT will come later)
  emitToHome(device.homeId, "command_updated", {
    homeId: device.homeId,
    deviceDbId: device.id,
    deviceId: device.deviceId,
    cmdId,
    status: "PENDING",
    sentAt: created.sentAt.toISOString(),
    ackedAt: null,
    error: null,
  });

  res.status(201).json({ cmdId, status: "PENDING" });
});

// -------------------------
// Sprint 5: SmartLock APIs (credential mgmt)
// -------------------------

app.post("/devices/:id/lock/pins", authRequired, async (req, res) => {
  const deviceDbId = Number(req.params.id);
  if (!Number.isInteger(deviceDbId)) return res.status(400).json({ error: "Invalid device id" });

  const device = await prisma.device.findUnique({
    where: { id: deviceDbId },
    select: { id: true, homeId: true, deviceId: true, protocol: true, zigbeeIeee: true },
  });
  if (!device) return res.status(404).json({ error: "Device not found" });

  const m = await requireHomeRole(req, res, device.homeId, "ADMIN");
  if (!m) return;

  if (device.protocol !== "ZIGBEE" || !device.zigbeeIeee) {
    return res.status(400).json({ error: "SmartLock APIs require a Zigbee-plane device" });
  }

  const parsed = lockAddPinSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues?.[0]?.message || "Invalid body" });
  }

  const { slot, label, pin } = parsed.data;
  const secretHash = await bcrypt.hash(pin, 10);

  try {
    const r = await createAndPublishZigbeeActionCommand({
      device,
      action: "lock.add_pin",
      argsForDb: { slot, label: label ?? null, secretHash },
      argsForPublish: { slot, label: label ?? null, pin },
    });
    return res.status(201).json(r);
  } catch (e) {
    const httpStatus = e?.httpStatus || e?.statusCode || null;
    if (Number.isInteger(httpStatus)) {
      return res.status(httpStatus).json({ error: e?.message || "failed" });
    }
    console.warn("[lock] add_pin failed:", e?.message || e);
    return res.status(500).json({ error: "Failed to send command" });
  }
});

app.delete("/devices/:id/lock/pins/:slot", authRequired, async (req, res) => {
  const deviceDbId = Number(req.params.id);
  if (!Number.isInteger(deviceDbId)) return res.status(400).json({ error: "Invalid device id" });

  const slot = Number(req.params.slot);
  if (!Number.isInteger(slot) || slot < 0 || slot > 255) {
    return res.status(400).json({ error: "Invalid slot" });
  }

  const device = await prisma.device.findUnique({
    where: { id: deviceDbId },
    select: { id: true, homeId: true, deviceId: true, protocol: true, zigbeeIeee: true },
  });
  if (!device) return res.status(404).json({ error: "Device not found" });

  const m = await requireHomeRole(req, res, device.homeId, "ADMIN");
  if (!m) return;

  if (device.protocol !== "ZIGBEE" || !device.zigbeeIeee) {
    return res.status(400).json({ error: "SmartLock APIs require a Zigbee-plane device" });
  }

  try {
    const r = await createAndPublishZigbeeActionCommand({
      device,
      action: "lock.delete_pin",
      argsForDb: { slot },
      argsForPublish: { slot },
    });
    return res.status(201).json(r);
  } catch (e) {
    const httpStatus = e?.httpStatus || e?.statusCode || null;
    if (Number.isInteger(httpStatus)) {
      return res.status(httpStatus).json({ error: e?.message || "failed" });
    }
    console.warn("[lock] delete_pin failed:", e?.message || e);
    return res.status(500).json({ error: "Failed to send command" });
  }
});

app.post("/devices/:id/lock/rfid", authRequired, async (req, res) => {
  const deviceDbId = Number(req.params.id);
  if (!Number.isInteger(deviceDbId)) return res.status(400).json({ error: "Invalid device id" });

  const device = await prisma.device.findUnique({
    where: { id: deviceDbId },
    select: { id: true, homeId: true, deviceId: true, protocol: true, zigbeeIeee: true },
  });
  if (!device) return res.status(404).json({ error: "Device not found" });

  const m = await requireHomeRole(req, res, device.homeId, "ADMIN");
  if (!m) return;

  if (device.protocol !== "ZIGBEE" || !device.zigbeeIeee) {
    return res.status(400).json({ error: "SmartLock APIs require a Zigbee-plane device" });
  }

  const parsed = lockAddRfidSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues?.[0]?.message || "Invalid body" });
  }

  const { slot, label, uid } = parsed.data;
  const secretHash = await bcrypt.hash(uid, 10);

  try {
    const r = await createAndPublishZigbeeActionCommand({
      device,
      action: "lock.add_rfid",
      argsForDb: { slot, label: label ?? null, secretHash },
      argsForPublish: { slot, label: label ?? null, uid },
    });
    return res.status(201).json(r);
  } catch (e) {
    const httpStatus = e?.httpStatus || e?.statusCode || null;
    if (Number.isInteger(httpStatus)) {
      return res.status(httpStatus).json({ error: e?.message || "failed" });
    }
    console.warn("[lock] add_rfid failed:", e?.message || e);
    return res.status(500).json({ error: "Failed to send command" });
  }
});

app.delete("/devices/:id/lock/rfid/:slot", authRequired, async (req, res) => {
  const deviceDbId = Number(req.params.id);
  if (!Number.isInteger(deviceDbId)) return res.status(400).json({ error: "Invalid device id" });

  const slot = Number(req.params.slot);
  if (!Number.isInteger(slot) || slot < 0 || slot > 255) {
    return res.status(400).json({ error: "Invalid slot" });
  }

  const device = await prisma.device.findUnique({
    where: { id: deviceDbId },
    select: { id: true, homeId: true, deviceId: true, protocol: true, zigbeeIeee: true },
  });
  if (!device) return res.status(404).json({ error: "Device not found" });

  const m = await requireHomeRole(req, res, device.homeId, "ADMIN");
  if (!m) return;

  if (device.protocol !== "ZIGBEE" || !device.zigbeeIeee) {
    return res.status(400).json({ error: "SmartLock APIs require a Zigbee-plane device" });
  }

  try {
    const r = await createAndPublishZigbeeActionCommand({
      device,
      action: "lock.delete_rfid",
      argsForDb: { slot },
      argsForPublish: { slot },
    });
    return res.status(201).json(r);
  } catch (e) {
    const httpStatus = e?.httpStatus || e?.statusCode || null;
    if (Number.isInteger(httpStatus)) {
      return res.status(httpStatus).json({ error: e?.message || "failed" });
    }
    console.warn("[lock] delete_rfid failed:", e?.message || e);
    return res.status(500).json({ error: "Failed to send command" });
  }
});

// Command history (mobile can paginate instead of storing everything in memory)
app.get("/devices/:id/commands", authRequired, async (req, res) => {
  const deviceDbId = Number(req.params.id);
  if (!Number.isInteger(deviceDbId)) return res.status(400).json({ error: "Invalid device id" });

  const device = await prisma.device.findUnique({
    where: { id: deviceDbId },
    select: { id: true, homeId: true },
  });
  if (!device) return res.status(404).json({ error: "Device not found" });

  const m = await requireHomeRole(req, res, device.homeId, "MEMBER");
  if (!m) return;

  const limitRaw = Number(req.query.limit ?? 20);
  const limit = Math.max(1, Math.min(100, Number.isFinite(limitRaw) ? limitRaw : 20));
  const cursorRaw = req.query.cursor ? Number(req.query.cursor) : null;
  const cursor = Number.isInteger(cursorRaw) && cursorRaw > 0 ? cursorRaw : null;

  const rows = await prisma.command.findMany({
    where: { deviceId: device.id },
    orderBy: { id: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      cmdId: true,
      payload: true,
      status: true,
      sentAt: true,
      ackedAt: true,
      error: true,
    },
  });

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const nextCursor = hasMore ? items[items.length - 1].id : null;

  res.json({
    items,
    nextCursor,
  });
});

// -------------------------
// Zigbee (pairing + discovery)
// -------------------------
//
// Production note:
// - Pairing sessions are persisted in DB (ZigbeePairingSession) so backend restart does not break pairing UX.
// - Hub communicates over MQTT topics: home/hub/<hubId>/zigbee/*
// - Hub publishes discovered devices to: home/hub/<hubId>/zigbee/discovered

function getPairingDurationSec(body) {
  const v = Number(body?.durationSec);
  if (!Number.isFinite(v)) return 60;
  return Math.max(10, Math.min(300, Math.floor(v)));
}

async function pruneExpiredPairingSessionsDb() {
  const now = new Date();
  await prisma.zigbeePairingSession.deleteMany({ where: { expiresAt: { lt: now } } });
}

async function requireValidPairingSession(token, userId) {
  const session = await prisma.zigbeePairingSession.findUnique({ where: { token } });
  if (!session) return null;
  if (session.expiresAt && Date.now() > session.expiresAt.getTime()) return null;

  // v5: session is bound to a home (hub-first flow). Any ADMIN in that home can use it.
  if (session.homeId) {
    const m = await getMembership(userId, session.homeId);
    if (!m || !roleAtLeast(m.role, "ADMIN")) return null;
    return session;
  }

  // Backward compatibility: older sessions without homeId fall back to strict owner check.
  if (session.ownerId !== userId) return null;
  return session;
}

/**
 * Sprint 11: send Identify command to a Zigbee end-device through the Zigbee plane.
 *
 * MQTT topic: home/zb/<ieee>/set
 * Payload: {cmdId, ts, action:"identify", args:{time}}
 */
function sendZigbeeIdentify(ieee, timeSec = 4) {
  const norm = normalizeIeee(ieee);
  if (!norm) throw new Error("invalid ieee");
  const t = Math.max(0, Math.min(10, Math.floor(Number(timeSec) || 0)));
  const cmdId = crypto.randomUUID();
  const topic = `home/zb/${norm}/set`;
  const body = { cmdId, ts: Date.now(), action: "identify", args: { time: t }, params: { time: t } };
  mqttClient.publish(topic, JSON.stringify(body), { qos: 1 }, (err) => {
    if (err) console.warn("[MQTT] identify publish failed:", err?.message || err);
  });
  return cmdId;
}

/**
 * Shared pairing-session creation logic.
 * Used by both legacy `/zigbee/pairing/open` and hub-scoped `/hubs/:hubId/pairing/open`.
 */
async function openZigbeePairingSession(req, res, input) {
  await pruneExpiredPairingSessionsDb();

  const requestedHubId = (input?.hubId || "").toString() || null;
  const requestedHomeId = input?.homeId != null ? Number(input.homeId) : null;

  // Sprint 2: pairing mode
  const mode = (input?.mode || (input?.claimedSerial ? "SERIAL_FIRST" : input?.expectedModelId ? "TYPE_FIRST" : "LEGACY")).toString();
  const claimedSerial = (input?.claimedSerial || "").toString() || null;
  const expectedModelId = (input?.expectedModelId || "").toString() || null;

  // Determine hub + home in a backward compatible way:
  // - Legacy clients send homeId and may omit hubId (if only 1 hub)
  // - Sprint 2 clients can send hubId and omit homeId (derive from bound hub)
  let hubId = requestedHubId;
  let targetHomeId = requestedHomeId;

  if (!hubId && targetHomeId) {
    const hubs = await prisma.hub.findMany({ where: { homeId: targetHomeId }, select: { hubId: true } });
    if (hubs.length === 1) hubId = hubs[0].hubId;
  }

  if (!hubId && process.env.ZIGBEE_HUB_ID) {
    // optional fallback for local dev
    hubId = process.env.ZIGBEE_HUB_ID;
  }

  if (!hubId) {
    res.status(400).json({ error: "hubId is required" });
    return null;
  }

  // Lookup hub + bound home
  const hub = await prisma.hub.findFirst({ where: { hubId }, select: { hubId: true, homeId: true } });
  if (!hub || !hub.homeId) {
    res.status(400).json({ error: "Hub not found or not bound to any home (activate hub first)" });
    return null;
  }

  if (!targetHomeId) targetHomeId = hub.homeId;
  if (targetHomeId !== hub.homeId) {
    res.status(400).json({ error: "hubId does not belong to homeId" });
    return null;
  }

  const m = await requireHomeRole(req, res, targetHomeId, "ADMIN");
  if (!m) return null;

  // Validate Sprint 2 flow params
  if (mode === "SERIAL_FIRST") {
    if (!claimedSerial) {
      res.status(400).json({ error: "claimedSerial is required for SERIAL_FIRST" });
      return null;
    }
    const inv = await prisma.deviceInventory.findUnique({ where: { serial: claimedSerial }, select: { serial: true, protocol: true, status: true, claimedHomeId: true } });
    if (!inv) {
      res.status(404).json({ error: "claimedSerial not found in inventory" });
      return null;
    }
    if (inv.protocol !== "ZIGBEE") {
      res.status(400).json({ error: "claimedSerial must be a ZIGBEE inventory" });
      return null;
    }
    if (inv.status !== "CLAIMED" || inv.claimedHomeId !== targetHomeId) {
      res.status(409).json({ error: "claimedSerial must be claimed by this home first (call /devices/claim)" });
      return null;
    }
  }

  if (mode === "TYPE_FIRST") {
    // Sprint 11: allow expectedModelId to be omitted.
    // If present, validate it is a ZIGBEE ProductModel.
    if (expectedModelId) {
      const pm = await prisma.productModel.findUnique({ where: { id: expectedModelId }, select: { id: true, protocol: true } });
      if (!pm) {
        res.status(404).json({ error: "expectedModelId not found" });
        return null;
      }
      if (pm.protocol !== "ZIGBEE") {
        res.status(400).json({ error: "expectedModelId must be a ZIGBEE ProductModel" });
        return null;
      }
    }
  }

  const token = crypto.randomUUID();
  const durationSec = getPairingDurationSec({ durationSec: input?.durationSec ?? 60 });
  const expiresAt = new Date(Date.now() + durationSec * 1000);

  await prisma.zigbeePairingSession.create({
    data: {
      token,
      ownerId: req.user.id,
      hubId,
      homeId: targetHomeId,
      mode,
      claimedSerial,
      expectedModelId: expectedModelId || null,
      expiresAt,
    },
  });

  mqttClient.publish(
    `home/hub/${hubId}/zigbee/pairing/open`,
    JSON.stringify({ token, durationSec, mode, claimedSerial, expectedModelId: expectedModelId || null }),
    { qos: 1 },
  );

  return {
    token,
    hubId,
    homeId: targetHomeId,
    expiresAt: expiresAt.toISOString(),
    mode,
    claimedSerial,
    expectedModelId: expectedModelId || null,
  };
}


async function resolveRoomId(homeId, roomId, roomName) {
  let targetRoomId = roomId ?? null;
  const name = (roomName || "").trim();
  if (!targetRoomId && name) {
    const room = await prisma.room.upsert({
      where: { homeId_name: { homeId, name } },
      update: {},
      create: { homeId, name },
      select: { id: true },
    });
    targetRoomId = room.id;
  }
  return targetRoomId;
}

function parsePublicMqttHost() {
  // If MQTT_URL is something like mqtt://mosquitto:1883 (inside Docker),
  // that host is NOT reachable by phones/ESP32 on the LAN.
  // Use MQTT_PUBLIC_HOST in .env for real devices.
  const url = process.env.MQTT_URL || "";
  try {
    const u = new URL(url);
    return u.hostname || "localhost";
  } catch {
    return "localhost";
  }
}

function defaultHubId(body) {
  // NOTE: v5 hubs default to `hub-<macSuffix>`; avoid hardcoding hub1.
  return (body?.hubId || process.env.ZIGBEE_HUB_ID || "hub-unknown").toString();
}

/**
 * Sprint 12: Device descriptor
 *
 * Purpose: allow the mobile app to render device-specific UI by
 * model capabilities + uiSchema (plugin registry).
 */
app.get("/devices/:id/descriptor", authRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid device id" });

  const device = await prisma.device.findUnique({
    where: { id },
    include: {
      productModel: { select: { id: true, capabilities: true, uiSchema: true } },
    },
  });
  if (!device) return res.status(404).json({ error: "Device not found" });

  const m = await requireHomeRole(req, res, device.homeId, "MEMBER");
  if (!m) return;

  const descriptor = buildDescriptorFromProductModel(device.productModel ?? null);

  // If the device has modelId but ProductModel missing (dev), still return modelId.
  if (!descriptor.modelId && device.modelId) {
    descriptor.modelId = device.modelId;
  }

  return res.json({ deviceId: device.id, descriptor });
});


/**
 * Current state snapshot
 * - populated by MQTT ingest (MQTT device plane + Zigbee plane)
 */
app.get("/devices/:id/state", authRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid device id" });

  const device = await prisma.device.findUnique({
    where: { id },
    select: { id: true, homeId: true, deviceId: true, protocol: true, zigbeeIeee: true },
  });
  if (!device) return res.status(404).json({ error: "Device not found" });

  const m = await requireHomeRole(req, res, device.homeId, "MEMBER");
  if (!m) return;

  const current = await prisma.deviceStateCurrent.findUnique({
    where: { deviceId: device.id },
    select: { state: true, online: true, lastSeen: true, updatedAt: true },
  });

  res.json({
    deviceId: device.id,
    deviceUuid: device.deviceId,
    protocol: device.protocol,
    zigbeeIeee: device.zigbeeIeee || null,
    snapshot: current
      ? {
          state: current.state,
          online: current.online,
          lastSeen: current.lastSeen ? current.lastSeen.toISOString() : null,
          updatedAt: current.updatedAt.toISOString(),
        }
      : null,
  });
});

/**
 * Device events (time-series)
 * - populated by Zigbee plane ingest (home/zb/<ieee>/event)
 * - filter by day using createdAt (UTC day) when `date=YYYY-MM-DD` is provided
 */
app.get("/devices/:id/events", authRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid device id" });

  const device = await prisma.device.findUnique({ where: { id }, select: { id: true, homeId: true } });
  if (!device) return res.status(404).json({ error: "Device not found" });

  const m = await requireHomeRole(req, res, device.homeId, "MEMBER");
  if (!m) return;

  const dateStr = (req.query.date || "").toString().trim();
  let createdAtFilter = undefined;

  if (dateStr) {
    // interpret as UTC day (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    }
    const start = new Date(dateStr + "T00:00:00.000Z");
    if (Number.isNaN(start.getTime())) {
      return res.status(400).json({ error: "Invalid date" });
    }
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    createdAtFilter = { gte: start, lt: end };
  }

  const limitRaw = Number(req.query.limit ?? 200);
  const limit = Math.max(1, Math.min(1000, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 200));

  const rows = await prisma.deviceEvent.findMany({
    where: {
      deviceId: device.id,
      ...(createdAtFilter ? { createdAt: createdAtFilter } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, type: true, data: true, sourceAt: true, createdAt: true },
  });

  res.json({
    deviceId: device.id,
    date: dateStr || null,
    events: rows.map((r) => ({
      id: r.id,
      type: r.type,
      data: r.data,
      sourceAt: r.sourceAt ? r.sourceAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

/**
 * State history (time-series)
 * - populated by MQTT ingest (see src/mqtt.js)
 */
app.get("/devices/:id/state-history", authRequired, async (req, res) => {
  const id = Number(req.params.id);
  const limit = Math.min(Number(req.query.limit || 200), 1000);

  const device = await prisma.device.findUnique({ where: { id }, select: { id: true, homeId: true, deviceId: true } });
  if (!device) return res.status(404).json({ error: "Device not found" });
  const m = await requireHomeRole(req, res, device.homeId, "MEMBER");
  if (!m) return;
  const rows = await prisma.deviceStateHistory.findMany({
    where: { deviceId: id },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  res.json({ deviceId: id, history: rows });
});

/**
 * Sprint 11: TH_SENSOR_V1 history (simple daily list)
 *
 * GET /devices/:id/history?date=YYYY-MM-DD
 * Returns: [{ts, temperature, humidity}]
 */
app.get("/devices/:id/history", authRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid device id" });

  const device = await prisma.device.findUnique({ where: { id }, select: { id: true, homeId: true, modelId: true } });
  if (!device) return res.status(404).json({ error: "Device not found" });
  const m = await requireHomeRole(req, res, device.homeId, "MEMBER");
  if (!m) return;

  const dateStr = String(req.query.date || "").trim();
  if (!dateStr) return res.status(400).json({ error: "date is required (YYYY-MM-DD)" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });

  const start = new Date(dateStr + "T00:00:00.000Z");
  if (Number.isNaN(start.getTime())) return res.status(400).json({ error: "Invalid date" });
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const limitRaw = Number(req.query.limit ?? 2000);
  const limit = Math.max(1, Math.min(10000, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 2000));

  const rows = await prisma.deviceStateHistory.findMany({
    where: {
      deviceId: id,
      createdAt: { gte: start, lt: end },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { createdAt: true, state: true },
  });

  const points = [];
  for (const r of rows) {
    const s = r.state;
    const t = s && typeof s === "object" ? s.temperature : undefined;
    const h = s && typeof s === "object" ? s.humidity : undefined;
    if (t == null && h == null) continue;
    points.push({
      ts: r.createdAt.toISOString(),
      temperature: t != null ? Number(t) : null,
      humidity: h != null ? Number(h) : null,
    });
  }

  res.json({ deviceId: id, date: dateStr, points });
});

/**
 * OTA helper endpoints
 * NOTE: Zigbee end-devices in this project download OTA over WiFi (hardcoded SSID/PASS + URL in firmware).
 * These endpoints mainly trigger the OTA action (via hub -> coordinator -> identify magic time).
 */
function loadOtaManifest() {
  try {
    const p = path.join(OTA_DIR, "manifest.json");
    const raw = fs.readFileSync(p, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

app.get("/devices/:id/ota/check", authRequired, async (req, res) => {
  const id = Number(req.params.id);

  const device = await prisma.device.findUnique({ where: { id }, select: { id: true, homeId: true, deviceId: true, protocol: true, type: true, firmwareType: true, firmwareVersion: true } });
  if (!device) return res.status(404).json({ error: "Device not found" });
  const m = await requireHomeRole(req, res, device.homeId, "MEMBER");
  if (!m) return;
  const manifest = loadOtaManifest();
  if (!manifest) return res.json({ deviceId: id, available: null, note: "manifest.json not found" });

  const key = device.firmwareType || device.type;
  const entry =
    (device.protocol === "ZIGBEE" ? manifest?.zigbee?.[key] : manifest?.mqtt?.[key]) || null;

  if (!entry) {
    return res.json({ deviceId: id, available: null, note: `No OTA entry for key=${key}` });
  }

  const url =
    entry.path && entry.path.startsWith("http")
      ? entry.path
      : `${req.protocol}://${req.get("host")}${entry.path}`;

  res.json({
    deviceId: id,
    current: device.firmwareVersion || null,
    available: { version: entry.version || null, url },
  });
});

app.post("/devices/:id/ota/start", authRequired, async (req, res) => {
  const id = Number(req.params.id);

  const device = await prisma.device.findUnique({ where: { id }, select: { id: true, homeId: true, deviceId: true } });
  if (!device) return res.status(404).json({ error: "Device not found" });
  const m = await requireHomeRole(req, res, device.homeId, "MEMBER");
  if (!m) return;
  const cmdId = crypto.randomUUID();
  const payload = { ota: true };

  // persist command record (so it shows in command history)
  const command = await prisma.command.create({
    data: {
      cmdId,
      deviceId: device.id,
      status: "PENDING",
      payload,
    },
  });

  // publish via MQTT using the unified contract
  publishCommand(mqttClient, {
    homeId: device.homeId,
    deviceId: device.deviceId,
    cmdId,
    payload,
  });
  res.json({ cmdId, status: "PENDING", command });
});

app.post("/zigbee/pairing/open", authRequired, async (req, res) => {
  const parsed = zigbeeOpenPairingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const result = await openZigbeePairingSession(req, res, {
    hubId: parsed.data.hubId ?? null,
    homeId: parsed.data.homeId ?? null,
    durationSec: parsed.data.durationSec ?? 60,
    mode: parsed.data.mode ?? null,
    claimedSerial: parsed.data.claimedSerial ?? null,
    expectedModelId: parsed.data.expectedModelId ?? null,
  });
  if (!result) return;

  res.json(result);
});

/**
 * Sprint 11: Hub-scoped pairing endpoints (alias to /zigbee/pairing/*)
 *
 * Rationale: mobile UX wants a hub-centric path and token-scoped discovered list.
 * We keep the old endpoints for backward compatibility.
 */
app.post("/hubs/:hubId/pairing/open", authRequired, async (req, res) => {
  const parsed = zigbeeOpenPairingSchema.safeParse({ ...req.body, hubId: req.params.hubId });
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const result = await openZigbeePairingSession(req, res, {
    hubId: req.params.hubId,
    homeId: parsed.data.homeId ?? null,
    durationSec: parsed.data.durationSec ?? 60,
    mode: parsed.data.mode ?? "TYPE_FIRST",
    claimedSerial: parsed.data.claimedSerial ?? null,
    expectedModelId: parsed.data.expectedModelId ?? null,
  });
  if (!result) return;

  // Sprint 11 contract: return {token, expiresAt} (keep extra fields as non-breaking)
  res.status(201).json({ token: result.token, expiresAt: result.expiresAt, hubId: result.hubId, homeId: result.homeId, mode: result.mode });
});

app.get("/hubs/:hubId/pairing/discovered", authRequired, async (req, res) => {
  const token = String(req.query.token || "").trim();
  if (!token) return res.status(400).json({ error: "token required" });

  const session = await requireValidPairingSession(token, req.user.id);
  if (!session) return res.status(400).json({ error: "Invalid/expired token (re-open pairing)" });
  if (session.hubId !== String(req.params.hubId)) return res.status(400).json({ error: "hubId does not match pairing token" });

  const devices = await prisma.zigbeeDiscoveredDevice.findMany({
    where: { hubId: session.hubId, pairingToken: token, status: "PENDING" },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { suggestedModel: { select: { id: true, name: true, manufacturer: true, protocol: true } } },
  });

  res.json({ token, hubId: session.hubId, devices });
});

app.post("/hubs/:hubId/pairing/confirm", authRequired, async (req, res) => {
  const parsed = zigbeePairingConfirmSchema.safeParse({ ...req.body, hubId: req.params.hubId });
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { token, ieee } = parsed.data;

  const device = await createZigbeeDeviceFromToken(req, res, token, ieee, { ...req.body, hubId: req.params.hubId });
  if (!device) return;

  // Optional Identify confirm (Sprint 11)
  const identifySecRaw = req.body?.identifySec;
  const identifySec = Number.isFinite(Number(identifySecRaw)) ? Math.max(0, Math.min(10, Math.floor(Number(identifySecRaw)))) : 4;
  if (identifySec > 0 && device?.zigbeeIeee) {
    try {
      sendZigbeeIdentify(device.zigbeeIeee, identifySec);
    } catch {
      // best-effort
    }
  }

  res.json({ device });
});

app.post("/hubs/:hubId/pairing/reject", authRequired, async (req, res) => {
  const parsed = zigbeePairingRejectSchema.safeParse({ ...req.body, hubId: req.params.hubId });
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { token, ieee } = parsed.data;

  // reuse existing logic by calling the same handler body
  const session = await requireValidPairingSession(token, req.user.id);
  if (!session) return res.status(400).json({ error: "Invalid/expired token" });
  if (session.hubId !== String(req.params.hubId)) return res.status(400).json({ error: "hubId does not match pairing token" });

  const normIeee = normalizeIeee(ieee);
  if (!normIeee) return res.status(400).json({ error: "Invalid ieee" });

  await prisma.zigbeeDiscoveredDevice
    .update({
      where: { hubId_ieee: { hubId: session.hubId, ieee: normIeee } },
      data: { status: "REJECTED" },
    })
    .catch(() => {});

  mqttClient.publish(`home/hub/${session.hubId}/zigbee/pairing/reject`, JSON.stringify({ token, ieee: normIeee }), { qos: 1 });
  res.json({ ok: true });
});

async function createZigbeeDeviceFromToken(req, res, token, ieeeRaw, input) {
  const ieee = normalizeIeee(ieeeRaw);
  if (!ieee) {
    res.status(400).json({ error: "Invalid ieee (expect 16-hex IEEE address)" });
    return null;
  }

  const session = await requireValidPairingSession(token, req.user.id);
  if (!session) {
    res.status(400).json({ error: "Invalid/expired token (re-open pairing)" });
    return null;
  }

  const sessionMode = session.mode || "LEGACY";
  const inputHubId = input?.hubId ? String(input.hubId) : null;
  if (inputHubId && inputHubId !== session.hubId) {
    res.status(400).json({ error: "hubId does not match pairing token" });
    return null;
  }

  // Home: explicit > session > hub.homeId > default admin home
  let homeId = input?.homeId != null ? Number(input.homeId) : session.homeId;
  const hub = await prisma.hub.findFirst({ where: { hubId: session.hubId }, select: { hubId: true, homeId: true } });
  if (!hub || !hub.homeId) {
    res.status(400).json({ error: "Hub not found or not bound to any home (activate hub first)" });
    return null;
  }
  if (!homeId) homeId = hub.homeId;
  if (!homeId) homeId = await pickDefaultAdminHomeId(req.user.id);
  if (!homeId) {
    res.status(400).json({ error: "No home found for user" });
    return null;
  }

  if (homeId !== hub.homeId) {
    res.status(400).json({ error: "hubId does not belong to homeId" });
    return null;
  }

  const m = await requireHomeRole(req, res, homeId, "ADMIN");
  if (!m) return null;

  // Optional room support (legacy UI). Sprint 2 flows may omit.
  const roomIdRaw = input?.roomId != null ? Number(input.roomId) : null;
  const roomId = Number.isInteger(roomIdRaw) && roomIdRaw > 0 ? roomIdRaw : null;
  const roomName = input?.room;
  const targetRoomId = await resolveRoomId(homeId, roomId, roomName);
  if (targetRoomId) {
    const okRoom = await prisma.room.findFirst({ where: { id: targetRoomId, homeId }, select: { id: true } });
    if (!okRoom) {
      res.status(400).json({ error: "roomId does not belong to this home" });
      return null;
    }
  }

  // Best-effort discovered row (may not exist if join event missed)
  const discovered = await prisma.zigbeeDiscoveredDevice
    .findUnique({ where: { hubId_ieee: { hubId: session.hubId, ieee } } })
    .catch(() => null);

  // Determine model selection
  const explicitModelId = input?.modelId ? String(input.modelId) : null;
  let chosenModelId = null;

  if (sessionMode === "TYPE_FIRST") {
    chosenModelId = explicitModelId || session.expectedModelId || discovered?.suggestedModelId || null;
    if (!chosenModelId) {
      res.status(400).json({ error: "modelId required (TYPE_FIRST)" });
      return null;
    }

    // If fingerprint suggests a different model than expected, require explicit selection.
    if (!explicitModelId && session.expectedModelId && discovered?.suggestedModelId && discovered.suggestedModelId !== session.expectedModelId) {
      res.status(400).json({ error: "Fingerprint does not match expectedModelId. Provide modelId to confirm." });
      return null;
    }
  }

  let inv = null;
  if (sessionMode === "SERIAL_FIRST") {
    if (!session.claimedSerial) {
      res.status(400).json({ error: "claimedSerial missing for SERIAL_FIRST (re-open pairing)" });
      return null;
    }
    inv = await prisma.deviceInventory.findUnique({ where: { serial: session.claimedSerial } });
    if (!inv) {
      res.status(404).json({ error: "claimedSerial not found" });
      return null;
    }
    if (inv.protocol !== "ZIGBEE") {
      res.status(400).json({ error: "claimedSerial must be a ZIGBEE inventory" });
      return null;
    }
    if (inv.claimedHomeId !== homeId || inv.status !== "CLAIMED") {
      res.status(409).json({ error: "claimedSerial must be CLAIMED by this home first" });
      return null;
    }
    chosenModelId = explicitModelId || inv.modelId || discovered?.suggestedModelId || null;
    if (!chosenModelId) {
      res.status(400).json({ error: "No modelId available for SERIAL_FIRST (inventory missing modelId)" });
      return null;
    }
  }

  if (sessionMode === "LEGACY") {
    chosenModelId = explicitModelId || discovered?.suggestedModelId || null;
  }

  // Descriptor (optional)
  let productModel = null;
  if (chosenModelId) {
    productModel = await prisma.productModel.findUnique({ where: { id: chosenModelId } }).catch(() => null);
  }

  // Name/type defaults
  const legacyName = input?.name ? String(input.name) : null;
  const legacyType = input?.type ? String(input.type) : null;

  const finalType = (legacyType || inv?.typeDefault || guessDeviceTypeFromModelId(chosenModelId) || discovered?.suggestedType || "relay");
  const finalName = legacyName || productModel?.name || discovered?.model || `${finalType}-${ieee.slice(-4)}`;

  // Ensure IEEE isn't already bound to a different device (important for SERIAL_FIRST)
  const existingByIeee = await prisma.device.findUnique({ where: { zigbeeIeee: ieee }, select: { id: true, deviceId: true } }).catch(() => null);
  if (existingByIeee && inv && existingByIeee.deviceId !== inv.deviceUuid) {
    res.status(409).json({ error: "This IEEE is already bound to another device" });
    return null;
  }

  const now = new Date();

  let device = null;
  if (inv) {
    // SERIAL_FIRST: bind to the pre-provisioned deviceUuid in inventory
    device = await prisma.device.upsert({
      where: { deviceId: inv.deviceUuid },
      update: {
        homeId,
        roomId: targetRoomId,
        name: finalName,
        type: finalType,
        protocol: "ZIGBEE",
        serial: inv.serial,
        modelId: chosenModelId,
        zigbeeIeee: ieee,
        hubId: session.hubId,
        legacyTopicBase: `home/zb/${ieee}`,
        lifecycleStatus: "BOUND",
        boundAt: now,
        unboundAt: null,
        lastProvisionedAt: now,
      },
      create: {
        name: finalName,
        type: finalType,
        protocol: "ZIGBEE",
        deviceId: inv.deviceUuid,
        homeId,
        roomId: targetRoomId,
        createdById: req.user.id,
        serial: inv.serial,
        modelId: chosenModelId,
        zigbeeIeee: ieee,
        hubId: session.hubId,
        legacyTopicBase: `home/zb/${ieee}`,
        lifecycleStatus: "BOUND",
        boundAt: now,
        lastProvisionedAt: now,
      },
    });

    await prisma.deviceInventory.update({
      where: { serial: inv.serial },
      data: { status: "BOUND" },
    }).catch(() => {});
  } else {
    // TYPE_FIRST / LEGACY: bind by IEEE (unique)
    const existing = await prisma.device.findUnique({ where: { zigbeeIeee: ieee }, select: { deviceId: true } }).catch(() => null);
    const deviceId = existing?.deviceId || crypto.randomUUID();
    device = await prisma.device.upsert({
      where: { deviceId },
      update: {
        homeId,
        roomId: targetRoomId,
        name: finalName,
        type: finalType,
        protocol: "ZIGBEE",
        modelId: chosenModelId ?? null,
        zigbeeIeee: ieee,
        hubId: session.hubId,
        legacyTopicBase: `home/zb/${ieee}`,
        lifecycleStatus: "BOUND",
        boundAt: now,
        unboundAt: null,
        lastProvisionedAt: now,
      },
      create: {
        name: finalName,
        type: finalType,
        protocol: "ZIGBEE",
        deviceId,
        homeId,
        roomId: targetRoomId,
        createdById: req.user.id,
        modelId: chosenModelId ?? null,
        zigbeeIeee: ieee,
        hubId: session.hubId,
        legacyTopicBase: `home/zb/${ieee}`,
        lifecycleStatus: "BOUND",
        boundAt: now,
        lastProvisionedAt: now,
      },
    });
  }

  await prisma.deviceStateCurrent.upsert({
    where: { deviceId: device.id },
    update: {},
    create: { deviceId: device.id, state: null, online: false },
  });

  // Mark discovered row as CONFIRMED (best-effort)
  await prisma.zigbeeDiscoveredDevice
    .update({ where: { hubId_ieee: { hubId: session.hubId, ieee } }, data: { status: "CONFIRMED", homeId, ownerId: req.user.id, suggestedModelId: chosenModelId ?? discovered?.suggestedModelId ?? null } })
    .catch(() => {});

  // Notify hub host so it can configure bind/report if needed.
  mqttClient.publish(
    `home/hub/${session.hubId}/zigbee/pairing/confirm`,
    JSON.stringify({
      token,
      ieee,
      homeId,
      deviceId: device.deviceId,
      deviceDbId: device.id,
      type: finalType,
      modelId: chosenModelId ?? null,
    }),
    { qos: 1 },
  );

  appendLogLine("audit.log", {
    ts: new Date().toISOString(),
    event: "device.bound",
    userId: req.user.id,
    homeId,
    hubId: session.hubId,
    ieee,
    deviceId: device.deviceId,
    deviceDbId: device.id,
    modelId: chosenModelId ?? null,
    mode: sessionMode,
  });

  // attach descriptor in response when useful
  device.productModel = productModel || null;

  return device;
}

app.post("/zigbee/pairing/confirm", authRequired, async (req, res) => {
  const parsed = zigbeePairingConfirmSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { token, ieee } = parsed.data;
  if (!token || !ieee) return res.status(400).json({ error: "token, ieee required" });

  const device = await createZigbeeDeviceFromToken(req, res, token, ieee, req.body);
  if (!device) return;

  // Optional: Identify confirm (backward compatible)
  const identifySecRaw = req.body?.identifySec;
  const identifySec = Number.isFinite(Number(identifySecRaw))
    ? Math.max(0, Math.min(10, Math.floor(Number(identifySecRaw))))
    : 0;
  if (identifySec > 0 && device?.zigbeeIeee) {
    try {
      sendZigbeeIdentify(device.zigbeeIeee, identifySec);
    } catch (e) {
      // ignore
    }
  }

  res.json({ device });
});

app.post("/zigbee/pairing/reject", authRequired, async (req, res) => {
  const parsed = zigbeePairingRejectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { token, ieee } = parsed.data;
  if (!token || !ieee) return res.status(400).json({ error: "token, ieee required" });

  const session = await requireValidPairingSession(token, req.user.id);
  if (!session) return res.status(400).json({ error: "Invalid/expired token" });

  const normIeee = normalizeIeee(ieee);
  if (!normIeee) return res.status(400).json({ error: "Invalid ieee" });

  // Optional hubId check (Sprint 2)
  const bodyHubId = req.body?.hubId ? String(req.body.hubId) : null;
  if (bodyHubId && bodyHubId !== session.hubId) return res.status(400).json({ error: "hubId does not match pairing token" });

  await prisma.zigbeeDiscoveredDevice
    .update({
      where: { hubId_ieee: { hubId: session.hubId, ieee: normIeee } },
      data: { status: "REJECTED" },
    })
    .catch(() => {});

  mqttClient.publish(
    `home/hub/${session.hubId}/zigbee/pairing/reject`,
    JSON.stringify({ token, ieee: normIeee }),
    { qos: 1 },
  );
  res.json({ ok: true });
});

app.post("/zigbee/pairing/close", authRequired, async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: "token required" });

  const session = await requireValidPairingSession(token, req.user.id);
  if (!session) return res.status(400).json({ error: "Invalid/expired token" });

  mqttClient.publish(
    `home/hub/${session.hubId}/zigbee/pairing/close`,
    JSON.stringify({ token }),
    { qos: 1 },
  );

  await prisma.zigbeePairingSession.delete({ where: { token } }).catch(() => {});
  res.json({ ok: true });
});

app.get("/zigbee/discovered", authRequired, async (req, res) => {
  const homeIdRaw = req.query.homeId;
  let homeIds = [];
  if (homeIdRaw != null) {
    const homeId = Number(homeIdRaw);
    if (!Number.isInteger(homeId) || homeId <= 0) return res.status(400).json({ error: "Invalid homeId" });
    const m = await requireHomeRole(req, res, homeId, "MEMBER");
    if (!m) return;
    homeIds = [homeId];
  } else {
    const memberships = await prisma.homeMember.findMany({ where: { userId: req.user.id }, select: { homeId: true } });
    homeIds = memberships.map((m) => m.homeId);
  }

  const devices = await prisma.zigbeeDiscoveredDevice.findMany({
    where: {
      OR: [{ homeId: { in: homeIds } }, { ownerId: req.user.id }],
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      suggestedModel: { select: { id: true, name: true, manufacturer: true, protocol: true } },
    },
  });

  // Sprint 2: compute suggestions list (best-effort) using fingerprintManuf/fingerprintModel
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

  const enriched = devices.map((d) => {
    const suggestions = suggestModelsByFingerprint({ manufacturer: d.manufacturer, model: d.model }, candidateModels).slice(0, 5);
    return { ...d, suggestions };
  });

  res.json({ devices: enriched });
});

// Convenience endpoints for mobile UI (so app does not need token plumbing)
app.post("/zigbee/discovered/:ieee/confirm", authRequired, async (req, res) => {
  const ieeeRaw = req.params.ieee;
  const ieee = normalizeIeee(ieeeRaw);
  if (!ieee) return res.status(400).json({ error: "Invalid ieee" });

  const memberships = await prisma.homeMember.findMany({ where: { userId: req.user.id }, select: { homeId: true } });
  const homeIds = memberships.map((m) => m.homeId);
  const discovered = await prisma.zigbeeDiscoveredDevice.findFirst({
    where: { ieee, status: "PENDING", OR: [{ homeId: { in: homeIds } }, { ownerId: req.user.id }] },
    orderBy: { createdAt: "desc" },
  });
  if (!discovered) return res.status(404).json({ error: "Not found" });

  if (discovered.homeId) {
    const m = await requireHomeRole(req, res, discovered.homeId, "ADMIN");
    if (!m) return;
  }

  const device = await createZigbeeDeviceFromToken(req, res, discovered.pairingToken, ieee, req.body);
  if (!device) return;

  res.json({ device });
});

app.post("/zigbee/discovered/:ieee/reject", authRequired, async (req, res) => {
  const ieeeRaw = req.params.ieee;
  const ieee = normalizeIeee(ieeeRaw);
  if (!ieee) return res.status(400).json({ error: "Invalid ieee" });

  const memberships = await prisma.homeMember.findMany({ where: { userId: req.user.id }, select: { homeId: true } });
  const homeIds = memberships.map((m) => m.homeId);
  const discovered = await prisma.zigbeeDiscoveredDevice.findFirst({
    where: { ieee, status: "PENDING", OR: [{ homeId: { in: homeIds } }, { ownerId: req.user.id }] },
    orderBy: { createdAt: "desc" },
  });
  if (!discovered) return res.status(404).json({ error: "Not found" });

  if (discovered.homeId) {
    const m = await requireHomeRole(req, res, discovered.homeId, "ADMIN");
    if (!m) return;
  }

  // Best-effort: only allow reject if token still valid
  const session = await requireValidPairingSession(discovered.pairingToken, req.user.id);
  if (session) {
    mqttClient.publish(
      `home/hub/${discovered.hubId}/zigbee/pairing/reject`,
      JSON.stringify({ token: discovered.pairingToken, ieee }),
      { qos: 1 },
    );
  }

  await prisma.zigbeeDiscoveredDevice.update({
    where: { hubId_ieee: { hubId: discovered.hubId, ieee } },
    data: { status: "REJECTED" },
  });

  res.json({ ok: true });
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`[SYS] ${signal} received, shutting down...`);
  try {
    mqttClient.end(true);
  } catch {
    // ignore
  }
  prisma
    .$disconnect()
    .catch(() => {})
    .finally(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// -------------------------
// Start server
// -------------------------

app.listen(PORT, "0.0.0.0", () => {
  // Bind to 0.0.0.0 so the mobile app (emulator/real device) can reach the backend.
  console.log(`Backend listening on http://0.0.0.0:${PORT}`);
});
