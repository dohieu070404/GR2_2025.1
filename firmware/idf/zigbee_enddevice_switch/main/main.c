/*
 * Zigbee End Device Switch - ESP-IDF skeleton
 */

#include <stdio.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "esp_log.h"
#include "nvs_flash.h"

#include "driver/gpio.h"

// Zigbee headers (add after integrating esp-zigbee-sdk)
// #include "esp_zigbee_core.h"

static const char *TAG = "zb_switch";

#define BUTTON_GPIO GPIO_NUM_9

static void button_task(void *arg)
{
    bool last = true;
    while (1) {
        bool now = gpio_get_level(BUTTON_GPIO);
        if (last && !now) {
            ESP_LOGI(TAG, "button pressed");
            // TODO: send Zigbee On/Off Toggle command
            //  - Either bind to a group/light, or send to coordinator as a scene/controller event.
        }
        last = now;
        vTaskDelay(pdMS_TO_TICKS(30));
    }
}

void app_main(void)
{
    ESP_ERROR_CHECK(nvs_flash_init());

    gpio_config_t btn_conf = {
        .pin_bit_mask = (1ULL << BUTTON_GPIO),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&btn_conf);

    xTaskCreate(button_task, "button", 2048, NULL, 5, NULL);

    // TODO: Zigbee End-Device init (On/Off Switch)
    // - create endpoint with On/Off cluster (client)
    // - start network steering

    ESP_LOGI(TAG, "Zigbee switch skeleton ready (integrate esp-zigbee-sdk)");
}
