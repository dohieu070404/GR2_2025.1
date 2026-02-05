# OTA artifacts folder

Backend serves this folder at `/ota/*`.

## 1) What you need to place here

Export compiled binaries from Arduino IDE:

- Arduino IDE → **Sketch → Export Compiled Binary**
- Copy the produced `.bin` files into:

### Zigbee end-devices (ESP32-C6 / ESP32-H2)
- `ota/zigbee/zigbee_enddevice_light.bin`
- `ota/zigbee/zigbee_enddevice_rgb.bin`
- `ota/zigbee/zigbee_enddevice_sensor.bin`

### ESP32 MQTT devices (example: relay)
- `ota/mqtt/esp32_mqtt_relay.bin`

## 2) Manifest format (backend expects this)

`ota/manifest.json` is used by:
- `GET /devices/:id/ota/check` (returns available version + URL)

Structure:

```json
{
  "zigbee": {
    "rgb":   { "version": "3.1.0", "path": "/ota/zigbee/zigbee_enddevice_rgb.bin" },
    "dimmer":{ "version": "3.1.0", "path": "/ota/zigbee/zigbee_enddevice_light.bin" },
    "sensor":{ "version": "3.1.0", "path": "/ota/zigbee/zigbee_enddevice_sensor.bin" }
  },
  "mqtt": {
    "relay": { "version": "3.1.0", "path": "/ota/mqtt/esp32_mqtt_relay.bin" }
  }
}
```

> Notes
> - `path` can be an absolute URL too (e.g., CDN).
> - `sha256` is optional (you can add it later for integrity checks).
