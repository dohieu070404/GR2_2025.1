// Zigbee End Device - Sensor (Temperature + Humidity) (Arduino IDE)
// Target: ESP32-C6 OR ESP32-H2
//
// Endpoint 1:
// - Basic (server)
// - Identify (server)
// - Temperature Measurement (0x0402, server)
// - Relative Humidity Measurement (0x0405, server)
//
// Reports every REPORT_INTERVAL_S seconds.
// OTA trigger: Identify command with identify_time == 0x1234
// - ESP32-C6: WiFi HTTP OTA (hardcoded SSID/PASS + OTA_URL)
// - ESP32-H2: WiFi not supported -> ignored

#include <Arduino.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/timers.h"

#include "esp_zigbee_core.h"
#include "esp_zigbee_zcl_common.h"
#include "esp_zigbee_zcl_command.h"

// ------------------------
// Zigbee IDs
// ------------------------
#define SENSOR_ENDPOINT 1

// ------------------------
// Basic cluster fingerprint (Sprint 2 pairing)
// ------------------------
#define ZCL_CLUSTER_BASIC 0x0000
#define ATTR_BASIC_MANUFACTURER_NAME 0x0004
#define ATTR_BASIC_MODEL_IDENTIFIER  0x0005
#define ATTR_BASIC_SW_BUILD_ID       0x4000

// Make these match backend ProductModel fingerprint fields.
static const char* BASIC_MANUFACTURER = "SmartHome";
static const char* BASIC_MODEL = "TH_SENSOR_V1";
static const char* BASIC_SW_BUILD = "1.0.0";

static uint8_t g_basic_manuf_str[1 + 32];
static uint8_t g_basic_model_str[1 + 32];
static uint8_t g_basic_sw_str[1 + 32];
static bool g_fingerprint_reported = false;
static uint32_t g_last_fingerprint_ms = 0;

#ifndef ESP_ZB_ZCL_ATTR_TYPE_CHAR_STRING
#define ESP_ZB_ZCL_ATTR_TYPE_CHAR_STRING 0x42
#endif

static void fill_zcl_char_string(uint8_t* buf, size_t buf_size, const char* s) {
  if (!buf || buf_size < 2) return;
  if (!s) s = "";
  size_t len = strlen(s);
  if (len > buf_size - 1) len = buf_size - 1;
  buf[0] = (uint8_t)len;
  memcpy(buf + 1, s, len);
}

static void set_basic_fingerprint_attributes() {
  fill_zcl_char_string(g_basic_manuf_str, sizeof(g_basic_manuf_str), BASIC_MANUFACTURER);
  fill_zcl_char_string(g_basic_model_str, sizeof(g_basic_model_str), BASIC_MODEL);
  fill_zcl_char_string(g_basic_sw_str, sizeof(g_basic_sw_str), BASIC_SW_BUILD);

  // Store in local attribute table (Pascal string layout: [len][bytes]).
  (void)esp_zb_zcl_set_attribute_val(
    SENSOR_ENDPOINT,
    ZCL_CLUSTER_BASIC,
    ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
    ATTR_BASIC_MANUFACTURER_NAME,
    g_basic_manuf_str,
    false
  );
  (void)esp_zb_zcl_set_attribute_val(
    SENSOR_ENDPOINT,
    ZCL_CLUSTER_BASIC,
    ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
    ATTR_BASIC_MODEL_IDENTIFIER,
    g_basic_model_str,
    false
  );
  (void)esp_zb_zcl_set_attribute_val(
    SENSOR_ENDPOINT,
    ZCL_CLUSTER_BASIC,
    ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
    ATTR_BASIC_SW_BUILD_ID,
    g_basic_sw_str,
    false
  );
}

static void maybe_report_basic_fingerprint();

#define ZCL_CLUSTER_TEMP_MEASUREMENT 0x0402
#define ZCL_CLUSTER_RH_MEASUREMENT   0x0405
#define ATTR_MEASURED_VALUE          0x0000

#ifndef ESP_ZB_HA_PROFILE_ID
#define ESP_ZB_HA_PROFILE_ID 0x0104
#endif

#ifndef ESP_ZB_HA_TEMPERATURE_SENSOR_DEVICE_ID
#define ESP_ZB_HA_TEMPERATURE_SENSOR_DEVICE_ID 0x0302
#endif

// ------------------------
// Reporting + fake sensor
// ------------------------
#ifndef REPORT_INTERVAL_S
#define REPORT_INTERVAL_S 10
#endif

static TimerHandle_t s_report_timer;

static int16_t read_fake_temperature_c_x100() {
  // 23.00C ± 1.00C
  uint32_t r = (uint32_t)esp_random();
  int delta = (int)(r % 201) - 100;
  return (int16_t)(2300 + delta);
}

static uint16_t read_fake_humidity_pct_x100() {
  // 45.00% ± 2.50%
  uint32_t r = (uint32_t)esp_random();
  int delta = (int)(r % 501) - 250;
  int v = 4500 + delta;
  if (v < 0) v = 0;
  if (v > 10000) v = 10000;
  return (uint16_t)v;
}

static void report_attr(uint16_t cluster_id, uint16_t attr_id) {
  esp_zb_zcl_report_attr_cmd_req_t req = {};
  req.address_mode = ESP_ZB_APS_ADDR_MODE_DST_ADDR_ENDP_NOT_PRESENT;
  req.zcl_basic_cmd.src_endpoint = SENSOR_ENDPOINT;
  req.zcl_basic_cmd.cluster_id = cluster_id;
  req.attribute_id = attr_id;
  esp_zb_zcl_report_attr_cmd_req(&req);
}

static void maybe_report_basic_fingerprint() {
  const uint32_t now = millis();
  // Send at least once, and then refresh occasionally in case coordinator missed it.
  if (!g_fp_sent_once || (now - g_fp_last_ms) > 60000UL) {
    report_attr(ZCL_CLUSTER_BASIC, ATTR_BASIC_MANUFACTURER_NAME);
    report_attr(ZCL_CLUSTER_BASIC, ATTR_BASIC_MODEL_IDENTIFIER);
    report_attr(ZCL_CLUSTER_BASIC, ATTR_BASIC_SW_BUILD_ID);
    g_fp_sent_once = true;
    g_fp_last_ms = now;
  }
}

static void update_and_report() {
  // Also report Basic fingerprint periodically (Sprint 2 fallback path).
  maybe_report_basic_fingerprint();

  int16_t temp = read_fake_temperature_c_x100();
  uint16_t rh = read_fake_humidity_pct_x100();

  // Zigbee uses 0.01 units for these clusters.
  esp_zb_zcl_set_attribute_val(SENSOR_ENDPOINT, ZCL_CLUSTER_TEMP_MEASUREMENT,
                              ESP_ZB_ZCL_CLUSTER_SERVER_ROLE, ATTR_MEASURED_VALUE,
                              &temp, false);
  esp_zb_zcl_set_attribute_val(SENSOR_ENDPOINT, ZCL_CLUSTER_RH_MEASUREMENT,
                              ESP_ZB_ZCL_CLUSTER_SERVER_ROLE, ATTR_MEASURED_VALUE,
                              &rh, false);

  report_attr(ZCL_CLUSTER_TEMP_MEASUREMENT, ATTR_MEASURED_VALUE);
  report_attr(ZCL_CLUSTER_RH_MEASUREMENT, ATTR_MEASURED_VALUE);

  Serial.printf("[SENSOR] temp=%d.%02dC rh=%d.%02d%%\n", temp / 100, abs(temp % 100), rh / 100, rh % 100);
}

static void report_timer_cb(TimerHandle_t) {
  update_and_report();
}

// ------------------------
// OTA trigger (Identify)
// ------------------------
static const uint16_t MAGIC_OTA_IDENTIFY_TIME = 0x1234;

#ifndef OTA_URL
#define OTA_URL "http://192.168.1.10:3000/ota/zigbee/zigbee_enddevice_sensor.bin"
#endif

#ifndef OTA_WIFI_SSID
#define OTA_WIFI_SSID "YOUR_WIFI_SSID"
#endif
#ifndef OTA_WIFI_PASS
#define OTA_WIFI_PASS "YOUR_WIFI_PASSWORD"
#endif

#if defined(CONFIG_IDF_TARGET_ESP32C6) || defined(ARDUINO_ESP32C6_DEV) || defined(ARDUINO_ESP32C6)
  #define HAS_WIFI 1
#else
  #define HAS_WIFI 0
#endif

#if HAS_WIFI
#include <WiFi.h>
#include <HTTPClient.h>
#include <Update.h>
#endif

static volatile bool g_ota_pending = false;
static TaskHandle_t g_ota_task = nullptr;

static void ota_task(void*) {
#if !HAS_WIFI
  Serial.println("[OTA] WiFi not supported on this target. Ignored.");
  g_ota_pending = false;
  g_ota_task = nullptr;
  vTaskDelete(nullptr);
  return;
#else
  Serial.println("[OTA] start...");
  WiFi.mode(WIFI_STA);
  WiFi.begin(OTA_WIFI_SSID, OTA_WIFI_PASS);

  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - start) < 15000) {
    delay(200);
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[OTA] WiFi connect failed");
    g_ota_pending = false;
    g_ota_task = nullptr;
    vTaskDelete(nullptr);
    return;
  }

  HTTPClient http;
  http.begin(OTA_URL);
  int code = http.GET();
  if (code != HTTP_CODE_OK) {
    Serial.printf("[OTA] HTTP %d\n", code);
    http.end();
    g_ota_pending = false;
    g_ota_task = nullptr;
    vTaskDelete(nullptr);
    return;
  }

  int len = http.getSize();
  WiFiClient *stream = http.getStreamPtr();
  if (!Update.begin((len > 0) ? (size_t)len : UPDATE_SIZE_UNKNOWN)) {
    Serial.println("[OTA] Update.begin failed");
    http.end();
    g_ota_pending = false;
    g_ota_task = nullptr;
    vTaskDelete(nullptr);
    return;
  }

  size_t written = Update.writeStream(*stream);
  if (!Update.end()) {
    Serial.printf("[OTA] Update.end failed err=%u\n", (unsigned)Update.getError());
    http.end();
    g_ota_pending = false;
    g_ota_task = nullptr;
    vTaskDelete(nullptr);
    return;
  }

  Serial.printf("[OTA] wrote %u bytes, rebooting...\n", (unsigned)written);
  http.end();
  delay(500);
  ESP.restart();
  return;
#endif
}

static void maybe_start_ota() {
  if (!g_ota_pending) return;
  if (g_ota_task != nullptr) return;
  xTaskCreate(ota_task, "ota_task", 8192, nullptr, 1, &g_ota_task);
}

// ------------------------
// Zigbee callbacks
// ------------------------
static void zb_attr_set_cb(const esp_zb_zcl_set_attr_value_message_t *message) {
  if (!message) return;
  if (message->info.cluster == ESP_ZB_ZCL_CLUSTER_ID_IDENTIFY && message->attribute.id == ESP_ZB_ZCL_ATTR_IDENTIFY_IDENTIFY_TIME_ID) {
    uint16_t t = *(uint16_t *)message->attribute.data.value;
    Serial.printf("[ZB] Identify time set = %u\n", (unsigned)t);
    if (t == MAGIC_OTA_IDENTIFY_TIME) {
      Serial.println("[ZB] OTA trigger received");
      g_ota_pending = true;
    }
  }
}

static esp_err_t zb_action_handler(esp_zb_core_action_callback_id_t callback_id, const void *message) {
  switch (callback_id) {
    case ESP_ZB_CORE_SET_ATTR_VALUE_CB_ID:
      zb_attr_set_cb((const esp_zb_zcl_set_attr_value_message_t *)message);
      break;
    default:
      break;
  }
  return ESP_OK;
}

static void zigbee_task(void*) {
  // Platform & NVS
  esp_zb_platform_config_t config = {};
#if defined(ESP_ZB_DEFAULT_RADIO_CONFIG) && defined(ESP_ZB_DEFAULT_HOST_CONFIG)
  config.radio_config = ESP_ZB_DEFAULT_RADIO_CONFIG();
  config.host_config = ESP_ZB_DEFAULT_HOST_CONFIG();
#endif
  esp_zb_platform_config(&config);

  esp_zb_cfg_t zb_nwk_cfg = {};
#if defined(ESP_ZB_ZED_CONFIG)
  zb_nwk_cfg = ESP_ZB_ZED_CONFIG();
#else
  // Fallback: minimal end device config (SDK provides sensible defaults)
  zb_nwk_cfg.esp_zb_role = ESP_ZB_DEVICE_TYPE_END_DEVICE;
  zb_nwk_cfg.install_code_policy = false;
#endif
  esp_zb_init(&zb_nwk_cfg);

  esp_zb_ep_list_t *ep_list = esp_zb_ep_list_create();
  esp_zb_cluster_list_t *cluster_list = esp_zb_zcl_cluster_list_create();

  // Basic + Identify
  esp_zb_cluster_list_add_basic_cluster(cluster_list, nullptr, (uint8_t)ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
  esp_zb_cluster_list_add_identify_cluster(cluster_list, nullptr, (uint8_t)ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

  // Temp/Humidity
  esp_zb_cluster_list_add_temperature_measurement_cluster(cluster_list, nullptr, (uint8_t)ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
  esp_zb_cluster_list_add_relative_humidity_measurement_cluster(cluster_list, nullptr, (uint8_t)ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

  esp_zb_endpoint_config_t endpoint_config = {
      .endpoint = SENSOR_ENDPOINT,
      .app_profile_id = ESP_ZB_HA_PROFILE_ID,
      .app_device_id = ESP_ZB_HA_TEMPERATURE_SENSOR_DEVICE_ID,
      .app_device_version = 0,
  };

  esp_zb_ep_list_add_ep(ep_list, cluster_list, endpoint_config);
  esp_zb_device_register(ep_list);

  // Set Basic fingerprint attributes (manufacturer/model) so the coordinator can identify us.
  set_basic_fingerprint_attributes();

  // Register callback
  esp_zb_core_action_handler_register(zb_action_handler);

  // Start
  esp_zb_set_primary_network_channel_set(ESP_ZB_TRANSCEIVER_ALL_CHANNELS_MASK);
  esp_zb_start(false);

  // Start periodic report timer
  s_report_timer = xTimerCreate("report", pdMS_TO_TICKS(REPORT_INTERVAL_S * 1000), pdTRUE, nullptr, report_timer_cb);
  xTimerStart(s_report_timer, 0);

  // First report quickly
  vTaskDelay(pdMS_TO_TICKS(1000));
  update_and_report();

  while (true) {
    esp_zb_main_loop_iteration();
    maybe_start_ota();
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("[BOOT] Zigbee Sensor");

  xTaskCreate(zigbee_task, "zb_task", 8192, nullptr, 5, nullptr);
}

void loop() {
  delay(1000);
}
