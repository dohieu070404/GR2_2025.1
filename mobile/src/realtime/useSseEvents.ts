import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { API_URL } from "../config";
import type { CommandStatus, Device, DeviceCommand } from "../types";

type SseFrame = {
  id: string | null;
  event: string | null;
  dataLines: string[];
};

// RN XMLHttpRequest keeps growing `responseText` for streaming responses.
// To avoid unbounded memory growth on long sessions, we periodically rotate
// the SSE connection once responseText grows beyond this threshold.
const MAX_RESPONSE_TEXT_CHARS = 512_000; // ~512 KB

function safeJsonParse<T = any>(str: string): T | null {
  try {
    return JSON.parse(str) as T;
  } catch {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function toLocalIsoDate(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function toIsoMaybe(v: any): string | null {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
  return null;
}

function getDeviceDbId(input: any): number | null {
  const raw = input?.deviceDbId ?? input?.deviceId ?? input?.id ?? null;
  const n = typeof raw === "string" ? Number(raw) : raw;
  return Number.isInteger(n) ? (n as number) : null;
}

function getDeviceUuid(input: any): string | null {
  const raw = input?.deviceId;
  if (typeof raw !== "string") return null;
  // When using the new backend contract, deviceId is usually a UUID/ULID-like string.
  // Keep it as-is (do NOT lowercase) because some schemes are case-sensitive.
  const s = raw.trim();
  return s.length ? s : null;
}

function normalizeCommandStatus(v: any): CommandStatus | null {
  if (v === "PENDING" || v === "ACKED" || v === "FAILED" || v === "TIMEOUT") return v;
  return null;
}

function updateDevicesList(
  qc: ReturnType<typeof useQueryClient>,
  predicate: (d: Device) => boolean,
  updater: (d: Device) => Device
) {
  qc.setQueriesData({ queryKey: ["devices"] }, (old: any) => {
    if (!old?.devices) return old;
    return {
      ...old,
      devices: (old.devices as Device[]).map((d) => (predicate(d) ? updater(d) : d)),
    };
  });
}

function updateDeviceEverywhere(
  qc: ReturnType<typeof useQueryClient>,
  deviceDbId: number,
  updater: (d: Device) => Device
) {
  updateDevicesList(qc, (d) => d.id === deviceDbId, updater);

  // Optional: device detail cache if the app uses it in the future.
  qc.setQueryData(["device", deviceDbId], (old: any) => {
    if (!old) return old;
    return updater(old as Device);
  });
}

function upsertCommandInCache(
  qc: ReturnType<typeof useQueryClient>,
  deviceDbId: number,
  cmd: DeviceCommand
) {
  qc.setQueryData(["deviceCommands", deviceDbId], (old: any) => {
    if (!old?.items) return old;

    const items: DeviceCommand[] = Array.isArray(old.items) ? old.items : [];
    const idx = items.findIndex((c) => c.cmdId === cmd.cmdId);

    if (idx === -1) {
      return {
        ...old,
        items: [cmd, ...items],
      };
    }

    const next = [...items];
    next[idx] = { ...next[idx], ...cmd };

    return {
      ...old,
      items: next,
    };
  });
}

export function useSseEvents(token: string | null) {
  const qc = useQueryClient();

  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const lastPosRef = useRef(0);
  const bufferRef = useRef("");
  const frameRef = useRef<SseFrame>({ id: null, event: null, dataLines: [] });
  const lastEventIdRef = useRef<string | null>(null);

  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffMsRef = useRef(1000);
  const stoppedRef = useRef(false);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  function clearReconnectTimer() {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }

  function stopConnection() {
    clearReconnectTimer();

    if (xhrRef.current) {
      try {
        xhrRef.current.onprogress = null;
        xhrRef.current.onerror = null;
        xhrRef.current.onload = null;
        xhrRef.current.onreadystatechange = null;
        xhrRef.current.onabort = null;
        xhrRef.current.abort();
      } catch {
        // ignore
      }
      xhrRef.current = null;
    }

    // Reset incremental parsing state
    lastPosRef.current = 0;
    bufferRef.current = "";
    frameRef.current = { id: null, event: null, dataLines: [] };
  }

  function scheduleReconnect(reason: string) {
    if (stoppedRef.current) return;
    if (!token) return;
    if (appStateRef.current !== "active") return;

    clearReconnectTimer();

    const delay = backoffMsRef.current;
    // Exponential backoff: 1s, 2s, 4s, ... max 30s
    backoffMsRef.current = Math.min(backoffMsRef.current * 2, 30_000);

    console.log(`[SSE] reconnect in ${delay}ms (${reason})`);
    reconnectTimerRef.current = setTimeout(() => {
      startConnection();
    }, delay);
  }

  function resetBackoff() {
    backoffMsRef.current = 1000;
  }

  function dispatchFrame(frame: SseFrame) {
    if (!frame.dataLines.length) return;

    if (frame.id) {
      lastEventIdRef.current = frame.id;
    }

    const eventName = frame.event || "message";
    const dataStr = frame.dataLines.join("\n");
    const data = safeJsonParse<any>(dataStr);
    if (!data) return;

    if (eventName === "ready" || eventName === "ping") {
      // ignore
      return;
    }

    if (eventName === "device_state_updated") {
      const deviceDbId = getDeviceDbId(data);
      const deviceUuid = getDeviceUuid(data);
      if (!deviceDbId && !deviceUuid) return;

      // backend might send either { state: {..} } or { state: { ts, state:{..} } }
      const state = data?.state?.state ?? data?.state ?? null;
      const lastSeen = toIsoMaybe(data?.lastSeen) ?? toIsoMaybe(data?.ts) ?? nowIso();
      const online = typeof data?.online === "boolean" ? data.online : null;

      const apply = (updater: (d: Device) => Device) => {
        if (deviceDbId) {
          updateDeviceEverywhere(qc, deviceDbId, updater);
        } else if (deviceUuid) {
          updateDevicesList(qc, (d) => d.deviceId === deviceUuid, updater);
        }
      };

      apply((d) => {
        const nextStateCurrent = {
          ...(d.stateCurrent || { state: null }),
          state,
          lastSeen,
          updatedAt: nowIso(),
          ...(typeof online === "boolean" ? { online } : {}),
        };

        return {
          ...d,
          lastState: state,
          lastSeen,
          ...(typeof online === "boolean" ? { online } : {}),
          stateCurrent: nextStateCurrent,
        };
      });

      return;
    }

    if (eventName === "device_status_changed") {
      const deviceDbId = getDeviceDbId(data);
      const deviceUuid = getDeviceUuid(data);
      if (!deviceDbId && !deviceUuid) return;

      const online = typeof data?.online === "boolean" ? data.online : null;
      if (typeof online !== "boolean") return;

      const lastSeen = toIsoMaybe(data?.lastSeen) ?? toIsoMaybe(data?.ts) ?? nowIso();

      const apply = (updater: (d: Device) => Device) => {
        if (deviceDbId) {
          updateDeviceEverywhere(qc, deviceDbId, updater);
        } else if (deviceUuid) {
          updateDevicesList(qc, (d) => d.deviceId === deviceUuid, updater);
        }
      };

      apply((d) => {
        const nextStateCurrent = {
          ...(d.stateCurrent || { state: null }),
          lastSeen,
          updatedAt: nowIso(),
          online,
        };

        return {
          ...d,
          online,
          lastSeen,
          stateCurrent: nextStateCurrent,
        };
      });

      return;
    }

    if (eventName === "device_event_created") {
      const deviceDbId = getDeviceDbId(data);
      if (!deviceDbId) return;
      const ev = data?.event ?? null;

      // Sprint 5: append today's list immediately for better realtime UX
      if (ev && typeof ev?.id !== "undefined") {
        const today = toLocalIsoDate(new Date());
        qc.setQueryData(["deviceEvents", deviceDbId, today], (old: any) => {
          if (!old?.events || !Array.isArray(old.events)) return old;
          const exists = old.events.some((x: any) => x?.id === ev.id);
          if (exists) return old;
          return { ...old, events: [ev, ...old.events] };
        });
      }

      // Refresh any event/history queries for this device (all days)
      qc.invalidateQueries({ queryKey: ["deviceEvents", deviceDbId] });
      return;
    }

    if (eventName === "command_updated") {
      const deviceDbId = getDeviceDbId(data);
      const deviceUuid = getDeviceUuid(data);
      if (!deviceDbId && !deviceUuid) return;

      const cmdId = typeof data?.cmdId === "string" ? data.cmdId : null;
      if (!cmdId) return;

      const status = normalizeCommandStatus(data?.status);
      if (!status) return;

      const sentAt = toIsoMaybe(data?.sentAt) ?? null;
      const ackedAt = toIsoMaybe(data?.ackedAt) ?? null;
      const error = data?.error != null ? String(data.error) : null;

      const apply = (updater: (d: Device) => Device) => {
        if (deviceDbId) {
          updateDeviceEverywhere(qc, deviceDbId, updater);
        } else if (deviceUuid) {
          updateDevicesList(qc, (d) => d.deviceId === deviceUuid, updater);
        }
      };

      apply((d) => {
        const prev = d.lastCommand;
        const shouldUpdate = !prev || prev.cmdId === cmdId;

        if (!shouldUpdate) return d;

        return {
          ...d,
          lastCommand: {
            cmdId,
            status,
            payload: prev?.payload,
            sentAt: sentAt ?? prev?.sentAt ?? null,
            ackedAt: ackedAt ?? prev?.ackedAt ?? null,
            error,
          },
        };
      });

      // Update command list cache if present
      if (deviceDbId) {
        upsertCommandInCache(qc, deviceDbId, {
          cmdId,
          status,
          payload: data?.payload,
          sentAt,
          ackedAt,
          error,
        });
      }

      return;
    }
  }

  function processLine(line: string) {
    // Empty line means "dispatch event"
    if (line === "") {
      const frame = frameRef.current;
      dispatchFrame(frame);
      frameRef.current = { id: null, event: null, dataLines: [] };
      return;
    }

    // Comment
    if (line.startsWith(":")) return;

    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    const value = idx === -1 ? "" : line.slice(idx + 1).trimStart();

    switch (field) {
      case "event":
        frameRef.current.event = value;
        break;
      case "data":
        frameRef.current.dataLines.push(value);
        break;
      case "id":
        frameRef.current.id = value;
        lastEventIdRef.current = value;
        break;
      case "retry":
        // server hint - ignore, we handle reconnect ourselves
        break;
      default:
        break;
    }
  }

  function feedText(newText: string) {
    bufferRef.current += newText;

    while (true) {
      const idx = bufferRef.current.indexOf("\n");
      if (idx === -1) break;

      const rawLine = bufferRef.current.slice(0, idx);
      bufferRef.current = bufferRef.current.slice(idx + 1);

      const line = rawLine.replace(/\r$/, "");
      processLine(line);
    }
  }

  function startConnection() {
    if (!token) return;
    if (appStateRef.current !== "active") return;

    stopConnection();
    clearReconnectTimer();

    const url = `${API_URL}/events`;
    console.log(`[SSE] connect ${url}`);

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;

    try {
      xhr.open("GET", url, true);
      xhr.setRequestHeader("Accept", "text/event-stream");
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      // Resume from last event ID (backend supports Last-Event-ID)
      if (lastEventIdRef.current) {
        xhr.setRequestHeader("Last-Event-ID", lastEventIdRef.current);
      }

      xhr.onreadystatechange = () => {
        // HEADERS_RECEIVED means the connection is established.
        if (xhr.readyState === 2) {
          resetBackoff();
          console.log("[SSE] connected");
        }

        // DONE means the server closed the connection.
        if (xhr.readyState === 4) {
          console.log(`[SSE] closed (status=${xhr.status})`);
          scheduleReconnect(`closed status=${xhr.status}`);
        }
      };

      xhr.onprogress = () => {
        const text = xhr.responseText || "";
        const lastPos = lastPosRef.current;
        if (text.length <= lastPos) return;

        const chunk = text.slice(lastPos);
        lastPosRef.current = text.length;
        feedText(chunk);

        // Rotate connection to avoid unbounded growth of xhr.responseText
        if (text.length >= MAX_RESPONSE_TEXT_CHARS) {
          console.log(`[SSE] rotate connection (buffer=${text.length})`);
          // Keep lastEventIdRef; it will be sent as Last-Event-ID on reconnect.
          stopConnection();
          resetBackoff();
          clearReconnectTimer();
          reconnectTimerRef.current = setTimeout(() => startConnection(), 0);
        }
      };

      xhr.onerror = () => {
        console.log("[SSE] error");
        scheduleReconnect("error");
      };

      xhr.onabort = () => {
        // stopConnection triggers abort; no-op
      };

      xhr.send(null);
    } catch (e) {
      console.log("[SSE] connect failed", e);
      scheduleReconnect("exception");
    }
  }

  useEffect(() => {
    stoppedRef.current = false;

    // Token missing => ensure stopped.
    if (!token) {
      stopConnection();
      return;
    }

    // Start now.
    startConnection();

    const sub = AppState.addEventListener("change", (next) => {
      appStateRef.current = next;
      if (next === "active") {
        // reconnect when app returns to foreground
        startConnection();
      } else {
        // close in background (saves battery)
        stopConnection();
      }
    });

    return () => {
      stoppedRef.current = true;
      sub.remove();
      stopConnection();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
}
