/*
  Hub Host firmware (ESP32-WROOM-32) — Arduino IDE

  This firmware bridges:
    - WiFi/MQTT (to backend)
    - UART JSON (to Zigbee Coordinator ESP32-C6)

  Key hardening:
  - Safe MQTT payload assembly (never write into callback payload)
  - Non-blocking WiFi/MQTT reconnect with backoff + connect timeouts
  - Prevent WiFi.begin() spam while STA is already connecting
  - Pairing open/confirm/reject token validation (token + expiry window)
  - Validate/normalize IEEE (accept 0x prefix / ':' / '-' then normalize to 16 hex lower-case)
  - LWT + retained hub status
  - Optional retained heartbeat to keep status fresh

  MQTT topics (must match backend):
    - Sub: home/hub/<HUB_ID>/zigbee/pairing/open
    - Sub: home/hub/<HUB_ID>/zigbee/pairing/confirm
    - Sub: home/hub/<HUB_ID>/zigbee/pairing/reject
    - Sub: home/hub/<HUB_ID>/zigbee/pairing/close
    - Pub: home/hub/<HUB_ID>/zigbee/discovered
    - Pub: home/hub/<HUB_ID>/status (retain, LWT offline)
    - Sub: home/zb/<ieee>/set
    - Pub: home/zb/<ieee>/state (retain)
    - Pub: home/zb/<ieee>/cmd_result

  UART protocol: newline-delimited JSON.
  - Coordinator -> hub:
      {"evt":"device_annce","ieee":"00124b0000000001","short":"0x1234"}
      {"evt":"attr_report","ieee":"00124b0000000001","cluster":"onoff","attr":"onoff","value":1}
      {"evt":"join_state","enabled":true,"duration":60}
      {"evt":"cmd_result","cmdId":"...","ieee":"00124b0000000001","ok":true}
      {"evt":"log","msg":"..."}
  - Hub -> coordinator:
      {"cmd":"permit_join","duration":60}
      {"cmd":"zcl_onoff","ieee":"00124b0000000001","value":1,"cmdId":"..."}
      {"cmd":"zcl_level","ieee":"00124b0000000001","value":128,"cmdId":"..."}
      {"cmd":"remove_device","ieee":"00124b0000000001"}

  Arduino IDE dependencies (Library Manager):
    - ArduinoJson (v6)
    - AsyncMqttClient
    - AsyncTCP (ESP32)

  Notes:
  - If Mosquitto runs in Docker on your PC, MQTT_HOST must be your PC LAN IP
    (NOT "mosquitto" and NOT 127.0.0.1 from the ESP32 perspective).
*/

// -----------------------------------------------------------------------------
// Arduino IDE compatibility
// -----------------------------------------------------------------------------
// Arduino's build system auto-generates function prototypes for .ino sketches.
// If a function signature uses a custom struct type that is defined later in the
// file, those generated prototypes may appear *before* the struct definition and
// cause errors like: "'<type>' does not name a type".
//
// We forward-declare our custom structs here so the auto-generated prototypes
// compile on Arduino IDE.
struct auto_light_off_t;
struct auto_evt_key_t;
struct fp_entry_t;
struct gate_state_t;

#include <WiFi.h>
#include <AsyncTCP.h>
#include <AsyncMqttClient.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Update.h>
#include "mbedtls/sha256.h"
#include <esp_system.h>
#include <Preferences.h>
#include <time.h>

// ----------------- CONFIG -----------------
static const char* WIFI_SSID = "502_vtv1";
static const char* WIFI_PASS = "11223344";

// IMPORTANT: set to the broker IP reachable from this ESP32 (usually your PC LAN IP)
static const char* MQTT_HOST = "192.168.2.3";
static const uint16_t MQTT_PORT = 1883;
static const char* MQTT_USER = "smarthome";
static const char* MQTT_PASS = "smarthome123";

// Must be UNIQUE per physical hub.
//
// Default (v5): hub-<macSuffix>
//   - macSuffix = last 3 bytes of STA MAC (6 hex chars)
//   - Example: STA MAC 24:6F:28:AA:BB:CC  => hub-aabbcc
//
// Override (DEV only): stored in NVS (namespace "hub", key "hub_id").
// In production builds, define HUB_PROD_MODE to FORCE mac-derived HUB_ID.
static const char* HUB_FIRMWARE_VERSION = "hub_host_mqtt_uart@v5";
static const char* HUB_BUILD_TIME = __DATE__ " " __TIME__;
static String gHubId; // computed at boot

// NVS (Preferences)
static Preferences gPrefs;

// Best-effort time sync (NTP) for meaningful `ts` in MQTT payloads.
static bool gTimeInit = false;
static bool gTimeSynced = false;

// UART to coordinator (ESP32-C6)
// Hub uses UART2 by default:
static const int UART2_RX = 16; // Hub RX2 (connect to C6 TX)
static const int UART2_TX = 17; // Hub TX2 (connect to C6 RX)
static const uint32_t UART_BAUD = 115200;

// ----------------- LIMITS / BUFFERS -----------------
#ifndef MQTT_RX_BUF_SIZE
#define MQTT_RX_BUF_SIZE 4096
#endif
static char mqttRxBuf[MQTT_RX_BUF_SIZE];
static bool mqttDropping = false;

// UART line buffer size (newline-delimited JSON frames).
static const size_t UART_LINE_BUF_SIZE = 2048;// was 768
static char uartLineBuf[UART_LINE_BUF_SIZE];
static size_t uartLineLen = 0;
static bool uartLineOverflow = false;

// Reconnect backoff
static const uint32_t BACKOFF_MIN_MS = 1000;
static const uint32_t BACKOFF_MAX_MS = 30000;

// Connect timeouts (avoid "connecting" stuck)
static const uint32_t WIFI_CONNECT_TIMEOUT_MS = 15000;
static const uint32_t MQTT_CONNECT_TIMEOUT_MS = 10000;

// Hub status heartbeat (optional, keeps retained fresh)
static const uint32_t HUB_STATUS_HEARTBEAT_MS = 60000;

// ----------------- GLOBALS -----------------
AsyncMqttClient mqtt;

// MQTT will payload must remain valid in memory after setup().
static String gMqttWillPayload;

// Topics
String tPairOpen;
String tPairConfirm;
String tPairReject;
String tPairClose;
String tDiscovered;
String tHubStatus;
String tHubZigbeeVersion;
String tOtaCmd;
String tOtaCmdResult;
String tZbSetWildcard = "home/zb/+/set";
String tZbEventWildcard = "home/zb/+/event"; // Sprint 5: rule lock->gate

// Sprint 8: local automations (mini Xiaomi)
String tAutomationSync;
String tAutomationSyncResult;
String tAutomationEvent;

// Sprint 5: automation rule config (NVS)
static Preferences gRulePrefs;
static String gRuleLockIeee;
static String gRuleGateIeee;

// Sprint 8: local automations engine (NVS + runtime)
static Preferences gAutoPrefs;
static uint32_t gAutoAppliedVersion = 0;

// Store compiled rules (JSON array) in memory.
static DynamicJsonDocument gAutoRulesDoc(4096);

static const size_t AUTO_RULE_MAX = 16;
static uint32_t gAutoRuleLastExecMs[AUTO_RULE_MAX];

// Simple delayed action support (used for Motion -> Light auto-off)
static const size_t AUTO_LIGHT_OFF_MAX = 8;
struct auto_light_off_t {
  bool used;
  uint32_t dueMs; // millis()
  char ieee16[17];
  uint32_t ruleId;
};
static auto_light_off_t gAutoLightOff[AUTO_LIGHT_OFF_MAX];

// De-dup event processing across (1) local hook and (2) MQTT loopback
static const size_t AUTO_EVENT_DEDUP_MAX = 8;
struct auto_evt_key_t {
  bool used;
  char ieee16[17];
  char type[40];
  uint64_t ts;
};
static auto_evt_key_t gAutoEvtSeen[AUTO_EVENT_DEDUP_MAX];
static uint8_t gAutoEvtSeenPtr = 0;

// OTA state
static bool gOtaBusy = false;

// Pairing session
String activePairingToken;
uint32_t activePairingUntilMs = 0;

// Zigbee fingerprint cache (manufacturer/model) keyed by IEEE.
// We keep it tiny to avoid heap fragmentation and only store printable strings.
static const size_t FP_CACHE_SIZE = 24;
struct fp_entry_t {
  bool used;
  char ieee16[17];
  char manufacturer[33];
  char model[33];
  char swBuildId[33];
  uint32_t lastUpdateMs;
};

static fp_entry_t fpCache[FP_CACHE_SIZE];

static fp_entry_t* fp_find(const char* ieee16) {
  if (!ieee16 || !ieee16[0]) return nullptr;
  for (size_t i = 0; i < FP_CACHE_SIZE; i++) {
    if (fpCache[i].used && strncmp(fpCache[i].ieee16, ieee16, 16) == 0) return &fpCache[i];
  }
  return nullptr;
}

static fp_entry_t* fp_upsert(const char* ieee16) {
  if (!ieee16 || !ieee16[0]) return nullptr;
  fp_entry_t* e = fp_find(ieee16);
  if (e) return e;
  // find free
  for (size_t i = 0; i < FP_CACHE_SIZE; i++) {
    if (!fpCache[i].used) {
      fpCache[i].used = true;
      strncpy(fpCache[i].ieee16, ieee16, sizeof(fpCache[i].ieee16));
      fpCache[i].ieee16[sizeof(fpCache[i].ieee16) - 1] = 0;
      fpCache[i].manufacturer[0] = 0;
      fpCache[i].model[0] = 0;
      fpCache[i].swBuildId[0] = 0;
      fpCache[i].lastUpdateMs = millis();
      return &fpCache[i];
    }
  }
  // evict oldest
  size_t oldest = 0;
  uint32_t oldestMs = fpCache[0].lastUpdateMs;
  for (size_t i = 1; i < FP_CACHE_SIZE; i++) {
    if (fpCache[i].lastUpdateMs < oldestMs) {
      oldestMs = fpCache[i].lastUpdateMs;
      oldest = i;
    }
  }
  fpCache[oldest].used = true;
  strncpy(fpCache[oldest].ieee16, ieee16, sizeof(fpCache[oldest].ieee16));
  fpCache[oldest].ieee16[sizeof(fpCache[oldest].ieee16) - 1] = 0;
  fpCache[oldest].manufacturer[0] = 0;
  fpCache[oldest].model[0] = 0;
  fpCache[oldest].swBuildId[0] = 0;
  fpCache[oldest].lastUpdateMs = millis();
  return &fpCache[oldest];
}

// -----------------
// GATE_PIR_V1 state cache (needs full snapshot; no partial overwrites)
// -----------------

static const size_t GATE_CACHE_SIZE = 16;
struct gate_state_t {
  bool used;
  char ieee16[17];
  bool gateOpen;
  bool lightOn;
  uint8_t lightLevel; // 0..255 (from ZCL level)
  uint64_t motionLastAt; // epoch ms (best-effort)
  uint32_t lastUpdateMs;
};

static gate_state_t gateCache[GATE_CACHE_SIZE];

// -----------------
// TH_SENSOR_V1 state cache (needs full snapshot; no partial overwrites)
// Contract:
// - coordinator forwards ZCL attr_report value x100
// - hub_host publishes retained home/zb/<ieee>/state {ts, reported:{temperature, humidity}}
// -----------------

static const size_t TH_CACHE_SIZE = 32;
struct th_state_t {
  bool used;
  char ieee16[17];
  bool hasTemp;
  bool hasHum;
  int32_t tempX100;
  int32_t humX100;
  uint32_t lastUpdateMs;
};

static th_state_t thCache[TH_CACHE_SIZE];

static th_state_t* th_find(const char* ieee16) {
  if (!ieee16 || !ieee16[0]) return nullptr;
  for (size_t i = 0; i < TH_CACHE_SIZE; i++) {
    if (thCache[i].used && strncmp(thCache[i].ieee16, ieee16, 16) == 0) return &thCache[i];
  }
  return nullptr;
}

static th_state_t* th_upsert(const char* ieee16) {
  if (!ieee16 || !ieee16[0]) return nullptr;
  th_state_t* e = th_find(ieee16);
  if (e) {
    e->lastUpdateMs = millis();
    return e;
  }
  for (size_t i = 0; i < TH_CACHE_SIZE; i++) {
    if (!thCache[i].used) {
      thCache[i].used = true;
      strncpy(thCache[i].ieee16, ieee16, sizeof(thCache[i].ieee16));
      thCache[i].ieee16[sizeof(thCache[i].ieee16) - 1] = 0;
      thCache[i].hasTemp = false;
      thCache[i].hasHum = false;
      thCache[i].tempX100 = 0;
      thCache[i].humX100 = 0;
      thCache[i].lastUpdateMs = millis();
      return &thCache[i];
    }
  }
  // evict oldest
  size_t oldest = 0;
  uint32_t oldestMs = thCache[0].lastUpdateMs;
  for (size_t i = 1; i < TH_CACHE_SIZE; i++) {
    if (thCache[i].lastUpdateMs < oldestMs) {
      oldestMs = thCache[i].lastUpdateMs;
      oldest = i;
    }
  }
  thCache[oldest].used = true;
  strncpy(thCache[oldest].ieee16, ieee16, sizeof(thCache[oldest].ieee16));
  thCache[oldest].ieee16[sizeof(thCache[oldest].ieee16) - 1] = 0;
  thCache[oldest].hasTemp = false;
  thCache[oldest].hasHum = false;
  thCache[oldest].tempX100 = 0;
  thCache[oldest].humX100 = 0;
  thCache[oldest].lastUpdateMs = millis();
  return &thCache[oldest];
}

static bool is_model_gate_pir(const char* ieee16) {
  fp_entry_t* fp = fp_find(ieee16);
  if (!fp) return false;
  return strncmp(fp->model, "GATE_PIR_V1", 32) == 0;
}

static gate_state_t* gate_find(const char* ieee16) {
  if (!ieee16 || !ieee16[0]) return nullptr;
  for (size_t i = 0; i < GATE_CACHE_SIZE; i++) {
    if (gateCache[i].used && strncmp(gateCache[i].ieee16, ieee16, 16) == 0) return &gateCache[i];
  }
  return nullptr;
}

static gate_state_t* gate_upsert(const char* ieee16) {
  if (!ieee16 || !ieee16[0]) return nullptr;
  gate_state_t* e = gate_find(ieee16);
  if (e) {
    e->lastUpdateMs = millis();
    return e;
  }
  for (size_t i = 0; i < GATE_CACHE_SIZE; i++) {
    if (!gateCache[i].used) {
      gateCache[i].used = true;
      strncpy(gateCache[i].ieee16, ieee16, sizeof(gateCache[i].ieee16));
      gateCache[i].ieee16[sizeof(gateCache[i].ieee16) - 1] = 0;
      gateCache[i].gateOpen = false;
      gateCache[i].lightOn = false;
      gateCache[i].lightLevel = 0;
      gateCache[i].motionLastAt = 0;
      gateCache[i].lastUpdateMs = millis();
      return &gateCache[i];
    }
  }
  // evict oldest
  size_t oldest = 0;
  uint32_t oldestMs = gateCache[0].lastUpdateMs;
  for (size_t i = 1; i < GATE_CACHE_SIZE; i++) {
    if (gateCache[i].lastUpdateMs < oldestMs) {
      oldestMs = gateCache[i].lastUpdateMs;
      oldest = i;
    }
  }
  gateCache[oldest].used = true;
  strncpy(gateCache[oldest].ieee16, ieee16, sizeof(gateCache[oldest].ieee16));
  gateCache[oldest].ieee16[sizeof(gateCache[oldest].ieee16) - 1] = 0;
  gateCache[oldest].gateOpen = false;
  gateCache[oldest].lightOn = false;
  gateCache[oldest].lightLevel = 0;
  gateCache[oldest].motionLastAt = 0;
  gateCache[oldest].lastUpdateMs = millis();
  return &gateCache[oldest];
}

// Non-blocking reconnect state
uint32_t wifiBackoffMs = BACKOFF_MIN_MS;
uint32_t wifiNextAttemptMs = 0;
bool wifiConnecting = false;
uint32_t wifiAttemptStartedMs = 0;

uint32_t mqttBackoffMs = BACKOFF_MIN_MS;
uint32_t mqttNextAttemptMs = 0;
bool mqttConnecting = false;
uint32_t mqttAttemptStartedMs = 0;

uint32_t nextHubStatusMs = 0;

static bool timeDue(uint32_t now, uint32_t dueMs) {
  return (int32_t)(now - dueMs) >= 0;
}

static uint64_t nowMs() {
  // Prefer real epoch ms when NTP is synced; fall back to uptime.
  time_t sec = time(nullptr);
  if (sec > 1700000000) return (uint64_t)sec * 1000ULL;
  return (uint64_t)millis();
}

static bool isSafeHubIdChar(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
}

static bool isValidHubId(const String& s) {
  if (s.length() < 5 || s.length() > 64) return false;
  for (size_t i = 0; i < s.length(); i++) {
    if (!isSafeHubIdChar(s[i])) return false;
  }
  return true;
}

static String deriveHubIdFromMac() {
  // More reliable than WiFi.macAddress() before WiFi.begin() on some core versions.
  uint64_t m = ESP.getEfuseMac();// 48-bit base MAC
  uint8_t b3 = (uint8_t)((m >> 16) & 0xFF);
  uint8_t b4 = (uint8_t)((m >> 8) & 0xFF);
  uint8_t b5 = (uint8_t)(m & 0xFF);
  char suf[7];
  snprintf(suf, sizeof(suf), "%02x%02x%02x", b3, b4, b5);
  return String("hub-") + String(suf);
}

static void initHubIdFromNvsOrMac() {
  // Preferences must be opened before use.
  gPrefs.begin("hub", false /*rw*/);

  const String derived = deriveHubIdFromMac();
  String override = gPrefs.getString("hub_id", "");
  override.trim();

#ifdef HUB_PROD_MODE
  // Production: ALWAYS use derived hub id.
  gHubId = derived;
  if (override.length() > 0 && override != derived) {
    Serial.printf("[Hub] HUB_PROD_MODE: ignoring hub_id override '%s' (derived=%s)\n", override.c_str(), derived.c_str());
  }
#else
  if (override.length() > 0 && isValidHubId(override)) {
    gHubId = override;
  } else {
    if (override.length() > 0 && !isValidHubId(override)) {
      Serial.printf("[Hub] invalid hub_id override in NVS (ignored): '%s'\n", override.c_str());
    }
    gHubId = derived;
  }
#endif

  Serial.printf("[Hub] hubId=%s\n", gHubId.c_str());
}

// Sprint 5: load automation rule mapping from NVS.
// Namespace: "rule"
// Keys:
//   - LOCK_IEEE: 16-hex (no colons), e.g. aabbccddeeff0011
//   - GATE_IEEE: 16-hex (no colons)
static void loadRuleConfig() {
  gRulePrefs.begin("rule", true /*readOnly*/);
  String lockRaw = gRulePrefs.getString("LOCK_IEEE", "");
  String gateRaw = gRulePrefs.getString("GATE_IEEE", "");
  gRulePrefs.end();

  gRuleLockIeee = normalizeIeee(lockRaw);
  gRuleGateIeee = normalizeIeee(gateRaw);

  if (!gRuleLockIeee.isEmpty() || !gRuleGateIeee.isEmpty()) {
    Serial.printf("[Rule] LOCK_IEEE=%s GATE_IEEE=%s\n", gRuleLockIeee.c_str(), gRuleGateIeee.c_str());
  }
}

// Sprint 8: load compiled automations from NVS.
// Once appliedVersion > 0, the legacy LOCK_IEEE -> GATE_IEEE rule is disabled.
static void loadAutomationFromNvs() {
  gAutoPrefs.begin("auto", true /*readOnly*/);
  gAutoAppliedVersion = gAutoPrefs.getUInt("appliedVersion", 0);
  String rulesJson = gAutoPrefs.getString("rules", "");
  gAutoPrefs.end();

  gAutoRulesDoc.clear();
  if (!rulesJson.isEmpty()) {
    DeserializationError err = deserializeJson(gAutoRulesDoc, rulesJson);
    if (err) {
      Serial.printf("[Auto] load rules parse error: %s\n", err.c_str());
      gAutoRulesDoc.clear();
    }
  }

  memset(gAutoRuleLastExecMs, 0, sizeof(gAutoRuleLastExecMs));
  for (size_t i = 0; i < AUTO_LIGHT_OFF_MAX; i++) gAutoLightOff[i].used = false;
  for (size_t i = 0; i < AUTO_EVENT_DEDUP_MAX; i++) gAutoEvtSeen[i].used = false;
  gAutoEvtSeenPtr = 0;

  if (gAutoAppliedVersion > 0) {
    Serial.printf("[Auto] loaded appliedVersion=%u rules=%u\n", (unsigned)gAutoAppliedVersion, (unsigned)gAutoRulesDoc.size());
  }
}

static void ensureTimeInit() {
  if (gTimeInit) return;
  if (WiFi.status() != WL_CONNECTED) return;
  // UTC, no DST.
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  gTimeInit = true;
  Serial.println("[Time] NTP init");
}

static void checkTimeSynced() {
  if (gTimeSynced) return;
  time_t sec = time(nullptr);
  if (sec > 1700000000) {
    gTimeSynced = true;
    Serial.printf("[Time] synced epoch=%ld\n", (long)sec);
  }
}

// ----------------- HELPERS -----------------
static String topicBaseHubZigbee() {
  return String("home/hub/") + gHubId + "/zigbee";
}

static void buildTopics() {
  String base = topicBaseHubZigbee();
  tPairOpen = base + "/pairing/open";
  tPairConfirm = base + "/pairing/confirm";
  tPairReject = base + "/pairing/reject";
  tPairClose = base + "/pairing/close";
  tDiscovered = base + "/discovered";
  tHubStatus = String("home/hub/") + gHubId + "/status";
  // Sprint 7: coordinator firmware version passthrough + Hub OTA
  tHubZigbeeVersion = String("home/hub/") + gHubId + "/zigbee/version";
  tOtaCmd = String("home/hub/") + gHubId + "/ota/cmd";
  tOtaCmdResult = String("home/hub/") + gHubId + "/ota/cmd_result";

  // Sprint 8: local automations sync + logs
  tAutomationSync = String("home/hub/") + gHubId + "/automation/sync";
  tAutomationSyncResult = String("home/hub/") + gHubId + "/automation/sync_result";
  tAutomationEvent = String("home/hub/") + gHubId + "/automation/event";
}

static bool isHexChar(char c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

static bool isValidIeee16Hex(const String& s) {
  if (s.length() != 16) return false;
  for (size_t i = 0; i < s.length(); i++) {
    if (!isHexChar(s[i])) return false;
  }
  return true;
}

// Normalize IEEE string into 16 hex lower-case.
// Accepts: "00124b0000000001", "0x00124b0000000001", "00:12:4b:00:...:01", "00-12-4B-...-01"
static String normalizeIeee(const String& in) {
  if (in.isEmpty()) return "";

  String s = in;
  s.trim();

  // strip "0x" prefix if any
  if (s.length() >= 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) {
    s = s.substring(2);
  }

  // remove separators ':' '-' ' '
  String out;
  out.reserve(16);
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == ':' || c == '-' || c == ' ') continue;
    out += c;
  }

  out.toLowerCase();
  if (!isValidIeee16Hex(out)) return "";
  return out;
}

static String genPairToken() {
  // 128-bit-ish token (hex) from esp_random()
  char buf[33];
  uint32_t r1 = esp_random();
  uint32_t r2 = esp_random();
  uint32_t r3 = esp_random();
  uint32_t r4 = esp_random();
  snprintf(buf, sizeof(buf), "%08lx%08lx%08lx%08lx",
           (unsigned long)r1, (unsigned long)r2, (unsigned long)r3, (unsigned long)r4);
  return String(buf);
}

// Generic command id for Zigbee data-plane commands.
// Format: 32 hex chars.
static String genCmdId() {
  return genPairToken();
}

static bool isPairingActive() {
  if (activePairingToken.isEmpty()) return false;
  return (int32_t)(millis() - activePairingUntilMs) <= 0;
}

static void uartSendJson(const JsonDocument& doc) {
  String out;
  serializeJson(doc, out);
  Serial2.print(out);
  Serial2.print('\n');
}

static bool topicIsZbSet(const String& topic, String& outIeee16) {
  // Expected: home/zb/<ieee>/set
  if (!topic.startsWith("home/zb/")) return false;
  if (!topic.endsWith("/set")) return false;

  const int baseLen = String("home/zb/").length();
  const int end = topic.length() - String("/set").length();
  if (end <= baseLen) return false;

  String raw = topic.substring(baseLen, end);
  String norm = normalizeIeee(raw);
  if (norm.isEmpty()) {
    Serial.printf("[MQTT] Reject set: invalid IEEE in topic: %s\n", raw.c_str());
    return false;
  }
  outIeee16 = norm;
  return true;
}

static bool topicIsZbEvent(const String& topic, String& outIeee16) {
  // home/zb/<ieee>/event
  const String prefix = "home/zb/";
  const String suffix = "/event";
  if (!topic.startsWith(prefix) || !topic.endsWith(suffix)) return false;
  String raw = topic.substring(prefix.length(), topic.length() - suffix.length());
  String norm = normalizeIeee(raw);
  if (norm.isEmpty()) {
    Serial.printf("[MQTT] Reject event: invalid IEEE in topic: %s\n", raw.c_str());
    return false;
  }
  outIeee16 = norm;
  return true;
}

static void mqttPublish(const String& topic, const String& payload, uint8_t qos, bool retain) {
  if (!mqtt.connected()) return;
  mqtt.publish(topic.c_str(), qos, retain, payload.c_str(), payload.length());
}

static void publishZbState(const String& ieee16, const JsonDocument& state) {
  String topic = String("home/zb/") + ieee16 + "/state";
  // Contract v1: envelope with ts + reported.*
  StaticJsonDocument<768> env;
  const uint64_t ts = nowMs();
  env["ts"] = (unsigned long long)ts;
  JsonObject reported = env.createNestedObject("reported");
  // Copy fields from `state` into reported (state is expected to be an object).
  JsonObjectConst src = state.as<JsonObjectConst>();

  // Sprint 7: attach fwVersion when known from Zigbee Basic SW Build ID.
  if (!src.containsKey("fwVersion")) {
    fp_entry_t* fp = fp_find(ieee16.c_str());
    if (fp && fp->swBuildId[0]) {
      if (fp->model[0]) {
        reported["fwVersion"] = String(fp->model) + "-" + String(fp->swBuildId);
      } else {
        reported["fwVersion"] = fp->swBuildId;
      }
    }
  }
  for (JsonPairConst kv : src) {
    reported[kv.key().c_str()] = kv.value();
  }

  // Sprint 10: normalize SmartLock state contracts coming from low-end MCU (no real-time clock)
  // - If lockoutRemainMs present: convert to epoch lockoutUntil based on envelope ts
  // - Ensure lastAction.atMs exists and is epoch (fallback to ts)
  if (reported["lock"].is<JsonObject>()) {
    JsonObject lock = reported["lock"].as<JsonObject>();
    if (lock.containsKey("lockoutRemainMs")) {
      uint32_t remain = lock["lockoutRemainMs"].as<uint32_t>();
      lock["lockoutUntil"] = (unsigned long long)(ts + (uint64_t)remain);
      lock.remove("lockoutRemainMs");
    }

    // Keep both legacy reported.lastAction and new reported.lock.lastAction for compatibility
    bool hasTop = reported["lastAction"].is<JsonObject>();
    bool hasLock = lock["lastAction"].is<JsonObject>();
    if (hasTop && !hasLock) {
      lock["lastAction"] = reported["lastAction"].as<JsonObjectConst>();
      hasLock = true;
    } else if (!hasTop && hasLock) {
      reported["lastAction"] = lock["lastAction"].as<JsonObjectConst>();
      hasTop = true;
    }

    if (hasLock) {
      JsonObject la = lock["lastAction"].as<JsonObject>();
      if (!la.containsKey("atMs") || la["atMs"].as<uint64_t>() < 1000000000000ULL) {
        la["atMs"] = (unsigned long long)ts;
      }
    }
  }
  if (reported["lastAction"].is<JsonObject>()) {
    JsonObject la = reported["lastAction"].as<JsonObject>();
    if (!la.containsKey("atMs") || la["atMs"].as<uint64_t>() < 1000000000000ULL) {
      la["atMs"] = (unsigned long long)ts;
    }
  }

  String payload;
  serializeJson(env, payload);
  mqttPublish(topic, payload, 0, true);
}

static void publishZbCmdResult(const String& ieee16, const char* cmdId, bool ok, const char* error) {
  String topic = String("home/zb/") + ieee16 + "/cmd_result";
  StaticJsonDocument<256> doc;
  doc["ts"] = (unsigned long long)nowMs();
  if (cmdId && cmdId[0] != '\0') doc["cmdId"] = cmdId;
  doc["ok"] = ok;
  if (!ok && error && error[0] != '\0') doc["error"] = error;

  String payload;
  serializeJson(doc, payload);
  mqttPublish(topic, payload, 0, false);
}

static void publishZbEvent(const String& ieee16, const char* type, const JsonVariantConst data) {
  if (!type || type[0] == '\0') return;
  String topic = String("home/zb/") + ieee16 + "/event";
  StaticJsonDocument<384> doc;
  doc["ts"] = (unsigned long long)nowMs();
  doc["type"] = type;
  if (!data.isNull()) {
    doc["data"] = data;
  }

  // Sprint 8: local automation engine hook (pre-publish).
  // We still also process MQTT loopback events; de-dup logic prevents double triggers.
  automationOnZbEvent(ieee16, doc);

  String payload;
  serializeJson(doc, payload);
  mqttPublish(topic, payload, 0, false);
}

// Sprint 5: legacy automation rule (fallback)
// If configured, on lock.unlock success -> publish gate.open
static void maybeRuleLockUnlockToGateOpen(const String& lockIeee16, JsonDocument& doc) {
  // Once Sprint 8 rules are applied (version>0), disable this legacy rule to avoid double triggers.
  if (gAutoAppliedVersion > 0) return;
  if (gRuleLockIeee.isEmpty() || gRuleGateIeee.isEmpty()) return;
  if (gRuleGateIeee == gRuleLockIeee) return; // safety: never self-control
  if (lockIeee16 != gRuleLockIeee) return;

  const char* type = doc["type"] | "";
  if (!type || strcmp(type, "lock.unlock") != 0) return;

  bool success = false;
  JsonVariant dataV = doc["data"];
  if (!dataV.isNull()) {
    if (dataV["success"].is<bool>()) success = dataV["success"].as<bool>();
    else if (!dataV["success"].isNull()) success = dataV["success"].as<int>() != 0;
  }
  if (!success) return;

  // Simple debounce to avoid repeated publishes on duplicate events.
  static uint64_t lastTrigMs = 0;
  const uint64_t now = nowMs();
  if (lastTrigMs && (now - lastTrigMs) < 500ULL) return;
  lastTrigMs = now;

  StaticJsonDocument<256> out;
  out["cmdId"] = genCmdId();
  out["ts"] = (unsigned long long)now;
  out["action"] = "gate.open";
  JsonObject args = out.createNestedObject("args");
  args["source"] = "lock";
  JsonObject params = out.createNestedObject("params");
  params["source"] = "lock";

  String payload;
  serializeJson(out, payload);
  String topic = String("home/zb/") + gRuleGateIeee + "/set";
  Serial.printf("[Rule] lock.unlock -> gate.open gate=%s\n", gRuleGateIeee.c_str());
  mqttPublish(topic, payload, 1, false);
}

// -----------------------------------------------------------------------------
// Sprint 8: Local automation engine (mini Xiaomi)
// -----------------------------------------------------------------------------

static void publishAutomationSyncResult(const String& cmdId, bool ok, uint32_t appliedVersion, const char* message) {
  StaticJsonDocument<256> out;
  out["ts"] = (unsigned long long)nowMs();
  out["cmdId"] = cmdId;
  out["ok"] = ok;
  out["appliedVersion"] = appliedVersion;
  if (message && message[0]) out["message"] = message;

  String payload;
  serializeJson(out, payload);
  mqttPublish(tAutomationSyncResult, payload, 1, false);
}

static bool autoSeenEvent(const String& ieee16, const char* type, uint64_t ts) {
  if (!type || type[0] == '\0') return false;
  for (size_t i = 0; i < AUTO_EVENT_DEDUP_MAX; i++) {
    if (!gAutoEvtSeen[i].used) continue;
    if (gAutoEvtSeen[i].ts != ts) continue;
    if (strcmp(gAutoEvtSeen[i].ieee16, ieee16.c_str()) != 0) continue;
    if (strcmp(gAutoEvtSeen[i].type, type) != 0) continue;
    return true;
  }

  auto_evt_key_t& slot = gAutoEvtSeen[gAutoEvtSeenPtr % AUTO_EVENT_DEDUP_MAX];
  gAutoEvtSeenPtr++;
  slot.used = true;
  strncpy(slot.ieee16, ieee16.c_str(), sizeof(slot.ieee16));
  slot.ieee16[sizeof(slot.ieee16) - 1] = '\0';
  strncpy(slot.type, type, sizeof(slot.type));
  slot.type[sizeof(slot.type) - 1] = '\0';
  slot.ts = ts;
  return false;
}

static bool autoDataMatch(JsonVariantConst dataV, JsonVariantConst matchV) {
  if (matchV.isNull()) return true;
  if (!matchV.is<JsonObjectConst>()) return true;
  JsonObjectConst match = matchV.as<JsonObjectConst>();
  if (!dataV.is<JsonObjectConst>()) return false;
  JsonObjectConst data = dataV.as<JsonObjectConst>();

  for (JsonPairConst kv : match) {
    const char* key = kv.key().c_str();
    JsonVariantConst expected = kv.value();
    JsonVariantConst actual = data[key];
    if (actual.isNull()) return false;

    if (expected.is<bool>()) {
      bool a = actual.is<bool>() ? actual.as<bool>() : (actual.as<long long>() != 0);
      if (a != expected.as<bool>()) return false;
      continue;
    }
    if (expected.is<long long>() || expected.is<int>() || expected.is<unsigned long long>()) {
      long long a = actual.as<long long>();
      long long e = expected.as<long long>();
      if (a != e) return false;
      continue;
    }
    if (expected.is<const char*>()) {
      const char* a = actual.as<const char*>();
      const char* e = expected.as<const char*>();
      if (!a || !e || strcmp(a, e) != 0) return false;
      continue;
    }

    // fallback: compare json stringified values
    String as;
    String es;
    serializeJson(actual, as);
    serializeJson(expected, es);
    if (as != es) return false;
  }
  return true;
}

static void autoPublishZbSet(const char* ieee16, const char* action, JsonVariantConst paramsV, uint32_t ruleId, const char* reason) {
  if (!ieee16 || ieee16[0] == '\0') return;
  if (!action || action[0] == '\0') return;

  StaticJsonDocument<256> out;
  out["cmdId"] = genCmdId();
  out["ts"] = (unsigned long long)nowMs();
  out["action"] = action;

  JsonObject args = out.createNestedObject("args");
  if (paramsV.is<JsonObjectConst>()) {
    for (JsonPairConst kv : paramsV.as<JsonObjectConst>()) {
      args[kv.key()] = kv.value();
    }
  }
  args["source"] = "auto";
  args["ruleId"] = ruleId;
  if (reason && reason[0]) args["reason"] = reason;

  JsonObject params = out.createNestedObject("params");
  if (paramsV.is<JsonObjectConst>()) {
    for (JsonPairConst kv : paramsV.as<JsonObjectConst>()) {
      params[kv.key()] = kv.value();
    }
  }
  params["source"] = "auto";
  params["ruleId"] = ruleId;
  if (reason && reason[0]) params["reason"] = reason;

  String payload;
  serializeJson(out, payload);
  String topic = String("home/zb/") + ieee16 + "/set";
  mqttPublish(topic, payload, 1, false);
}

static void autoScheduleLightOff(const char* ieee16, uint32_t ruleId, uint32_t afterSec) {
  if (!ieee16 || ieee16[0] == '\0') return;
  if (afterSec == 0) return;

  uint32_t due = millis() + afterSec * 1000U;

  // Replace existing timer for same device if any
  for (size_t i = 0; i < AUTO_LIGHT_OFF_MAX; i++) {
    if (!gAutoLightOff[i].used) continue;
    if (strcmp(gAutoLightOff[i].ieee16, ieee16) != 0) continue;
    gAutoLightOff[i].dueMs = due;
    gAutoLightOff[i].ruleId = ruleId;
    return;
  }

  for (size_t i = 0; i < AUTO_LIGHT_OFF_MAX; i++) {
    if (gAutoLightOff[i].used) continue;
    gAutoLightOff[i].used = true;
    strncpy(gAutoLightOff[i].ieee16, ieee16, sizeof(gAutoLightOff[i].ieee16));
    gAutoLightOff[i].ieee16[sizeof(gAutoLightOff[i].ieee16) - 1] = '\0';
    gAutoLightOff[i].dueMs = due;
    gAutoLightOff[i].ruleId = ruleId;
    return;
  }

  // No free slot -> overwrite slot 0 (best-effort)
  gAutoLightOff[0].used = true;
  strncpy(gAutoLightOff[0].ieee16, ieee16, sizeof(gAutoLightOff[0].ieee16));
  gAutoLightOff[0].ieee16[sizeof(gAutoLightOff[0].ieee16) - 1] = '\0';
  gAutoLightOff[0].dueMs = due;
  gAutoLightOff[0].ruleId = ruleId;
}

// Called for both:
// - local events produced by this hub (hooked in publishZbEvent)
// - events received over MQTT (home/zb/+/event)
static void automationOnZbEvent(const String& ieee16, JsonDocument& evtDoc) {
  if (gAutoAppliedVersion == 0) return; // not yet configured
  if (ieee16.isEmpty()) return;

  const char* evtType = evtDoc["type"] | "";
  if (!evtType || evtType[0] == '\0') return;

  uint64_t ts = evtDoc["ts"] | (unsigned long long)nowMs();
  if (autoSeenEvent(ieee16, evtType, ts)) return;

  JsonVariantConst evtData = evtDoc["data"];

  JsonArrayConst rules = gAutoRulesDoc.as<JsonArrayConst>();
  if (rules.isNull()) return;

  size_t idx = 0;
  for (JsonObjectConst rule : rules) {
    if (idx >= AUTO_RULE_MAX) break;
    idx++;

    bool enabled = rule["enabled"] | false;
    if (!enabled) continue;

    const char* trigType = rule["triggerType"] | "EVENT";
    if (strcmp(trigType, "EVENT") != 0) {
      // STATE triggers are optional in Sprint 8; ignore for now.
      continue;
    }

    JsonObjectConst trig = rule["trigger"].as<JsonObjectConst>();
    if (trig.isNull()) continue;
    const char* src = trig["source"] | "ZIGBEE";
    if (strcmp(src, "ZIGBEE") != 0) continue;

    const char* trigIeee = trig["ieee"] | "";
    if (trigIeee[0] && strcmp(trigIeee, ieee16.c_str()) != 0) continue;

    const char* trigEvtType = trig["eventType"] | "";
    if (!trigEvtType || trigEvtType[0] == '\0') continue;
    if (strcmp(trigEvtType, evtType) != 0) continue;

    if (!autoDataMatch(evtData, trig["dataMatch"])) continue;

    // Cooldown policy (milliseconds, based on millis())
    uint32_t cooldownSec = 0;
    JsonVariantConst pol = rule["executionPolicy"];
    if (!pol.isNull()) {
      cooldownSec = pol["cooldownSec"] | 0;
    }
    if (cooldownSec > 0) {
      uint32_t now = millis();
      uint32_t last = gAutoRuleLastExecMs[idx - 1];
      if (last != 0 && (uint32_t)(now - last) < cooldownSec * 1000U) continue;
      gAutoRuleLastExecMs[idx - 1] = now;
    } else {
      gAutoRuleLastExecMs[idx - 1] = millis();
    }

    uint32_t ruleId = rule["id"] | 0;
    const char* ruleName = rule["name"] | "";

    // Execute actions
    JsonArrayConst actions = rule["actions"].as<JsonArrayConst>();

    StaticJsonDocument<640> logDoc;
    logDoc["ts"] = (unsigned long long)nowMs();
    logDoc["appliedVersion"] = gAutoAppliedVersion;
    logDoc["ruleId"] = ruleId;
    if (ruleName && ruleName[0]) logDoc["ruleName"] = ruleName;

    JsonObject trigLog = logDoc.createNestedObject("trigger");
    trigLog["ieee"] = ieee16;
    trigLog["type"] = evtType;
    trigLog["eventTs"] = (unsigned long long)ts;

    JsonArray actLog = logDoc.createNestedArray("actions");
    if (!actions.isNull()) {
      for (JsonObjectConst act : actions) {
        const char* kind = act["kind"] | "ZIGBEE";
        if (strcmp(kind, "ZIGBEE") != 0) continue;

        const char* tgtIeee = act["ieee"] | "";
        const char* a = act["action"] | "";
        if (!tgtIeee || tgtIeee[0] == '\0') continue;
        if (!a || a[0] == '\0') continue;

        JsonVariantConst paramsV = act["params"];
        autoPublishZbSet(tgtIeee, a, paramsV, ruleId, "automation");

        JsonObject al = actLog.createNestedObject();
        al["ieee"] = tgtIeee;
        al["action"] = a;

        // Motion -> Light on + auto-off (implemented locally)
        if (strcmp(a, "light.set") == 0 && paramsV.is<JsonObjectConst>()) {
          JsonObjectConst po = paramsV.as<JsonObjectConst>();
          bool on = po["on"] | false;
          uint32_t autoOffSec = po["autoOffSec"] | 0;
          if (on && autoOffSec > 0) {
            autoScheduleLightOff(tgtIeee, ruleId, autoOffSec);
            al["autoOffSec"] = autoOffSec;
          }
        }
      }
    }

    String logPayload;
    serializeJson(logDoc, logPayload);
    mqttPublish(tAutomationEvent, logPayload, 0, false);
  }
}

// Receive compiled rules from backend, store to NVS, and apply in-memory.
static void handleAutomationSync(JsonDocument& doc) {
  const char* cmdId = doc["cmdId"] | "";
  uint32_t version = doc["version"] | 0;
  JsonArray rules = doc["rules"].as<JsonArray>();

  if (!cmdId || cmdId[0] == '\0') {
    publishAutomationSyncResult("", false, gAutoAppliedVersion, "missing cmdId");
    return;
  }

  if (gAutoAppliedVersion > 0 && version < gAutoAppliedVersion) {
    publishAutomationSyncResult(String(cmdId), false, gAutoAppliedVersion, "older version");
    return;
  }

  String rulesJson;
  if (rules.isNull()) {
    rulesJson = "[]";
  } else {
    serializeJson(rules, rulesJson);
  }

  // Persist
  gAutoPrefs.begin("auto", false /*rw*/);
  gAutoPrefs.putUInt("appliedVersion", version);
  gAutoPrefs.putString("rules", rulesJson);
  gAutoPrefs.end();

  // Apply in-memory
  gAutoAppliedVersion = version;
  gAutoRulesDoc.clear();
  DeserializationError err = deserializeJson(gAutoRulesDoc, rulesJson);
  if (err) {
    gAutoRulesDoc.clear();
    publishAutomationSyncResult(String(cmdId), false, gAutoAppliedVersion, "rules parse error");
    return;
  }

  memset(gAutoRuleLastExecMs, 0, sizeof(gAutoRuleLastExecMs));
  for (size_t i = 0; i < AUTO_LIGHT_OFF_MAX; i++) gAutoLightOff[i].used = false;
  for (size_t i = 0; i < AUTO_EVENT_DEDUP_MAX; i++) gAutoEvtSeen[i].used = false;
  gAutoEvtSeenPtr = 0;

  Serial.printf("[Auto] appliedVersion=%u rules=%u\n", version, (unsigned)gAutoRulesDoc.size());
  publishAutomationSyncResult(String(cmdId), true, version, "ok");
}

// Runs periodically in the main loop (handles scheduled auto-off actions).
static void automationTick() {
  if (gAutoAppliedVersion == 0) return;
  if (!mqtt.connected()) return;

  uint32_t now = millis();
  for (size_t i = 0; i < AUTO_LIGHT_OFF_MAX; i++) {
    if (!gAutoLightOff[i].used) continue;
    if (!timeDue(now, gAutoLightOff[i].dueMs)) continue;

    gAutoLightOff[i].used = false;

    // Send light.set {on:false}
    StaticJsonDocument<64> p;
    p["on"] = false;
    autoPublishZbSet(gAutoLightOff[i].ieee16, "light.set", p.as<JsonVariantConst>(), gAutoLightOff[i].ruleId, "autoOff");

    // Emit an execution log for visibility
    StaticJsonDocument<256> logDoc;
    logDoc["ts"] = (unsigned long long)nowMs();
    logDoc["appliedVersion"] = gAutoAppliedVersion;
    logDoc["ruleId"] = gAutoLightOff[i].ruleId;
    logDoc["kind"] = "auto_off";
    logDoc["ieee"] = gAutoLightOff[i].ieee16;
    String logPayload;
    serializeJson(logDoc, logPayload);
    mqttPublish(tAutomationEvent, logPayload, 0, false);
  }
}

static void publishGatePirSnapshot(const String& ieee16, const gate_state_t* s) {
  if (!s) return;
  StaticJsonDocument<256> state;
  JsonObject gate = state.createNestedObject("gate");
  gate["open"] = s->gateOpen;
  JsonObject light = state.createNestedObject("light");
  light["on"] = s->lightOn;
  JsonObject motion = state.createNestedObject("motion");
  if (s->motionLastAt) motion["lastAt"] = (unsigned long long)s->motionLastAt;
  publishZbState(ieee16, state);
}

static void publishDiscovered(const String& ieeeRaw, uint32_t shortAddr) {
  if (!isPairingActive()) return;

  String ieee16 = normalizeIeee(ieeeRaw);
  if (ieee16.isEmpty()) return;

  StaticJsonDocument<400> doc;
  doc["token"] = activePairingToken;
  doc["ts"] = (unsigned long long)nowMs();
  doc["ieee"] = ieee16;
  doc["shortAddr"] = shortAddr;

  // Sprint 2: attach fingerprint if we already learned it from coordinator.
  fp_entry_t* fp = fp_find(ieee16.c_str());
  if (fp) {
    if (fp->manufacturer[0]) doc["manufacturer"] = fp->manufacturer;
    if (fp->model[0]) doc["model"] = fp->model;
    if (fp->swBuildId[0]) doc["swBuildId"] = fp->swBuildId;
  }

  String payload;
  serializeJson(doc, payload);
  mqttPublish(tDiscovered, payload, 0, false);
}

static void publishHubOnline(bool online) {
  StaticJsonDocument<320> doc;
  doc["online"] = online;
  doc["fwVersion"] = HUB_FIRMWARE_VERSION;
  doc["buildTime"] = HUB_BUILD_TIME;
  doc["mac"] = WiFi.macAddress();
  doc["ip"] = (WiFi.status() == WL_CONNECTED) ? WiFi.localIP().toString() : String("");
  doc["rssi"] = (WiFi.status() == WL_CONNECTED) ? WiFi.RSSI() : 0;
  doc["ts"] = (unsigned long long)nowMs();

  String payload;
  serializeJson(doc, payload);
  mqttPublish(tHubStatus, payload, 1, true);
}

// Sprint 7: coordinator fw info passthrough (UART -> MQTT, retained)
static void publishCoordinatorFwInfo(const String& fwVersion, const String& buildTime) {
  if (fwVersion.isEmpty()) return;
  StaticJsonDocument<256> doc;
  doc["ts"] = (unsigned long long)nowMs();
  doc["fwVersion"] = fwVersion;
  if (!buildTime.isEmpty()) doc["buildTime"] = buildTime;
  String payload;
  serializeJson(doc, payload);
  mqttPublish(tHubZigbeeVersion, payload, 1, true);
}

// ----------------- HUB OTA (Sprint 7) -----------------
static String bytesToHex(const uint8_t* buf, size_t len) {
  static const char* hex = "0123456789abcdef";
  String s;
  s.reserve(len * 2);
  for (size_t i = 0; i < len; i++) {
    uint8_t b = buf[i];
    s += hex[(b >> 4) & 0xF];
    s += hex[b & 0xF];
  }
  return s;
}

static bool isHex64(const String& s) {
  if (s.length() != 64) return false;
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    bool ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
    if (!ok) return false;
  }
  return true;
}

static void publishOtaResult(const String& cmdId, bool ok, const String& code, const String& message, const String& version) {
  StaticJsonDocument<320> doc;
  doc["ts"] = (unsigned long long)nowMs();
  doc["cmdId"] = cmdId;
  doc["ok"] = ok;
  doc["version"] = version;
  if (!ok) {
    if (code.length()) doc["code"] = code;
    if (message.length()) doc["message"] = message;
  } else {
    if (message.length()) doc["message"] = message;
  }
  String payload;
  serializeJson(doc, payload);
  mqttPublish(tOtaCmdResult, payload, 1, false);
}

static void runHubOta(const String& cmdId, const String& version, const String& url, const String& sha256Expected, int sizeHint) {
  if (gOtaBusy) {
    publishOtaResult(cmdId, false, "BUSY", "OTA already in progress", version);
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {
    publishOtaResult(cmdId, false, "NO_WIFI", "WiFi not connected", version);
    return;
  }
  if (url.length() < 10 || (!url.startsWith("http://") && !url.startsWith("https://"))) {
    publishOtaResult(cmdId, false, "BAD_URL", "url must be http(s)", version);
    return;
  }
  if (!isHex64(sha256Expected)) {
    publishOtaResult(cmdId, false, "BAD_SHA256", "sha256 must be 64-hex", version);
    return;
  }

  gOtaBusy = true;
  Serial.printf("[OTA] begin cmdId=%s version=%s url=%s\n", cmdId.c_str(), version.c_str(), url.c_str());

  HTTPClient http;
  http.setTimeout(15000);
  if (!http.begin(url)) {
    gOtaBusy = false;
    publishOtaResult(cmdId, false, "HTTP_BEGIN", "http.begin failed", version);
    return;
  }

  int httpCode = http.GET();
  if (httpCode <= 0) {
    String m = String("GET failed: ") + http.errorToString(httpCode);
    http.end();
    gOtaBusy = false;
    publishOtaResult(cmdId, false, "HTTP_GET", m, version);
    return;
  }
  if (httpCode != HTTP_CODE_OK) {
    String m = String("HTTP status ") + String(httpCode);
    http.end();
    gOtaBusy = false;
    publishOtaResult(cmdId, false, "HTTP_STATUS", m, version);
    return;
  }

  int contentLen = http.getSize();
  int expectedSize = (sizeHint > 0) ? sizeHint : contentLen;
  if (expectedSize <= 0) {
    // Update can still proceed without size, but it's safer to require it.
    expectedSize = contentLen;
  }

  if (!Update.begin(expectedSize > 0 ? expectedSize : UPDATE_SIZE_UNKNOWN)) {
    String m = String("Update.begin failed: ") + String(Update.errorString());
    http.end();
    gOtaBusy = false;
    publishOtaResult(cmdId, false, "UPDATE_BEGIN", m, version);
    return;
  }

  WiFiClient* stream = http.getStreamPtr();
  const size_t bufSize = 1024;
  uint8_t buf[bufSize];
  size_t writtenTotal = 0;

  mbedtls_sha256_context ctx;
  mbedtls_sha256_init(&ctx);
  // Arduino-ESP32 toolchain often ships mbedTLS without the *_ret variants.
  // Use the non-ret APIs for broad compatibility.
  mbedtls_sha256_starts(&ctx, 0);

  uint32_t lastProgressMs = millis();
  while (http.connected()) {
    size_t avail = stream->available();
    if (!avail) {
      delay(5);
      if (millis() - lastProgressMs > 20000) {
        // Keep watchdog fed and avoid stuck loop; still continue.
        lastProgressMs = millis();
      }
      continue;
    }
    size_t toRead = avail;
    if (toRead > bufSize) toRead = bufSize;
    int n = stream->readBytes(buf, toRead);
    if (n <= 0) break;
    lastProgressMs = millis();

    mbedtls_sha256_update(&ctx, buf, (size_t)n);

    size_t w = Update.write(buf, (size_t)n);
    if (w != (size_t)n) {
      String m = String("Update.write failed: ") + String(Update.errorString());
      mbedtls_sha256_free(&ctx);
      Update.abort();
      http.end();
      gOtaBusy = false;
      publishOtaResult(cmdId, false, "UPDATE_WRITE", m, version);
      return;
    }
    writtenTotal += w;

    if (contentLen > 0 && (int)writtenTotal >= contentLen) break;
    yield();
  }

  uint8_t hash[32];
  mbedtls_sha256_finish(&ctx, hash);
  mbedtls_sha256_free(&ctx);

  http.end();

  // Verify hash BEFORE finalizing OTA.
  String sha256Actual = bytesToHex(hash, 32);
  if (sha256Actual != sha256Expected) {
    Update.abort();
    gOtaBusy = false;
    publishOtaResult(cmdId, false, "SHA_MISMATCH", String("actual=") + sha256Actual, version);
    return;
  }

  if (!Update.end(true)) {
    String m = String("Update.end failed: ") + String(Update.errorString());
    gOtaBusy = false;
    publishOtaResult(cmdId, false, "UPDATE_END", m, version);
    return;
  }

  publishOtaResult(cmdId, true, "", "applied", version);
  Serial.println("[OTA] success -> reboot");
  delay(300);
  ESP.restart();
}

// ----------------- NON-BLOCKING RECONNECT -----------------
static void ensureWifiNonBlocking() {
  if (WiFi.status() == WL_CONNECTED) {
    if (wifiConnecting) {
      Serial.printf("[WiFi] connected IP=%s\n", WiFi.localIP().toString().c_str());
    }
    wifiBackoffMs = BACKOFF_MIN_MS;
    wifiConnecting = false;
    return;
  }

  const uint32_t now = millis();

  // If already connecting, wait until timeout; do NOT call WiFi.begin() again.
  if (wifiConnecting) {
    if ((uint32_t)(now - wifiAttemptStartedMs) < WIFI_CONNECT_TIMEOUT_MS) {
      return;
    }
    Serial.println("[WiFi] connect timeout -> disconnect & retry");
    WiFi.disconnect(true); // turn WiFi off then retry
    delay(100);
    wifiConnecting = false;

    wifiNextAttemptMs = now + wifiBackoffMs;
    wifiBackoffMs = min(BACKOFF_MAX_MS, wifiBackoffMs * 2);
    return;
  }

  if (!timeDue(now, wifiNextAttemptMs)) return;

  Serial.printf("[WiFi] begin (backoff=%ums)\n", (unsigned)wifiBackoffMs);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  wifiConnecting = true;
  wifiAttemptStartedMs = now;

  wifiNextAttemptMs = now + wifiBackoffMs;
  wifiBackoffMs = min(BACKOFF_MAX_MS, wifiBackoffMs * 2);
}

static void ensureMqttNonBlocking() {
  if (WiFi.status() != WL_CONNECTED) {
    mqttConnecting = false;
    return;
  }

  if (mqtt.connected()) {
    mqttBackoffMs = BACKOFF_MIN_MS;
    mqttConnecting = false;
    return;
  }

  const uint32_t now = millis();

  // If MQTT connect is in progress but no callback arrives, release after timeout.
  if (mqttConnecting) {
    if ((uint32_t)(now - mqttAttemptStartedMs) < MQTT_CONNECT_TIMEOUT_MS) return;
    Serial.println("[MQTT] connect timeout -> retry later");
    mqtt.disconnect(); // abort pending connect if any
    mqttConnecting = false;
    mqttNextAttemptMs = now + mqttBackoffMs;
    mqttBackoffMs = min(BACKOFF_MAX_MS, mqttBackoffMs * 2);
    return;
  }

  if (!timeDue(now, mqttNextAttemptMs)) return;

  Serial.printf("[MQTT] connect (backoff=%ums)\n", (unsigned)mqttBackoffMs);
  mqttConnecting = true;
  mqttAttemptStartedMs = now;
  mqtt.connect();

  mqttNextAttemptMs = now + mqttBackoffMs;
}

// ----------------- MQTT CALLBACKS -----------------
static void handleMqttJsonMessage(const String& topic, const char* jsonText) {
  // Sprint 8: automation sync payload can be larger than the previous default.
  StaticJsonDocument<2048> doc;
  DeserializationError err = deserializeJson(doc, jsonText);
  if (err) {
    Serial.printf("[MQTT] JSON parse error: %s\n", err.c_str());
    return;
  }

  // Sprint 7: Hub OTA command (HTTP download + sha256 verify)
  if (topic == tOtaCmd) {
    const char* cmdId = doc["cmdId"] | "";
    const char* version = doc["version"] | "";
    const char* url = doc["url"] | "";
    const char* sha256 = doc["sha256"] | "";
    int sizeHint = doc["size"] | 0;
    if (!cmdId || cmdId[0] == '\0') {
      publishOtaResult("", false, "BAD_CMDID", "missing cmdId", version ? version : "");
      return;
    }
    String sha = String(sha256);
    sha.toLowerCase();
    runHubOta(String(cmdId), String(version), String(url), sha, sizeHint);
    return;
  }

  // Sprint 8: receive compiled automation rules from backend (versioned)
  if (topic == tAutomationSync) {
    handleAutomationSync(doc);
    return;
  }

  if (topic == tPairOpen) {
    // { token?, durationSec? }
    const char* token = doc["token"] | "";
    int durationSec = doc["durationSec"] | 60;
    if (durationSec < 5) durationSec = 5;
    if (durationSec > 300) durationSec = 300;

    String tok = String(token);
    if (tok.isEmpty()) tok = genPairToken();

    activePairingToken = tok;
    activePairingUntilMs = millis() + (uint32_t)durationSec * 1000U;

    Serial.printf("[ZB] pairing open token=%s duration=%d\n", activePairingToken.c_str(), durationSec);

    StaticJsonDocument<128> u;
    u["cmd"] = "permit_join";
    u["duration"] = durationSec;
    uartSendJson(u);
    return;
  }

  if (topic == tPairConfirm) {
    // { token, ieee }
    const char* ieee = doc["ieee"] | "";
    const char* token = doc["token"] | "";
    Serial.printf("[ZB] confirm ieee=%s token=%s\n", ieee, token);

    if (!isPairingActive()) {
      Serial.println("[ZB] confirm ignored (pairing not active)");
      return;
    }
    if (String(token) != activePairingToken) {
      Serial.println("[ZB] confirm ignored (token mismatch)");
      return;
    }

    String ieee16 = normalizeIeee(String(ieee));
    if (ieee16.isEmpty()) {
      Serial.println("[ZB] confirm ignored (invalid ieee)");
      return;
    }

    // Provisioning is done in backend; hub just validates.
    return;
  }

  if (topic == tPairReject) {
    // { token, ieee }
    const char* ieee = doc["ieee"] | "";
    const char* token = doc["token"] | "";
    Serial.printf("[ZB] reject ieee=%s token=%s\n", ieee, token);

    if (!isPairingActive()) {
      Serial.println("[ZB] reject ignored (pairing not active)");
      return;
    }
    if (String(token) != activePairingToken) {
      Serial.println("[ZB] reject ignored (token mismatch)");
      return;
    }

    String ieee16 = normalizeIeee(String(ieee));
    if (ieee16.isEmpty()) {
      Serial.println("[ZB] reject ignored (invalid ieee)");
      return;
    }

    StaticJsonDocument<160> u;
    u["cmd"] = "remove_device";
    u["ieee"] = ieee16;
    uartSendJson(u);
    return;
  }

  if (topic == tPairClose) {
    // Best-effort close: clear token and disable permit-join.
    Serial.println("[ZB] pairing close");
    activePairingToken = "";
    activePairingUntilMs = 0;

    StaticJsonDocument<128> u;
    u["cmd"] = "permit_join";
    u["duration"] = 0;
    uartSendJson(u);
    return;
  }

  // Sprint 5: observe Zigbee-plane events for local automation rules.
  String ieeeEvt;
  if (topicIsZbEvent(topic, ieeeEvt)) {
    // Sprint 8: automation engine triggers on Zigbee events (including lock.unlock from enddevices).
    automationOnZbEvent(ieeeEvt, doc);
    maybeRuleLockUnlockToGateOpen(ieeeEvt, doc);
    return;
  }

  // Zigbee virtual device command: home/zb/<ieee>/set
  String ieee16;
  if (topicIsZbSet(topic, ieee16)) {
    // Contract v1 (preferred): { cmdId, ts, action, args }
    // Backward compatible (v5 light/dimmer): { relay:bool } or { pwm:int }
    const char* cmdIdIn = doc["cmdId"] | "";
    const char* action = doc["action"] | "";
    String cmdId = (cmdIdIn && cmdIdIn[0] != '\0') ? String(cmdIdIn) : genCmdId();

    JsonVariant argsV = doc["args"];
    if (argsV.isNull()) argsV = doc["payload"]; // optional alias

    auto hasTopRelay = doc.containsKey("relay");
    auto hasTopPwm = doc.containsKey("pwm");

    // Sprint 11: Identify (device blink) helper
    // MQTT: home/zb/<ieee>/set {cmdId, action:"identify", args:{time:4}}
    // -> UART to coordinator: {cmd:"identify", ieee, endpoint, time, cmdId}
    if (action && strlen(action) > 0 && (strcmp(action, "identify") == 0 || strcmp(action, "device.identify") == 0)) {
      int sec = 4;
      if (!argsV.isNull()) {
        if (!argsV["time"].isNull()) sec = argsV["time"].as<int>();
        else if (!argsV["sec"].isNull()) sec = argsV["sec"].as<int>();
        else if (!argsV["value"].isNull()) sec = argsV["value"].as<int>();
      }
      if (sec < 0) sec = 0;
      if (sec > 60) sec = 60;

      StaticJsonDocument<192> u;
      u["cmd"] = "identify";
      u["ieee"] = ieee16;
      u["endpoint"] = 1;
      u["time"] = sec;
      u["cmdId"] = cmdId;
      uartSendJson(u);
      return;
    }

    const bool isGateAction = (action && strlen(action) > 0 && (strncmp(action, "gate.", 5) == 0 || strncmp(action, "light.", 6) == 0));
    const bool isGateDev = is_model_gate_pir(ieee16.c_str()) || isGateAction;
	    const bool isLockAction = (action && strlen(action) > 0 && (strncmp(action, "lock.", 5) == 0));

	    // --- SmartLock actions (LOCK_V2_DUALMCU) ---
	    // Contract: MQTT home/zb/<ieee>/set {cmdId, action:"lock.*", args:{...}}
	    // We forward 1:1 to coordinator via UART newline JSON.
	    if (isLockAction) {
	      StaticJsonDocument<384> u;
	      u["cmd"] = "lock_action";
	      u["ieee"] = ieee16;
	      u["endpoint"] = 1;
	      u["cmdId"] = cmdId;
	      u["action"] = action;
	      if (!argsV.isNull()) u["args"] = argsV;
	      uartSendJson(u);
	      return;
	    }

    // --- Gate actions (GATE_PIR_V1) ---
    if (isGateDev && action && strlen(action) > 0 && (strcmp(action, "gate.open") == 0 || strcmp(action, "gate.close") == 0)) {
      const bool open = strcmp(action, "gate.open") == 0;

      StaticJsonDocument<192> u;
      u["cmd"] = "zcl_onoff";
      u["ieee"] = ieee16;
      u["endpoint"] = 1;
      u["value"] = open ? 1 : 0;
      u["cmdId"] = cmdId;
      uartSendJson(u);

      gate_state_t* gs = gate_upsert(ieee16.c_str());
      if (gs) {
        const bool changed = (gs->gateOpen != open);
        gs->gateOpen = open;
        gs->lastUpdateMs = millis();
        publishGatePirSnapshot(ieee16, gs);
        if (changed) {
          StaticJsonDocument<96> data;
          data["open"] = open;
          publishZbEvent(ieee16, "gate.state", data.as<JsonVariantConst>());
        }
      }
      return;
    }

    // --- Light actions (GATE_PIR_V1) ---
    if (isGateDev && action && strlen(action) > 0 && strcmp(action, "light.set") == 0) {
      bool on = false;
      if (!argsV.isNull()) {
        if (argsV["on"].is<bool>()) on = argsV["on"].as<bool>();
        else if (!argsV["value"].isNull()) on = argsV["value"].as<int>() != 0;
      }
      const int level = on ? 254 : 0;

      StaticJsonDocument<192> u;
      u["cmd"] = "zcl_level";
      u["ieee"] = ieee16;
      u["endpoint"] = 1;
      u["value"] = level;
      u["cmdId"] = cmdId;
      uartSendJson(u);

      gate_state_t* gs = gate_upsert(ieee16.c_str());
      if (gs) {
        const bool changed = (gs->lightOn != on);
        gs->lightOn = on;
        gs->lightLevel = (uint8_t)level;
        gs->lastUpdateMs = millis();
        publishGatePirSnapshot(ieee16, gs);
        if (changed) {
          StaticJsonDocument<128> data;
          data["on"] = on;
          publishZbEvent(ieee16, "light.state", data.as<JsonVariantConst>());
        }
      }
      return;
    }

    if (isGateDev && action && strlen(action) > 0 && strcmp(action, "light.set_timeout") == 0) {
      int sec = 20;
      if (!argsV.isNull()) {
        if (!argsV["sec"].isNull()) sec = argsV["sec"].as<int>();
        else if (!argsV["value"].isNull()) sec = argsV["value"].as<int>();
      }
      if (sec < 0) sec = 0;
      if (sec > 255) sec = 255;

      StaticJsonDocument<192> u;
      u["cmd"] = "zcl_level";
      u["ieee"] = ieee16;
      u["endpoint"] = 2; // config endpoint for timeoutSec
      u["value"] = sec;
      u["cmdId"] = cmdId;
      uartSendJson(u);
      return;
    }

    // --- Generic onoff/level (legacy compatible) ---
    if ((action && strlen(action) > 0 && (strcmp(action, "onoff.set") == 0 || strcmp(action, "switch.set") == 0)) || hasTopRelay) {
      bool on = false;
      if (hasTopRelay) {
        on = doc["relay"].as<bool>();
      } else if (!argsV.isNull()) {
        if (argsV["on"].is<bool>()) on = argsV["on"].as<bool>();
        else if (!argsV["value"].isNull()) on = argsV["value"].as<int>() != 0;
      }

      StaticJsonDocument<192> u;
      u["cmd"] = "zcl_onoff";
      u["ieee"] = ieee16;
      u["endpoint"] = 1;
      u["value"] = on ? 1 : 0;
      u["cmdId"] = cmdId;
      uartSendJson(u);

      if (isGateDev) {
        gate_state_t* gs = gate_upsert(ieee16.c_str());
        if (gs) {
          const bool changed = (gs->gateOpen != on);
          gs->gateOpen = on;
          publishGatePirSnapshot(ieee16, gs);
          if (changed) {
            StaticJsonDocument<96> data;
            data["open"] = on;
            publishZbEvent(ieee16, "gate.state", data.as<JsonVariantConst>());
          }
        }
      } else {
        StaticJsonDocument<64> s;
        s["relay"] = on;
        publishZbState(ieee16, s);
      }
      return;
    }

    if ((action && strlen(action) > 0 && (strcmp(action, "level.set") == 0 || strcmp(action, "dimmer.set") == 0)) || hasTopPwm) {
      int level = 0;
      if (hasTopPwm) {
        level = doc["pwm"].as<int>();
      } else if (!argsV.isNull()) {
        if (!argsV["level"].isNull()) level = argsV["level"].as<int>();
        else if (!argsV["value"].isNull()) level = argsV["value"].as<int>();
      }
      if (level < 0) level = 0;
      if (level > 255) level = 255;

      StaticJsonDocument<192> u;
      u["cmd"] = "zcl_level";
      u["ieee"] = ieee16;
      u["endpoint"] = 1;
      u["value"] = level;
      u["cmdId"] = cmdId;
      uartSendJson(u);

      if (isGateDev) {
        const bool on = level > 0;
        gate_state_t* gs = gate_upsert(ieee16.c_str());
        if (gs) {
          const bool changed = (gs->lightOn != on);
          gs->lightOn = on;
          gs->lightLevel = (uint8_t)level;
          publishGatePirSnapshot(ieee16, gs);
          if (changed) {
            StaticJsonDocument<128> data;
            data["on"] = on;
            publishZbEvent(ieee16, "light.state", data.as<JsonVariantConst>());
          }
        }
      } else {
        StaticJsonDocument<64> s;
        s["pwm"] = level;
        publishZbState(ieee16, s);
      }
      return;
    }

    Serial.printf("[MQTT] zb/set ignored: unknown action='%s' topic=%s\n", action, topic.c_str());
  }
}

static void onMqttConnect(bool sessionPresent) {
  (void)sessionPresent;
  Serial.println("[MQTT] connected");
  mqttConnecting = false;

  mqttBackoffMs = BACKOFF_MIN_MS;
  mqttNextAttemptMs = millis() + BACKOFF_MIN_MS;

  mqtt.subscribe(tPairOpen.c_str(), 1);
  mqtt.subscribe(tPairConfirm.c_str(), 1);
  mqtt.subscribe(tPairReject.c_str(), 1);
  mqtt.subscribe(tPairClose.c_str(), 1);
  mqtt.subscribe(tZbSetWildcard.c_str(), 1);
  mqtt.subscribe(tZbEventWildcard.c_str(), 0);
  mqtt.subscribe(tOtaCmd.c_str(), 1);

  // Sprint 8: automation rule sync (versioned)
  mqtt.subscribe(tAutomationSync.c_str(), 1);

  publishHubOnline(true);
  nextHubStatusMs = millis() + HUB_STATUS_HEARTBEAT_MS;
}

static void onMqttDisconnect(AsyncMqttClientDisconnectReason reason) {
  Serial.printf("[MQTT] disconnected reason=%d\n", (int)reason);
  mqttConnecting = false;

  mqttNextAttemptMs = millis() + mqttBackoffMs;
  mqttBackoffMs = min(BACKOFF_MAX_MS, mqttBackoffMs * 2);
}

static void onMqttMessage(char* topic, char* payload, AsyncMqttClientMessageProperties properties,
                          size_t len, size_t index, size_t total) {
  (void)properties;

  // Assemble into fixed buffer; NEVER write into `payload`.
  if (total >= MQTT_RX_BUF_SIZE) {
    if (index == 0) {
      Serial.printf("[MQTT] drop too-large payload: %u bytes (limit %u)\n",
                    (unsigned)total, (unsigned)(MQTT_RX_BUF_SIZE - 1));
    }
    mqttDropping = true;
    if (index + len >= total) mqttDropping = false;
    return;
  }
  if (mqttDropping) {
    if (index + len >= total) mqttDropping = false;
    return;
  }

  memcpy(mqttRxBuf + index, payload, len);
  if (index + len != total) return;

  mqttRxBuf[total] = '\0';
  handleMqttJsonMessage(String(topic), mqttRxBuf);
}

// ----------------- UART -----------------
static void processUartLines() {
  while (Serial2.available()) {
    char c = (char)Serial2.read();
    if (c == '\r') continue;

    if (c == '\n') {
      if (uartLineOverflow) {
        Serial.printf("[UART] drop overlong line (>%u bytes)\n", (unsigned)(UART_LINE_BUF_SIZE - 1));
      } else {
        uartLineBuf[uartLineLen] = '\0';
        if (uartLineLen > 0) {
          StaticJsonDocument<3072> msg;// was 768
          DeserializationError err = deserializeJson(msg, uartLineBuf);
          if (!err) {
            const char* evt = msg["evt"] | "";

            if (strcmp(evt, "device_annce") == 0) {
              String ieeeRaw = msg["ieee"] | "";
              JsonVariant shortV = msg["short"];
              uint32_t shortAddr = 0;

              if (shortV.is<const char*>()) {
                const char* s = shortV.as<const char*>();
                if (s && (strncmp(s, "0x", 2) == 0 || strncmp(s, "0X", 2) == 0)) {
                  shortAddr = strtoul(s + 2, nullptr, 16);
                } else if (s) {
                  shortAddr = strtoul(s, nullptr, 16);
                }
              } else if (!shortV.isNull()) {
                shortAddr = shortV.as<uint32_t>();
              }

              String ieee16 = normalizeIeee(ieeeRaw);
              Serial.printf("[UART] device_annce ieee=%s short=0x%04x\n",
                            ieee16.isEmpty() ? ieeeRaw.c_str() : ieee16.c_str(),
                            (unsigned)shortAddr);

              publishDiscovered(ieeeRaw, shortAddr);

            } else if (strcmp(evt, "fw_info") == 0) {
              // Sprint 7: coordinator reports its fwVersion at boot.
              const char* fwV = msg["fwVersion"] | "";
              const char* bt = msg["buildTime"] | "";
              if (fwV && fwV[0]) {
                Serial.printf("[UART] fw_info coordinator fwVersion=%s\n", fwV);
                publishCoordinatorFwInfo(String(fwV), String(bt));
              }

            } else if (strcmp(evt, "basic_fingerprint") == 0) {
              String ieeeRaw = msg["ieee"] | "";
              JsonVariant shortV = msg["short"];
              uint32_t shortAddr = 0;

              if (shortV.is<const char*>()) {
                const char* s = shortV.as<const char*>();
                if (s && (strncmp(s, "0x", 2) == 0 || strncmp(s, "0X", 2) == 0)) {
                  shortAddr = strtoul(s + 2, nullptr, 16);
                } else if (s) {
                  shortAddr = strtoul(s, nullptr, 16);
                }
              } else if (!shortV.isNull()) {
                shortAddr = shortV.as<uint32_t>();
              }

              String ieee16 = normalizeIeee(ieeeRaw);
              if (!ieee16.isEmpty()) {
                const char* manuf = msg["manufacturer"] | "";
                const char* model = msg["model"] | "";
                const char* swBuildId = msg["swBuildId"] | "";

                fp_entry_t* fp = fp_upsert(ieee16.c_str());
                if (fp) {
                  if (manuf && manuf[0]) strncpy(fp->manufacturer, manuf, sizeof(fp->manufacturer) - 1);
                  if (model && model[0]) strncpy(fp->model, model, sizeof(fp->model) - 1);
                  if (swBuildId && swBuildId[0]) strncpy(fp->swBuildId, swBuildId, sizeof(fp->swBuildId) - 1);
                  fp->lastUpdateMs = millis();
                }

                Serial.printf("[UART] basic_fingerprint ieee=%s short=0x%04x manuf=%s model=%s\n",
                              ieee16.c_str(), (unsigned)shortAddr,
                              manuf && manuf[0] ? manuf : "-", model && model[0] ? model : "-");

                // If we're in pairing mode, publish discovered again so backend gets fingerprint.
                publishDiscovered(ieee16, shortAddr);
              }

            } else if (strcmp(evt, "attr_report") == 0) {
              String ieeeRaw = msg["ieee"] | "";
              const char* cluster = msg["cluster"] | "";
              const char* attr = msg["attr"] | "";
              JsonVariant value = msg["value"];

              String ieee16 = normalizeIeee(ieeeRaw);
              if (!ieee16.isEmpty()) {
                bool handled = false;

                const bool isGateDev = is_model_gate_pir(ieee16.c_str());
                if (isGateDev) {
                  gate_state_t* gs = gate_upsert(ieee16.c_str());
                  if (gs) {
                    // Gate state (OnOff)
                    if (strcmp(cluster, "onoff") == 0 && strcmp(attr, "onoff") == 0) {
                      const bool open = value.as<int>() != 0;
                      const bool changed = (gs->gateOpen != open);
                      gs->gateOpen = open;
                      gs->lastUpdateMs = millis();
                      publishGatePirSnapshot(ieee16, gs);
                      if (changed) {
                        StaticJsonDocument<96> data;
                        data["open"] = open;
                        publishZbEvent(ieee16, "gate.state", data.as<JsonVariantConst>());
                      }
                      handled = true;
                    }

                    // Light state (Level)
                    if (!handled && strcmp(cluster, "level") == 0 &&
                        (strcmp(attr, "level") == 0 || strcmp(attr, "current_level") == 0)) {
                      int lvl = value.as<int>();
                      if (lvl < 0) lvl = 0;
                      if (lvl > 255) lvl = 255;
                      const bool on = lvl > 0;
                      const bool changed = (gs->lightOn != on);
                      gs->lightOn = on;
                      gs->lightLevel = (uint8_t)lvl;
                      gs->lastUpdateMs = millis();
                      publishGatePirSnapshot(ieee16, gs);
                      if (changed) {
                        StaticJsonDocument<128> data;
                        data["on"] = on;
                        publishZbEvent(ieee16, "light.state", data.as<JsonVariantConst>());
                      }
                      handled = true;
                    }

                    // PIR motion (Occupancy)
                    const bool isOcc = (strcmp(cluster, "occupancy") == 0 && strcmp(attr, "occupied") == 0) ||
                                       (strcmp(cluster, "0x0406") == 0 && strcmp(attr, "0x0000") == 0);
                    if (!handled && isOcc) {
                      const int occ = value.as<int>();
                      if (occ != 0) {
                        gs->motionLastAt = nowMs();
                        gs->lastUpdateMs = millis();
                        publishGatePirSnapshot(ieee16, gs);
                        StaticJsonDocument<96> data;
                        data["level"] = occ;
                        publishZbEvent(ieee16, "motion.detected", data.as<JsonVariantConst>());
                      }
                      handled = true;
                    }
                  }
                }

                // TH_SENSOR_V1: temperature/humidity reports are partial updates.
                // Keep a per-device cache so we always publish a full snapshot.
                if (!handled && strcmp(attr, "value") == 0) {
                  const bool isTemp = strcmp(cluster, "temperature") == 0;
                  const bool isHum = strcmp(cluster, "humidity") == 0;
                  if (isTemp || isHum) {
                    th_state_t* th = th_upsert(ieee16.c_str());
                    if (th) {
                      const int32_t v = (int32_t)value.as<long>();
                      if (isTemp) {
                        th->tempX100 = v;
                        th->hasTemp = true;
                      } else {
                        th->humX100 = v;
                        th->hasHum = true;
                      }
                      th->lastUpdateMs = millis();

                      StaticJsonDocument<192> st;
                      if (th->hasTemp) st["temperature"] = ((float)th->tempX100) / 100.0f;
                      if (th->hasHum) st["humidity"] = ((float)th->humX100) / 100.0f;
                      publishZbState(ieee16, st);
                      handled = true;
                    }
                  }
                }

                if (!handled) {
                  // Default mapping for generic Zigbee devices
                  StaticJsonDocument<256> state;
                  if (strcmp(cluster, "onoff") == 0 && strcmp(attr, "onoff") == 0) {
                    state["relay"] = value.as<int>() != 0;
                  } else if (strcmp(cluster, "level") == 0 &&
                             (strcmp(attr, "level") == 0 || strcmp(attr, "current_level") == 0)) {
                    int lvl = value.as<int>();
                    if (lvl < 0) lvl = 0;
                    if (lvl > 255) lvl = 255;
                    state["pwm"] = lvl;
                  } else {
                    state["cluster"] = cluster;
                    state["attr"] = attr;
                    state["value"] = value;
                  }
                  publishZbState(ieee16, state);
                }
              }

            } else if (strcmp(evt, "join_state") == 0) {
              bool enabled = msg["enabled"] | false;
              int duration = msg["duration"] | 0;
              Serial.printf("[UART] join_state enabled=%d duration=%d\n", enabled ? 1 : 0, duration);

            } else if (strcmp(evt, "zb_identify") == 0) {
              // Sprint 11: Identify confirm (device blink) -> publish claimed event
              String ieeeRaw = msg["ieee"] | "";
              String ieee16 = normalizeIeee(ieeeRaw);
              int t = msg["time"] | msg["identifyTime"] | 0;
              if (!ieee16.isEmpty()) {
                StaticJsonDocument<96> data;
                if (t > 0) data["time"] = t;
                publishZbEvent(ieee16, "device.claimed", data.as<JsonVariantConst>());
                Serial.printf("[UART] zb_identify ieee=%s time=%d -> device.claimed\n", ieee16.c_str(), t);
              }

            } else if (strcmp(evt, "zb_event") == 0) {
              // Coordinator -> hub: normalized event from Zigbee device
              String ieeeRaw = msg["ieee"] | "";
              String ieee16 = normalizeIeee(ieeeRaw);
              const char* type = msg["type"] | "";
              JsonVariantConst data = msg["data"].as<JsonVariantConst>();
              if (!ieee16.isEmpty() && type && type[0] != '\0') {
                publishZbEvent(ieee16, type, data);
              }

            } else if (strcmp(evt, "zb_state") == 0) {
              // Coordinator -> hub: normalized state snapshot from Zigbee device
              String ieeeRaw = msg["ieee"] | "";
              String ieee16 = normalizeIeee(ieeeRaw);
              JsonVariantConst stV = msg["state"].as<JsonVariantConst>();
              if (!ieee16.isEmpty()) {
                DynamicJsonDocument stDoc(1024);
                if (!stV.isNull()) {
                  stDoc.set(stV);
                } else {
                  stDoc.to<JsonObject>();
                }
                publishZbState(ieee16, stDoc);
              }

            } else if (strcmp(evt, "cmd_result") == 0) {
              const char* cmdId = msg["cmdId"] | "";
              String ieeeRaw = msg["ieee"] | "";
              bool ok = msg["ok"] | false;
              const char* error = msg["error"] | "";

              String ieee16 = normalizeIeee(ieeeRaw);
              Serial.printf("[UART] cmd_result cmdId=%s ieee=%s ok=%d err=%s\n",
                            cmdId,
                            ieee16.isEmpty() ? ieeeRaw.c_str() : ieee16.c_str(),
                            ok ? 1 : 0,
                            (ok || !error || error[0] == '\0') ? "" : error);

              if (!ieee16.isEmpty()) {
                publishZbCmdResult(ieee16, cmdId, ok, error);
              }

            } else if (strcmp(evt, "log") == 0) {
              const char* s = msg["msg"] | "";
              Serial.printf("[C6] %s\n", s);
            }
          } else {
            Serial.printf("[UART] JSON parse error: %s\n", err.c_str());
          }
        }
      }

      uartLineLen = 0;
      uartLineOverflow = false;
      continue;
    }

    if (uartLineOverflow) continue;

    if (uartLineLen + 1 < UART_LINE_BUF_SIZE) {
      uartLineBuf[uartLineLen++] = c;
    } else {
      uartLineOverflow = true;
    }
  }
}

// ----------------- ARDUINO -----------------
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n[Hub] boot");

  initHubIdFromNvsOrMac();
  loadRuleConfig();
  loadAutomationFromNvs();

  // UART
  Serial2.begin(UART_BAUD, SERIAL_8N1, UART2_RX, UART2_TX);

  // Topics depend on hubId
  buildTopics();

  // WiFi: set mode ONCE (avoid reconfig spam)
  WiFi.persistent(false);
  WiFi.setAutoReconnect(false);
  WiFi.mode(WIFI_STA);

  // MQTT config
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCredentials(MQTT_USER, MQTT_PASS);
  mqtt.setKeepAlive(30);
  mqtt.setCleanSession(true);

  // Stable client id: hubId + full MAC
  uint64_t mac = ESP.getEfuseMac();
  char macHex[17];
  snprintf(macHex, sizeof(macHex), "%08lx%08lx",
           (unsigned long)((mac >> 32) & 0xFFFFFFFF),
           (unsigned long)(mac & 0xFFFFFFFF));
  String cid = String("smarthome-") + gHubId + "-" + String(macHex);
  mqtt.setClientId(cid.c_str());

  // LWT: retained offline. Note: MQTT broker will publish this payload on unexpected disconnect.
  // `ts` in LWT is best-effort (cannot be updated at the moment of power loss).
  gMqttWillPayload = String("{\"online\":false,\"ts\":") + String((unsigned long long)nowMs()) + "}";
  mqtt.setWill(tHubStatus.c_str(), 1 /*qos*/, true /*retain*/, gMqttWillPayload.c_str());

  mqtt.onConnect(onMqttConnect);
  mqtt.onDisconnect(onMqttDisconnect);
  mqtt.onMessage(onMqttMessage);

  // Kick first attempts immediately
  wifiNextAttemptMs = 0;
  mqttNextAttemptMs = 0;
  nextHubStatusMs = millis() + HUB_STATUS_HEARTBEAT_MS;
}

void loop() {
  ensureWifiNonBlocking();
  ensureTimeInit();
  checkTimeSynced();
  ensureMqttNonBlocking();
  processUartLines();
  automationTick();

  // Periodic status heartbeat (retain)
  if (mqtt.connected() && timeDue(millis(), nextHubStatusMs)) {
    publishHubOnline(true);
    nextHubStatusMs = millis() + HUB_STATUS_HEARTBEAT_MS;
  }

  // expire pairing (do NOT block)
  if (!activePairingToken.isEmpty() && timeDue(millis(), activePairingUntilMs)) {
    Serial.println("[ZB] pairing expired");
    activePairingToken = "";
    activePairingUntilMs = 0;
  }
}
