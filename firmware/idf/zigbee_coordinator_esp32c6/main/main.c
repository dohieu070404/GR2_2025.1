// Zigbee Coordinator (ESP32-C6 + ESP-IDF + esp-zigbee-lib)
//
// Responsibilities:
// - Form Zigbee network (Coordinator)
// - Permit join on demand (duration seconds; auto-disable)
// - Track join/announce + attribute reports
// - Bridge events to UART as newline-delimited JSON
// - Accept commands from UART as newline-delimited JSON
//
// UART JSON protocol (newline-delimited):
//
// Events coordinator -> hub host:
//   {"evt":"device_annce","ieee":"00124b0001abcd12","short":"0x1234"}
//   {"evt":"attr_report","ieee":"00124b0001abcd12","cluster":"onoff","attr":"onoff","value":1}
//   {"evt":"join_state","enabled":true,"duration":60}
//
// Commands hub host -> coordinator:
//   {"cmd":"permit_join","duration":60}
//   {"cmd":"zcl_onoff","ieee":"00124b0001abcd12","value":1}
//   {"cmd":"zcl_level","ieee":"00124b0001abcd12","value":128}
//   {"cmd":"remove_device","ieee":"00124b0001abcd12"}

#include <stdio.h>
#include <string.h>
#include <inttypes.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "freertos/timers.h"

#include "driver/uart.h"
#include "esp_log.h"
#include "nvs_flash.h"

#include "sdkconfig.h"

// Zigbee
#include "esp_zigbee_core.h"
#include "esp_zigbee_zdo_command.h"
#include "esp_zigbee_zcl_command.h"
#include "esp_zigbee_ha_standard.h"

static const char *TAG = "ZB_COORD";

// -------------------------
// Kconfig defaults (if user didn't set)
// -------------------------

#ifndef CONFIG_SMARTHOME_UART_PORT
#define CONFIG_SMARTHOME_UART_PORT 1
#endif
#ifndef CONFIG_SMARTHOME_UART_TX_PIN
#define CONFIG_SMARTHOME_UART_TX_PIN 16
#endif
#ifndef CONFIG_SMARTHOME_UART_RX_PIN
#define CONFIG_SMARTHOME_UART_RX_PIN 17
#endif
#ifndef CONFIG_SMARTHOME_UART_BAUD
#define CONFIG_SMARTHOME_UART_BAUD 115200
#endif
#ifndef CONFIG_SMARTHOME_UART_RX_BUF_SIZE
#define CONFIG_SMARTHOME_UART_RX_BUF_SIZE 1024
#endif

#define UART_PORT ((uart_port_t)CONFIG_SMARTHOME_UART_PORT)
#define UART_TX_PIN (CONFIG_SMARTHOME_UART_TX_PIN)
#define UART_RX_PIN (CONFIG_SMARTHOME_UART_RX_PIN)
#define UART_BAUD (CONFIG_SMARTHOME_UART_BAUD)
#define UART_RX_BUF (CONFIG_SMARTHOME_UART_RX_BUF_SIZE)

// UART line framing limits
#define UART_LINE_MAX 512

// Zigbee endpoint used by the coordinator (client clusters)
#define COORD_ENDPOINT 1
// End device examples in this repo also use endpoint 1
#define DEFAULT_DST_ENDPOINT 1

// Channel mask for 11-26
#ifndef ESP_ZB_TRANSCEIVER_ALL_CHANNELS_MASK
#define ESP_ZB_TRANSCEIVER_ALL_CHANNELS_MASK 0x07FFF800
#endif

// -------------------------
// UART JSON helpers
// -------------------------

static void uart_write_line(const char *line)
{
    uart_write_bytes(UART_PORT, line, strlen(line));
    uart_write_bytes(UART_PORT, "\n", 1);
}

static void uart_send_join_state(bool enabled, uint16_t duration)
{
    char buf[128];
    snprintf(buf, sizeof(buf),
             "{\"evt\":\"join_state\",\"enabled\":%s,\"duration\":%u}",
             enabled ? "true" : "false", (unsigned)duration);
    uart_write_line(buf);
}

static void uart_send_device_annce(const char *ieee, uint16_t short_addr)
{
    char buf[160];
    snprintf(buf, sizeof(buf),
             "{\"evt\":\"device_annce\",\"ieee\":\"%s\",\"short\":\"0x%04x\"}",
             ieee, (unsigned)short_addr);
    uart_write_line(buf);
}

static void uart_send_attr_report(const char *ieee, const char *cluster, const char *attr, int32_t value)
{
    char buf[200];
    snprintf(buf, sizeof(buf),
             "{\"evt\":\"attr_report\",\"ieee\":\"%s\",\"cluster\":\"%s\",\"attr\":\"%s\",\"value\":%" PRId32 "}",
             ieee, cluster, attr, value);
    uart_write_line(buf);
}

// -------------------------
// Device table (IEEE <-> short)
// -------------------------

typedef struct {
    bool used;
    char ieee[17];
    uint16_t short_addr;
} device_entry_t;

static device_entry_t s_devices[32];

static void str_to_lower(char *s)
{
    while (*s) {
        if (*s >= 'A' && *s <= 'Z') *s = (char)(*s - 'A' + 'a');
        s++;
    }
}

static bool is_hex_char(char c)
{
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

static bool normalize_ieee_str(const char *in, char out[17])
{
    if (!in) return false;
    size_t n = strlen(in);
    if (n != 16) return false;
    for (size_t i = 0; i < 16; i++) {
        if (!is_hex_char(in[i])) return false;
        out[i] = in[i];
    }
    out[16] = '\0';
    str_to_lower(out);
    return true;
}

static void ieee_bytes_to_str(const uint8_t ieee[8], char out[17])
{
    // esp-zigbee stores IEEE little-endian in an array; print big-endian as hex.
    static const char *hex = "0123456789abcdef";
    for (int i = 0; i < 8; i++) {
        uint8_t b = ieee[7 - i];
        out[i * 2 + 0] = hex[(b >> 4) & 0x0F];
        out[i * 2 + 1] = hex[b & 0x0F];
    }
    out[16] = '\0';
}

static device_entry_t *find_device_by_ieee(const char *ieee)
{
    for (size_t i = 0; i < sizeof(s_devices) / sizeof(s_devices[0]); i++) {
        if (s_devices[i].used && strncmp(s_devices[i].ieee, ieee, 17) == 0) return &s_devices[i];
    }
    return NULL;
}

static device_entry_t *find_device_by_short(uint16_t short_addr)
{
    for (size_t i = 0; i < sizeof(s_devices) / sizeof(s_devices[0]); i++) {
        if (s_devices[i].used && s_devices[i].short_addr == short_addr) return &s_devices[i];
    }
    return NULL;
}

static device_entry_t *upsert_device(const char *ieee, uint16_t short_addr)
{
    device_entry_t *e = find_device_by_ieee(ieee);
    if (e) {
        e->short_addr = short_addr;
        return e;
    }
    for (size_t i = 0; i < sizeof(s_devices) / sizeof(s_devices[0]); i++) {
        if (!s_devices[i].used) {
            s_devices[i].used = true;
            strncpy(s_devices[i].ieee, ieee, sizeof(s_devices[i].ieee));
            s_devices[i].ieee[16] = '\0';
            s_devices[i].short_addr = short_addr;
            return &s_devices[i];
        }
    }
    ESP_LOGW(TAG, "Device table full; cannot store %s", ieee);
    return NULL;
}

// -------------------------
// UART -> Zigbee command queue
// -------------------------

typedef enum {
    CMD_PERMIT_JOIN,
    CMD_ZCL_ONOFF,
    CMD_ZCL_LEVEL,
    CMD_REMOVE_DEVICE,
} cmd_type_t;

typedef struct {
    cmd_type_t type;
    char ieee[17];
    uint16_t u16;
} uart_cmd_t;

static QueueHandle_t s_cmd_queue;
static TimerHandle_t s_permit_timer;
static uint16_t s_join_duration = 0;
static bool s_join_enabled = false;

static void permit_timer_cb(TimerHandle_t xTimer)
{
    (void)xTimer;
    uart_cmd_t cmd = {0};
    cmd.type = CMD_PERMIT_JOIN;
    cmd.u16 = 0;
    xQueueSend(s_cmd_queue, &cmd, 0);
}

// -------------------------
// Zigbee helpers
// -------------------------

static void zb_set_permit_join(uint16_t duration)
{
    esp_zb_zdo_mgmt_permit_joining_req_t req = {0};
    req.dst_addr = 0xFFFC; // all routers and coordinator
    req.permit_duration = (uint8_t)duration;
    req.tc_significance = 0;
    (void)esp_zb_zdo_mgmt_permit_joining_req(&req);

    s_join_enabled = duration > 0;
    s_join_duration = duration;
    uart_send_join_state(s_join_enabled, s_join_duration);
}

static void zb_send_onoff(uint16_t short_addr, bool on)
{
    esp_zb_zcl_on_off_cmd_t cmd_req = {0};
    cmd_req.zcl_basic_cmd.dst_addr_u.addr_short = short_addr;
    cmd_req.zcl_basic_cmd.dst_endpoint = DEFAULT_DST_ENDPOINT;
    cmd_req.zcl_basic_cmd.src_endpoint = COORD_ENDPOINT;
    cmd_req.address_mode = ESP_ZB_APS_ADDR_MODE_16_ENDP_PRESENT;
    cmd_req.on_off_cmd_id = on ? ESP_ZB_ZCL_CMD_ON_OFF_ON_ID : ESP_ZB_ZCL_CMD_ON_OFF_OFF_ID;
    (void)esp_zb_zcl_on_off_cmd_req(&cmd_req);
}

static void zb_send_level(uint16_t short_addr, uint8_t level)
{
    esp_zb_zcl_level_move_to_level_cmd_t cmd_req = {0};
    cmd_req.zcl_basic_cmd.dst_addr_u.addr_short = short_addr;
    cmd_req.zcl_basic_cmd.dst_endpoint = DEFAULT_DST_ENDPOINT;
    cmd_req.zcl_basic_cmd.src_endpoint = COORD_ENDPOINT;
    cmd_req.address_mode = ESP_ZB_APS_ADDR_MODE_16_ENDP_PRESENT;
    cmd_req.level = level;
    cmd_req.transition_time = 0;
    (void)esp_zb_zcl_level_move_to_level_cmd_req(&cmd_req);
}

static void zb_remove_device(const uint8_t ieee_le[8])
{
    esp_zb_zdo_mgmt_leave_req_t req = {0};
    req.dst_addr = 0xFFFC; // broadcast to routers/coordinator
    memcpy(req.device_addr, ieee_le, 8);
    req.remove_children = 1;
    req.rejoin = 0;
    (void)esp_zb_zdo_mgmt_leave_req(&req);
}

// Convert normalized IEEE string to little-endian bytes
static bool ieee_str_to_bytes_le(const char *ieee, uint8_t out[8])
{
    char norm[17];
    if (!normalize_ieee_str(ieee, norm)) return false;
    for (int i = 0; i < 8; i++) {
        char hi = norm[i * 2];
        char lo = norm[i * 2 + 1];
        int vhi = (hi <= '9') ? (hi - '0') : ((hi | 0x20) - 'a' + 10);
        int vlo = (lo <= '9') ? (lo - '0') : ((lo | 0x20) - 'a' + 10);
        uint8_t b = (uint8_t)((vhi << 4) | vlo);
        // We printed big-endian; stack uses little-endian.
        out[7 - i] = b;
    }
    return true;
}

// -------------------------
// Zigbee callbacks
// -------------------------

static esp_err_t zb_action_handler(esp_zb_core_action_callback_id_t callback_id, const void *message)
{
    switch (callback_id) {
    case ESP_ZB_CORE_REPORT_ATTR_CB_ID: {
        const esp_zb_zcl_report_attr_message_t *m = (const esp_zb_zcl_report_attr_message_t *)message;
        if (!m || m->status != ESP_ZB_ZCL_STATUS_SUCCESS) break;
        device_entry_t *dev = find_device_by_short(m->src_address.u.short_addr);
        const char *ieee = dev ? dev->ieee : "";

        // Basic mapping (extend as needed)
        if (m->cluster == ESP_ZB_ZCL_CLUSTER_ID_ON_OFF && m->attribute.id == ESP_ZB_ZCL_ATTR_ON_OFF_ON_OFF_ID) {
            int32_t v = *((uint8_t *)m->attribute.data.value);
            uart_send_attr_report(ieee, "onoff", "onoff", v ? 1 : 0);
        } else if (m->cluster == ESP_ZB_ZCL_CLUSTER_ID_LEVEL_CONTROL && m->attribute.id == ESP_ZB_ZCL_ATTR_LEVEL_CONTROL_CURRENT_LEVEL_ID) {
            int32_t v = *((uint8_t *)m->attribute.data.value);
            uart_send_attr_report(ieee, "level", "level", v);
        } else if (m->cluster == ESP_ZB_ZCL_CLUSTER_ID_TEMP_MEASUREMENT && m->attribute.id == ESP_ZB_ZCL_ATTR_TEMP_MEASUREMENT_VALUE_ID) {
            int32_t v = *((int16_t *)m->attribute.data.value); // 0.01 degC
            uart_send_attr_report(ieee, "temperature", "value", v);
        } else {
            // Unknown: forward numeric value best-effort (int32)
            int32_t v = 0;
            if (m->attribute.data.size >= 1) {
                memcpy(&v, m->attribute.data.value, m->attribute.data.size > 4 ? 4 : m->attribute.data.size);
            }
            uart_send_attr_report(ieee, "unknown", "unknown", v);
        }
        break;
    }
    default:
        break;
    }
    return ESP_OK;
}

void esp_zb_app_signal_handler(esp_zb_app_signal_t *signal_struct)
{
    esp_zb_app_signal_type_t sig = *(esp_zb_app_signal_type_t *)signal_struct->p_app_signal;
    esp_err_t status = signal_struct->esp_err_status;

    switch (sig) {
    case ESP_ZB_BDB_SIGNAL_DEVICE_FIRST_START:
    case ESP_ZB_BDB_SIGNAL_DEVICE_REBOOT:
        ESP_LOGI(TAG, "Zigbee stack started (%s)", esp_err_to_name(status));
        if (status == ESP_OK) {
            // Coordinator: form network
            esp_zb_bdb_start_top_level_commissioning(ESP_ZB_BDB_MODE_NETWORK_FORMATION);
        }
        break;
    case ESP_ZB_BDB_SIGNAL_FORMATION:
        ESP_LOGI(TAG, "Network formation: %s", esp_err_to_name(status));
        if (status == ESP_OK) {
            // Start with join disabled (host will enable)
            zb_set_permit_join(0);
        }
        break;
    case ESP_ZB_ZDO_SIGNAL_DEVICE_ANNCE: {
        const esp_zb_zdo_signal_device_annce_params_t *p = (const esp_zb_zdo_signal_device_annce_params_t *)signal_struct->p_app_signal;
        if (!p) break;
        char ieee[17];
        ieee_bytes_to_str(p->ieee_addr, ieee);
        str_to_lower(ieee);
        upsert_device(ieee, p->device_short_addr);
        uart_send_device_annce(ieee, p->device_short_addr);
        break;
    }
    default:
        break;
    }
}

// -------------------------
// UART RX task
// -------------------------

static void enqueue_cmd(const uart_cmd_t *cmd)
{
    if (xQueueSend(s_cmd_queue, cmd, 0) != pdTRUE) {
        ESP_LOGW(TAG, "Command queue full; dropping");
    }
}

static void process_uart_json_line(const char *line)
{
    // Lightweight JSON parse (no dynamic memory dependencies): do manual extraction
    // because cJSON allocations can fragment.
    // Accepted commands are small; we can do a simple substring search.

    // NOTE: For a stricter parser, swap this to cJSON.
    const char *cmd = strstr(line, "\"cmd\"");
    if (!cmd) return;
    const char *p = strstr(cmd, ":");
    if (!p) return;
    p++;
    while (*p == ' ' || *p == '\t') p++;
    if (*p != '"') return;
    p++;
    char cmd_name[32] = {0};
    size_t i = 0;
    while (*p && *p != '"' && i < sizeof(cmd_name) - 1) {
        cmd_name[i++] = *p++;
    }
    cmd_name[i] = '\0';

    uart_cmd_t out = {0};

    if (strcmp(cmd_name, "permit_join") == 0) {
        // default duration 60
        uint16_t duration = 60;
        const char *d = strstr(line, "\"duration\"");
        if (d) {
            const char *c = strstr(d, ":");
            if (c) duration = (uint16_t)atoi(c + 1);
        }
        out.type = CMD_PERMIT_JOIN;
        out.u16 = duration;
        enqueue_cmd(&out);
        return;
    }

    const char *ie = strstr(line, "\"ieee\"");
    if (!ie) {
        ESP_LOGW(TAG, "Missing ieee in cmd");
        return;
    }
    const char *ie_c = strstr(ie, ":");
    if (!ie_c) return;
    ie_c++;
    while (*ie_c == ' ' || *ie_c == '\t') ie_c++;
    if (*ie_c != '"') return;
    ie_c++;
    char ieee_norm[17] = {0};
    char ieee_tmp[32] = {0};
    size_t j = 0;
    while (*ie_c && *ie_c != '"' && j < sizeof(ieee_tmp) - 1) {
        ieee_tmp[j++] = *ie_c++;
    }
    ieee_tmp[j] = '\0';
    if (!normalize_ieee_str(ieee_tmp, ieee_norm)) {
        ESP_LOGW(TAG, "Invalid ieee: %s", ieee_tmp);
        return;
    }
    strncpy(out.ieee, ieee_norm, sizeof(out.ieee));
    out.ieee[16] = '\0';

    if (strcmp(cmd_name, "zcl_onoff") == 0) {
        uint16_t v = 0;
        const char *vv = strstr(line, "\"value\"");
        if (vv) {
            const char *c = strstr(vv, ":");
            if (c) v = (uint16_t)atoi(c + 1);
        }
        out.type = CMD_ZCL_ONOFF;
        out.u16 = v ? 1 : 0;
        enqueue_cmd(&out);
        return;
    }

    if (strcmp(cmd_name, "zcl_level") == 0) {
        uint16_t v = 0;
        const char *vv = strstr(line, "\"value\"");
        if (vv) {
            const char *c = strstr(vv, ":");
            if (c) v = (uint16_t)atoi(c + 1);
        }
        if (v > 254) v = 254;
        out.type = CMD_ZCL_LEVEL;
        out.u16 = v;
        enqueue_cmd(&out);
        return;
    }

    if (strcmp(cmd_name, "remove_device") == 0) {
        out.type = CMD_REMOVE_DEVICE;
        enqueue_cmd(&out);
        return;
    }
}

static void uart_rx_task(void *arg)
{
    (void)arg;
    uint8_t tmp[128];
    char line[UART_LINE_MAX];
    size_t len = 0;
    bool overflow = false;

    while (1) {
        int n = uart_read_bytes(UART_PORT, tmp, sizeof(tmp), pdMS_TO_TICKS(50));
        if (n <= 0) continue;

        for (int i = 0; i < n; i++) {
            char c = (char)tmp[i];
            if (c == '\r') continue;
            if (c == '\n') {
                if (!overflow && len > 0) {
                    line[len] = '\0';
                    process_uart_json_line(line);
                } else if (overflow) {
                    ESP_LOGW(TAG, "UART line too long; dropped");
                }
                len = 0;
                overflow = false;
                continue;
            }
            if (overflow) continue;
            if (len < UART_LINE_MAX - 1) {
                line[len++] = c;
            } else {
                overflow = true;
            }
        }
    }
}

// -------------------------
// Zigbee main task
// -------------------------

static void zigbee_task(void *pvParameters)
{
    (void)pvParameters;

    esp_zb_platform_config_t config = {
        .radio_config = ESP_ZB_DEFAULT_RADIO_CONFIG(),
        .host_config = ESP_ZB_DEFAULT_HOST_CONFIG(),
    };
    ESP_ERROR_CHECK(esp_zb_platform_config(&config));

    esp_zb_cfg_t zb_nwk_cfg = ESP_ZB_ZC_CONFIG();
    esp_zb_init(&zb_nwk_cfg);

    // Coordinator endpoint (client clusters)
    esp_zb_ep_list_t *ep_list = esp_zb_ep_list_create();
    esp_zb_endpoint_config_t ep_cfg = {
        .endpoint = COORD_ENDPOINT,
        .app_profile_id = ESP_ZB_AF_HA_PROFILE_ID,
        .app_device_id = ESP_ZB_HA_ON_OFF_SWITCH_DEVICE_ID,
        .app_device_version = 0,
    };

    // Minimal cluster list: Basic (server) + Identify (server) + OnOff (client) + Level (client)
    esp_zb_cluster_list_t *cluster_list = esp_zb_zcl_cluster_list_create();
    esp_zb_basic_cluster_cfg_t basic_cfg = {
        .zcl_version = ESP_ZB_ZCL_VERSION,
        .power_source = ESP_ZB_ZCL_BASIC_POWER_SOURCE_DC_SOURCE,
    };
    esp_zb_cluster_list_add_basic_cluster(cluster_list, &basic_cfg, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
    esp_zb_identify_cluster_cfg_t identify_cfg = {0};
    esp_zb_cluster_list_add_identify_cluster(cluster_list, &identify_cfg, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
    esp_zb_cluster_list_add_on_off_cluster(cluster_list, NULL, ESP_ZB_ZCL_CLUSTER_CLIENT_ROLE);
    esp_zb_cluster_list_add_level_control_cluster(cluster_list, NULL, ESP_ZB_ZCL_CLUSTER_CLIENT_ROLE);

    ESP_ERROR_CHECK(esp_zb_ep_list_add_ep(ep_list, cluster_list, ep_cfg));
    ESP_ERROR_CHECK(esp_zb_device_register(ep_list));

    esp_zb_core_action_handler_register(zb_action_handler);

    esp_zb_set_primary_network_channel_set(ESP_ZB_TRANSCEIVER_ALL_CHANNELS_MASK);

    ESP_LOGI(TAG, "Starting Zigbee coordinator...");
    esp_zb_start(false);

    while (1) {
        // Process UART commands
        uart_cmd_t cmd;
        while (xQueueReceive(s_cmd_queue, &cmd, 0) == pdTRUE) {
            if (cmd.type == CMD_PERMIT_JOIN) {
                // Zigbee API should be called from Zigbee context
                zb_set_permit_join(cmd.u16);
                if (cmd.u16 > 0) {
                    xTimerStop(s_permit_timer, 0);
                    xTimerChangePeriod(s_permit_timer, pdMS_TO_TICKS(cmd.u16 * 1000U), 0);
                    xTimerStart(s_permit_timer, 0);
                } else {
                    xTimerStop(s_permit_timer, 0);
                }
            } else if (cmd.type == CMD_ZCL_ONOFF) {
                device_entry_t *d = find_device_by_ieee(cmd.ieee);
                if (!d) {
                    ESP_LOGW(TAG, "Unknown device ieee=%s", cmd.ieee);
                } else {
                    zb_send_onoff(d->short_addr, cmd.u16 ? true : false);
                }
            } else if (cmd.type == CMD_ZCL_LEVEL) {
                device_entry_t *d = find_device_by_ieee(cmd.ieee);
                if (!d) {
                    ESP_LOGW(TAG, "Unknown device ieee=%s", cmd.ieee);
                } else {
                    zb_send_level(d->short_addr, (uint8_t)cmd.u16);
                }
            } else if (cmd.type == CMD_REMOVE_DEVICE) {
                uint8_t ieee_le[8];
                if (ieee_str_to_bytes_le(cmd.ieee, ieee_le)) {
                    zb_remove_device(ieee_le);
                }
            }
        }

        esp_zb_main_loop_iteration();
    }
}

static void init_uart(void)
{
    uart_config_t uart_config = {
        .baud_rate = UART_BAUD,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };
    ESP_ERROR_CHECK(uart_driver_install(UART_PORT, UART_RX_BUF, 0, 0, NULL, 0));
    ESP_ERROR_CHECK(uart_param_config(UART_PORT, &uart_config));
    ESP_ERROR_CHECK(uart_set_pin(UART_PORT, UART_TX_PIN, UART_RX_PIN, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));
}

void app_main(void)
{
    ESP_LOGI(TAG, "Zigbee coordinator starting");

    ESP_ERROR_CHECK(nvs_flash_init());

    init_uart();

    s_cmd_queue = xQueueCreate(16, sizeof(uart_cmd_t));
    s_permit_timer = xTimerCreate("permit", pdMS_TO_TICKS(1000), pdFALSE, NULL, permit_timer_cb);

    xTaskCreate(uart_rx_task, "uart_rx", 4096, NULL, 5, NULL);
    xTaskCreate(zigbee_task, "zb_main", 8192, NULL, 5, NULL);
}
