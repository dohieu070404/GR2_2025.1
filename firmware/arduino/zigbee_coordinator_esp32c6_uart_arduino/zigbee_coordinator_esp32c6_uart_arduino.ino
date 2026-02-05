/*
  Zigbee Coordinator (ESP32‑C6) — UART JSON bridge for Hub Host (ESP32‑WROOM‑32)

  ✅ Goal for SmartHome v5
  - Works with Arduino‑ESP32 (ESP32‑C6) Zigbee stack API (ESP‑Zigbee)
  - UART protocol (newline‑delimited JSON) matches Hub Host firmware in this repo
  - Device announce -> Hub: {"evt":"device_annce","ieee":"00124b0001abcd12","short":"0x1234"}
  - Attribute report -> Hub: {"evt":"attr_report","ieee":"...","cluster":"onoff","attr":"onoff","value":1}
  - Join state -> Hub: {"evt":"join_state","enabled":true,"duration":60}
  - Hub -> Coordinator commands:
      {"cmd":"permit_join","duration":60,"cmdId":"..."}
      {"cmd":"zcl_onoff","ieee":"...","value":1,"endpoint":1,"cmdId":"..."}
      {"cmd":"zcl_level","ieee":"...","value":128,"endpoint":1,"cmdId":"..."}
      {"cmd":"remove_device","ieee":"...","cmdId":"..."}

  Arduino IDE dependencies:
    - ArduinoJson (v6)
    - ESP32 board package by Espressif Systems (version that supports ESP32‑C6 Zigbee)

  UART wiring (recommended to match Hub Host UART2 defaults):
    - Hub Host TX(GPIO17) -> C6 RX(GPIO17)
    - Hub Host RX(GPIO16) <- C6 TX(GPIO16)
    - GND <-> GND

  Notes:
    - Zigbee APIs must be called from the Zigbee task context.
      => UART commands are queued into g_cmdQueue and executed inside zb_task.
    - IEEE string is normalized to 16 hex chars (no 0x, no separators, lowercase).
*/

// -----------------------------------------------------------------------------
// Arduino IDE compatibility
// -----------------------------------------------------------------------------
// Arduino's .ino build step auto-generates function prototypes.
// Forward declare custom structs used in function signatures so those
// auto-generated prototypes compile cleanly.
struct device_entry_t;
struct uart_cmd_t;

#include <Arduino.h>
#include <ArduinoJson.h>

// Zigbee (ESP‑Zigbee) headers from Arduino‑ESP32
#include "esp_zigbee_core.h"
#include "zcl/esp_zigbee_zcl_common.h"
#include "zcl/esp_zigbee_zcl_command.h"
#include "zcl/esp_zigbee_zcl_custom_cluster.h"
// ZDO request/command APIs moved between headers across SDK revisions.
// Try both include paths for maximum Arduino‑ESP32 compatibility.
#if __has_include("zdo/esp_zigbee_zdo_command.h")
#include "zdo/esp_zigbee_zdo_command.h"
#elif __has_include("esp_zigbee_zdo_command.h")
#include "esp_zigbee_zdo_command.h"
#endif

#if __has_include("esp_zigbee_zdo_common.h")
#include "esp_zigbee_zdo_common.h"
#endif

// Platform helpers (some cores expose default config helpers here)
#if __has_include("platform/esp_zigbee_platform.h")
#include "platform/esp_zigbee_platform.h"
#elif __has_include("esp_zigbee_platform.h")
#include "esp_zigbee_platform.h"
#endif
#include "ha/esp_zigbee_ha_standard.h"

// Some Arduino Zigbee builds don't expose these IDs.
#ifndef ESP_ZB_ZCL_CLUSTER_ID_OCCUPANCY_SENSING
#define ESP_ZB_ZCL_CLUSTER_ID_OCCUPANCY_SENSING 0x0406
#endif
#ifndef ESP_ZB_ZCL_ATTR_OCCUPANCY_SENSING_OCCUPANCY_ID
#define ESP_ZB_ZCL_ATTR_OCCUPANCY_SENSING_OCCUPANCY_ID 0x0000
#endif

// ------------------------ CONFIG ------------------------

// UART between Hub Host (ESP32‑WROOM‑32) and Coordinator (ESP32‑C6)
static HardwareSerial U(1);
static const uint32_t UART_BAUD = 115200;
#ifndef UART_RX_GPIO
#define UART_RX_GPIO 17
#endif
static const int UART_RX_PIN = UART_RX_GPIO;
#ifndef UART_TX_GPIO
#define UART_TX_GPIO 16
#endif
static const int UART_TX_PIN = UART_TX_GPIO;

// Sprint 7: coordinator firmware version report
static const char* COORD_FIRMWARE_VERSION = "ZB_COORD_C6-1.0.0";
static const char* COORD_BUILD_TIME = __DATE__ " " __TIME__;

// Zigbee endpoint config
static const uint8_t COORD_ENDPOINT = 1;
static const uint8_t DEFAULT_DST_ENDPOINT = 1;

// SmartLock vendor/custom cluster (Sprint 10)
// We use ZCL custom-cluster commands to carry JSON payloads.
static const uint16_t LOCK_CUSTOM_CLUSTER_ID = 0xFF00;
static const uint8_t LOCK_CMD_ACTION_REQ = 0x00;
static const uint8_t LOCK_CMD_CMD_RESULT = 0x01;
static const uint8_t LOCK_CMD_EVENT = 0x02;
static const uint8_t LOCK_CMD_STATE = 0x03;
static const size_t LOCK_MAX_JSON = 240; // must fit ZCL char string (1-byte length)

// Queue sizing
static const uint8_t MAX_DEVICES = 32;
static const uint8_t CMD_QUEUE_LEN = 16;

// ------------------------ COMPAT FALLBACKS ------------------------

// Some Arduino Zigbee builds don’t expose ESP_ZB_ZCL_VERSION; default to 3.
#ifndef ESP_ZB_ZCL_VERSION
#define ESP_ZB_ZCL_VERSION 3
#endif

// Cluster/attr constants (fallbacks for portability)
#ifndef ESP_ZB_ZCL_CLUSTER_ID_ON_OFF
#define ESP_ZB_ZCL_CLUSTER_ID_ON_OFF 0x0006
#endif
#ifndef ESP_ZB_ZCL_CLUSTER_ID_LEVEL_CONTROL
#define ESP_ZB_ZCL_CLUSTER_ID_LEVEL_CONTROL 0x0008
#endif
#ifndef ESP_ZB_ZCL_CLUSTER_ID_TEMP_MEASUREMENT
#define ESP_ZB_ZCL_CLUSTER_ID_TEMP_MEASUREMENT 0x0402
#endif
#ifndef ESP_ZB_ZCL_CLUSTER_ID_REL_HUMIDITY_MEASUREMENT
#define ESP_ZB_ZCL_CLUSTER_ID_REL_HUMIDITY_MEASUREMENT 0x0405
#endif

#ifndef ESP_ZB_ZCL_ATTR_ON_OFF_ON_OFF_ID
#define ESP_ZB_ZCL_ATTR_ON_OFF_ON_OFF_ID 0x0000
#endif
#ifndef ESP_ZB_ZCL_ATTR_LEVEL_CONTROL_CURRENT_LEVEL_ID
#define ESP_ZB_ZCL_ATTR_LEVEL_CONTROL_CURRENT_LEVEL_ID 0x0000
#endif
#ifndef ESP_ZB_ZCL_ATTR_TEMP_MEASUREMENT_VALUE_ID
#define ESP_ZB_ZCL_ATTR_TEMP_MEASUREMENT_VALUE_ID 0x0000
#endif
#ifndef ESP_ZB_ZCL_ATTR_REL_HUMIDITY_MEASUREMENT_VALUE_ID
#define ESP_ZB_ZCL_ATTR_REL_HUMIDITY_MEASUREMENT_VALUE_ID 0x0000
#endif

// Basic cluster fingerprint (manufacturer/model)
#ifndef ESP_ZB_ZCL_CLUSTER_ID_BASIC
#define ESP_ZB_ZCL_CLUSTER_ID_BASIC 0x0000
#endif
#ifndef ESP_ZB_ZCL_ATTR_BASIC_MANUFACTURER_NAME_ID
#define ESP_ZB_ZCL_ATTR_BASIC_MANUFACTURER_NAME_ID 0x0004
#endif
#ifndef ESP_ZB_ZCL_ATTR_BASIC_MODEL_IDENTIFIER_ID
#define ESP_ZB_ZCL_ATTR_BASIC_MODEL_IDENTIFIER_ID 0x0005
#endif
#ifndef ESP_ZB_ZCL_ATTR_BASIC_SW_BUILD_ID
#define ESP_ZB_ZCL_ATTR_BASIC_SW_BUILD_ID 0x4000
#endif

// Sprint 11: Identify helper
#ifndef ESP_ZB_ZCL_CLUSTER_ID_IDENTIFY
#define ESP_ZB_ZCL_CLUSTER_ID_IDENTIFY 0x0003
#endif
#ifndef ESP_ZB_ZCL_ATTR_IDENTIFY_TIME_ID
#define ESP_ZB_ZCL_ATTR_IDENTIFY_TIME_ID 0x0000
#endif

#ifndef ESP_ZB_ZCL_ATTR_TYPE_CHAR_STRING
#define ESP_ZB_ZCL_ATTR_TYPE_CHAR_STRING 0x42
#endif
#ifndef ESP_ZB_ZCL_ATTR_TYPE_LONG_CHAR_STRING
#define ESP_ZB_ZCL_ATTR_TYPE_LONG_CHAR_STRING 0x43
#endif

// ------------------------ UART JSON helpers ------------------------

static void uart_write_line(const String &line) {
  U.print(line);
  U.print('\n');
}

static void uart_send_json(const JsonDocument &doc) {
  String out;
  serializeJson(doc, out);
  uart_write_line(out);
}

static void uart_send_fw_info() {
  StaticJsonDocument<200> doc;
  doc["evt"] = "fw_info";
  doc["fwVersion"] = COORD_FIRMWARE_VERSION;
  doc["buildTime"] = COORD_BUILD_TIME;
  uart_send_json(doc);
}

static void uart_send_cmd_result(const char *cmdId, const char *ieeeStr, bool ok, const char *err = nullptr) {
  StaticJsonDocument<256> doc;
  doc["evt"] = "cmd_result";
  if (cmdId && cmdId[0] != '\0') doc["cmdId"] = cmdId;
  if (ieeeStr && ieeeStr[0] != '\0') doc["ieee"] = ieeeStr;
  doc["ok"] = ok;
  if (!ok && err) doc["error"] = err;
  uart_send_json(doc);
}

// Sprint 10: pass-through Zigbee events/state from lock end-device to hub_host
static void uart_send_zb_event(const char *ieeeStr, const char *type, JsonVariantConst data) {
  StaticJsonDocument<384> doc;
  doc["evt"] = "zb_event";
  if (ieeeStr && ieeeStr[0] != '\0') doc["ieee"] = ieeeStr;
  doc["type"] = type;
  if (!data.isNull()) doc["data"] = data;
  uart_send_json(doc);
}

static void uart_send_zb_state(const char *ieeeStr, JsonVariantConst state) {
  StaticJsonDocument<640> doc;
  doc["evt"] = "zb_state";
  if (ieeeStr && ieeeStr[0] != '\0') doc["ieee"] = ieeeStr;
  if (!state.isNull()) doc["state"] = state;
  uart_send_json(doc);
}

static void uart_send_join_state(bool enabled, int duration) {
  StaticJsonDocument<160> doc;
  doc["evt"] = "join_state";
  doc["enabled"] = enabled;
  doc["duration"] = duration;
  uart_send_json(doc);
}

// Sprint 11: Identify confirmation event (device is blinking)
static void uart_send_zb_identify(const char *ieeeStr, uint16_t identifyTimeSec, const char *reason = nullptr) {
  StaticJsonDocument<200> doc;
  doc["evt"] = "zb_identify";
  if (ieeeStr && ieeeStr[0] != '\0') doc["ieee"] = ieeeStr;
  doc["time"] = identifyTimeSec;
  if (reason && reason[0] != '\0') doc["reason"] = reason;
  uart_send_json(doc);
}

static void uart_send_device_annce(const char *ieeeStr, uint16_t shortAddr) {
  StaticJsonDocument<192> doc;
  doc["evt"] = "device_annce";
  doc["ieee"] = ieeeStr;
  char sh[8];
  snprintf(sh, sizeof(sh), "0x%04x", (unsigned)shortAddr);
  doc["short"] = sh;
  uart_send_json(doc);
}

static void uart_send_attr_report(const char *ieeeStr, const char *cluster, const char *attr, int32_t value) {
  StaticJsonDocument<256> doc;
  doc["evt"] = "attr_report";
  doc["ieee"] = ieeeStr;
  doc["cluster"] = cluster;
  doc["attr"] = attr;
  doc["value"] = value;
  uart_send_json(doc);
}

static void uart_send_basic_fingerprint(const char *ieeeStr, uint16_t shortAddr,
                                        const char *manufacturer,
                                        const char *model,
                                        const char *swBuildId) {
  StaticJsonDocument<300> doc;
  doc["evt"] = "basic_fingerprint";
  doc["ieee"] = ieeeStr;
  char sh[8];
  snprintf(sh, sizeof(sh), "0x%04x", (unsigned)shortAddr);
  doc["short"] = sh;
  if (manufacturer && manufacturer[0] != '\0') doc["manufacturer"] = manufacturer;
  if (model && model[0] != '\0') doc["model"] = model;
  if (swBuildId && swBuildId[0] != '\0') doc["swBuildId"] = swBuildId;
  uart_send_json(doc);
}

// ------------------------ IEEE helpers ------------------------

static bool normalize_ieee_str(const char *in, char out16[17]) {
  // Accept: "00124b..." or "0x00124b..." or with separators ':' '-'
  if (!in) return false;
  size_t o = 0;
  for (size_t i = 0; in[i] != 0 && o < 16; i++) {
    char c = in[i];
    if (c == 'x' || c == 'X') continue;
    if (c == '0' && (in[i + 1] == 'x' || in[i + 1] == 'X')) continue;
    if (c == ':' || c == '-' || c == ' ') continue;
    bool isHex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
    if (!isHex) continue;
    out16[o++] = (char)tolower((unsigned char)c);
  }
  if (o != 16) return false;
  out16[16] = 0;
  return true;
}

static void ieee_le_to_str16(const uint8_t ieee_le[8], char out16[17]) {
  // Stack uses little‑endian bytes; output big‑endian hex string.
  static const char *hex = "0123456789abcdef";
  for (int i = 0; i < 8; i++) {
    uint8_t b = ieee_le[7 - i];
    out16[i * 2] = hex[(b >> 4) & 0xF];
    out16[i * 2 + 1] = hex[b & 0xF];
  }
  out16[16] = 0;
}

static bool ieee_str16_to_le_bytes(const char *ieeeIn, uint8_t out_le[8]) {
  char norm[17];
  if (!normalize_ieee_str(ieeeIn, norm)) return false;
  for (int i = 0; i < 8; i++) {
    char hi = norm[i * 2];
    char lo = norm[i * 2 + 1];
    int vhi = (hi <= '9') ? (hi - '0') : (hi - 'a' + 10);
    int vlo = (lo <= '9') ? (lo - '0') : (lo - 'a' + 10);
    uint8_t b = (uint8_t)((vhi << 4) | vlo);
    out_le[7 - i] = b;
  }
  return true;
}

// ------------------------ Device table ------------------------

struct device_entry_t {
  bool used;
  uint16_t short_addr;
  char ieee16[17]; // normalized string
  uint32_t last_seen_ms;
  char manufacturer[33];
  char model[33];
  char swBuildId[33];
};

static device_entry_t g_devices[MAX_DEVICES];

static device_entry_t *find_device_by_short(uint16_t short_addr) {
  for (uint8_t i = 0; i < MAX_DEVICES; i++) {
    if (g_devices[i].used && g_devices[i].short_addr == short_addr) return &g_devices[i];
  }
  return nullptr;
}

static device_entry_t *find_device_by_ieee(const char *ieee16) {
  for (uint8_t i = 0; i < MAX_DEVICES; i++) {
    if (g_devices[i].used && strncmp(g_devices[i].ieee16, ieee16, 16) == 0) return &g_devices[i];
  }
  return nullptr;
}

static device_entry_t *upsert_device(uint16_t short_addr, const uint8_t ieee_le[8]) {
  char ieee16[17];
  ieee_le_to_str16(ieee_le, ieee16);
  device_entry_t *e = find_device_by_short(short_addr);
  if (!e) e = find_device_by_ieee(ieee16);
  if (!e) {
    // find empty
    for (uint8_t i = 0; i < MAX_DEVICES; i++) {
      if (!g_devices[i].used) {
        e = &g_devices[i];
        break;
      }
    }
  }
  if (!e) {
    // evict oldest
    uint8_t oldest = 0;
    uint32_t bestAge = 0;
    for (uint8_t i = 0; i < MAX_DEVICES; i++) {
      uint32_t age = millis() - g_devices[i].last_seen_ms;
      if (age >= bestAge) {
        bestAge = age;
        oldest = i;
      }
    }
    e = &g_devices[oldest];
  }
  bool ieeeChanged = true;
  if (e && e->used) {
    ieeeChanged = (strncmp(e->ieee16, ieee16, 16) != 0);
  }

  e->used = true;
  e->short_addr = short_addr;
  strncpy(e->ieee16, ieee16, sizeof(e->ieee16));
  e->ieee16[16] = 0;
  e->last_seen_ms = millis();
  if (ieeeChanged) {
    e->manufacturer[0] = 0;
    e->model[0] = 0;
    e->swBuildId[0] = 0;
  }
  return e;
}

static bool zcl_string_to_cstr(uint8_t zclType, const void *valuePtr, char *out, size_t outLen) {
  if (!out || outLen == 0) return false;
  out[0] = 0;
  if (!valuePtr) return false;
  const uint8_t *b = (const uint8_t *)valuePtr;
  if (zclType == ESP_ZB_ZCL_ATTR_TYPE_CHAR_STRING) {
    uint8_t len = b[0];
    if (len == 0xFF) return false;
    size_t n = (len < (outLen - 1)) ? (size_t)len : (outLen - 1);
    memcpy(out, b + 1, n);
    out[n] = 0;
    return true;
  }
  if (zclType == ESP_ZB_ZCL_ATTR_TYPE_LONG_CHAR_STRING) {
    uint16_t len = (uint16_t)b[0] | ((uint16_t)b[1] << 8);
    if (len == 0xFFFF) return false;
    size_t n = ((size_t)len < (outLen - 1)) ? (size_t)len : (outLen - 1);
    memcpy(out, b + 2, n);
    out[n] = 0;
    return true;
  }
  return false;
}

// ------------------------ Zigbee command helpers ------------------------

static void zb_set_permit_join(uint16_t duration_sec) {
  // Newer esp-zigbee APIs use esp_zb_zdo_permit_joining_req().
  esp_zb_zdo_permit_joining_req_param_t req = {0};
  req.dst_nwk_addr = 0x0000; // coordinator
  req.permit_duration = (duration_sec > 0xFF) ? 0xFF : (uint8_t)duration_sec;
  req.tc_significance = 1;
  (void)esp_zb_zdo_permit_joining_req(&req, nullptr, nullptr);
  uart_send_join_state(duration_sec > 0, (int)duration_sec);
}

static void zb_send_onoff(uint16_t short_addr, uint8_t dst_endpoint, bool on) {
  esp_zb_zcl_on_off_cmd_t cmd = {0};
  cmd.zcl_basic_cmd.src_endpoint = COORD_ENDPOINT;
  cmd.zcl_basic_cmd.dst_endpoint = dst_endpoint ? dst_endpoint : DEFAULT_DST_ENDPOINT;
  cmd.address_mode = ESP_ZB_APS_ADDR_MODE_16_ENDP_PRESENT;
  cmd.zcl_basic_cmd.dst_addr_u.addr_short = short_addr;
  cmd.on_off_cmd_id = on ? ESP_ZB_ZCL_CMD_ON_OFF_ON_ID : ESP_ZB_ZCL_CMD_ON_OFF_OFF_ID;
  (void)esp_zb_zcl_on_off_cmd_req(&cmd);
}

static void zb_send_level(uint16_t short_addr, uint8_t dst_endpoint, uint8_t level, uint16_t transition_ds) {
  // In esp-zigbee v1.6+ the type is esp_zb_zcl_move_to_level_cmd_t.
  esp_zb_zcl_move_to_level_cmd_t cmd = {0};
  cmd.zcl_basic_cmd.src_endpoint = COORD_ENDPOINT;
  cmd.zcl_basic_cmd.dst_endpoint = dst_endpoint ? dst_endpoint : DEFAULT_DST_ENDPOINT;
  cmd.address_mode = ESP_ZB_APS_ADDR_MODE_16_ENDP_PRESENT;
  cmd.zcl_basic_cmd.dst_addr_u.addr_short = short_addr;
  cmd.level = level;
  cmd.transition_time = transition_ds; // deci‑seconds
  (void)esp_zb_zcl_level_move_to_level_cmd_req(&cmd);
}

static void zb_send_lock_custom_cmd(uint16_t short_addr, uint8_t dst_endpoint, uint8_t custom_cmd_id, const char *json) {
  if (!json) return;
  const size_t len = strlen(json);
  if (len == 0 || len > 250) {
    Serial.printf("[ZB] lock_custom_cmd payload too large len=%u\n", (unsigned)len);
    return;
  }

  uint8_t zclStr[1 + 251];
  zclStr[0] = (uint8_t)len;
  memcpy(zclStr + 1, json, len);

  esp_zb_zcl_custom_cluster_cmd_req_t req = {0};
  req.zcl_basic_cmd.src_endpoint = COORD_ENDPOINT;
  req.zcl_basic_cmd.dst_endpoint = dst_endpoint ? dst_endpoint : DEFAULT_DST_ENDPOINT;
  req.zcl_basic_cmd.dst_addr_u.addr_short = short_addr;
  req.address_mode = ESP_ZB_APS_ADDR_MODE_16_ENDP_PRESENT;
  req.cluster_id = LOCK_CUSTOM_CLUSTER_ID;
  req.profile_id = ESP_ZB_AF_HA_PROFILE_ID;
  req.direction = ESP_ZB_ZCL_CMD_DIRECTION_TO_SRV;
  req.custom_cmd_id = custom_cmd_id;
  req.data.type = ESP_ZB_ZCL_ATTR_TYPE_CHAR_STRING;
  req.data.size = (uint16_t)(len + 1);
  req.data.value = zclStr;

  (void)esp_zb_zcl_custom_cluster_cmd_req(&req);
}

// Sprint 11: Identify (blink) command
// Use custom cluster command sender to avoid dependency on identify-specific wrappers.
static void zb_send_identify(uint16_t short_addr, uint8_t dst_endpoint, uint16_t identify_time_sec) {
  uint8_t payload[2];
  payload[0] = (uint8_t)(identify_time_sec & 0xFF);
  payload[1] = (uint8_t)((identify_time_sec >> 8) & 0xFF);

  esp_zb_zcl_custom_cluster_cmd_req_t req = {0};
  req.zcl_basic_cmd.src_endpoint = COORD_ENDPOINT;
  req.zcl_basic_cmd.dst_endpoint = dst_endpoint ? dst_endpoint : DEFAULT_DST_ENDPOINT;
  req.zcl_basic_cmd.dst_addr_u.addr_short = short_addr;
  req.address_mode = ESP_ZB_APS_ADDR_MODE_16_ENDP_PRESENT;
  req.cluster_id = ESP_ZB_ZCL_CLUSTER_ID_IDENTIFY;
  req.profile_id = ESP_ZB_AF_HA_PROFILE_ID;
  req.direction = ESP_ZB_ZCL_CMD_DIRECTION_TO_SRV;
  req.custom_cmd_id = 0x00; // Identify command
  req.data.type = 0x21;     // ZCL uint16 (payload is raw bytes for this helper)
  req.data.size = 2;
  req.data.value = payload;

  (void)esp_zb_zcl_custom_cluster_cmd_req(&req);
}

// Sprint 11: Actively read basic fingerprint right after device announce.
// Many devices do not proactively report Basic cluster attributes.
static void zb_read_basic_fingerprint(uint16_t short_addr, uint8_t dst_endpoint) {
#if defined(ESP_ZB_ZCL_CLUSTER_ID_BASIC)
  static uint16_t attrs[3] = {
      (uint16_t)ESP_ZB_ZCL_ATTR_BASIC_MANUFACTURER_NAME_ID,
      (uint16_t)ESP_ZB_ZCL_ATTR_BASIC_MODEL_IDENTIFIER_ID,
      (uint16_t)ESP_ZB_ZCL_ATTR_BASIC_SW_BUILD_ID,
  };
  esp_zb_zcl_read_attr_cmd_t cmd = {0};
  cmd.zcl_basic_cmd.src_endpoint = COORD_ENDPOINT;
  cmd.zcl_basic_cmd.dst_endpoint = dst_endpoint ? dst_endpoint : DEFAULT_DST_ENDPOINT;
  cmd.zcl_basic_cmd.dst_addr_u.addr_short = short_addr;
  cmd.address_mode = ESP_ZB_APS_ADDR_MODE_16_ENDP_PRESENT;
  cmd.cluster_id = ESP_ZB_ZCL_CLUSTER_ID_BASIC;
  cmd.attr_number = 3;
  cmd.attr_field = attrs;
  (void)esp_zb_zcl_read_attr_cmd_req(&cmd);
#endif
}

static void zb_remove_device(const uint8_t ieee_le[8]) {
  esp_zb_zdo_mgmt_leave_req_param_t req = {0};
  req.dst_nwk_addr = 0x0000; // coordinator
  memcpy(req.device_address, ieee_le, sizeof(req.device_address));
  req.remove_children = 1;
  req.rejoin = 0;
  (void)esp_zb_zdo_device_leave_req(&req, nullptr, nullptr);
}

// ------------------------ Zigbee callbacks ------------------------

static esp_err_t zb_action_handler(esp_zb_core_action_callback_id_t callback_id, const void *message) {
  switch (callback_id) {
    case ESP_ZB_CORE_REPORT_ATTR_CB_ID: {
      const esp_zb_zcl_report_attr_message_t *m = (const esp_zb_zcl_report_attr_message_t *)message;
      if (!m || m->status != ESP_ZB_ZCL_STATUS_SUCCESS) return ESP_OK;

      device_entry_t *dev = find_device_by_short(m->src_address.u.short_addr);
      if (!dev) return ESP_OK;
      dev->last_seen_ms = millis();

      // Map to the string contract expected by Hub Host firmware.
      const char *clusterName = "raw";
      const char *attrName = "raw";
      int32_t valueInt = 0;

      const uint16_t cluster = m->cluster;
      const uint16_t attrId = m->attribute.id;
      const uint8_t type = m->attribute.data.type;
      const void *val = m->attribute.data.value;

      // Sprint 2: capture Basic cluster fingerprint (manufacturer/model) for pairing UX.
      if (cluster == ESP_ZB_ZCL_CLUSTER_ID_BASIC &&
          (attrId == ESP_ZB_ZCL_ATTR_BASIC_MANUFACTURER_NAME_ID ||
           attrId == ESP_ZB_ZCL_ATTR_BASIC_MODEL_IDENTIFIER_ID ||
           attrId == ESP_ZB_ZCL_ATTR_BASIC_SW_BUILD_ID)) {
        char buf[33];
        if (zcl_string_to_cstr(type, val, buf, sizeof(buf))) {
          if (attrId == ESP_ZB_ZCL_ATTR_BASIC_MANUFACTURER_NAME_ID) {
            strncpy(dev->manufacturer, buf, sizeof(dev->manufacturer));
            dev->manufacturer[sizeof(dev->manufacturer) - 1] = 0;
          } else if (attrId == ESP_ZB_ZCL_ATTR_BASIC_MODEL_IDENTIFIER_ID) {
            strncpy(dev->model, buf, sizeof(dev->model));
            dev->model[sizeof(dev->model) - 1] = 0;
          } else if (attrId == ESP_ZB_ZCL_ATTR_BASIC_SW_BUILD_ID) {
            strncpy(dev->swBuildId, buf, sizeof(dev->swBuildId));
            dev->swBuildId[sizeof(dev->swBuildId) - 1] = 0;
          }

          uart_send_basic_fingerprint(dev->ieee16, dev->short_addr,
                                     dev->manufacturer,
                                     dev->model,
                                     dev->swBuildId);
        }
        return ESP_OK;
      }

      if (cluster == ESP_ZB_ZCL_CLUSTER_ID_ON_OFF && attrId == ESP_ZB_ZCL_ATTR_ON_OFF_ON_OFF_ID) {
        clusterName = "onoff";
        attrName = "onoff";
        // bool can be stored as uint8_t in some builds
        if (val) valueInt = (*(const uint8_t *)val) ? 1 : 0;
      } else if (cluster == ESP_ZB_ZCL_CLUSTER_ID_LEVEL_CONTROL &&
                 attrId == ESP_ZB_ZCL_ATTR_LEVEL_CONTROL_CURRENT_LEVEL_ID) {
        clusterName = "level";
        attrName = "level";
        if (val) valueInt = *(const uint8_t *)val;
      } else if (cluster == ESP_ZB_ZCL_CLUSTER_ID_OCCUPANCY_SENSING &&
                 attrId == ESP_ZB_ZCL_ATTR_OCCUPANCY_SENSING_OCCUPANCY_ID) {
        clusterName = "occupancy";
        attrName = "occupied";
        if (val) valueInt = *(const uint8_t *)val;
      } else if (cluster == ESP_ZB_ZCL_CLUSTER_ID_TEMP_MEASUREMENT &&
                 attrId == ESP_ZB_ZCL_ATTR_TEMP_MEASUREMENT_VALUE_ID) {
        clusterName = "temperature";
        attrName = "value";
        if (val) valueInt = *(const int16_t *)val; // unit: 0.01°C
      } else if (cluster == ESP_ZB_ZCL_CLUSTER_ID_REL_HUMIDITY_MEASUREMENT &&
                 attrId == ESP_ZB_ZCL_ATTR_REL_HUMIDITY_MEASUREMENT_VALUE_ID) {
        clusterName = "humidity";
        attrName = "value";
        if (val) valueInt = *(const uint16_t *)val; // unit: 0.01%
      } else if (cluster == ESP_ZB_ZCL_CLUSTER_ID_IDENTIFY && attrId == ESP_ZB_ZCL_ATTR_IDENTIFY_TIME_ID) {
        // Sprint 11: Identify confirmation. Many devices do not send an explicit ack.
        // If we ever receive Identify Time >0, forward as a UART event.
        uint16_t t = 0;
        if (val) t = *(const uint16_t *)val;
        if (t > 0) {
          uart_send_zb_identify(dev->ieee16, t, "attr_report");
        }
        return ESP_OK;
      } else {
        static char clusterBuf[8];
        static char attrBuf[8];
        snprintf(clusterBuf, sizeof(clusterBuf), "0x%04x", (unsigned)cluster);
        snprintf(attrBuf, sizeof(attrBuf), "0x%04x", (unsigned)attrId);
        clusterName = clusterBuf;
        attrName = attrBuf;

        // best‑effort decode common scalar types
        if (!val) {
          valueInt = 0;
        } else if (type == ESP_ZB_ZCL_ATTR_TYPE_U8) {
          valueInt = *(const uint8_t *)val;
        } else if (type == ESP_ZB_ZCL_ATTR_TYPE_S16) {
          valueInt = *(const int16_t *)val;
        } else if (type == ESP_ZB_ZCL_ATTR_TYPE_U16) {
          valueInt = *(const uint16_t *)val;
        } else if (type == ESP_ZB_ZCL_ATTR_TYPE_BOOL) {
          valueInt = (*(const uint8_t *)val) ? 1 : 0;
        } else {
          valueInt = 0;
        }
      }

      uart_send_attr_report(dev->ieee16, clusterName, attrName, valueInt);
      return ESP_OK;
    }
	  case ESP_ZB_CORE_CMD_CUSTOM_CLUSTER_REQ_CB_ID: {
	    const esp_zb_zcl_custom_cluster_command_message_t *m = (const esp_zb_zcl_custom_cluster_command_message_t *)message;
	    if (!m) return ESP_OK;
	    if (m->info.status != ESP_ZB_ZCL_STATUS_SUCCESS) return ESP_OK;

	    // Map source short address -> ieee string
	    const uint16_t srcShort = m->info.src_address.u.short_addr;
	    device_entry_t *dev = find_device_by_short(srcShort);
	    if (!dev) {
	      Serial.printf("[ZB] custom_cmd id=0x%02x from unknown short=0x%04x\n", m->info.command.id, srcShort);
	      return ESP_OK;
	    }

	    // Our payload is ZCL char-string (len byte + data)
	    const uint8_t *raw = (const uint8_t *)m->data.value;
	    if (!raw || m->data.size < 1) return ESP_OK;
	    const uint8_t len = raw[0];
	    char jsonBuf[256];
	    const size_t copyN = (len < sizeof(jsonBuf) - 1) ? len : (sizeof(jsonBuf) - 1);
	    if (m->data.size < (size_t)(1 + len)) {
	      // best-effort: trust provided buffer size
	      const size_t avail = (m->data.size > 1) ? (m->data.size - 1) : 0;
	      const size_t n2 = (avail < (sizeof(jsonBuf) - 1)) ? avail : (sizeof(jsonBuf) - 1);
	      memcpy(jsonBuf, raw + 1, n2);
	      jsonBuf[n2] = '\0';
	    } else {
	      memcpy(jsonBuf, raw + 1, copyN);
	      jsonBuf[copyN] = '\0';
	    }

	    StaticJsonDocument<256> doc;
	    DeserializationError err = deserializeJson(doc, jsonBuf);
	    if (err) {
	      Serial.printf("[ZB] custom_cmd JSON parse fail: %s\n", err.c_str());
	      return ESP_OK;
	    }

	    const uint8_t cmdId = m->info.command.id;
	    if (cmdId == LOCK_CMD_CMD_RESULT) {
	      const char *cmdIdStr = doc["cmdId"] | "";
	      const bool ok = doc["ok"] | false;
	      const char *error = doc["error"] | "";
	      uart_send_cmd_result(cmdIdStr, dev->ieee16, ok, error);
	    } else if (cmdId == LOCK_CMD_EVENT) {
	      const char *type = doc["type"] | "";
	      JsonVariantConst data = doc["data"].as<JsonVariantConst>();
	      if (type && type[0]) {
	        uart_send_zb_event(dev->ieee16, type, data);
	      }
	    } else if (cmdId == LOCK_CMD_STATE) {
	      // State payload is already the reported object
	      uart_send_zb_state(dev->ieee16, doc.as<JsonVariantConst>());
	    } else {
	      Serial.printf("[ZB] unknown custom_cmd id=0x%02x from %s\n", cmdId, dev->ieee16);
	    }
	    return ESP_OK;
	  }
	    default:
	      return ESP_OK;
  }
}

// Zigbee stack calls this weak symbol.

// esp_zb_scheduler_alarm() passes a uint8_t parameter (Arduino-ESP32 Zigbee libs
// build with that signature). Keep an adapter to avoid void* casts.
static void bdb_commissioning_cb(uint8_t mode) {
  esp_zb_bdb_start_top_level_commissioning((esp_zb_bdb_commissioning_mode_t)mode);
}

extern "C" void esp_zb_app_signal_handler(esp_zb_app_signal_t *signal_struct) {
  if (!signal_struct) return;

  esp_zb_app_signal_type_t sig = *(esp_zb_app_signal_type_t *)signal_struct->p_app_signal;
  esp_err_t status = signal_struct->esp_err_status;

  if (sig == ESP_ZB_ZDO_SIGNAL_SKIP_STARTUP) {
    // Start commissioning
    esp_zb_bdb_start_top_level_commissioning(ESP_ZB_BDB_MODE_INITIALIZATION);
    return;
  }

  if (sig == ESP_ZB_BDB_SIGNAL_DEVICE_FIRST_START || sig == ESP_ZB_BDB_SIGNAL_DEVICE_REBOOT) {
    if (status == ESP_OK) {
      esp_zb_bdb_start_top_level_commissioning(ESP_ZB_BDB_MODE_NETWORK_FORMATION);
    }
    return;
  }

  if (sig == ESP_ZB_BDB_SIGNAL_FORMATION) {
    if (status == ESP_OK) {
      esp_zb_bdb_start_top_level_commissioning(ESP_ZB_BDB_MODE_NETWORK_STEERING);
    } else {
      // Retry formation
      esp_zb_scheduler_alarm(bdb_commissioning_cb,
                             (uint8_t)ESP_ZB_BDB_MODE_NETWORK_FORMATION,
                             1000);
    }
    return;
  }

  if (sig == ESP_ZB_ZDO_SIGNAL_DEVICE_ANNCE) {
    esp_zb_zdo_signal_device_annce_params_t *annce =
        (esp_zb_zdo_signal_device_annce_params_t *)esp_zb_app_signal_get_params((uint32_t *)signal_struct->p_app_signal);
    if (!annce) return;

    device_entry_t *dev = upsert_device(annce->device_short_addr, annce->ieee_addr);
    if (dev) {
      uart_send_device_annce(dev->ieee16, dev->short_addr);
      // Sprint 11: actively request Basic fingerprint so discovered payload has manufacturer/model/swBuildId.
      zb_read_basic_fingerprint(dev->short_addr, DEFAULT_DST_ENDPOINT);
    }
    return;
  }
}

// ------------------------ UART command queue ------------------------

typedef enum {
  CMD_PERMIT_JOIN = 1,
  CMD_ZCL_ONOFF = 2,
  CMD_ZCL_LEVEL = 3,
  CMD_REMOVE_DEVICE = 4,
  CMD_LOCK_ACTION = 5,
  CMD_IDENTIFY = 6,
} cmd_type_t;

struct uart_cmd_t {
  cmd_type_t type;
  char cmdId[40];
  char ieee16[17];
  uint8_t dst_ep; // default 1
  uint16_t u16;
  char payload[256];
};

static QueueHandle_t g_cmdQueue = nullptr;

static bool enqueue_cmd(const uart_cmd_t &cmd) {
  if (!g_cmdQueue) return false;
  return xQueueSend(g_cmdQueue, &cmd, 0) == pdTRUE;
}

static bool parse_uart_cmd(const JsonDocument &doc, uart_cmd_t &out, const char **err) {
  *err = nullptr;
  memset(&out, 0, sizeof(out));

  const char *cmd = doc["cmd"] | "";
  const char *cmdId = doc["cmdId"] | "";
  if (cmdId && cmdId[0] != '\0') {
    strncpy(out.cmdId, cmdId, sizeof(out.cmdId) - 1);
    out.cmdId[sizeof(out.cmdId) - 1] = 0;
  }

  if (strcmp(cmd, "permit_join") == 0) {
    int duration = doc["duration"] | (doc["durationSec"] | 60);
    if (duration < 0) duration = 0;
    if (duration > 255) duration = 255;
    out.type = CMD_PERMIT_JOIN;
    out.u16 = (uint16_t)duration;
    return true;
  }

  if (strcmp(cmd, "zcl_onoff") == 0) {
    const char *ieeeIn = doc["ieee"] | "";
    char norm[17];
    if (!normalize_ieee_str(ieeeIn, norm)) {
      *err = "invalid ieee";
      return false;
    }
    int v = doc["value"].is<int>() ? doc["value"].as<int>() : (doc["on"].as<bool>() ? 1 : 0);
    out.type = CMD_ZCL_ONOFF;
    strncpy(out.ieee16, norm, sizeof(out.ieee16));
    out.dst_ep = (uint8_t)(doc["endpoint"] | DEFAULT_DST_ENDPOINT);
    if (out.dst_ep == 0) out.dst_ep = DEFAULT_DST_ENDPOINT;
    out.u16 = (uint16_t)(v ? 1 : 0);
    return true;
  }

  if (strcmp(cmd, "zcl_level") == 0) {
    const char *ieeeIn = doc["ieee"] | "";
    char norm[17];
    if (!normalize_ieee_str(ieeeIn, norm)) {
      *err = "invalid ieee";
      return false;
    }
    int level = doc["value"] | (doc["level"] | 0);
    if (level < 0) level = 0;
    if (level > 255) level = 255;
    out.type = CMD_ZCL_LEVEL;
    strncpy(out.ieee16, norm, sizeof(out.ieee16));
    out.dst_ep = (uint8_t)(doc["endpoint"] | DEFAULT_DST_ENDPOINT);
    if (out.dst_ep == 0) out.dst_ep = DEFAULT_DST_ENDPOINT;
    out.u16 = (uint16_t)level;
    return true;
  }

  // Sprint 11: Identify (blink) command
  if (strcmp(cmd, "identify") == 0) {
    const char *ieeeIn = doc["ieee"] | "";
    char norm[17];
    if (!normalize_ieee_str(ieeeIn, norm)) {
      *err = "invalid ieee";
      return false;
    }
    int timeSec = doc["time"] | (doc["duration"] | (doc["durationSec"] | 4));
    if (timeSec < 0) timeSec = 0;
    if (timeSec > 255) timeSec = 255;
    out.type = CMD_IDENTIFY;
    strncpy(out.ieee16, norm, sizeof(out.ieee16));
    out.dst_ep = (uint8_t)(doc["endpoint"] | DEFAULT_DST_ENDPOINT);
    if (out.dst_ep == 0) out.dst_ep = DEFAULT_DST_ENDPOINT;
    out.u16 = (uint16_t)timeSec;
    return true;
  }

	if (strcmp(cmd, "lock_action") == 0) {
	  const char *ieeeIn = doc["ieee"] | "";
	  char norm[17];
	  if (!normalize_ieee_str(ieeeIn, norm)) {
	    *err = "invalid ieee";
	    return false;
	  }
	  const char *action = doc["action"] | "";
	  JsonVariantConst argsV = doc["args"].as<JsonVariantConst>();
	  if (!action || action[0] == 0) {
	    *err = "missing action";
	    return false;
	  }
	  out.type = CMD_LOCK_ACTION;
	  strncpy(out.ieee16, norm, sizeof(out.ieee16));
	  out.dst_ep = (uint8_t)(doc["endpoint"] | DEFAULT_DST_ENDPOINT);
	  if (out.dst_ep == 0) out.dst_ep = DEFAULT_DST_ENDPOINT;

	  // Build payload JSON to send over Zigbee custom cluster command
	  StaticJsonDocument<256> pl;
	  pl["cmdId"] = out.cmdId;
	  pl["action"] = action;
	  if (!argsV.isNull()) pl["args"] = argsV;
	  char buf[sizeof(out.payload)];
	  size_t n = serializeJson(pl, buf, sizeof(buf));
	  if (n == 0 || n >= sizeof(out.payload)) {
	    *err = "payload too large";
	    return false;
	  }
	  strncpy(out.payload, buf, sizeof(out.payload));
	  out.payload[sizeof(out.payload) - 1] = '\0';
	  return true;
	}

  if (strcmp(cmd, "remove_device") == 0) {
    const char *ieeeIn = doc["ieee"] | "";
    char norm[17];
    if (!normalize_ieee_str(ieeeIn, norm)) {
      *err = "invalid ieee";
      return false;
    }
    out.type = CMD_REMOVE_DEVICE;
    strncpy(out.ieee16, norm, sizeof(out.ieee16));
    return true;
  }

  *err = "unknown cmd";
  return false;
}

// ------------------------ Zigbee init/task ------------------------

static void zigbee_init_coordinator() {
  // Zigbee platform config
  esp_zb_platform_config_t config = {};
#if defined(ESP_ZB_DEFAULT_RADIO_CONFIG) && defined(ESP_ZB_DEFAULT_HOST_CONFIG)
  // If the SDK provides default config macros, use them.
  config.radio_config = ESP_ZB_DEFAULT_RADIO_CONFIG();
  config.host_config = ESP_ZB_DEFAULT_HOST_CONFIG();
#endif
  ESP_ERROR_CHECK(esp_zb_platform_config(&config));

  esp_zb_cfg_t zb_nwk_cfg = {};
#if defined(ESP_ZB_ZC_CONFIG)
  zb_nwk_cfg = ESP_ZB_ZC_CONFIG();
#else
  // Fallback: minimal coordinator configuration (API fields are stable across SDK revs).
  zb_nwk_cfg.esp_zb_role = ESP_ZB_DEVICE_TYPE_COORDINATOR;
  zb_nwk_cfg.install_code_policy = false;
  zb_nwk_cfg.nwk_cfg.zczr_cfg.max_children = 16;
#endif
  esp_zb_init(&zb_nwk_cfg);

  // Coordinator endpoint: Basic/Identify server + OnOff/Level client
  esp_zb_ep_list_t *ep_list = esp_zb_ep_list_create();
  esp_zb_endpoint_config_t ep_cfg = {
      .endpoint = COORD_ENDPOINT,
      .app_profile_id = ESP_ZB_AF_HA_PROFILE_ID,
      .app_device_id = ESP_ZB_HA_ON_OFF_SWITCH_DEVICE_ID,
      .app_device_version = 0,
  };

  esp_zb_cluster_list_t *cluster_list = esp_zb_zcl_cluster_list_create();
  // Keep this endpoint minimal: basic + identify server, and client clusters for sending.
  // (Match the function signatures used in other Arduino Zigbee sketches in this repo.)
  esp_zb_cluster_list_add_basic_cluster(cluster_list, nullptr, (uint8_t)ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
  esp_zb_cluster_list_add_identify_cluster(cluster_list, nullptr, (uint8_t)ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

  esp_zb_cluster_list_add_on_off_cluster(cluster_list, nullptr, (uint8_t)ESP_ZB_ZCL_CLUSTER_CLIENT_ROLE);
  esp_zb_cluster_list_add_level_cluster(cluster_list, nullptr, (uint8_t)ESP_ZB_ZCL_CLUSTER_CLIENT_ROLE);

  // SmartLock custom cluster (client): receive direction_to_cli cmds from lock end-device
  // and send direction_to_srv action requests.
  esp_zb_attribute_list_t *lock_client_cluster = esp_zb_zcl_attr_list_create(LOCK_CUSTOM_CLUSTER_ID);
  esp_zb_cluster_list_add_custom_cluster(cluster_list, lock_client_cluster, (uint8_t)ESP_ZB_ZCL_CLUSTER_CLIENT_ROLE);

  ESP_ERROR_CHECK(esp_zb_ep_list_add_ep(ep_list, cluster_list, ep_cfg));
  ESP_ERROR_CHECK(esp_zb_device_register(ep_list));

  esp_zb_core_action_handler_register(zb_action_handler);
  esp_zb_set_primary_network_channel_set(ESP_ZB_TRANSCEIVER_ALL_CHANNELS_MASK);

  esp_zb_start(false);
}

static void zb_task(void *) {
  zigbee_init_coordinator();

  while (true) {
    // Process queued UART commands in Zigbee context
    uart_cmd_t cmd;
    while (g_cmdQueue && xQueueReceive(g_cmdQueue, &cmd, 0) == pdTRUE) {
      if (cmd.type == CMD_PERMIT_JOIN) {
        zb_set_permit_join(cmd.u16);
        uart_send_cmd_result(cmd.cmdId, "", true, nullptr);
      } else if (cmd.type == CMD_ZCL_ONOFF) {
        device_entry_t *d = find_device_by_ieee(cmd.ieee16);
        if (!d) {
          uart_send_cmd_result(cmd.cmdId, cmd.ieee16, false, "unknown device (wait for device_annce)");
        } else {
          zb_send_onoff(d->short_addr, cmd.dst_ep, cmd.u16 ? true : false);
          uart_send_cmd_result(cmd.cmdId, cmd.ieee16, true, nullptr);
        }
      } else if (cmd.type == CMD_ZCL_LEVEL) {
        device_entry_t *d = find_device_by_ieee(cmd.ieee16);
        if (!d) {
          uart_send_cmd_result(cmd.cmdId, cmd.ieee16, false, "unknown device (wait for device_annce)");
        } else {
          zb_send_level(d->short_addr, cmd.dst_ep, (uint8_t)cmd.u16, 0);
          uart_send_cmd_result(cmd.cmdId, cmd.ieee16, true, nullptr);
        }

      } else if (cmd.type == CMD_IDENTIFY) {
        device_entry_t *d = find_device_by_ieee(cmd.ieee16);
        if (!d) {
          uart_send_cmd_result(cmd.cmdId, cmd.ieee16, false, "unknown device (wait for device_annce)");
        } else {
          zb_send_identify_cmd(d->short_addr, cmd.dst_ep, cmd.u16);
          uart_send_cmd_result(cmd.cmdId, cmd.ieee16, true, nullptr);
          // Best-effort: treat "sent Identify" as confirmation signal for UI
          uart_send_zb_identify(d->ieee16, cmd.u16, "cmd");
        }
	      } else if (cmd.type == CMD_LOCK_ACTION) {
	        device_entry_t *d = find_device_by_ieee(cmd.ieee16);
	        if (!d) {
	          uart_send_cmd_result(cmd.cmdId, cmd.ieee16, false, "unknown device (wait for device_annce)");
	        } else {
	          zb_send_lock_custom_cmd(d->short_addr, cmd.dst_ep, LOCK_CMD_ACTION_REQ, cmd.payload);
	          // actual cmd_result will be forwarded by end-device
	        }
      } else if (cmd.type == CMD_REMOVE_DEVICE) {
        uint8_t ieee_le[8];
        if (!ieee_str16_to_le_bytes(cmd.ieee16, ieee_le)) {
          uart_send_cmd_result(cmd.cmdId, cmd.ieee16, false, "invalid ieee");
        } else {
          zb_remove_device(ieee_le);
          uart_send_cmd_result(cmd.cmdId, cmd.ieee16, true, nullptr);
        }
      }
    }

    esp_zb_main_loop_iteration();
    vTaskDelay(1);
  }
}

// ------------------------ Arduino entry ------------------------

static String g_uartLine;

void setup() {
  Serial.begin(115200);
  delay(200);

  U.begin(UART_BAUD, SERIAL_8N1, UART_RX_PIN, UART_TX_PIN);
  g_cmdQueue = xQueueCreate(CMD_QUEUE_LEN, sizeof(uart_cmd_t));

  Serial.println("[C6] Zigbee Coordinator + UART bridge starting...");
  // Sprint 7: report coordinator fwVersion to hub_host
  uart_send_fw_info();
  xTaskCreate(zb_task, "zb_task", 8192, nullptr, 5, nullptr);
}

void loop() {
  while (U.available()) {
    char c = (char)U.read();
    if (c == '\r') continue;

    if (c == '\n') {
      String line = g_uartLine;
      g_uartLine = "";
      line.trim();
      if (line.length() == 0) continue;

      StaticJsonDocument<512> doc;
      DeserializationError derr = deserializeJson(doc, line);
      if (derr) {
        uart_send_cmd_result("", "", false, "json parse error");
        continue;
      }

      uart_cmd_t cmd;
      const char *err = nullptr;
      if (!parse_uart_cmd(doc, cmd, &err)) {
        const char *cmdId = doc["cmdId"] | "";
        uart_send_cmd_result(cmdId, doc["ieee"] | "", false, err ? err : "bad cmd");
        continue;
      }

      if (!enqueue_cmd(cmd)) {
        uart_send_cmd_result(cmd.cmdId, cmd.ieee16, false, "cmd queue full");
        continue;
      }
    } else {
      g_uartLine += c;
      if (g_uartLine.length() > 1024) {
        g_uartLine = ""; // prevent runaway
        uart_send_cmd_result("", "", false, "uart line too long");
      }
    }
  }

  delay(2);
}
