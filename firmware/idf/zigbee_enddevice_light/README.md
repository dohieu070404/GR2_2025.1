# Zigbee End Device - Light (ESP-IDF)

Project: `firmware/idf/zigbee_enddevice_light/`

## Endpoint / clusters

- Endpoint: `1`
- Server clusters:
  - Basic (0x0000)
  - Identify (0x0003)
  - On/Off (0x0006)
  - Level Control (0x0008)

## Build / flash

```bash
cd firmware/idf/zigbee_enddevice_light
idf.py set-target esp32c6
idf.py build
idf.py -p /dev/ttyUSB0 flash monitor
```

## Notes

- GPIO config via `idf.py menuconfig -> SmartHome Zigbee End Device (Light)`
- This firmware updates `On/Off` and `Current Level` attributes and applies them to GPIO.