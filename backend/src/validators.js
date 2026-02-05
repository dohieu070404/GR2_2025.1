import { z } from "zod";

export const registerSchema = z.object({
  name: z.string().min(2).max(60),
  email: z.string().email().max(120),
  password: z.string().min(6).max(100),
});

export const loginSchema = z.object({
  email: z.string().email().max(120),
  password: z.string().min(6).max(100),
});

export const deviceCreateSchema = z.object({
  name: z.string().min(1).max(80),
  type: z.enum(["relay", "dimmer", "rgb", "sensor"]),

  // For production UX, client MAY omit homeId to use a default admin/owner home.
  // Mobile can also send explicit homeId.
  homeId: z.number().int().positive().optional(),

  // Either roomId or room name can be provided.
  roomId: z.number().int().positive().optional().nullable(),
  room: z.string().min(1).max(80).optional().nullable(),

  protocol: z.enum(["MQTT", "ZIGBEE"]).optional().default("MQTT"),
  firmwareVersion: z.string().max(50).optional().nullable(),
});

export const deviceUpdateSchema =
  z
    .object({
      name: z.string().min(1).max(80).optional(),
      type: z.enum(["relay", "dimmer", "rgb", "sensor"]).optional(),
      // Either roomId or room name can be provided.
      roomId: z.number().int().positive().optional().nullable(),
      room: z.string().min(1).max(80).optional().nullable(),
      firmwareVersion: z.string().max(50).optional().nullable(),
    })
    .refine((v) => Object.keys(v).length > 0, {
      message: "At least one field is required",
    });


export const homeCreateSchema = z.object({
  name: z.string().min(1).max(80),
});

export const roomCreateSchema = z.object({
  name: z.string().min(1).max(80),
});

// ----------------------
// Inventory bootstrap (admin/dev)
// ----------------------
export const adminInventoryDeviceSchema = z.object({
  serial: z.string().min(3).max(80),
  type: z.enum(["relay", "dimmer", "rgb", "sensor"]).optional().nullable(),
  protocol: z.enum(["MQTT", "ZIGBEE"]).optional().default("MQTT"),
  model: z.string().max(80).optional().nullable(),
  modelId: z.string().min(1).max(50).optional().nullable(),
});

export const adminInventoryHubSchema = z.object({
  hubIdOrSerial: z.string().min(2).max(80),
  modelId: z.string().min(1).max(50).optional().nullable(),
});

// Sprint 9: Manual HubInventory create (admin)
// Supports both the new contract {serial, setupCode, model} and legacy UI {hubId, setupCode, modelId}.
export const adminInventoryHubManualSchema = z
  .object({
    serial: z.string().min(2).max(80).optional().nullable(),
    hubId: z.string().min(2).max(80).optional().nullable(),
    setupCode: z.string().min(4).max(32),
    model: z.string().min(1).max(50).optional().nullable(),
    modelId: z.string().min(1).max(50).optional().nullable(),
  })
  .superRefine((v, ctx) => {
    if (!v.serial && !v.hubId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "serial is required" });
    }
    if (!v.model && !v.modelId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "model is required" });
    }
  });


// ----------------------
// ProductModel catalog (admin)
// ----------------------
export const productModelCreateSchema = z.object({
  id: z.string().min(2).max(50),
  name: z.string().min(2).max(120),
  manufacturer: z.string().min(2).max(120),
  protocol: z.enum(["HUB","MQTT","ZIGBEE"]),
  fingerprintManuf: z.string().max(120).optional().nullable(),
  fingerprintModel: z.string().max(120).optional().nullable(),
  capabilities: z.any().optional().nullable(),
  uiSchema: z.any().optional().nullable(),
  defaultConfig: z.any().optional().nullable(),
});

// ----------------------
// Real onboarding / claim
// ----------------------
export const hubClaimSchema = z.object({
  hubId: z.string().min(2).max(80),
  setupCode: z.string().min(4).max(32),
  homeId: z.number().int().positive(),
  name: z.string().min(1).max(80).optional().nullable(),
});

// Sprint 9: Hub activate/bind by inventory serial + setupCode
// (hubSerial accepted for backward compatibility)
export const hubActivateSchema = z
  .object({
    serial: z.string().min(2).max(80).optional().nullable(),
    hubSerial: z.string().min(2).max(80).optional().nullable(),
    setupCode: z.string().min(4).max(32),
    homeId: z.number().int().positive(),
    name: z.string().min(1).max(80).optional().nullable(),
    installerMode: z.boolean().optional().nullable(),
  })
  .superRefine((v, ctx) => {
    if (!v.serial && !v.hubSerial) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "serial is required" });
    }
  });

// Sprint 9: minimal user profile
export const profileUpdateSchema = z
  .object({
    displayName: z.string().min(1).max(80).optional().nullable(),
    avatarUrl: z.string().url().max(500).optional().nullable(),
  })
  .refine((v) => v.displayName !== undefined || v.avatarUrl !== undefined, {
    message: "At least one field is required",
  });

// Sprint 9: home invites (minimal)
export const homeInviteCreateSchema = z.object({
  role: z.enum(["ADMIN", "MEMBER", "GUEST"]).optional().nullable(),
  expiresInHours: z.number().int().positive().max(24 * 30).optional().nullable(),
});

export const homeInviteAcceptSchema = z.object({
  code: z.string().min(6).max(64),
});

// Sprint 9: admin MQTT tools
export const adminMqttClearRetainedSchema = z.object({
  topics: z.array(z.string().min(1).max(200)).min(1).max(200),
});

export const deviceClaimSchema = z.object({
  serial: z.string().min(3).max(80),
  setupCode: z.string().min(4).max(32),
  homeId: z.number().int().positive(),
  name: z.string().min(1).max(80).optional().nullable(),
  type: z.enum(["relay", "dimmer", "rgb", "sensor"]).optional().nullable(),
  protocol: z.enum(["MQTT", "ZIGBEE"]).optional().nullable(),
  roomId: z.number().int().positive().optional().nullable(),
  room: z.string().min(1).max(80).optional().nullable(),
});

export const zigbeeOpenPairingSchema = z.object({
  // Sprint 1 legacy: {homeId, hubId?, durationSec?}
  // Sprint 2: add Xiaomi-style flows (mode + claimedSerial/expectedModelId)
  homeId: z.number().int().positive().optional().nullable(),
  hubId: z.string().min(2).max(80).optional().nullable(),
  durationSec: z.number().int().positive().max(300).optional().nullable(),

  mode: z.enum(["LEGACY", "SERIAL_FIRST", "TYPE_FIRST"]).optional().nullable(),
  claimedSerial: z.string().min(3).max(80).optional().nullable(),
  expectedModelId: z.string().min(1).max(50).optional().nullable(),
});

export const zigbeePairingConfirmSchema = z.object({
  hubId: z.string().min(2).max(80).optional().nullable(),
  token: z.string().min(6).max(80),
  ieee: z.string().min(4).max(64),
  modelId: z.string().min(1).max(50).optional().nullable(),
});

export const zigbeePairingRejectSchema = z.object({
  hubId: z.string().min(2).max(80).optional().nullable(),
  token: z.string().min(6).max(80),
  ieee: z.string().min(4).max(64),
});

// ----------------------
// Sprint 5: SmartLock APIs
// ----------------------

export const lockAddPinSchema = z.object({
  slot: z.number().int().min(0).max(255),
  label: z.string().min(1).max(80).optional().nullable(),
  // PIN digits only; keep short for UI keypad.
  pin: z.string().regex(/^\d{4,12}$/),
});

export const lockAddRfidSchema = z.object({
  slot: z.number().int().min(0).max(255),
  label: z.string().min(1).max(80).optional().nullable(),
  // UID hex (no separators), typically 4..10 bytes => 8..20 hex, but allow up to 32.
  uid: z
    .string()
    .transform((s) => s.trim().toLowerCase())
    .refine((s) => /^[0-9a-f]{8,32}$/.test(s), "uid must be hex (8..32 chars)"),
});

// ----------------------
// Sprint 7: Admin firmware release/rollout
// ----------------------

export const firmwareReleaseCreateSchema = z.object({
  targetType: z.enum(["HUB"]).optional().default("HUB"),
  version: z.string().min(1).max(60),
  url: z.string().url().max(500),
  sha256: z
    .string()
    .transform((s) => s.trim().toLowerCase())
    .refine((s) => /^[0-9a-f]{64}$/.test(s), "sha256 must be 64-hex"),
  size: z.number().int().positive().optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
});

export const firmwareRolloutCreateSchema = z.object({
  releaseId: z.number().int().positive(),
  hubIds: z.array(z.string().min(2).max(80)).min(1).max(500),
});

// ----------------------
// Sprint 8: Automations
// ----------------------

const automationTriggerSchema = z
  .object({
    deviceId: z.number().int().positive().optional(),
    ieee: z.string().min(4).max(64).optional(),
    eventType: z.string().min(1).max(120).optional(),
    // For EVENT triggers: only exact match is supported in hub_host.
    dataMatch: z.any().optional().nullable(),

    // Optional STATE trigger fields (reserved).
    path: z.string().min(1).max(120).optional(),
    op: z.enum(["==", "!=", ">", ">=", "<", "<="]).optional(),
    value: z.any().optional().nullable(),
  })
  .passthrough();

const automationActionSchema = z
  .object({
    deviceId: z.number().int().positive().optional(),
    ieee: z.string().min(4).max(64).optional(),
    action: z.string().min(1).max(120),
    params: z.any().optional().nullable(),
  })
  .passthrough();

export const automationCreateSchema = z
  .object({
    name: z.string().min(1).max(120),
    enabled: z.boolean().optional().default(true),
    triggerType: z.enum(["EVENT", "STATE"]),
    trigger: automationTriggerSchema,
    actions: z.array(automationActionSchema).min(1).max(10),
    executionPolicy: z.any().optional().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.triggerType === "EVENT") {
      if (!v.trigger.eventType) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "trigger.eventType is required for EVENT" });
      }
      if (!v.trigger.deviceId && !v.trigger.ieee) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "trigger.deviceId or trigger.ieee is required" });
      }
    }
    // STATE triggers are reserved (hub_host supports EVENT only in Sprint 8).
  });

export const automationUpdateSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    enabled: z.boolean().optional(),
    triggerType: z.enum(["EVENT", "STATE"]).optional(),
    trigger: automationTriggerSchema.optional(),
    actions: z.array(automationActionSchema).min(1).max(10).optional(),
    executionPolicy: z.any().optional().nullable(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field is required",
  });

export function validateCommandForType(deviceType, body) {
  // Management commands (generic): allow for all device types.
  // Contract: { mgmt: { action: "reset_connection" | "factory_reset", ... } }
  if (body?.mgmt?.action) {
    return { ok: true, payload: { mgmt: { ...body.mgmt } } };
  }

// OTA trigger (generic)
if (body && (body.ota === true || typeof body.ota === "object")) {
  return { ok: true, payload: { ota: true } };
}

  // Returns { ok: true, payload } or { ok: false, error }
  if (deviceType === "relay") {
    if (typeof body.relay !== "boolean") {
      return { ok: false, error: "relay requires { relay: boolean }" };
    }
    return { ok: true, payload: { relay: body.relay } };
  }

  if (deviceType === "dimmer") {
    const n = body.pwm;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 255) {
      return { ok: false, error: "dimmer requires { pwm: number(0..255) }" };
    }
    return { ok: true, payload: { pwm: Math.round(n) } };
  }

  if (deviceType === "rgb") {
    const rgb = body.rgb;
    const ok =
      rgb &&
      typeof rgb === "object" &&
      [rgb.r, rgb.g, rgb.b].every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 255);
    if (!ok) {
      return { ok: false, error: "rgb requires { rgb: { r,g,b } } (0..255)" };
    }
    return {
      ok: true,
      payload: { rgb: { r: Math.round(rgb.r), g: Math.round(rgb.g), b: Math.round(rgb.b) } },
    };
  }

  // Sensor devices are read-only from the app.
  if (deviceType === "sensor") {
    return { ok: false, error: "sensor devices are read-only (no /command supported)" };
  }

  return { ok: false, error: "Unsupported device type" };
}
