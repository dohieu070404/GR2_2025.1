// Zigbee End Device - Sensor (Temperature + Humidity)
// ESP-IDF + esp-zigbee-lib
//
// Endpoint 1:
// - Temperature Measurement cluster (server)
// - Relative Humidity Measurement cluster (server)
//
// This example uses fake measurements. Replace `read_fake_*()` with your
// sensor driver.

#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/timers.h"

#include "esp_log.h"
#include "nvs_flash.h"
#include "esp_random.h"

#include "sdkconfig.h"

#include "esp_zigbee_core.h"
#include "esp_zigbee_zcl_command.h"

static const char *TAG = "ZB_SENSOR";

#ifndef CONFIG_SMARTHOME_SENSOR_GPIO
#define CONFIG_SMARTHOME_SENSOR_GPIO (-1)
#endif

#ifndef CONFIG_SMARTHOME_SENSOR_REPORT_INTERVAL_S
#define CONFIG_SMARTHOME_SENSOR_REPORT_INTERVAL_S 10
#endif

#define SENSOR_ENDPOINT 1

// Clusters
#define ZCL_CLUSTER_TEMP_MEASUREMENT 0x0402
#define ZCL_CLUSTER_RH_MEASUREMENT   0x0405

// Attribute IDs
#define ATTR_MEASURED_VALUE 0x0000

static TimerHandle_t s_report_timer;

static int16_t read_fake_temperature_c_x100(void) {
  // 23.00C ± 1.00C
  int r = (int)(esp_random() % 201) - 100;
  return (int16_t)(2300 + r);
}

static uint16_t read_fake_humidity_pct_x100(void) {
  // 45.00% ± 2.50%
  int r = (int)(esp_random() % 501) - 250;
  int v = 4500 + r;
  if (v < 0) v = 0;
  if (v > 10000) v = 10000;
  return (uint16_t)v;
}

static void report_attr(uint16_t cluster_id, uint16_t attr_id) {
  esp_zb_zcl_report_attr_cmd_req_t req = {0};
  req.address_mode = ESP_ZB_APS_ADDR_MODE_DST_ADDR_ENDP_NOT_PRESENT;
  req.zcl_basic_cmd.src_endpoint = SENSOR_ENDPOINT;
  req.zcl_basic_cmd.cluster_id = cluster_id;
  req.attribute_id = attr_id;
  esp_zb_zcl_report_attr_cmd_req(&req);
}

static void update_and_report(void) {
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

  ESP_LOGI(TAG, "Reported temp=%d.%02dC rh=%d.%02d%%", temp / 100, abs(temp % 100), rh / 100,
           rh % 100);
}

static void report_timer_cb(TimerHandle_t t) {
  (void)t;
  // This is a timer callback (not the Zigbee thread). Use the Zigbee lock.
  esp_zb_lock_acquire(portMAX_DELAY);
  update_and_report();
  esp_zb_lock_release();
}

static void zigbee_task(void *pvParameters) {
  (void)pvParameters;

  // Configure Zigbee platform
  esp_zb_platform_config_t platform_cfg = {
      .radio_config = ESP_ZB_DEFAULT_RADIO_CONFIG(),
      .host_config = ESP_ZB_DEFAULT_HOST_CONFIG(),
  };
  ESP_ERROR_CHECK(esp_zb_platform_config(&platform_cfg));

  esp_zb_cfg_t zb_nwk_cfg = ESP_ZB_ZED_CONFIG();
  esp_zb_init(&zb_nwk_cfg);

  // Endpoint: Basic + Identify + Temp + RH
  esp_zb_ep_list_t *ep_list = esp_zb_ep_list_create();
  esp_zb_cluster_list_t *cluster_list = esp_zb_zcl_cluster_list_create();

  esp_zb_cluster_list_add_basic_cluster(cluster_list, NULL, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
  esp_zb_cluster_list_add_identify_cluster(cluster_list, NULL, ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
  esp_zb_cluster_list_add_temperature_measurement_cluster(cluster_list, NULL,
                                                        ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);
  esp_zb_cluster_list_add_relative_humidity_measurement_cluster(cluster_list, NULL,
                                                              ESP_ZB_ZCL_CLUSTER_SERVER_ROLE);

  esp_zb_endpoint_config_t ep_cfg = {
      .endpoint = SENSOR_ENDPOINT,
      .app_profile_id = ESP_ZB_AF_HA_PROFILE_ID,
      .app_device_id = ESP_ZB_HA_TEMPERATURE_SENSOR_DEVICE_ID,
      .app_device_version = 0,
  };
  ESP_ERROR_CHECK(esp_zb_ep_list_add_ep(ep_list, cluster_list, ep_cfg));
  ESP_ERROR_CHECK(esp_zb_device_register(ep_list));

  ESP_LOGI(TAG, "Starting Zigbee end device (sensor)...");
  esp_zb_start(false);

  // Periodic reporting timer
  s_report_timer = xTimerCreate("zb_report", pdMS_TO_TICKS(CONFIG_SMARTHOME_SENSOR_REPORT_INTERVAL_S * 1000),
                                pdTRUE, NULL, report_timer_cb);
  xTimerStart(s_report_timer, 0);

  while (true) {
    esp_zb_main_loop_iteration();
  }
}

void app_main(void) {
  ESP_LOGI(TAG, "Zigbee sensor end device (ESP32-C6)");

  esp_err_t ret = nvs_flash_init();
  if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    ESP_ERROR_CHECK(nvs_flash_init());
  }

  xTaskCreate(zigbee_task, "zb_task", 8192, NULL, 5, NULL);
}
