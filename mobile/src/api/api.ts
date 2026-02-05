import { http } from "./client";
import type {
  Device,
  DeviceCommand,
  DeviceEvent,
  DeviceType,
  DeviceStateHistoryRow,
  Hub,
  MqttDiagnostics,
  Home,
  OtaCheckResult,
  Room,
  User,
  ZigbeeDiscoveredDevice,
} from "../types";

// ----------------------
// Auth
// ----------------------
export async function apiRegister(input: { name: string; email: string; password: string }) {
  const res = await http.post("/auth/register", input);
  return res.data as { token: string; user: User };
}

export async function apiLogin(input: { email: string; password: string }) {
  const res = await http.post("/auth/login", input);
  return res.data as { token: string; user: User };
}

export async function apiMe() {
  const res = await http.get("/me");
  return res.data as { user: User };
}

export async function apiLogout() {
  const res = await http.post("/auth/logout");
  return res.data as { ok: true };
}

// ----------------------
// Homes & Rooms
// ----------------------
export async function apiListHomes() {
  const res = await http.get("/homes");
  const data: any = res.data;

  // Normalize server responses:
  // - { homes: [...] }
  // - [...] (legacy)
  // - { items: [...] } (generic list wrapper)
  if (Array.isArray(data)) return { homes: data as Home[] };
  if (data?.homes) return data as { homes: Home[] };
  if (data?.items) return { homes: data.items as Home[] };
  return { homes: [] };
}


export async function apiCreateHome(input: { name: string }) {
  const res = await http.post("/homes", input);
  const data: any = res.data;

  // Normalize server responses:
  // - { home: {...} }
  // - {...} (legacy)
  const home = data?.home ?? data;
  return { home } as { home: Home };
}


export async function apiListRooms(homeId: number) {
  const res = await http.get(`/homes/${homeId}/rooms`);
  return res.data as { rooms: Room[] };
}

export async function apiCreateRoom(homeId: number, input: { name: string }) {
  const res = await http.post(`/homes/${homeId}/rooms`, input);
  return res.data as { room: Room };
}

// ----------------------
// Devices
// ----------------------
export async function apiListDevices(input?: { homeId?: number | null; roomId?: number | null }) {
  // Sprint 12: prefer /homes/:homeId/devices (includes descriptor summary)
  // but keep backward compatibility with /devices list.
  if (input?.homeId) {
    const res = await http.get(`/homes/${input.homeId}/devices`, {
      params: {
        roomId: input?.roomId ?? undefined,
      },
    });
    return res.data as { devices: Device[] };
  }

  const res = await http.get("/devices", {
    params: {
      homeId: input?.homeId ?? undefined,
      roomId: input?.roomId ?? undefined,
    },
  });
  return res.data as { devices: Device[] };
}

// Sprint 12: Device descriptor (capabilities + uiSchema)
export async function apiGetDeviceDescriptor(deviceId: number) {
  const res = await http.get(`/devices/${deviceId}/descriptor`);
  return res.data as { deviceId: number; descriptor: import("../types").DeviceDescriptor };
}

export async function apiCreateDevice(input: { homeId: number; name: string; type: DeviceType; roomId?: number | null; room?: string | null }) {
  // Physical devices must use /devices/claim.
  // Keep this for dev UI testing as a "virtual device".
  const res = await http.post("/devices/virtual", input);
  return res.data as { device: Device };
}

// ----------------------
// Real onboarding (Hub first)
// ----------------------

export async function apiListHubs(homeId: number) {
  const res = await http.get("/hubs", { params: { homeId } });
  return res.data as { hubs: Hub[] };
}

export async function apiClaimHub(input: { hubId: string; setupCode: string; homeId: number; name?: string | null }) {
  const res = await http.post("/hubs/claim", input);
  return res.data as { hub: Hub };
}

// Sprint 9: Activate hub using inventory serial + setupCode
export async function apiActivateHub(input: {
  serial: string;
  setupCode: string;
  homeId: number;
  name?: string | null;
  installerMode?: boolean;
}) {
  const res = await http.post("/hubs/activate", input);
  return res.data as {
    hub: Hub;
    runtime?: { online?: boolean; mac?: string | null; ip?: string | null; lastSeen?: string | null } | null;
    inventory?: { serial: string; modelId?: string | null; status?: string } | null;
  };
}

export async function apiClaimDevice(input: {
  serial: string;
  setupCode: string;
  homeId: number;
  name?: string | null;
  type?: DeviceType | null;
  roomId?: number | null;
  room?: string | null;
}) {
  const res = await http.post("/devices/claim", input);
  return res.data as { device: Device; provisioning: any };
}

export async function apiResetConnection(deviceDbId: number) {
  const res = await http.post(`/devices/${deviceDbId}/reset-connection`);
  return res.data as { ok: true; resetRequest: any };
}

export async function apiFactoryReset(deviceDbId: number) {
  const res = await http.post(`/devices/${deviceDbId}/factory-reset`);
  return res.data as { ok: true; resetRequest: any };
}

export async function apiMqttDiagnostics() {
  const res = await http.get("/diagnostics/mqtt");
  return res.data as MqttDiagnostics;
}

export async function apiUpdateDevice(
  id: number,
  input: Partial<{ name: string; type: DeviceType; roomId?: number | null; room?: string | null }>
) {
  const res = await http.put(`/devices/${id}`, input);
  return res.data as { device: Device };
}

export async function apiDeleteDevice(id: number) {
  const res = await http.delete(`/devices/${id}`);
  return res.data as { ok: true };
}

export async function apiSendCommand(id: number, payload: any) {
  const res = await http.post(`/devices/${id}/command`, payload);
  return res.data as { cmdId?: string; status?: string; ok?: boolean };
}

export async function apiGetDeviceStateCurrent(deviceId: number) {
  const res = await http.get(`/devices/${deviceId}/state`);
  return res.data as { deviceId: number; state: any; updatedAt?: string };
}

// ----------------------
// Sprint 5: SmartLock APIs
// ----------------------

export async function apiLockAddPin(
  deviceId: number,
  input: { slot: number; label?: string | null; pin: string }
) {
  const res = await http.post(`/devices/${deviceId}/lock/pins`, input);
  return res.data as { cmdId: string; status: string };
}

export async function apiLockDeletePin(deviceId: number, slot: number) {
  const res = await http.delete(`/devices/${deviceId}/lock/pins/${slot}`);
  return res.data as { cmdId: string; status: string };
}

export async function apiLockAddRfid(
  deviceId: number,
  input: { slot: number; label?: string | null; uid: string }
) {
  const res = await http.post(`/devices/${deviceId}/lock/rfid`, input);
  return res.data as { cmdId: string; status: string };
}

export async function apiLockDeleteRfid(deviceId: number, slot: number) {
  const res = await http.delete(`/devices/${deviceId}/lock/rfid/${slot}`);
  return res.data as { cmdId: string; status: string };
}

export async function apiListDeviceCommands(deviceId: number, input?: { limit?: number; cursor?: number | null }) {
  const res = await http.get(`/devices/${deviceId}/commands`, {
    params: {
      limit: input?.limit,
      cursor: input?.cursor,
    },
  });
  return res.data as { items: DeviceCommand[]; nextCursor: number | null };
}

export async function apiGetDeviceStateHistory(deviceId: number, input?: { limit?: number }) {
  const res = await http.get(`/devices/${deviceId}/state-history`, {
    params: { limit: input?.limit ?? 200 },
  });
  return res.data as { deviceId: number; history: DeviceStateHistoryRow[] };
}

export async function apiGetDeviceEvents(
  deviceId: number,
  input?: { date?: string; from?: string; to?: string; limit?: number },
) {
  const res = await http.get(`/devices/${deviceId}/events`, {
    params: {
      date: input?.date ?? undefined,
      from: input?.from ?? undefined,
      to: input?.to ?? undefined,
      limit: input?.limit ?? undefined,
    },
  });
  return res.data as { events: DeviceEvent[] };
}

export async function apiOtaCheck(deviceId: number) {
  const res = await http.get(`/devices/${deviceId}/ota/check`);
  return res.data as OtaCheckResult;
}

export async function apiOtaStart(deviceId: number) {
  const res = await http.post(`/devices/${deviceId}/ota/start`);
  return res.data as { cmdId: string; status: string };
}

// ----------------------
// Zigbee (pairing + discovery)
// ----------------------
export async function apiZbListDiscovered(homeId?: number | null) {
  const res = await http.get("/zigbee/discovered", {
    params: {
      homeId: homeId ?? undefined,
    },
  });
  return res.data as { devices: ZigbeeDiscoveredDevice[] };
}

export async function apiZbOpenPairing(input: { homeId: number; hubId: string; durationSec?: number }) {
  const res = await http.post("/zigbee/pairing/open", {
    homeId: input.homeId,
    hubId: input.hubId,
    durationSec: input.durationSec ?? 60,
  });
  return res.data as { ok?: true; hubId?: string; token: string; expiresAt?: string };
}

export async function apiZbConfirmDevice(
  ieee: string,
  input: { homeId: number; name: string; type: DeviceType; roomId?: number | null; room?: string | null }
) {
  const res = await http.post(`/zigbee/discovered/${ieee}/confirm`, input);
  return res.data as { device: Device };
}

export async function apiZbRejectDevice(ieee: string) {
  const res = await http.post(`/zigbee/discovered/${ieee}/reject`);
  return res.data as { ok: true };
}

// ----------------------
// Sprint 11: Hub-scoped pairing API (token-first)
// ----------------------
export async function apiHubPairingOpen(input: {
  hubId: string;
  homeId: number;
  durationSec?: number;
  mode?: "LEGACY" | "SERIAL_FIRST" | "TYPE_FIRST";
  roomId?: number | null;
}) {
  const res = await http.post(`/hubs/${input.hubId}/pairing/open`, {
    homeId: input.homeId,
    durationSec: input.durationSec ?? 60,
    mode: input.mode ?? "TYPE_FIRST",
    roomId: input.roomId ?? undefined,
  });
  return res.data as { token: string; expiresAt: string; hubId?: string; homeId?: number; mode?: string };
}

export async function apiHubPairingDiscovered(input: { hubId: string; token: string }) {
  const res = await http.get(`/hubs/${input.hubId}/pairing/discovered`, {
    params: { token: input.token },
  });
  return res.data as { devices: ZigbeeDiscoveredDevice[] };
}

export async function apiHubPairingConfirm(input: {
  hubId: string;
  token: string;
  ieee: string;
  homeId: number;
  roomId?: number | null;
  name?: string;
  type?: DeviceType;
  modelId?: string;
  identifySec?: number;
}) {
  const res = await http.post(`/hubs/${input.hubId}/pairing/confirm`, {
    token: input.token,
    ieee: input.ieee,
    homeId: input.homeId,
    roomId: input.roomId ?? undefined,
    name: input.name ?? undefined,
    type: input.type ?? undefined,
    modelId: input.modelId ?? undefined,
    identifySec: input.identifySec ?? undefined,
  });
  return res.data as { device: Device };
}

export async function apiHubPairingReject(input: { hubId: string; token: string; ieee: string }) {
  const res = await http.post(`/hubs/${input.hubId}/pairing/reject`, {
    token: input.token,
    ieee: input.ieee,
  });
  return res.data as { ok: true };
}

// Sprint 11: TH history (daily)
export async function apiGetDeviceHistory(input: { deviceId: number; date: string }) {
  const res = await http.get(`/devices/${input.deviceId}/history`, {
    params: { date: input.date },
  });
  return res.data as { deviceId: number; date: string; points: Array<{ ts: string; temperature?: number | null; humidity?: number | null }> };
}
