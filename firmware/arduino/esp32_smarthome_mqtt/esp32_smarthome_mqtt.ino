/*
  ESP32 MQTT Device Firmware (Arduino)

  Goals (production-ready contract):
  - Implement MQTT contract:
      Sub: home/<homeId>/device/<deviceId>/set
      Pub: .../ack (QoS1)
           .../state (retain)
           .../status (retain + LWT offline)
  - Non-blocking WiFi/MQTT reconnect with exponential backoff
  - Safe JSON parsing (NEVER write into MQTT callback payload buffer)
  - Persist state in NVS (Preferences) so reboot keeps last state

  Dependencies:
  - WiFi (built-in)
  - ArduinoJson
  - AsyncMqttClient (install from Library Manager)

  Notes:
  - This sample implements a RELAY device type (GPIO on/off).
    Adapt `applyPayload()` for dimmer/RGB/sensors as needed.
*/

#include <WiFi.h>
#include <AsyncTCP.h>
#include <AsyncMqttClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <esp_system.h>
#include <vector>

// ----------------- USER CONFIG -----------------
//
// Defaults (used if NVS is empty). You can provision WITHOUT reflashing via Serial CLI.

// WiFi defaults
static const char* DEFAULT_WIFI_SSID = "YOUR_WIFI_SSID";
static const char* DEFAULT_WIFI_PASS = "YOUR_WIFI_PASSWORD";

// MQTT defaults
static const char* DEFAULT_MQTT_HOST = "192.168.1.10";
static const uint16_t DEFAULT_MQTT_PORT = 1883;
static const char* DEFAULT_MQTT_USER = "smarthome";
static const char* DEFAULT_MQTT_PASS = "smarthome123";

// If NVS doesn't have values yet, these defaults are used.
// IMPORTANT: backend expects homeId to match DB Home.id (integer string).
static const char* DEFAULT_HOME_ID = "1";
// IMPORTANT: This must match the Device.deviceId you provisioned in backend.
static const char* DEFAULT_DEVICE_ID = "00000000-0000-0000-0000-000000000000";
static const char* DEFAULT_DEVICE_TYPE = "relay";

// NVS keys
static const char* PREF_NS = "smarthome";
static const char* KEY_WIFI_SSID = "wifi_ssid";
static const char* KEY_WIFI_PASS = "wifi_pass";
static const char* KEY_MQTT_HOST = "mqtt_host";
static const char* KEY_MQTT_PORT = "mqtt_port";
static const char* KEY_MQTT_USER = "mqtt_user";
static const char* KEY_MQTT_PASS = "mqtt_pass";
static const char* KEY_HOME_ID   = "homeId";
static const char* KEY_DEVICE_ID = "deviceId";
static const char* KEY_TYPE      = "type";

// Runtime config
static String cfgWifiSsid;
static String cfgWifiPass;
static String cfgMqttHost;
static uint16_t cfgMqttPort = DEFAULT_MQTT_PORT;
static String cfgMqttUser;
static String cfgMqttPass;

// Serial CLI line buffer
static String cliLine;

// Hardware
static const int RELAY_PIN = 5;        // change to your wiring
static const bool RELAY_ACTIVE_HIGH = true;

// Safety limits
// Max accepted MQTT message size for /set (bytes). Bigger => drop.
// Keep this in sync with broker/device limits.
#ifndef MQTT_RX_BUF_SIZE
#define MQTT_RX_BUF_SIZE 512
#endif
static char rxBuf[MQTT_RX_BUF_SIZE];
static bool rxDropping = false;

// Exponential backoff (ms)
static const uint32_t BACKOFF_MIN_MS = 1000;
static const uint32_t BACKOFF_MAX_MS = 30000;

// ----------------- GLOBALS -----------------
Preferences prefs;
AsyncMqttClient mqtt;

String homeId;
String deviceId;
String deviceType;

String topicPrefix;
String topicSet;
String topicAck;
String topicState;
String topicStatus;

bool relayOn = false;

uint32_t wifiBackoffMs = BACKOFF_MIN_MS;
uint32_t wifiNextAttemptMs = 0;
uint32_t mqttBackoffMs = BACKOFF_MIN_MS;
uint32_t mqttNextAttemptMs = 0;

static bool timeDue(uint32_t now, uint32_t dueMs) {
  return (int32_t)(now - dueMs) >= 0;
}

static void applyRelay(bool on) {
  relayOn = on;
  digitalWrite(RELAY_PIN, (RELAY_ACTIVE_HIGH ? (on ? HIGH : LOW) : (on ? LOW : HIGH)));
}

static void buildTopics() {
  topicPrefix = String("home/") + homeId + "/device/" + deviceId;
  topicSet = topicPrefix + "/set";
  topicAck = topicPrefix + "/ack";
  topicState = topicPrefix + "/state";
  topicStatus = topicPrefix + "/status";

  // LWT: retained offline
  mqtt.setWill(topicStatus.c_str(), 1 /*qos*/, true /*retain*/, "{\"online\":false}");
}

static void publishStatus(bool online) {
  StaticJsonDocument<96> doc;
  doc["ts"] = (uint32_t)millis();
  doc["online"] = online;
  String out;
  serializeJson(doc, out);
  mqtt.publish(topicStatus.c_str(), 1 /*qos*/, true /*retain*/, out.c_str(), out.length());
}

static void publishState() {
  StaticJsonDocument<192> doc;
  doc["ts"] = (uint32_t)millis();
  JsonObject st = doc.createNestedObject("state");
  st["relay"] = relayOn;
  String out;
  serializeJson(doc, out);

  mqtt.publish(topicState.c_str(), 1 /*qos*/, true /*retain*/, out.c_str(), out.length());
}

static uint16_t publishAck(const String& cmdId, bool ok, const char* errorOrNull) {
  StaticJsonDocument<192> doc;
  doc["cmdId"] = cmdId;
  doc["ok"] = ok;
  doc["ts"] = (uint32_t)millis();
  if (ok) {
    doc["error"] = nullptr;
  } else {
    doc["error"] = errorOrNull ? errorOrNull : "error";
  }
  String out;
  serializeJson(doc, out);
  return mqtt.publish(topicAck.c_str(), 1 /*qos*/, false /*retain*/, out.c_str(), out.length());
}

// Mgmt reset actions
enum PendingRestartAction { RESTART_NONE = 0, RESTART_RESET_CONNECTION = 1, RESTART_FACTORY_RESET = 2 };
static volatile PendingRestartAction pendingRestart = RESTART_NONE;

// When we receive a management reset command, we ACK it first, then reboot.
// For QoS1 ACK, AsyncMqttClient triggers `onPublish(packetId)` when PUBACK is received.
static volatile uint16_t pendingRestartAckPacketId = 0;
static volatile uint32_t pendingRestartDeadlineMs = 0;
static volatile uint32_t restartDueMs = 0;

static void clearConnectionCreds() {
  prefs.remove(KEY_WIFI_SSID);
  prefs.remove(KEY_WIFI_PASS);
  prefs.remove(KEY_MQTT_HOST);
  prefs.remove(KEY_MQTT_PORT);
  prefs.remove(KEY_MQTT_USER);
  prefs.remove(KEY_MQTT_PASS);
}

static void factoryResetAll() {
  // Wipe all keys in this namespace (including relay state).
  prefs.clear();
}

static bool applyPayload(JsonObject payload, String& error) {
  // Allow management payloads for any type
  if (payload.containsKey("mgmt") && payload["mgmt"].is<JsonObject>()) {
    JsonObject mgmt = payload["mgmt"].as<JsonObject>();
    const char* action = mgmt["action"] | "";
    if (!action || action[0] == '\0') {
      error = "payload.mgmt.action required";
      return false;
    }
    if (strcmp(action, "reset_connection") == 0) {
      clearConnectionCreds();
      pendingRestart = RESTART_RESET_CONNECTION;
      return true;
    }
    if (strcmp(action, "factory_reset") == 0) {
      factoryResetAll();
      pendingRestart = RESTART_FACTORY_RESET;
      return true;
    }
    error = String("unknown mgmt.action: ") + action;
    return false;
  }

  if (deviceType != "relay") {
    error = "unsupported deviceType";
    return false;
  }

  if (!payload.containsKey("relay")) {
    error = "missing payload.relay";
    return false;
  }
  if (!payload["relay"].is<bool>()) {
    error = "payload.relay must be boolean";
    return false;
  }

  bool on = payload["relay"].as<bool>();
  applyRelay(on);
  prefs.putBool("relay", relayOn);
  return true;
}

static void handleSetJson(const char* json) {
  StaticJsonDocument<512> doc;
  DeserializationError err = deserializeJson(doc, json);
  if (err) {
    Serial.printf("[MQTT] JSON parse error: %s\n", err.c_str());
    return;
  }

  const char* cmdIdC = doc["cmdId"] | "";
  if (!cmdIdC || cmdIdC[0] == '\0') {
    Serial.println("[MQTT] drop /set: missing cmdId");
    return;
  }
  String cmdId = String(cmdIdC);

  JsonVariant payloadV = doc["payload"];
  if (!payloadV.is<JsonObject>()) {
    publishAck(cmdId, false, "missing payload object");
    return;
  }

  String error;
  bool ok = applyPayload(payloadV.as<JsonObject>(), error);
  uint16_t ackPacketId = publishAck(cmdId, ok, ok ? nullptr : error.c_str());
  if (ok) {
    if (pendingRestart != RESTART_NONE) {
      // Restart AFTER ACK is confirmed (PUBACK) or after a short safety timeout.
      pendingRestartAckPacketId = ackPacketId;
      pendingRestartDeadlineMs = millis() + 2500; // fallback: do not wait forever
      Serial.printf("[MGMT] action=%d ackPacketId=%u -> pending restart\n", (int)pendingRestart, (unsigned)ackPacketId);
      if (ackPacketId == 0) {
        // Should not happen while connected, but don't get stuck.
        restartDueMs = millis() + 300;
      }
    } else {
      publishState();
    }
  }
}

// ----------------- MQTT callbacks -----------------
static void onMqttConnect(bool sessionPresent) {
  (void)sessionPresent;
  Serial.println("[MQTT] connected");

  mqtt.subscribe(topicSet.c_str(), 1 /*qos*/);

  // Publish presence + state on connect.
  publishStatus(true);
  publishState();

  mqttBackoffMs = BACKOFF_MIN_MS;
}

static void onMqttDisconnect(AsyncMqttClientDisconnectReason reason) {
  Serial.printf("[MQTT] disconnected reason=%d\n", (int)reason);
  // Will be reconnected by ensureMqttNonBlocking() with backoff.
}

static void onMqttPublish(uint16_t packetId) {
  // Called when QoS1 publish is acknowledged by broker (PUBACK).
  if (pendingRestart != RESTART_NONE && pendingRestartAckPacketId != 0 && packetId == pendingRestartAckPacketId) {
    Serial.printf("[MGMT] ACK confirmed (packetId=%u). Restart scheduled.\n", (unsigned)packetId);
    restartDueMs = millis() + 200;
    pendingRestartAckPacketId = 0;
    pendingRestartDeadlineMs = 0;
  }
}

static void onMqttMessage(char* topic, char* payload, AsyncMqttClientMessageProperties properties,
                          size_t len, size_t index, size_t total) {
  (void)properties;
  String t = String(topic);
  if (t != topicSet) return;

  if (total >= MQTT_RX_BUF_SIZE) {
    if (index == 0) {
      Serial.printf("[MQTT] drop too-large /set payload: %u bytes (limit %u)\n", (unsigned)total,
                    (unsigned)(MQTT_RX_BUF_SIZE - 1));
    }
    rxDropping = true;
    return;
  }
  if (rxDropping) {
    if (index + len >= total) {
      rxDropping = false;
    }
    return;
  }

  memcpy(rxBuf + index, payload, len);
  if (index + len != total) return;
  rxBuf[total] = '\0';

  handleSetJson(rxBuf);
}

// ----------------- Non-blocking reconnect -----------------
static void ensureWifiNonBlocking() {
  if (WiFi.status() == WL_CONNECTED) {
    wifiBackoffMs = BACKOFF_MIN_MS;
    return;
  }
  uint32_t now = millis();
  if (!timeDue(now, wifiNextAttemptMs)) return;

  Serial.printf("[WiFi] begin (backoff=%ums)\n", (unsigned)wifiBackoffMs);
  WiFi.mode(WIFI_STA);
  WiFi.begin(cfgWifiSsid.c_str(), cfgWifiPass.c_str());

  wifiNextAttemptMs = now + wifiBackoffMs;
  wifiBackoffMs = (wifiBackoffMs < BACKOFF_MAX_MS) ? min(BACKOFF_MAX_MS, wifiBackoffMs * 2) : BACKOFF_MAX_MS;
}

static void ensureMqttNonBlocking() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (mqtt.connected()) {
    mqttBackoffMs = BACKOFF_MIN_MS;
    return;
  }
  uint32_t now = millis();
  if (!timeDue(now, mqttNextAttemptMs)) return;

  Serial.printf("[MQTT] connect (backoff=%ums)\n", (unsigned)mqttBackoffMs);
  mqtt.connect();

  mqttNextAttemptMs = now + mqttBackoffMs;
  mqttBackoffMs = (mqttBackoffMs < BACKOFF_MAX_MS) ? min(BACKOFF_MAX_MS, mqttBackoffMs * 2) : BACKOFF_MAX_MS;
}



static void loadConfig() {
  cfgWifiSsid = prefs.getString(KEY_WIFI_SSID, DEFAULT_WIFI_SSID);
  cfgWifiPass = prefs.getString(KEY_WIFI_PASS, DEFAULT_WIFI_PASS);

  cfgMqttHost = prefs.getString(KEY_MQTT_HOST, DEFAULT_MQTT_HOST);
  cfgMqttPort = (uint16_t)prefs.getUInt(KEY_MQTT_PORT, DEFAULT_MQTT_PORT);
  cfgMqttUser = prefs.getString(KEY_MQTT_USER, DEFAULT_MQTT_USER);
  cfgMqttPass = prefs.getString(KEY_MQTT_PASS, DEFAULT_MQTT_PASS);

  homeId = prefs.getString(KEY_HOME_ID, DEFAULT_HOME_ID);
  deviceId = prefs.getString(KEY_DEVICE_ID, DEFAULT_DEVICE_ID);
  deviceType = prefs.getString(KEY_TYPE, DEFAULT_DEVICE_TYPE);

  if (cfgWifiSsid.isEmpty()) cfgWifiSsid = DEFAULT_WIFI_SSID;
  if (cfgMqttHost.isEmpty()) cfgMqttHost = DEFAULT_MQTT_HOST;
  if (homeId.isEmpty()) homeId = DEFAULT_HOME_ID;
  if (deviceId.isEmpty()) deviceId = DEFAULT_DEVICE_ID;
  if (deviceType.isEmpty()) deviceType = DEFAULT_DEVICE_TYPE;
}

static void printConfig() {
  Serial.println("----- DEVICE CONFIG (NVS) -----");
  Serial.printf("wifi_ssid : %s\n", cfgWifiSsid.c_str());
  Serial.printf("wifi_pass : %s\n", cfgWifiPass.length() ? "<set>" : "<empty>");
  Serial.printf("mqtt_host : %s\n", cfgMqttHost.c_str());
  Serial.printf("mqtt_port : %u\n", (unsigned)cfgMqttPort);
  Serial.printf("mqtt_user : %s\n", cfgMqttUser.c_str());
  Serial.printf("mqtt_pass : %s\n", cfgMqttPass.length() ? "<set>" : "<empty>");
  Serial.printf("homeId    : %s\n", homeId.c_str());
  Serial.printf("deviceId  : %s\n", deviceId.c_str());
  Serial.printf("type      : %s\n", deviceType.c_str());
  Serial.println("------------------------------");
}

static void cliHelp() {
  Serial.println("Serial provisioning commands:");
  Serial.println("  CFG SHOW");
  Serial.println("  CFG WIFI <ssid> <pass>");
  Serial.println("  CFG MQTT <host> <port> [user] [pass]");
  Serial.println("  CFG ID <homeId> <deviceId> [type]");
  Serial.println("  CFG CLEAR  (clear only provisioning keys, keep relay state)");
  Serial.println("  CFG RESTART");
}

static void cliClear() {
  prefs.remove(KEY_WIFI_SSID);
  prefs.remove(KEY_WIFI_PASS);
  prefs.remove(KEY_MQTT_HOST);
  prefs.remove(KEY_MQTT_PORT);
  prefs.remove(KEY_MQTT_USER);
  prefs.remove(KEY_MQTT_PASS);
  prefs.remove(KEY_HOME_ID);
  prefs.remove(KEY_DEVICE_ID);
  prefs.remove(KEY_TYPE);
}

static void handleCliLine(String line) {
  line.trim();
  if (!line.length()) return;
  if (line.equalsIgnoreCase("HELP")) { cliHelp(); return; }
  if (!line.startsWith("CFG")) { Serial.println("Unknown command. Type HELP."); return; }

  // Split by space
  std::vector<String> parts;
  int i = 0;
  while (i < (int)line.length()) {
    while (i < (int)line.length() && line[i] == ' ') i++;
    int j = i;
    while (j < (int)line.length() && line[j] != ' ') j++;
    if (j > i) parts.push_back(line.substring(i, j));
    i = j;
  }
  if (parts.size() < 2) { cliHelp(); return; }

  String sub = parts[1]; sub.toUpperCase();

  if (sub == "SHOW") { loadConfig(); printConfig(); return; }

  if (sub == "WIFI" && parts.size() >= 4) {
    prefs.putString(KEY_WIFI_SSID, parts[2]);
    prefs.putString(KEY_WIFI_PASS, parts[3]);
    Serial.println("Saved WIFI. Restarting...");
    delay(200);
    ESP.restart();
    return;
  }

  if (sub == "MQTT" && parts.size() >= 4) {
    prefs.putString(KEY_MQTT_HOST, parts[2]);
    prefs.putUInt(KEY_MQTT_PORT, (uint32_t)parts[3].toInt());
    if (parts.size() >= 5) prefs.putString(KEY_MQTT_USER, parts[4]);
    if (parts.size() >= 6) prefs.putString(KEY_MQTT_PASS, parts[5]);
    Serial.println("Saved MQTT. Restarting...");
    delay(200);
    ESP.restart();
    return;
  }

  if (sub == "ID" && parts.size() >= 4) {
    prefs.putString(KEY_HOME_ID, parts[2]);
    prefs.putString(KEY_DEVICE_ID, parts[3]);
    if (parts.size() >= 5) prefs.putString(KEY_TYPE, parts[4]);
    Serial.println("Saved IDs. Restarting...");
    delay(200);
    ESP.restart();
    return;
  }

  if (sub == "CLEAR") {
    cliClear();
    Serial.println("Cleared provisioning keys. Restarting...");
    delay(200);
    ESP.restart();
    return;
  }

  if (sub == "RESTART") {
    Serial.println("Restarting...");
    delay(200);
    ESP.restart();
    return;
  }

  cliHelp();
}

static void pollCli() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n') {
      String line = cliLine;
      cliLine = "";
      handleCliLine(line);
    } else if (c != '\r') {
      if (cliLine.length() < 200) cliLine += c;
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n[Device] boot");

  // NVS
  prefs.begin(PREF_NS, false);
  loadConfig();
  printConfig();
  // Restore last state
  relayOn = prefs.getBool("relay", false);
  pinMode(RELAY_PIN, OUTPUT);
  applyRelay(relayOn);

  // MQTT config
  buildTopics();
  mqtt.setServer(cfgMqttHost.c_str(), cfgMqttPort);
  if (cfgMqttUser.length()) mqtt.setCredentials(cfgMqttUser.c_str(), cfgMqttPass.c_str());

  // Stable client id: deviceId + MAC
  String cid = String("dev-") + deviceId + "-" + String((uint32_t)ESP.getEfuseMac(), HEX);
  mqtt.setClientId(cid.c_str());

  mqtt.onConnect(onMqttConnect);
  mqtt.onDisconnect(onMqttDisconnect);
  mqtt.onPublish(onMqttPublish);
  mqtt.onMessage(onMqttMessage);

  Serial.printf("[CFG] homeId=%s deviceId=%s type=%s\n", homeId.c_str(), deviceId.c_str(), deviceType.c_str());
  Serial.printf("[CFG] topicPrefix=%s\n", topicPrefix.c_str());
}

void loop() {
  pollCli();
  ensureWifiNonBlocking();
  ensureMqttNonBlocking();

  // Management restart logic.
  // - Preferred: restart once ACK is confirmed (onPublish)
  // - Fallback: if ACK isn't confirmed within deadline, still restart
  if (pendingRestart != RESTART_NONE) {
    const uint32_t now = millis();
    if (restartDueMs && timeDue(now, restartDueMs)) {
      Serial.println("[MGMT] restarting now");
      delay(50);
      ESP.restart();
    }
    if (pendingRestartDeadlineMs && timeDue(now, pendingRestartDeadlineMs)) {
      Serial.println("[MGMT] restart fallback (ACK timeout)");
      delay(50);
      ESP.restart();
    }
  }

  // Your device work here (sensors, GPIO debounce, ...)
  // Keep loop non-blocking.
}
