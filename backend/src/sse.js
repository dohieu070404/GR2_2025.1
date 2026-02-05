// Simple in-memory SSE hub.
//
// Goals:
// - Fan-out events to all clients that are members of a given home
// - Keep-alive pings to survive proxies
// - Best-effort replay using Last-Event-ID via an in-memory ring buffer
//
// NOTE: For a multi-instance deployment, move this to a shared pub/sub
// (Redis, NATS, Kafka, ...) otherwise clients connected to instance A will
// not receive events emitted on instance B.

import crypto from "crypto";

/** @typedef {{ id: number, event: string, data: any, ts: number }} StoredEvent */

const clients = new Map();
// clientId -> { res, userId, homeIds:Set<number>, connectedAt:number }

let globalEventId = 0;

// Per-home ring buffer, used for replay on reconnect (Last-Event-ID).
const homeBuffers = new Map(); // homeId -> StoredEvent[]

const EVENT_BUFFER_SIZE = Number(process.env.SSE_EVENT_BUFFER_SIZE || 200);
const PING_INTERVAL_MS = Number(process.env.SSE_PING_INTERVAL_MS || 25000);

function nextId() {
  globalEventId += 1;
  return globalEventId;
}

function safeWrite(res, chunk) {
  try {
    res.write(chunk);
    return true;
  } catch {
    return false;
  }
}

function formatSseEvent({ id, event, data }) {
  // SSE frame:
  //   id: 1
  //   event: name
  //   data: {...}
  //
  // data must be a single line; JSON.stringify ensures that.
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function pushToHomeBuffer(homeId, evt) {
  if (!Number.isInteger(homeId)) return;
  const arr = homeBuffers.get(homeId) || [];
  arr.push(evt);
  if (arr.length > EVENT_BUFFER_SIZE) {
    arr.splice(0, arr.length - EVENT_BUFFER_SIZE);
  }
  homeBuffers.set(homeId, arr);
}

function replayEventsToClient(res, homeIds, lastEventId) {
  if (!Number.isFinite(lastEventId)) return;
  const all = [];

  for (const hid of homeIds) {
    const buf = homeBuffers.get(hid);
    if (!buf) continue;
    for (const e of buf) {
      if (e.id > lastEventId) all.push(e);
    }
  }

  all.sort((a, b) => a.id - b.id);
  for (const e of all) {
    if (!safeWrite(res, formatSseEvent(e))) return false;
  }
  return true;
}

export function addSseClient({ res, userId, homeIds, lastEventId }) {
  const clientId = crypto.randomUUID();
  clients.set(clientId, {
    res,
    userId,
    homeIds: new Set(Array.from(homeIds || [])),
    connectedAt: Date.now(),
  });

  // Best-effort replay on reconnect.
  if (lastEventId != null) {
    replayEventsToClient(res, new Set(Array.from(homeIds || [])), Number(lastEventId));
  }

  // Let the client know we are ready.
  safeWrite(res, formatSseEvent({ id: nextId(), event: "ready", data: { ts: Date.now() } }));

  return clientId;
}

export function removeSseClient(clientId) {
  const c = clients.get(clientId);
  if (!c) return;
  try {
    c.res.end();
  } catch {
    // ignore
  }
  clients.delete(clientId);
}

export function emitToHome(homeId, event, data) {
  const id = nextId();
  const payload = { id, event, data, ts: Date.now() };
  pushToHomeBuffer(homeId, payload);

  for (const [cid, c] of clients.entries()) {
    if (!c.homeIds.has(homeId)) continue;
    const ok = safeWrite(c.res, formatSseEvent(payload));
    if (!ok) removeSseClient(cid);
  }
}

export function getSseStats() {
  return {
    clients: clients.size,
    eventId: globalEventId,
    bufferSize: EVENT_BUFFER_SIZE,
    pingIntervalMs: PING_INTERVAL_MS,
  };
}

// Keep-alive ping (comment frame) for reverse proxies.
setInterval(() => {
  const now = Date.now();
  for (const [cid, c] of clients.entries()) {
    const ok = safeWrite(c.res, `: ping ${now}\n\n`);
    if (!ok) removeSseClient(cid);
  }
}, PING_INTERVAL_MS).unref?.();
