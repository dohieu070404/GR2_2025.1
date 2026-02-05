// ESP32-C6 Zigbee End Device - ServoGate + PIR + Light (Sprint 4)
// ModelId / Zigbee Basic model identifier: GATE_PIR_V1
//
// Endpoint 1:
// - Basic (server) + Identify (server)
// - On/Off (server)   => Gate open/close (On=open)
// - Level (server)    => Light level (0..254) (we treat >0 as ON)
// - Occupancy Sensing (server) => PIR motion (occupancy=1 pulse)
//
// Endpoint 2:
// - Level (server) => light timeout seconds (0..255). This endpoint is used ONLY for config.
//
// Local rules:
// - PIR rising edge -> light ON -> auto OFF after timeoutSec (extend on new motion)
// - Button press -> gate.close

#include <Arduino.h>

#include "esp_zigbee_core.h"
#include "esp_zigbee_zcl_common.h"
#include "esp_zigbee_zcl_command.h"
#include "ha/esp_zigbee_ha_standard.h"

// ------------------------
// GPIO defaults (override by defining macros before compile)
// ------------------------
#ifndef SERVO_GPIO
#define SERVO_GPIO 2
#endif
#ifndef LIGHT_GPIO
#define LIGHT_GPIO 3
#endif
#ifndef PIR_GPIO
#define PIR_GPIO 6
#endif
#ifndef BUTTON_GPIO
#define BUTTON_GPIO 7
#endif

// ------------------------
// Zigbee endpoints
// ------------------------
#define EP_MAIN 1
#define EP_CFG 2

// Cluster IDs not exposed in some Arduino builds
#ifndef ZCL_CLUSTER_BASIC
#define ZCL_CLUSTER_BASIC 0x0000
#endif
#ifndef ZCL_CLUSTER_IDENTIFY
#define ZCL_CLUSTER_IDENTIFY 0x0003
#endif
#ifndef ZCL_CLUSTER_ONOFF
#define ZCL_CLUSTER_ONOFF 0x0006
#endif
#ifndef ZCL_CLUSTER_LEVEL
#define ZCL_CLUSTER_LEVEL 0x0008
#endif
#ifndef ZCL_CLUSTER_OCCUPANCY
#define ZCL_CLUSTER_OCCUPANCY 0x0406
#endif

#ifndef ATTR_BASIC_MANUFACTURER_NAME
#define ATTR_BASIC_MANUFACTURER_NAME 0x0004
#endif
#ifndef ATTR_BASIC_MODEL_IDENTIFIER
#define ATTR_BASIC_MODEL_IDENTIFIER 0x0005
#endif
#ifndef ATTR_BASIC_SW_BUILD_ID
#define ATTR_BASIC_SW_BUILD_ID 0x4000
#endif

#ifndef ATTR_ONOFF
#define ATTR_ONOFF 0x0000
#endif

#ifndef ATTR_CURRENT_LEVEL
#define ATTR_CURRENT_LEVEL 0x0000
#endif

#ifndef ATTR_OCCUPANCY
#define ATTR_OCCUPANCY 0x0000
#endif

#ifndef ESP_ZB_ZCL_ATTR_TYPE_CHAR_STRING
#define ESP_ZB_ZCL_ATTR_TYPE_CHAR_STRING 0x42
#endif

// ------------------------
// Fingerprint (pairing)
// ------------------------
static const char *BASIC_MANUFACTURER = "SmartHome";
static const char *BASIC_MODEL = "GATE_PIR_V1";
static const char *BASIC_SW_BUILD = "1.0.0";

static uint8_t s_basic_manuf_str[1 + 32];
static uint8_t s_basic_model_str[1 + 32];
static uint8_t s_basic_sw_str[1 + 32];
static bool s_fp_sent_once = false;
static uint32_t s_last_fp_ms = 0;

static void fill_zcl_str(uint8_t *out, size_t outLen, const char *s) {
  if (!out || outLen < 2) return;
  size_t n = s ? strlen(s) : 0;
  if (n > outLen - 1) n = outLen - 1;
  out[0] = (uint8_t)n;
  if (n) memcpy(out + 1, s, n);
}

static void set_basic_fingerprint_attributes() {
  fill_zcl_str(s_basic_manuf_str, sizeof(s_basic_manuf_str), BASIC_MANUFACTURER);
  fill_zcl_str(s_basic_model_str, sizeof(s_basic_model_str), BASIC_MODEL);
  fill_zcl_str(s_basic_sw_str, sizeof(s_basic_sw_str), BASIC_SW_BUILD);

  esp_zb_zcl_set_attribute_val(EP_MAIN, ZCL_CLUSTER_BASIC, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
                               ATTR_BASIC_MANUFACTURER_NAME, s_basic_manuf_str, false);
  esp_zb_zcl_set_attribute_val(EP_MAIN, ZCL_CLUSTER_BASIC, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
                               ATTR_BASIC_MODEL_IDENTIFIER, s_basic_model_str, false);
  esp_zb_zcl_set_attribute_val(EP_MAIN, ZCL_CLUSTER_BASIC, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
                               ATTR_BASIC_SW_BUILD_ID, s_basic_sw_str, false);
}

static void report_attr(uint8_t endpoint, uint16_t cluster_id, uint16_t attr_id) {
  esp_zb_zcl_report_attr_cmd_req_t req = {};
  req.address_mode = ESP_ZB_APS_ADDR_MODE_DST_ADDR_ENDP_NOT_PRESENT;
  req.zcl_basic_cmd.src_endpoint = endpoint;
  req.zcl_basic_cmd.cluster_id = cluster_id;
  req.attribute_id = attr_id;
  req.cluster_role = ESP_ZB_ZCL_CLUSTER_SERVER_ROLE;
  esp_zb_zcl_report_attr_cmd_req(&req);
}

static void maybe_report_basic_fingerprint() {
  const uint32_t now = millis();
  if (!s_fp_sent_once || (now - s_last_fp_ms) > 60000) {
    report_attr(EP_MAIN, ZCL_CLUSTER_BASIC, ATTR_BASIC_MANUFACTURER_NAME);
    report_attr(EP_MAIN, ZCL_CLUSTER_BASIC, ATTR_BASIC_MODEL_IDENTIFIER);
    report_attr(EP_MAIN, ZCL_CLUSTER_BASIC, ATTR_BASIC_SW_BUILD_ID);
    s_fp_sent_once = true;
    s_last_fp_ms = now;
  }
}

// ------------------------
// Hardware: Servo (LEDC 50Hz)
// ------------------------
#ifndef SERVO_OPEN_ANGLE
#define SERVO_OPEN_ANGLE 90
#endif
#ifndef SERVO_CLOSE_ANGLE
#define SERVO_CLOSE_ANGLE 0
#endif

#ifndef SERVO_MIN_US
#define SERVO_MIN_US 500
#endif
#ifndef SERVO_MAX_US
#define SERVO_MAX_US 2500
#endif

#ifndef SERVO_PWM_CH
#define SERVO_PWM_CH 1
#endif

static void servo_init() {
  ledcSetup(SERVO_PWM_CH, 50 /*Hz*/, 16 /*bits*/);
  ledcAttachPin(SERVO_GPIO, SERVO_PWM_CH);
}

static void servo_write_angle(int angle) {
  if (angle < 0) angle = 0;
  if (angle > 180) angle = 180;
  const int pulse = SERVO_MIN_US + (SERVO_MAX_US - SERVO_MIN_US) * angle / 180;
  const uint32_t maxDuty = (1u << 16) - 1u;
  // 50Hz => 20,000us period
  const uint32_t duty = (uint32_t)pulse * maxDuty / 20000u;
  ledcWrite(SERVO_PWM_CH, duty);
}

// ------------------------
// Hardware: Light + inputs
// ------------------------
static void light_init() {
  pinMode(LIGHT_GPIO, OUTPUT);
  digitalWrite(LIGHT_GPIO, LOW);
}

static void light_apply_level(uint8_t level) {
  digitalWrite(LIGHT_GPIO, level > 0 ? HIGH : LOW);
}

static void inputs_init() {
  pinMode(PIR_GPIO, INPUT);
  pinMode(BUTTON_GPIO, INPUT_PULLUP);
}

// ------------------------
// State
// ------------------------
static bool s_gate_open = false;
static uint8_t s_light_level = 0; // 0..254
static uint8_t s_timeout_sec = 20;

static uint32_t s_light_off_due_ms = 0;
static bool s_pir_prev = false;
static bool s_btn_prev = true;
static uint32_t s_btn_last_ms = 0;

static void gate_apply(bool open) {
  s_gate_open = open;
  servo_write_angle(open ? SERVO_OPEN_ANGLE : SERVO_CLOSE_ANGLE);
}

static void zb_set_gate_open(bool open, bool report) {
  uint8_t v = open ? 1 : 0;
  esp_zb_zcl_set_attribute_val(EP_MAIN, ZCL_CLUSTER_ONOFF, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
                               ATTR_ONOFF, &v, false);
  if (report) report_attr(EP_MAIN, ZCL_CLUSTER_ONOFF, ATTR_ONOFF);
}

static void zb_set_light_level(uint8_t level, bool report) {
  if (level > 254) level = 254;
  s_light_level = level;
  esp_zb_zcl_set_attribute_val(EP_MAIN, ZCL_CLUSTER_LEVEL, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
                               ATTR_CURRENT_LEVEL, &level, false);
  if (report) report_attr(EP_MAIN, ZCL_CLUSTER_LEVEL, ATTR_CURRENT_LEVEL);
}

static void zb_set_timeout_sec(uint8_t sec, bool report) {
  s_timeout_sec = sec;
  esp_zb_zcl_set_attribute_val(EP_CFG, ZCL_CLUSTER_LEVEL, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
                               ATTR_CURRENT_LEVEL, &sec, false);
  if (report) report_attr(EP_CFG, ZCL_CLUSTER_LEVEL, ATTR_CURRENT_LEVEL);
}

static void zb_pulse_motion_report() {
  // occupancy=1 then occupancy=0 (best-effort)
  uint8_t occ = 1;
  esp_zb_zcl_set_attribute_val(EP_MAIN, ZCL_CLUSTER_OCCUPANCY, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
                               ATTR_OCCUPANCY, &occ, false);
  report_attr(EP_MAIN, ZCL_CLUSTER_OCCUPANCY, ATTR_OCCUPANCY);

  occ = 0;
  esp_zb_zcl_set_attribute_val(EP_MAIN, ZCL_CLUSTER_OCCUPANCY, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
                               ATTR_OCCUPANCY, &occ, false);
  // Do NOT spam too much; still report the falling edge to keep the coordinator state consistent.
  report_attr(EP_MAIN, ZCL_CLUSTER_OCCUPANCY, ATTR_OCCUPANCY);
}

static void on_motion_detected() {
  Serial.printf("[PIR] motion detected (timeoutSec=%u)\n", (unsigned)s_timeout_sec);

  // Motion event
  zb_pulse_motion_report();

  // Turn light ON and extend timer
  zb_set_light_level(254, true);
  light_apply_level(254);
  s_light_off_due_ms = millis() + (uint32_t)s_timeout_sec * 1000u;
}

static void maybe_light_auto_off() {
  if (s_light_off_due_ms == 0) return;
  if ((int32_t)(millis() - s_light_off_due_ms) < 0) return;
  s_light_off_due_ms = 0;

  Serial.println("[LIGHT] timeout -> OFF");
  zb_set_light_level(0, true);
  light_apply_level(0);
}

static void poll_inputs() {
  const bool pir = digitalRead(PIR_GPIO) ? true : false;
  if (pir && !s_pir_prev) {
    on_motion_detected();
  }
  s_pir_prev = pir;

  // Debounced button (active low)
  const bool btn = digitalRead(BUTTON_GPIO) ? true : false;
  const uint32_t now = millis();
  if (btn != s_btn_prev) {
    s_btn_prev = btn;
    s_btn_last_ms = now;
  }
  if (!btn && (now - s_btn_last_ms) > 40) {
    // pressed
    Serial.println("[BTN] close gate");
    gate_apply(false);
    zb_set_gate_open(false, true);
  }
}

// ------------------------
// Zigbee callbacks
// ------------------------
static esp_err_t set_attr_value_cb(const esp_zb_zcl_set_attr_value_message_t *m) {
  if (!m || m->info.status != ESP_ZB_ZCL_STATUS_SUCCESS) return ESP_OK;
  const uint8_t ep = m->info.dst_endpoint;
  const uint16_t cluster = m->info.cluster;
  const uint16_t attr = m->attribute.id;

  if (ep == EP_MAIN && cluster == ESP_ZB_ZCL_CLUSTER_ID_ON_OFF && attr == ESP_ZB_ZCL_ATTR_ON_OFF_ON_OFF_ID) {
    const uint8_t v = *(uint8_t *)m->attribute.data.value;
    const bool open = v != 0;
    Serial.printf("[ZB] gate onoff=%d\n", (int)open);
    gate_apply(open);
    // best-effort report to coordinator
    report_attr(EP_MAIN, ZCL_CLUSTER_ONOFF, ATTR_ONOFF);
    return ESP_OK;
  }

  if (ep == EP_MAIN && cluster == ESP_ZB_ZCL_CLUSTER_ID_LEVEL_CONTROL && attr == ESP_ZB_ZCL_ATTR_LEVEL_CONTROL_CURRENT_LEVEL_ID) {
    const uint8_t lvl = *(uint8_t *)m->attribute.data.value;
    Serial.printf("[ZB] light level=%u\n", (unsigned)lvl);
    s_light_level = lvl;
    light_apply_level(lvl);
    report_attr(EP_MAIN, ZCL_CLUSTER_LEVEL, ATTR_CURRENT_LEVEL);
    return ESP_OK;
  }

  if (ep == EP_CFG && cluster == ESP_ZB_ZCL_CLUSTER_ID_LEVEL_CONTROL && attr == ESP_ZB_ZCL_ATTR_LEVEL_CONTROL_CURRENT_LEVEL_ID) {
    const uint8_t sec = *(uint8_t *)m->attribute.data.value;
    s_timeout_sec = sec;
    Serial.printf("[ZB] set timeoutSec=%u\n", (unsigned)s_timeout_sec);
    // no report needed
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

  // Endpoint 1 (main)
  esp_zb_ep_list_t *ep_list = esp_zb_ep_list_create();
  esp_zb_cluster_list_t *cl_main = esp_zb_zcl_cluster_list_create();
  esp_zb_cluster_list_add_basic_cluster(cl_main, nullptr, (uint8_t)ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
  esp_zb_cluster_list_add_identify_cluster(cl_main, nullptr, (uint8_t)ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
  esp_zb_cluster_list_add_on_off_cluster(cl_main, nullptr, (uint8_t)ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
  esp_zb_cluster_list_add_level_cluster(cl_main, nullptr, (uint8_t)ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

  // Occupancy cluster (PIR)
  // Note: The Arduino Zigbee build provides this helper in HA standard.
  esp_zb_cluster_list_add_occupancy_sensing_cluster(cl_main, nullptr, (uint8_t)ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

  esp_zb_endpoint_config_t ep1 = {
      .endpoint = EP_MAIN,
      .app_profile_id = ESP_ZB_AF_HA_PROFILE_ID,
      .app_device_id = ESP_ZB_HA_DIMMABLE_LIGHT_DEVICE_ID,
      .app_device_version = 0,
  };
  esp_zb_ep_list_add_ep(ep_list, cl_main, ep1);

  // Endpoint 2 (config)
  esp_zb_cluster_list_t *cl_cfg = esp_zb_zcl_cluster_list_create();
  esp_zb_cluster_list_add_level_cluster(cl_cfg, nullptr, (uint8_t)ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
  esp_zb_endpoint_config_t ep2 = {
      .endpoint = EP_CFG,
      .app_profile_id = ESP_ZB_AF_HA_PROFILE_ID,
      .app_device_id = ESP_ZB_HA_DIMMABLE_LIGHT_DEVICE_ID,
      .app_device_version = 0,
  };
  esp_zb_ep_list_add_ep(ep_list, cl_cfg, ep2);

  esp_zb_device_register(ep_list);
  set_basic_fingerprint_attributes();

  // Init attributes
  zb_set_gate_open(false, false);
  zb_set_light_level(0, false);
  zb_set_timeout_sec(s_timeout_sec, false);
  uint8_t occ = 0;
  esp_zb_zcl_set_attribute_val(EP_MAIN, ZCL_CLUSTER_OCCUPANCY, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
                               ATTR_OCCUPANCY, &occ, false);

  esp_zb_core_action_handler_register(zb_action_handler);
  Serial.println("[ZB] starting ServoGate + PIR + Light...");
  esp_zb_start(false);

  while (true) {
    esp_zb_main_loop_iteration();
    vTaskDelay(1);
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("[BOOT] GATE_PIR_V1");

  servo_init();
  light_init();
  inputs_init();

  gate_apply(false);
  light_apply_level(0);

  xTaskCreate(zigbee_task, "zb", 8192, NULL, 5, NULL);
}

void loop() {
  maybe_report_basic_fingerprint();
  poll_inputs();
  maybe_light_auto_off();
  delay(20);
}
