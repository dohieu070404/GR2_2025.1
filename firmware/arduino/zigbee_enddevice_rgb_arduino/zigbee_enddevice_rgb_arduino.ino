// Zigbee End Device - RGB Light (Arduino IDE)
// Target: ESP32-C6 OR ESP32-H2
//
// Endpoint 1 (HA): Basic, Identify, Groups, Scenes, OnOff, Level, Color Control
// Control model:
// - OnOff (0x0006) -> on/off
// - Level (0x0008) -> brightness
// - Color Control (0x0300) -> hue + saturation (HSV)
//
// OTA trigger: Identify command with identify_time == 0x1234
// - ESP32-C6: WiFi HTTP OTA (hardcoded SSID/PASS + OTA_URL)
// - ESP32-H2: WiFi not supported -> ignored
//
// PWM pins: safe defaults (avoid common strapping pins)
// - ESP32-C6: R=2, G=3, B=6  (avoid strapping pins 4,5,8,9,15)
// - ESP32-H2: R=4, G=5, B=10 (avoid strapping pins 2,3,8,9,25)
// Override by defining RGB_R_GPIO / RGB_G_GPIO / RGB_B_GPIO

#include <Arduino.h>

#include "esp_zigbee_core.h"
#include "esp_zigbee_zcl_common.h"
#include "esp_zigbee_zcl_command.h"

// ------------------------
// Target-specific pins
// ------------------------
#if defined(CONFIG_IDF_TARGET_ESP32H2)
  #ifndef RGB_R_GPIO
  #define RGB_R_GPIO 4
  #endif
  #ifndef RGB_G_GPIO
  #define RGB_G_GPIO 5
  #endif
  #ifndef RGB_B_GPIO
  #define RGB_B_GPIO 10
  #endif
#elif defined(CONFIG_IDF_TARGET_ESP32C6)
  #ifndef RGB_R_GPIO
  #define RGB_R_GPIO 2
  #endif
  #ifndef RGB_G_GPIO
  #define RGB_G_GPIO 3
  #endif
  #ifndef RGB_B_GPIO
  #define RGB_B_GPIO 6
  #endif
#else
  // Fallback for other ESP32 targets
  #ifndef RGB_R_GPIO
  #define RGB_R_GPIO 25
  #endif
  #ifndef RGB_G_GPIO
  #define RGB_G_GPIO 26
  #endif
  #ifndef RGB_B_GPIO
  #define RGB_B_GPIO 27
  #endif
#endif

// LEDC
#ifndef LEDC_FREQ_HZ
#define LEDC_FREQ_HZ 5000
#endif
#ifndef LEDC_RES_BITS
#define LEDC_RES_BITS 8
#endif

// ------------------------
// Zigbee constants
// ------------------------
#define ZB_ENDPOINT 1

// ------------------------
// Basic cluster fingerprint (Sprint 2 pairing)
// ------------------------
#define ZCL_CLUSTER_BASIC 0x0000
#define ATTR_BASIC_MANUFACTURER_NAME 0x0004
#define ATTR_BASIC_MODEL_IDENTIFIER 0x0005
#define ATTR_BASIC_SW_BUILD_ID 0x4000

static const char* BASIC_MANUFACTURER = "SmartHome";
static const char* BASIC_MODEL = "RGB_V1";
static const char* BASIC_SW_BUILD_ID_STR = "1.0.0";

static uint8_t g_basic_manuf[33];
static uint8_t g_basic_model[33];
static uint8_t g_basic_swbuild[33];

static bool g_fp_sent_once = false;
static uint32_t g_fp_last_ms = 0;

static void fill_zcl_str(uint8_t* buf, size_t buf_size, const char* s) {
  if (!buf || buf_size < 2) return;
  if (!s) s = "";
  size_t n = strlen(s);
  if (n > buf_size - 1) n = buf_size - 1;
  buf[0] = (uint8_t)n;
  memcpy(buf + 1, s, n);
  if (1 + n < buf_size) buf[1 + n] = 0;
}

static void set_basic_fingerprint_attributes() {
  fill_zcl_str(g_basic_manuf, sizeof(g_basic_manuf), BASIC_MANUFACTURER);
  fill_zcl_str(g_basic_model, sizeof(g_basic_model), BASIC_MODEL);
  fill_zcl_str(g_basic_swbuild, sizeof(g_basic_swbuild), BASIC_SW_BUILD_ID_STR);

  esp_zb_zcl_set_attribute_val(ZB_ENDPOINT, ZCL_CLUSTER_BASIC, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
                               ATTR_BASIC_MANUFACTURER_NAME, g_basic_manuf, false);
  esp_zb_zcl_set_attribute_val(ZB_ENDPOINT, ZCL_CLUSTER_BASIC, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
                               ATTR_BASIC_MODEL_IDENTIFIER, g_basic_model, false);
  esp_zb_zcl_set_attribute_val(ZB_ENDPOINT, ZCL_CLUSTER_BASIC, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
                               ATTR_BASIC_SW_BUILD_ID, g_basic_swbuild, false);
}

static void report_attr(uint16_t cluster_id, uint16_t attr_id);

static void maybe_report_basic_fingerprint() {
  const uint32_t now = millis();
  if (!g_fp_sent_once || (now - g_fp_last_ms) > 60000UL) {
    report_attr(ZCL_CLUSTER_BASIC, ATTR_BASIC_MANUFACTURER_NAME);
    report_attr(ZCL_CLUSTER_BASIC, ATTR_BASIC_MODEL_IDENTIFIER);
    report_attr(ZCL_CLUSTER_BASIC, ATTR_BASIC_SW_BUILD_ID);
    g_fp_sent_once = true;
    g_fp_last_ms = now;
  }
}
#define ZCL_CLUSTER_ONOFF          0x0006
#define ZCL_CLUSTER_LEVEL          0x0008
#define ZCL_CLUSTER_COLOR_CONTROL  0x0300
#define ZCL_CLUSTER_IDENTIFY       0x0003

#define ATTR_ONOFF                 0x0000
#define ATTR_CURRENT_LEVEL         0x0000
#define ATTR_CURRENT_HUE           0x0000
#define ATTR_CURRENT_SAT           0x0001
#define ATTR_IDENTIFY_TIME         0x0000

#ifndef ESP_ZB_HA_COLOR_DIMMABLE_LIGHT_DEVICE_ID
#define ESP_ZB_HA_COLOR_DIMMABLE_LIGHT_DEVICE_ID 0x0102
#endif

static uint8_t g_on = 0;
static uint8_t g_level = 0x80; // 0..254
static uint8_t g_hue = 0;
static uint8_t g_sat = 0;

// OTA trigger
static const uint16_t OTA_MAGIC_IDENTIFY_TIME = 0x1234;

// ------------------------
// WiFi OTA (C6 only)
// ------------------------
#if defined(CONFIG_IDF_TARGET_ESP32C6)
  #include <WiFi.h>
  #include <HTTPClient.h>
  #include <Update.h>
  #define HAS_WIFI 1
#else
  #define HAS_WIFI 0
#endif

#ifndef WIFI_SSID
#define WIFI_SSID "YOUR_WIFI_SSID"
#endif
#ifndef WIFI_PASS
#define WIFI_PASS "YOUR_WIFI_PASS"
#endif
#ifndef OTA_URL
// Must be directly downloadable .bin (served by backend /ota/...)
#define OTA_URL "http://192.168.1.10:3000/ota/zigbee/zigbee_enddevice_rgb.bin"
#endif

static TaskHandle_t s_ota_task = NULL;

static bool ota_http_update(const char *url) {
#if !HAS_WIFI
  (void)url;
  Serial.println("[OTA] WiFi not supported on this target.");
  return false;
#else
  Serial.printf("[OTA] Connecting WiFi SSID=%s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000) {
    delay(200);
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[OTA] WiFi connect timeout");
    return false;
  }

  HTTPClient http;
  http.begin(url);
  int code = http.GET();
  if (code != HTTP_CODE_OK) {
    Serial.printf("[OTA] HTTP GET failed: %d\n", code);
    http.end();
    return false;
  }

  int len = http.getSize();
  WiFiClient *stream = http.getStreamPtr();
  if (!Update.begin(len > 0 ? (size_t)len : UPDATE_SIZE_UNKNOWN)) {
    Serial.println("[OTA] Update.begin failed");
    http.end();
    return false;
  }

  size_t written = Update.writeStream(*stream);
  if (len > 0 && (int)written != len) {
    Serial.printf("[OTA] written %u != len %d\n", (unsigned)written, len);
  }

  if (!Update.end(true)) {
    Serial.printf("[OTA] Update.end failed: %s\n", Update.errorString());
    http.end();
    return false;
  }

  http.end();
  Serial.println("[OTA] OK, rebooting...");
  delay(400);
  ESP.restart();
  return true;
#endif
}

static void ota_task(void *pv) {
  (void)pv;
  ota_http_update(OTA_URL);
  s_ota_task = NULL;
  vTaskDelete(NULL);
}

static void request_ota() {
  if (s_ota_task) return;
  Serial.printf("[OTA] requested url=%s\n", OTA_URL);
  xTaskCreate(ota_task, "ota", 8192, NULL, 3, &s_ota_task);
}

// ------------------------
// PWM helper
// ------------------------
static void pwm_setup() {
  ledcSetup(0, LEDC_FREQ_HZ, LEDC_RES_BITS);
  ledcSetup(1, LEDC_FREQ_HZ, LEDC_RES_BITS);
  ledcSetup(2, LEDC_FREQ_HZ, LEDC_RES_BITS);
  ledcAttachPin(RGB_R_GPIO, 0);
  ledcAttachPin(RGB_G_GPIO, 1);
  ledcAttachPin(RGB_B_GPIO, 2);
}

static void hsv_to_rgb(uint8_t hue, uint8_t sat, uint8_t val, uint8_t &r, uint8_t &g, uint8_t &b) {
  // hue: 0..254, sat/val: 0..254
  float H = (float)hue * (360.0f / 254.0f);
  float S = (float)sat / 254.0f;
  float V = (float)val / 254.0f;

  float C = V * S;
  float X = C * (1.0f - fabsf(fmodf(H / 60.0f, 2.0f) - 1.0f));
  float m = V - C;

  float r1 = 0, g1 = 0, b1 = 0;
  if (H < 60)      { r1 = C; g1 = X; b1 = 0; }
  else if (H < 120){ r1 = X; g1 = C; b1 = 0; }
  else if (H < 180){ r1 = 0; g1 = C; b1 = X; }
  else if (H < 240){ r1 = 0; g1 = X; b1 = C; }
  else if (H < 300){ r1 = X; g1 = 0; b1 = C; }
  else             { r1 = C; g1 = 0; b1 = X; }

  r = (uint8_t)((r1 + m) * 255.0f);
  g = (uint8_t)((g1 + m) * 255.0f);
  b = (uint8_t)((b1 + m) * 255.0f);
}

static void apply_output() {
  uint8_t val = g_on ? g_level : 0;
  uint8_t r, g, b;
  hsv_to_rgb(g_hue, g_sat, val, r, g, b);
  ledcWrite(0, r);
  ledcWrite(1, g);
  ledcWrite(2, b);
  Serial.printf("[OUT] on=%u level=%u hue=%u sat=%u -> rgb(%u,%u,%u)\n", g_on, g_level, g_hue, g_sat, r, g, b);
}

// ------------------------
// Zigbee reporting helper
// ------------------------
static void report_attr(uint16_t cluster_id, uint16_t attr_id) {
  esp_zb_zcl_report_attr_cmd_req_t req = {};
  req.address_mode = ESP_ZB_APS_ADDR_MODE_DST_ADDR_ENDP_NOT_PRESENT;
  req.zcl_basic_cmd.src_endpoint = ZB_ENDPOINT;
  req.zcl_basic_cmd.cluster_id = cluster_id;
  req.attribute_id = attr_id;
  esp_zb_zcl_report_attr_cmd_req(&req);
}

// ------------------------
// Zigbee action handler
// ------------------------
static esp_err_t set_attr_value_cb(const esp_zb_zcl_set_attr_value_message_t *m) {
  if (!m) return ESP_FAIL;
  const uint16_t cluster = m->info.cluster;
  const uint16_t attr = m->attribute.id;

  if (cluster == ZCL_CLUSTER_ONOFF && attr == ATTR_ONOFF) {
    uint8_t v = *(uint8_t *)m->attribute.data.value;
    g_on = v ? 1 : 0;
    apply_output();
    report_attr(ZCL_CLUSTER_ONOFF, ATTR_ONOFF);
    return ESP_OK;
  }
  if (cluster == ZCL_CLUSTER_LEVEL && attr == ATTR_CURRENT_LEVEL) {
    uint8_t v = *(uint8_t *)m->attribute.data.value;
    g_level = v;
    apply_output();
    report_attr(ZCL_CLUSTER_LEVEL, ATTR_CURRENT_LEVEL);
    return ESP_OK;
  }
  if (cluster == ZCL_CLUSTER_COLOR_CONTROL && (attr == ATTR_CURRENT_HUE || attr == ATTR_CURRENT_SAT)) {
    uint8_t v = *(uint8_t *)m->attribute.data.value;
    if (attr == ATTR_CURRENT_HUE) g_hue = v;
    if (attr == ATTR_CURRENT_SAT) g_sat = v;
    apply_output();
    report_attr(ZCL_CLUSTER_COLOR_CONTROL, attr);
    return ESP_OK;
  }
  if (cluster == ZCL_CLUSTER_IDENTIFY && attr == ATTR_IDENTIFY_TIME) {
    uint16_t t = *(uint16_t *)m->attribute.data.value;
    Serial.printf("[IDENTIFY] identify_time=%u\n", (unsigned)t);
    if (t == OTA_MAGIC_IDENTIFY_TIME) {
      request_ota();
    }
    return ESP_OK;
  }
  return ESP_OK;
}

static esp_err_t zb_action_handler(esp_zb_core_action_callback_id_t callback_id, const void *message) {
  switch (callback_id) {
    case ESP_ZB_CORE_SET_ATTR_VALUE_CB_ID:
      return set_attr_value_cb((const esp_zb_zcl_set_attr_value_message_t *)message);
    default:
      return ESP_OK;
  }
}

// ------------------------
// Zigbee task
// ------------------------
static void zigbee_task(void *pv) {
  (void)pv;

  esp_zb_platform_config_t platform_cfg = {};
#if defined(ESP_ZB_DEFAULT_RADIO_CONFIG) && defined(ESP_ZB_DEFAULT_HOST_CONFIG)
  platform_cfg.radio_config = ESP_ZB_DEFAULT_RADIO_CONFIG();
  platform_cfg.host_config = ESP_ZB_DEFAULT_HOST_CONFIG();
#endif
  esp_zb_platform_config(&platform_cfg);

  esp_zb_cfg_t zb_nwk_cfg = {};
#if defined(ESP_ZB_ZED_CONFIG)
  zb_nwk_cfg = ESP_ZB_ZED_CONFIG();
#else
  zb_nwk_cfg.esp_zb_role = ESP_ZB_DEVICE_TYPE_END_DEVICE;
  zb_nwk_cfg.install_code_policy = false;
#endif
  esp_zb_init(&zb_nwk_cfg);

  // Endpoint cluster list
  esp_zb_ep_list_t *ep_list = esp_zb_ep_list_create();
  esp_zb_cluster_list_t *cluster_list = esp_zb_zcl_cluster_list_create();

  // Signature (SDK >= 1.6): add_*_cluster(cluster_list, attr_list, role_mask)
  esp_zb_cluster_list_add_basic_cluster(cluster_list, nullptr, (uint8_t)ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
  esp_zb_cluster_list_add_identify_cluster(cluster_list, nullptr, (uint8_t)ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
  esp_zb_cluster_list_add_groups_cluster(cluster_list, nullptr, (uint8_t)ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
  esp_zb_cluster_list_add_scenes_cluster(cluster_list, nullptr, (uint8_t)ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
  esp_zb_cluster_list_add_on_off_cluster(cluster_list, nullptr, (uint8_t)ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
  esp_zb_cluster_list_add_level_cluster(cluster_list, nullptr, (uint8_t)ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
  esp_zb_cluster_list_add_color_control_cluster(cluster_list, nullptr, (uint8_t)ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

  esp_zb_endpoint_config_t ep_cfg = {
      .endpoint = ZB_ENDPOINT,
      .app_profile_id = ESP_ZB_AF_HA_PROFILE_ID,
      .app_device_id = ESP_ZB_HA_COLOR_DIMMABLE_LIGHT_DEVICE_ID,
      .app_device_version = 0,
  };
  esp_zb_ep_list_add_ep(ep_list, cluster_list, ep_cfg);
  esp_zb_device_register(ep_list);

  // Set Basic fingerprint attributes (manufacturer/model) so the coordinator can identify us.
  set_basic_fingerprint_attributes();

  // Action handler
  esp_zb_core_action_handler_register(zb_action_handler);

  Serial.println("[ZB] starting Zigbee end device (RGB)...");
  esp_zb_start(false);

  while (true) {
    esp_zb_main_loop_iteration();
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);

  Serial.printf("[BOOT] Zigbee RGB Light (R=%d G=%d B=%d)\n", (int)RGB_R_GPIO, (int)RGB_G_GPIO, (int)RGB_B_GPIO);
  pwm_setup();
  apply_output();

  xTaskCreate(zigbee_task, "zb_task", 8192, NULL, 5, NULL);
}

void loop() {
  // Periodically report fingerprint so the hub can suggest a ProductModel during pairing.
  maybe_report_basic_fingerprint();
  delay(1000);
}
