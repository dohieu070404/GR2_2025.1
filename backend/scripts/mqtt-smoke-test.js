#!/usr/bin/env node
/*
  MQTT smoke test

  - Connect to broker with username/password
  - Subscribe + publish roundtrip on diagnostics topic
  - Exit code 0 on success, 1 on failure

  Usage:
    cd backend
    MQTT_URL=mqtt://localhost:1883 MQTT_USERNAME=smarthome MQTT_PASSWORD=smarthome123 \
      node scripts/mqtt-smoke-test.js
*/

import mqtt from "mqtt";
import crypto from "crypto";

function getEnv(name, fallback) {
  const v = process.env[name];
  return v == null || v === "" ? fallback : v;
}

const url = getEnv("MQTT_URL", "mqtt://localhost:1883");
const username = getEnv("MQTT_USERNAME", "");
const password = getEnv("MQTT_PASSWORD", "");
const timeoutMs = Number(getEnv("MQTT_TEST_TIMEOUT_MS", "4000"));

const nonce = crypto.randomUUID();
const topic = `diagnostics/smoke/${nonce}`;
const payload = JSON.stringify({ nonce, ts: Date.now() });

const client = mqtt.connect(url, {
  clientId: `smoke-${nonce.slice(0, 8)}`,
  clean: true,
  keepalive: 20,
  connectTimeout: 8000,
  ...(username ? { username } : {}),
  ...(password ? { password } : {}),
});

let timer = null;
function done(ok, extra) {
  if (timer) clearTimeout(timer);
  try {
    client.end(true);
  } catch {}

  if (ok) {
    console.log(`[mqtt-smoke-test] OK url=${url} topic=${topic}`);
    process.exit(0);
  }
  console.error(`[mqtt-smoke-test] FAIL url=${url} topic=${topic}`, extra || "");
  process.exit(1);
}

timer = setTimeout(() => done(false, `TIMEOUT after ${timeoutMs}ms`), timeoutMs);

client.on("error", (err) => {
  done(false, err?.message || String(err));
});

client.on("connect", () => {
  client.subscribe(topic, { qos: 0 }, (err) => {
    if (err) return done(false, err?.message || String(err));
    client.publish(topic, payload, { qos: 0 }, (err2) => {
      if (err2) return done(false, err2?.message || String(err2));
    });
  });
});

client.on("message", (t, msg) => {
  if (t !== topic) return;
  try {
    const o = JSON.parse(msg.toString("utf8"));
    if (o?.nonce === nonce) return done(true);
  } catch {
    // ignore
  }
});
