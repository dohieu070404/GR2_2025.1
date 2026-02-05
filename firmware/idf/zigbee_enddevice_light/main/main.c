// Zigbee End Device - Light (On/Off + Level)
// ESP-IDF + esp-zigbee-lib
//
// Endpoint 1:
// - On/Off cluster (server)
// - Level Control cluster (server)
//
// Hardware:
// - GPIO controlled relay/LED (ON/OFF)
// - (Optional) PWM for dimming

#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "driver/gpio.h"
#include "driver/ledc.h"

#include "esp_log.h"
#include "nvs_flash.h"

#include "esp_zigbee_core.h"
#include "esp_zigbee_zcl.h"

#include "sdkconfig.h"

#ifndef CONFIG_SMARTHOME_LIGHT_GPIO
#define CONFIG_SMARTHOME_LIGHT_GPIO 2
#endif

#ifndef CONFIG_SMARTHOME_LIGHT_PWM_GPIO
#define CONFIG_SMARTHOME_LIGHT_PWM_GPIO -1
#endif

static const char *TAG = "ZB_LIGHT";

#define LIGHT_ENDPOINT 1

static bool s_relay_on = false;
static uint8_t s_level = 254;

static void hw_apply_onoff(bool on)
{
    gpio_set_level(CONFIG_SMARTHOME_LIGHT_GPIO, on ? 1 : 0);
    s_relay_on = on;
}

static void hw_apply_level(uint8_t level)
{
    s_level = level;
    if (CONFIG_SMARTHOME_LIGHT_PWM_GPIO < 0) {
        return;
    }
    // Map [0..254] -> duty [0..8191] (13-bit)
    uint32_t duty = (uint32_t)level * 8191 / 254;
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, duty);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
}

static void hw_init(void)
{
    gpio_config_t io_conf = {
        .pin_bit_mask = (1ULL << CONFIG_SMARTHOME_LIGHT_GPIO),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = 0,
        .pull_down_en = 0,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&io_conf));
    hw_apply_onoff(false);

    if (CONFIG_SMARTHOME_LIGHT_PWM_GPIO >= 0) {
        ledc_timer_config_t timer = {
            .speed_mode = LEDC_LOW_SPEED_MODE,
            .duty_resolution = LEDC_TIMER_13_BIT,
            .timer_num = LEDC_TIMER_0,
            .freq_hz = 5000,
            .clk_cfg = LEDC_AUTO_CLK,
        };
        ESP_ERROR_CHECK(ledc_timer_config(&timer));

        ledc_channel_config_t ch = {
            .gpio_num = CONFIG_SMARTHOME_LIGHT_PWM_GPIO,
            .speed_mode = LEDC_LOW_SPEED_MODE,
            .channel = LEDC_CHANNEL_0,
            .intr_type = LEDC_INTR_DISABLE,
            .timer_sel = LEDC_TIMER_0,
            .duty = 0,
            .hpoint = 0,
        };
        ESP_ERROR_CHECK(ledc_channel_config(&ch));
        hw_apply_level(0);
    }
}

// --- Zigbee helpers ---

static void zb_update_attr_onoff(bool on)
{
    uint8_t val = on ? 1 : 0;
    esp_zb_zcl_set_attribute_val(LIGHT_ENDPOINT, ESP_ZB_ZCL_CLUSTER_ID_ON_OFF,
                                ESP_ZB_ZCL_CLUSTER_SERVER_ROLE, ESP_ZB_ZCL_ATTR_ON_OFF_ON_OFF_ID,
                                &val, false);
}

static void zb_update_attr_level(uint8_t level)
{
    esp_zb_zcl_set_attribute_val(LIGHT_ENDPOINT, ESP_ZB_ZCL_CLUSTER_ID_LEVEL_CONTROL,
                                ESP_ZB_ZCL_CLUSTER_SERVER_ROLE, ESP_ZB_ZCL_ATTR_LEVEL_CONTROL_CURRENT_LEVEL_ID,
                                &level, false);
}

static esp_err_t zb_action_handler(esp_zb_core_action_callback_id_t callback_id, const void *message)
{
    // The SDK updates attributes when commands arrive. We observe attribute changes
    // and apply them to hardware.
    switch (callback_id) {
    case ESP_ZB_CORE_SET_ATTR_VALUE_CB_ID: {
        const esp_zb_zcl_set_attr_value_message_t *m = (const esp_zb_zcl_set_attr_value_message_t *)message;
        if (!m || m->info.dst_endpoint != LIGHT_ENDPOINT) {
            return ESP_OK;
        }
        if (m->info.cluster == ESP_ZB_ZCL_CLUSTER_ID_ON_OFF && m->info.attr_id == ESP_ZB_ZCL_ATTR_ON_OFF_ON_OFF_ID) {
            bool on = (*(uint8_t *)m->attribute.data.value) ? true : false;
            hw_apply_onoff(on);
            return ESP_OK;
        }
        if (m->info.cluster == ESP_ZB_ZCL_CLUSTER_ID_LEVEL_CONTROL && m->info.attr_id == ESP_ZB_ZCL_ATTR_LEVEL_CONTROL_CURRENT_LEVEL_ID) {
            uint8_t level = *(uint8_t *)m->attribute.data.value;
            hw_apply_level(level);
            return ESP_OK;
        }
        return ESP_OK;
    }
    default:
        return ESP_OK;
    }
}

void esp_zb_app_signal_handler(esp_zb_app_signal_t *signal_struct)
{
    esp_zb_app_signal_type_t sig = signal_struct->signal;
    esp_err_t status = signal_struct->esp_err_status;

    switch (sig) {
    case ESP_ZB_BDB_SIGNAL_DEVICE_FIRST_START:
    case ESP_ZB_BDB_SIGNAL_DEVICE_REBOOT:
        if (status == ESP_OK) {
            ESP_LOGI(TAG, "Joined network, starting steering");
            esp_zb_bdb_start_top_level_commissioning(ESP_ZB_BDB_MODE_NETWORK_STEERING);
        }
        break;
    default:
        break;
    }
}

static void zigbee_task(void *pvParameters)
{
    esp_zb_platform_config_t config = {
        .radio_config = ESP_ZB_DEFAULT_RADIO_CONFIG(),
        .host_config = ESP_ZB_DEFAULT_HOST_CONFIG(),
    };
    ESP_ERROR_CHECK(esp_zb_platform_config(&config));

    esp_zb_cfg_t zb_nwk_cfg = ESP_ZB_ZED_CONFIG();
    esp_zb_init(&zb_nwk_cfg);

    // Create endpoint with Basic + Identify + On/Off + Level (server)
    esp_zb_ep_list_t *ep_list = esp_zb_ep_list_create();
    esp_zb_endpoint_config_t ep_cfg = {
        .endpoint = LIGHT_ENDPOINT,
        .app_profile_id = ESP_ZB_AF_HA_PROFILE_ID,
        .app_device_id = ESP_ZB_HA_DIMMABLE_LIGHT_DEVICE_ID,
        .app_device_version = 0,
    };

    esp_zb_cluster_list_t *cluster_list = esp_zb_zcl_cluster_list_create();
    esp_zb_basic_cluster_cfg_t basic_cfg = {};
    esp_zb_cluster_list_add_basic_cluster(cluster_list, &basic_cfg, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

    esp_zb_identify_cluster_cfg_t identify_cfg = {};
    esp_zb_cluster_list_add_identify_cluster(cluster_list, &identify_cfg, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

    esp_zb_on_off_cluster_cfg_t onoff_cfg = {};
    esp_zb_cluster_list_add_on_off_cluster(cluster_list, &onoff_cfg, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

    esp_zb_level_cluster_cfg_t level_cfg = {};
    esp_zb_cluster_list_add_level_cluster(cluster_list, &level_cfg, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

    esp_zb_ep_list_add_ep(ep_list, cluster_list, ep_cfg);

    ESP_ERROR_CHECK(esp_zb_device_register(ep_list));
    esp_zb_core_action_handler_register(zb_action_handler);

    // Initial attribute values
    zb_update_attr_onoff(false);
    zb_update_attr_level(254);

    esp_zb_start(false);
    while (true) {
        esp_zb_main_loop_iteration();
    }
}

void app_main(void)
{
    ESP_LOGI(TAG, "Zigbee end-device light (endpoint %d)", LIGHT_ENDPOINT);
    ESP_ERROR_CHECK(nvs_flash_init());
    hw_init();
    xTaskCreate(zigbee_task, "zigbee", 8192, NULL, 5, NULL);
}
