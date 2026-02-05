# Zigbee End Device - Sensor (ESP-IDF)

Project: `firmware/idf/zigbee_enddevice_sensor/`

## Endpoint / clusters

- Endpoint: `1`
- Server clusters:
  - Basic (0x0000)
  - Identify (0x0003)
  - Temperature Measurement (0x0402)
  - Relative Humidity Measurement (0x0405)

## Build / flash

```bash
cd firmware/idf/zigbee_enddevice_sensor
idf.py set-target esp32c6
idf.py build
idf.py flash monitor
```

## Tuning

Report interval is configurable via menuconfig:

```bash
idf.py menuconfig
# SmartHome Zigbee End Device (Sensor) -> Report interval
```

## Expected behavior

- Joins the coordinator when permit join is enabled
- Periodically updates fake temperature/humidity values and reports attributes
