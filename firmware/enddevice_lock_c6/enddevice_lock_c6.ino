/*
  SmartLock Zigbee end-device bridge (ESP32-C6)

  Sprint 10 requirements:
    - Zigbee end device bridge between UART <-> Zigbee (custom cluster commands)
    - UART: newline JSON + cmdId end-to-end (ESP8266 UI is the lock brain)
    - Zigbee:
        * Receive lock action from coordinator -> UART -> UI
        * Receive cmd_result/event/state from UI -> Zigbee -> coordinator
        * Periodic state snapshot

  This device identifies as model "LOCK_V2_DUALMCU" to match backend seed.

  Dependencies:
    - ArduinoJson
    - ESP Zigbee SDK for Arduino (esp_zb_*)
*/

#include <Arduino.h>
#include <ArduinoJson.h>

#include "esp_zigbee_core.h"
#include "esp_zigbee_zcl_common.h"
#include "esp_zigbee_zcl_command.h"
#include "zcl/esp_zigbee_zcl_basic.h"
#include "ha/esp_zigbee_ha_standard.h"

// ============ Config ============

// UART to ESP8266 UI
#ifndef LOCK_UART_BAUD
#define LOCK_UART_BAUD 115200
#endif

#ifndef LOCK_UART_RX_PIN
#define LOCK_UART_RX_PIN 4
#endif

#ifndef LOCK_UART_TX_PIN
#define LOCK_UART_TX_PIN 5
#endif

// Zigbee endpoint
#define LOCK_ENDPOINT 0x01

// Custom cluster (manufacturer specific)
#define LOCK_CUSTOM_CLUSTER_ID 0xFF00

// Custom command IDs
#define LOCK_CMD_ACTION_REQ  0x00  // coordinator -> lock end-device
#define LOCK_CMD_CMD_RESULT  0x01  // lock end-device -> coordinator
#define LOCK_CMD_EVENT       0x02  // lock end-device -> coordinator
#define LOCK_CMD_STATE       0x03  // lock end-device -> coordinator

// A placeholder attribute so the custom cluster is not empty.
#define LOCK_CUSTOM_ATTR_ID 0x0000

static const char *TAG = "lock_ed";

// ============ UART line reader ============

static char g_uartLine[512];
static size_t g_uartLineLen = 0;

static bool uartReadLine(Stream &s, char *out, size_t outCap) {
  while (s.available()) {
    int c = s.read();
    if (c < 0) break;
    if (c == '\r') continue;

    if (c == '\n') {
      if (g_uartLineLen == 0) return false;
      g_uartLine[g_uartLineLen] = '\0';
      strncpy(out, g_uartLine, outCap);
      out[outCap - 1] = '\0';
      g_uartLineLen = 0;
      return true;
    }

    if (g_uartLineLen + 1 < sizeof(g_uartLine)) {
      g_uartLine[g_uartLineLen++] = static_cast<char>(c);
    } else {
      // Overflow -> reset
      g_uartLineLen = 0;
    }
  }
  return false;
}

// ============ Queues ============

typedef struct {
  uint8_t cmd_id;
  char payload[260]; // JSON payload (NOT including ZCL length byte)
} out_msg_t;

static QueueHandle_t g_outQueue = nullptr;

typedef struct {
  char payload[260]; // JSON payload (from coordinator)
} in_msg_t;

static QueueHandle_t g_inQueue = nullptr;

// ============ Zigbee send helper ============

static void zb_send_custom_to_coordinator(uint8_t custom_cmd_id, const char *jsonPayload) {
  if (!jsonPayload) return;
  const size_t len = strnlen(jsonPayload, 255);
  if (len == 0 || len > 254) {
    ESP_LOGW(TAG, "Payload too long (%u)", static_cast<unsigned>(len));
    return;
  }

  // ZCL char string: [len][bytes...]
  uint8_t zclStr[1 + 254];
  zclStr[0] = static_cast<uint8_t>(len);
  memcpy(zclStr + 1, jsonPayload, len);

  esp_zb_zcl_custom_cluster_cmd_req_t req = {};
  req.zcl_basic_cmd.dst_addr_u.addr_short = 0x0000; // coordinator
  req.zcl_basic_cmd.dst_endpoint = LOCK_ENDPOINT;
  req.zcl_basic_cmd.src_endpoint = LOCK_ENDPOINT;
  req.address_mode = ESP_ZB_APS_ADDR_MODE_16_ENDP_PRESENT;
  req.cluster_id = LOCK_CUSTOM_CLUSTER_ID;
  req.profile_id = ESP_ZB_AF_HA_PROFILE_ID;
  req.direction = ESP_ZB_ZCL_CMD_DIRECTION_TO_CLI;
  req.custom_cmd_id = custom_cmd_id;
  req.data.type = ESP_ZB_ZCL_ATTR_TYPE_CHAR_STRING;
  req.data.size = static_cast<uint16_t>(len + 1);
  req.data.value = zclStr;

  esp_zb_zcl_custom_cluster_cmd_req(&req);
}

// ============ Zigbee receive handler ============

static esp_err_t zb_custom_cmd_handler(const esp_zb_zcl_custom_cluster_command_message_t *message) {
  ESP_RETURN_ON_FALSE(message, ESP_FAIL, TAG, "Empty message");
  ESP_RETURN_ON_FALSE(message->info.status == ESP_ZB_ZCL_STATUS_SUCCESS, ESP_ERR_INVALID_ARG, TAG,
                      "Received message: error status(%d)", message->info.status);

  // We expect ACTION_REQ from coordinator
  if (message->info.command.id != LOCK_CMD_ACTION_REQ) {
    ESP_LOGW(TAG, "Ignore custom cmd id=%u", message->info.command.id);
    return ESP_OK;
  }

  if (!message->data.value || message->data.size < 2) {
    ESP_LOGW(TAG, "Invalid custom payload");
    return ESP_OK;
  }

  const uint8_t *zclStr = (const uint8_t *)message->data.value;
  const uint8_t slen = zclStr[0];
  if (slen + 1 > message->data.size) {
    ESP_LOGW(TAG, "Invalid ZCL string length");
    return ESP_OK;
  }

  char json[260];
  const size_t copyLen = min<size_t>(slen, sizeof(json) - 1);
  memcpy(json, zclStr + 1, copyLen);
  json[copyLen] = '\0';

  in_msg_t im = {};
  strncpy(im.payload, json, sizeof(im.payload));
  im.payload[sizeof(im.payload) - 1] = '\0';
  if (g_inQueue) {
    xQueueSend(g_inQueue, &im, 0);
  }

  return ESP_OK;
}

static esp_err_t zb_action_handler(esp_zb_core_action_callback_id_t callback_id, const void *message) {
  switch (callback_id) {
  case ESP_ZB_CORE_CMD_CUSTOM_CLUSTER_REQ_CB_ID:
    return zb_custom_cmd_handler((const esp_zb_zcl_custom_cluster_command_message_t *)message);
  default:
    ESP_LOGD(TAG, "Zigbee action cb: 0x%x", callback_id);
    return ESP_OK;
  }
}

// ============ Zigbee init ============

static void zb_init() {
  esp_zb_cfg_t zb_nwk_cfg = {
      .esp_zb_role = ESP_ZB_DEVICE_TYPE_ED,
      .install_code_policy = false,
      .nwk_cfg = {
          .zczr_cfg = {
              .max_children = 0,
          },
      },
  };

  esp_zb_init(&zb_nwk_cfg);

  // Basic info for backend model mapping
  esp_zb_basic_cluster_cfg_t basic_cfg = {
      .zcl_version = ESP_ZB_ZCL_BASIC_ZCL_VERSION_DEFAULT_VALUE,
      .power_source = ESP_ZB_ZCL_BASIC_POWER_SOURCE_DEFAULT_VALUE,
  };

  esp_zb_identify_cluster_cfg_t identify_cfg = {
      .identify_time = 0,
  };

  esp_zb_ep_list_t *ep_list = esp_zb_ep_list_create();

  esp_zb_endpoint_config_t ep_cfg = {
      .endpoint = LOCK_ENDPOINT,
      .app_profile_id = ESP_ZB_AF_HA_PROFILE_ID,
      .app_device_id = ESP_ZB_HA_CUSTOM_ATTR_DEVICE_ID,
      .app_device_version = 0,
  };

  esp_zb_cluster_list_t *cluster_list = esp_zb_zcl_cluster_list_create();
  esp_zb_cluster_list_add_basic_cluster(cluster_list, esp_zb_basic_cluster_create(&basic_cfg), ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
  esp_zb_cluster_list_add_identify_cluster(cluster_list, esp_zb_identify_cluster_create(&identify_cfg), ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

  // Custom cluster (server)
  esp_zb_attribute_list_t *custom_cluster = esp_zb_zcl_attr_list_create(LOCK_CUSTOM_CLUSTER_ID);
  static uint8_t custom_attr_value[] = "\x00"; // empty string
  esp_zb_custom_cluster_add_custom_attr(custom_cluster, LOCK_CUSTOM_ATTR_ID, ESP_ZB_ZCL_ATTR_TYPE_CHAR_STRING,
                                        ESP_ZB_ZCL_ATTR_ACCESS_WRITE_ONLY | ESP_ZB_ZCL_ATTR_ACCESS_REPORTING,
                                        custom_attr_value);
  esp_zb_cluster_list_add_custom_cluster(cluster_list, custom_cluster, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

  esp_zb_ep_list_add_ep(ep_list, cluster_list, ep_cfg);
  esp_zb_device_register(ep_list);

  // Override Basic strings to match backend model
  esp_zb_zcl_set_attribute_val(LOCK_ENDPOINT, ESP_ZB_ZCL_CLUSTER_ID_BASIC, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
                               ESP_ZB_ZCL_ATTR_BASIC_MANUFACTURER_NAME_ID, (void *)"\x08""SmartHome", false);
  esp_zb_zcl_set_attribute_val(LOCK_ENDPOINT, ESP_ZB_ZCL_CLUSTER_ID_BASIC, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
                               ESP_ZB_ZCL_ATTR_BASIC_MODEL_IDENTIFIER_ID, (void *)"\x0d""LOCK_V2_DUALMCU", false);
  esp_zb_zcl_set_attribute_val(LOCK_ENDPOINT, ESP_ZB_ZCL_CLUSTER_ID_BASIC, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE,
                               ESP_ZB_ZCL_ATTR_BASIC_SW_BUILD_ID, (void *)"\x05""1.0.0", false);

  esp_zb_core_action_handler_register(zb_action_handler);

  esp_zb_set_primary_network_channel_set(ESP_ZB_PRIMARY_CHANNEL_MASK);
  esp_zb_start(false);
}

static void zigbee_task(void *pvParameters) {
  esp_zb_platform_config_t config = {
      .radio_config = ESP_ZB_DEFAULT_RADIO_CONFIG(),
      .host_config = ESP_ZB_DEFAULT_HOST_CONFIG(),
  };
  esp_zb_platform_config(&config);

  zb_init();

  // Zigbee main loop
  out_msg_t msg;
  char lastState[260] = {0};
  uint32_t lastStateSentMs = 0;

  while (true) {
    esp_zb_main_loop_iteration();

    // Drain outgoing queue
    while (g_outQueue && xQueueReceive(g_outQueue, &msg, 0) == pdTRUE) {
      zb_send_custom_to_coordinator(msg.cmd_id, msg.payload);
      if (msg.cmd_id == LOCK_CMD_STATE) {
        strncpy(lastState, msg.payload, sizeof(lastState));
        lastState[sizeof(lastState) - 1] = '\0';
        lastStateSentMs = millis();
      }
    }

    // Periodic state snapshot (re-send last known state)
    const uint32_t now = millis();
    if (lastState[0] != '\0' && (now - lastStateSentMs) > 10000) {
      zb_send_custom_to_coordinator(LOCK_CMD_STATE, lastState);
      lastStateSentMs = now;
    }

    vTaskDelay(10 / portTICK_PERIOD_MS);
  }
}

// ============ Arduino setup/loop ============

static HardwareSerial &LOCK_UART = Serial1;

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println();
  Serial.println("[lock_ed] boot");

  LOCK_UART.begin(LOCK_UART_BAUD, SERIAL_8N1, LOCK_UART_RX_PIN, LOCK_UART_TX_PIN);

  g_outQueue = xQueueCreate(8, sizeof(out_msg_t));
  g_inQueue = xQueueCreate(4, sizeof(in_msg_t));

  xTaskCreate(zigbee_task, "ZB", 8192, nullptr, 5, nullptr);
}

static void enqueueOut(uint8_t cmdId, const char *payload) {
  if (!g_outQueue || !payload) return;
  out_msg_t m = {};
  m.cmd_id = cmdId;
  strncpy(m.payload, payload, sizeof(m.payload));
  m.payload[sizeof(m.payload) - 1] = '\0';
  xQueueSend(g_outQueue, &m, 0);
}

void loop() {
  // Process incoming Zigbee action requests -> send UART command to ESP8266
  in_msg_t im;
  while (g_inQueue && xQueueReceive(g_inQueue, &im, 0) == pdTRUE) {
    StaticJsonDocument<384> doc;
    DeserializationError err = deserializeJson(doc, im.payload);
    if (err) {
      Serial.printf("[lock_ed] bad action json: %s\n", err.c_str());
      continue;
    }

    const char *cmdId = doc["cmdId"] | "";
    const char *action = doc["action"] | doc["cmd"] | "";
    JsonVariantConst args = doc["args"].isNull() ? doc["params"] : doc["args"];

    StaticJsonDocument<384> out;
    out["cmd"] = action;
    out["cmdId"] = cmdId;
    if (!args.isNull()) out["args"] = args;

    String line;
    serializeJson(out, line);
    LOCK_UART.println(line);
    Serial.printf("[lock_ed] ->UART %s\n", line.c_str());
  }

  // Read UART from ESP8266 -> push to Zigbee
  char line[512];
  while (uartReadLine(LOCK_UART, line, sizeof(line))) {
    StaticJsonDocument<512> doc;
    DeserializationError err = deserializeJson(doc, line);
    if (err) {
      // Ignore noise (ESP8266 boot logs etc)
      continue;
    }

    const char *evt = doc["evt"] | "";
    if (strcmp(evt, "cmd_result") == 0) {
      StaticJsonDocument<256> payload;
      payload["cmdId"] = doc["cmdId"] | "";
      payload["ok"] = doc["ok"] | false;
      if (!doc["error"].isNull()) payload["error"] = doc["error"];
      String s; serializeJson(payload, s);
      enqueueOut(LOCK_CMD_CMD_RESULT, s.c_str());
      Serial.printf("[lock_ed] ZB cmd_result %s\n", s.c_str());
    } else if (strcmp(evt, "event") == 0) {
      StaticJsonDocument<384> payload;
      payload["type"] = doc["type"] | "";
      if (!doc["data"].isNull()) payload["data"] = doc["data"];
      String s; serializeJson(payload, s);
      enqueueOut(LOCK_CMD_EVENT, s.c_str());
      Serial.printf("[lock_ed] ZB event %s\n", s.c_str());
    } else if (strcmp(evt, "state") == 0) {
      JsonVariantConst st = doc["state"];
      if (st.isNull()) continue;
      String s; serializeJson(st, s);
      enqueueOut(LOCK_CMD_STATE, s.c_str());
      Serial.printf("[lock_ed] ZB state %s\n", s.c_str());
    }
  }

  delay(5);
}
