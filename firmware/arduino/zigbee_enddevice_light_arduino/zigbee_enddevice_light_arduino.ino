// Zigbee End Device - Dimmable Light (Arduino IDE)
// Target: ESP32-C6 OR ESP32-H2
//
// Clusters (endpoint 1): Basic, Identify, Groups, Scenes, OnOff, Level
// OTA trigger: Identify command with identify_time == 0x1234
// - ESP32-C6: performs WiFi HTTP OTA using hardcoded SSID/PASS + OTA_URL
// - ESP32-H2: WiFi not supported -> OTA is ignored (still acks Identify)
//
// PWM pins: choose safe defaults (avoid common strapping pins).
// You can override by defining LIGHT_PWM_GPIO in Arduino IDE (Sketch -> Export defines / build flags).
//
// ESP32-C6 default PWM GPIO: 3 (safe vs strapping pins 4,5,8,9,15)
// ESP32-H2 default PWM GPIO: 5 (avoid strapping pins 2,3,8,9,25)

#include <Arduino.h>

#include "esp_zigbee_core.h"
#include "esp_zigbee_zcl_common.h"
#include "esp_zigbee_zcl_command.h"
#include "ha/esp_zigbee_ha_standard.h"

// ------------------------
// Hardware (PWM output)
// ------------------------

#if defined(CONFIG_IDF_TARGET_ESP32C6)
  #ifndef LIGHT_PWM_GPIO
    #define LIGHT_PWM_GPIO 3
  #endif
#elif defined(CONFIG_IDF_TARGET_ESP32H2)
  #ifndef LIGHT_PWM_GPIO
    #define LIGHT_PWM_GPIO 5
  #endif
#else
  // Fallback (unknown target)
  #ifndef LIGHT_PWM_GPIO
    #define LIGHT_PWM_GPIO 3
  #endif
#endif

#ifndef LIGHT_PWM_CHANNEL
#define LIGHT_PWM_CHANNEL 0
#endif
#ifndef LIGHT_PWM_FREQ_HZ
#define LIGHT_PWM_FREQ_HZ 5000
#endif
#ifndef LIGHT_PWM_RES_BITS
#define LIGHT_PWM_RES_BITS 10
#endif

static void pwm_init() {
  ledcSetup(LIGHT_PWM_CHANNEL, LIGHT_PWM_FREQ_HZ, LIGHT_PWM_RES_BITS);
  ledcAttachPin(LIGHT_PWM_GPIO, LIGHT_PWM_CHANNEL);
}

static void pwm_write_level(uint8_t level /*0..254*/) {
  // Zigbee Level cluster uses 0..254
  uint32_t maxv = (1u << LIGHT_PWM_RES_BITS) - 1u;
  uint32_t v = (uint32_t)level * maxv / 254u;
  ledcWrite(LIGHT_PWM_CHANNEL, v);
}

// ------------------------
// OTA over WiFi (ESP32-C6)
// ------------------------

#define OTA_MAGIC_IDENTIFY_TIME 0x1234

#ifndef OTA_URL
// Example: http://<SERVER_IP>:3000/ota/zigbee/zigbee_enddevice_light.bin
#define OTA_URL "http://192.168.1.10:3000/ota/zigbee/zigbee_enddevice_light.bin"
#endif

#ifndef OTA_WIFI_SSID
#define OTA_WIFI_SSID "YourWiFiSSID"
#endif
#ifndef OTA_WIFI_PASS
#define OTA_WIFI_PASS "YourWiFiPASS"
#endif

#if defined(SOC_WIFI_SUPPORTED) || defined(CONFIG_IDF_TARGET_ESP32C6)
  #include <WiFi.h>
  #include <HTTPClient.h>
  #include <Update.h>
  #define HAS_WIFI_OTA 1
#else
  #define HAS_WIFI_OTA 0
#endif

static volatile bool s_ota_requested = false;
static bool s_ota_task_started = false;

#if HAS_WIFI_OTA
static bool ota_http_update(const char *url) {
  WiFi.mode(WIFI_STA);
  WiFi.begin(OTA_WIFI_SSID, OTA_WIFI_PASS);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - start) < 15000) {
    delay(200);
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[OTA] WiFi connect failed");
    return false;
  }

  HTTPClient http;
  WiFiClient client;
  Serial.printf("[OTA] GET %s\n", url);

  if (!http.begin(client, url)) {
    Serial.println("[OTA] http.begin failed");
    return false;
  }

  int code = http.GET();
  if (code != HTTP_CODE_OK) {
    Serial.printf("[OTA] HTTP code %d\n", code);
    http.end();
    return false;
  }

  int len = http.getSize();
  WiFiClient *stream = http.getStreamPtr();
  if (!Update.begin((len > 0) ? (size_t)len : UPDATE_SIZE_UNKNOWN)) {
    Serial.printf("[OTA] Update.begin failed (%s)\n", Update.errorString());
    http.end();
    return false;
  }

  size_t written = Update.writeStream(*stream);
  if (written == 0) {
    Serial.printf("[OTA] Update.writeStream failed (%s)\n", Update.errorString());
    Update.abort();
    http.end();
    return false;
  }

  if (!Update.end()) {
    Serial.printf("[OTA] Update.end failed (%s)\n", Update.errorString());
    http.end();
    return false;
  }

  if (!Update.isFinished()) {
    Serial.println("[OTA] Update not finished");
    http.end();
    return false;
  }

  http.end();
  Serial.println("[OTA] OK, rebooting...");
  delay(300);
  ESP.restart();
  return true;
}

static void ota_task(void *pv) {
  (void)pv;
  // Give Zigbee stack some time to send response/acks.
  delay(800);
  ota_http_update(OTA_URL);
  // If failed, just stop the task.
  s_ota_requested = false;
  s_ota_task_started = false;
  vTaskDelete(NULL);
}
#endif

static void request_ota_if_supported() {
  s_ota_requested = true;
#if HAS_WIFI_OTA
  if (!s_ota_task_started) {
    s_ota_task_started = true;
    xTaskCreate(ota_task, "ota", 8192, NULL, 5, NULL);
  }
#else
  Serial.println("[OTA] Requested but WiFi OTA not supported on this target");
#endif
}

// ------------------------
// Zigbee configuration
// ------------------------

#define LIGHT_ENDPOINT 1

// ------------------------
// Basic cluster fingerprint (Sprint 2 pairing)
// ------------------------
#define ZCL_CLUSTER_BASIC 0x0000
#define ATTR_BASIC_MANUFACTURER_NAME 0x0004
#define ATTR_BASIC_MODEL_IDENTIFIER 0x0005
#define ATTR_BASIC_SW_BUILD_ID 0x4000

static const char* BASIC_MANUFACTURER = "SmartHome";
static const char* BASIC_MODEL = "LIGHT_V1";
static const char* BASIC_SW_BUILD_ID_STR = "1.0.0";

static uint8_t s_basic_manufacturer_str[1 + 32];
static uint8_t s_basic_model_str[1 + 32];
static uint8_t s_basic_sw_build_str[1 + 32];

static bool s_fp_sent_once = false;
static uint32_t s_last_fp_ms = 0;

static void fill_zcl_str(uint8_t* out, size_t outLen, const char* s) {
  if (!out || outLen < 2) return;
  size_t n = s ? strlen(s) : 0;
  if (n > outLen - 1) n = outLen - 1;
  out[0] = (uint8_t)n;
  if (n) memcpy(out + 1, s, n);
}

static void set_basic_fingerprint_attributes() {
  fill_zcl_str(s_basic_manufacturer_str, sizeof(s_basic_manufacturer_str), BASIC_MANUFACTURER);
  fill_zcl_str(s_basic_model_str, sizeof(s_basic_model_str), BASIC_MODEL);
  fill_zcl_str(s_basic_sw_build_str, sizeof(s_basic_sw_build_str), BASIC_SW_BUILD_ID_STR);

  esp_zb_zcl_set_attribute_val(LIGHT_ENDPOINT, ZCL_CLUSTER_BASIC, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
                               ATTR_BASIC_MANUFACTURER_NAME, s_basic_manufacturer_str, false);
  esp_zb_zcl_set_attribute_val(LIGHT_ENDPOINT, ZCL_CLUSTER_BASIC, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
                               ATTR_BASIC_MODEL_IDENTIFIER, s_basic_model_str, false);
  esp_zb_zcl_set_attribute_val(LIGHT_ENDPOINT, ZCL_CLUSTER_BASIC, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
                               ATTR_BASIC_SW_BUILD_ID, s_basic_sw_build_str, false);
}

static void report_attr(uint16_t cluster_id, uint16_t attr_id) {
  esp_zb_zcl_report_attr_cmd_req_t req = {};
  req.address_mode = ESP_ZB_APS_ADDR_MODE_DST_ADDR_ENDP_NOT_PRESENT;
  req.zcl_basic_cmd.src_endpoint = LIGHT_ENDPOINT;
  req.zcl_basic_cmd.cluster_id = cluster_id;
  req.attribute_id = attr_id;
  req.cluster_role = ESP_ZB_ZCL_CLUSTER_SERVER_ROLE;
  esp_zb_zcl_report_attr_cmd_req(&req);
}

static void maybe_report_basic_fingerprint() {
  const uint32_t now = millis();
  if (!s_fp_sent_once || (now - s_last_fp_ms) > 60000) {
    report_attr(ZCL_CLUSTER_BASIC, ATTR_BASIC_MANUFACTURER_NAME);
    report_attr(ZCL_CLUSTER_BASIC, ATTR_BASIC_MODEL_IDENTIFIER);
    report_attr(ZCL_CLUSTER_BASIC, ATTR_BASIC_SW_BUILD_ID);
    s_fp_sent_once = true;
    s_last_fp_ms = now;
  }
}

static esp_zb_ha_dimmable_light_cfg_t s_light_cfg = {
    .basic_cfg =
        {
            .zcl_version = ESP_ZB_ZCL_BASIC_ZCL_VERSION_DEFAULT_VALUE,
            .power_source = ESP_ZB_ZCL_BASIC_POWER_SOURCE_DEFAULT_VALUE,
        },
    .identify_cfg =
        {
            .identify_time = 0,
        },
    .on_off_cfg =
        {
            .on_off = ESP_ZB_ZCL_ON_OFF_ON_OFF_DEFAULT_VALUE,
        },
    .level_cfg =
        {
            .current_level = 0x80,
        },
};

static void apply_output(bool on, uint8_t level) {
  if (!on) {
    pwm_write_level(0);
    return;
  }
  pwm_write_level(level);
}

static void set_attr_value_cb(const esp_zb_zcl_set_attr_value_message_t *message) {
  if (!message || message->info.status != ESP_ZB_ZCL_STATUS_SUCCESS) return;

  const uint16_t cluster_id = message->info.cluster;
  const uint16_t attr_id = message->attribute.id;

  if (cluster_id == ESP_ZB_ZCL_CLUSTER_ID_ON_OFF && attr_id == ESP_ZB_ZCL_ATTR_ON_OFF_ON_OFF_ID) {
    bool on = *(bool *)message->attribute.data.value;
    Serial.printf("[ZB] onoff=%d\n", (int)on);

    // Read current level from our config (best-effort)
    uint8_t level = s_light_cfg.level_cfg.current_level;
    apply_output(on, level);
  }

  if (cluster_id == ESP_ZB_ZCL_CLUSTER_ID_LEVEL_CONTROL &&
      attr_id == ESP_ZB_ZCL_ATTR_LEVEL_CONTROL_CURRENT_LEVEL_ID) {
    uint8_t level = *(uint8_t *)message->attribute.data.value;
    Serial.printf("[ZB] level=%u\n", (unsigned)level);

    // Read on/off from our config (best-effort)
    bool on = s_light_cfg.on_off_cfg.on_off;
    apply_output(on, level);
  }

  // OTA trigger via Identify
  if (cluster_id == ESP_ZB_ZCL_CLUSTER_ID_IDENTIFY && attr_id == 0x0000 /*identify_time*/) {
    uint16_t t = *(uint16_t *)message->attribute.data.value;
    Serial.printf("[ZB] identify_time=%u\n", (unsigned)t);
    if (t == OTA_MAGIC_IDENTIFY_TIME) {
      request_ota_if_supported();
    }
  }
}

static esp_err_t zb_action_handler(esp_zb_core_action_callback_id_t callback_id, const void *message) {
  switch (callback_id) {
  case ESP_ZB_CORE_SET_ATTR_VALUE_CB_ID:
    set_attr_value_cb((const esp_zb_zcl_set_attr_value_message_t *)message);
    return ESP_OK;
  default:
    return ESP_OK;
  }
}

static void zigbee_task(void *pvParameters) {
  (void)pvParameters;

  esp_zb_platform_config_t platform_cfg = {};
#if defined(ESP_ZB_DEFAULT_RADIO_CONFIG) && defined(ESP_ZB_DEFAULT_HOST_CONFIG)
  platform_cfg.radio_config = ESP_ZB_DEFAULT_RADIO_CONFIG();
  platform_cfg.host_config = ESP_ZB_DEFAULT_HOST_CONFIG();
#endif
  ESP_ERROR_CHECK(esp_zb_platform_config(&platform_cfg));

  esp_zb_cfg_t zb_nwk_cfg = {};
#if defined(ESP_ZB_ZED_CONFIG)
  zb_nwk_cfg = ESP_ZB_ZED_CONFIG();
#else
  zb_nwk_cfg.esp_zb_role = ESP_ZB_DEVICE_TYPE_END_DEVICE;
  zb_nwk_cfg.install_code_policy = false;
#endif
  esp_zb_init(&zb_nwk_cfg);

  esp_zb_ep_list_t *ep_list = esp_zb_ha_dimmable_light_ep_create(LIGHT_ENDPOINT, &s_light_cfg);
  ESP_ERROR_CHECK(esp_zb_device_register(ep_list));

  // Set Basic fingerprint attributes (manufacturer/model) so the coordinator can identify us.
  set_basic_fingerprint_attributes();

  esp_zb_core_action_handler_register(zb_action_handler);

  Serial.println("[ZB] Starting dimmable light end device...");
  esp_zb_start(false);

  while (true) {
    esp_zb_main_loop_iteration();
    // OTA request is handled by a separate task
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);

  Serial.printf("[BOOT] Zigbee Dimmable Light (PWM GPIO=%d)\n", (int)LIGHT_PWM_GPIO);
  pwm_init();
  apply_output(false, 0);

  xTaskCreate(zigbee_task, "zb_task", 8192, NULL, 5, NULL);
}

void loop() {
  // Zigbee runs in its own task
  maybe_report_basic_fingerprint();
  delay(1000);
}
