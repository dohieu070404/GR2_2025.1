export function getToken() {
  return localStorage.getItem("admin_token");
}

export function setToken(token) {
  if (!token) localStorage.removeItem("admin_token");
  else localStorage.setItem("admin_token", token);
}

export function getApiBase() {
  // Prefer absolute base if provided, else use relative (works with Vite proxy).
  return import.meta.env.VITE_API_BASE_URL || "";
}

async function request(path, opts = {}) {
  const base = getApiBase();
  const url = base ? `${base}${path}` : path;
  const token = getToken();

  // Use Headers to support either object/array/Headers input.
  const headers = new Headers(opts.headers || undefined);

  // Default JSON content-type (giữ như phiên bản TS ban đầu).
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore non-JSON
  }

  if (!res.ok) {
    const errMsg =
      (json && (json.error || json.message || json?.error?.message || json?.detail)) ||
      (text && text.trim()) ||
      res.statusText ||
      "Request failed";

    // Keep message readable if server returns HTML.
    const short = String(errMsg).replace(/\s+/g, " ").slice(0, 500);
    throw new Error(`${res.status} ${short}`.trim());
  }

  // If response is not JSON (e.g. CSV download), fall back to raw text.
  return json ?? text;
}

export const api = {
  login: (email, password) =>
    request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    }),

  me: () => request("/me"),

  dashboard: async () => {
    const [hubs, cmds] = await Promise.all([
      request("/admin/fleet/hubs"),
      request("/admin/commands?limit=200")
    ]);

    const hubItems = hubs.items || [];
    const cmdItems = cmds.items || [];

    const online = hubItems.filter((h) => h.online).length;
    const offline = hubItems.length - online;
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const cmdFail24h = cmdItems.filter((c) => c.status === "FAILED" && Date.parse(c.sentAt) >= since).length;
    return { hubOnline: online, hubOffline: offline, cmdFail24h };
  },

  listModels: () => request("/admin/models"),
  createModel: (body) => request("/admin/models", { method: "POST", body: JSON.stringify(body) }),

  listHubInventory: () => request("/admin/inventory/hubs?limit=200"),
  genHubInventory: (body) => request("/admin/inventory/hubs", { method: "POST", body: JSON.stringify(body) }),

  // Thêm thủ công 1 dòng HubInventory (đủ trường như seed.js)
  // NOTE: Một số backend chỉ hỗ trợ dạng bulk { items: [...] }.
  // Ở đây sẽ thử gửi dạng single trước, nếu 400 thì thử fallback sang bulk.
  createHubInventoryItem: async (body) => {
    try {
      return await request("/admin/inventory/hubs", { method: "POST", body: JSON.stringify(body) });
    } catch (e) {
      // Fallback: bulk payload
      return await request("/admin/inventory/hubs", { method: "POST", body: JSON.stringify({ items: [body] }) });
    }
  },

  // Nhập nhiều dòng HubInventory (CSV import -> items)
  createHubInventoryBulk: (items) =>
    request("/admin/inventory/hubs", { method: "POST", body: JSON.stringify({ items }) }),

  listDeviceInventory: () => request("/admin/inventory/devices?limit=200"),
  genDeviceInventory: (body) => request("/admin/inventory/devices", { method: "POST", body: JSON.stringify(body) }),

  // Thêm thủ công 1 dòng DeviceInventory (đủ trường như seed.js)
  // NOTE: Một số backend chỉ hỗ trợ dạng bulk { items: [...] }.
  createDeviceInventoryItem: async (body) => {
    try {
      return await request("/admin/inventory/devices", { method: "POST", body: JSON.stringify(body) });
    } catch (e) {
      return await request("/admin/inventory/devices", { method: "POST", body: JSON.stringify({ items: [body] }) });
    }
  },

  // Nhập nhiều dòng DeviceInventory (CSV import -> items)
  createDeviceInventoryBulk: (items) =>
    request("/admin/inventory/devices", { method: "POST", body: JSON.stringify({ items }) }),

  exportInventoryCsv: (kind) =>
    request("/admin/inventory/export", {
      method: "POST",
      body: JSON.stringify({ kind, format: "csv" })
    }),

  listFleetHubs: (status) =>
    request(`/admin/fleet/hubs${status ? `?status=${encodeURIComponent(status)}` : ""}`),

  listFleetDevices: (q) => {
    const params = new URLSearchParams(q);
    const qs = params.toString();
    return request(`/admin/fleet/devices${qs ? `?${qs}` : ""}`);
  },

  listEvents: (q) => {
    const params = new URLSearchParams(q);
    const qs = params.toString();
    return request(`/admin/events${qs ? `?${qs}` : ""}`);
  },

  listCommands: (q) => {
    const params = new URLSearchParams(q);
    const qs = params.toString();
    return request(`/admin/commands${qs ? `?${qs}` : ""}`);
  },

  retryCommand: (idOrCmdId) =>
    request(`/admin/commands/${encodeURIComponent(idOrCmdId)}/retry`, { method: "POST" }),

  // Hub OTA releases/rollouts
  listFirmwareReleases: () => request("/admin/firmware/releases?limit=200"),
  createFirmwareRelease: (body) =>
    request("/admin/firmware/releases", { method: "POST", body: JSON.stringify(body) }),
  listFirmwareRollouts: () => request("/admin/firmware/rollouts?limit=200"),
  createFirmwareRollout: (body) =>
    request("/admin/firmware/rollouts", { method: "POST", body: JSON.stringify(body) }),
  startFirmwareRollout: (id) =>
    request(`/admin/firmware/rollouts/${encodeURIComponent(id)}/start`, { method: "POST" }),
  pauseFirmwareRollout: (id) =>
    request(`/admin/firmware/rollouts/${encodeURIComponent(id)}/pause`, { method: "POST" }),
  getFirmwareRollout: (id) => request(`/admin/firmware/rollouts/${encodeURIComponent(id)}`),

  // Automations
  listHomeAutomations: (homeId) => request(`/homes/${homeId}/automations`),
  createHomeAutomation: (homeId, body) =>
    request(`/homes/${homeId}/automations`, { method: "POST", body: JSON.stringify(body) }),
  updateAutomation: (id, body) =>
    request(`/automations/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteAutomation: (id) => request(`/automations/${id}`, { method: "DELETE" }),
  enableAutomation: (id) => request(`/automations/${id}/enable`, { method: "POST" }),
  disableAutomation: (id) => request(`/automations/${id}/disable`, { method: "POST" }),
  getHubAutomationStatus: (hubId) => request(`/hubs/${encodeURIComponent(hubId)}/automations/status`)
};
