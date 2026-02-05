# Zigbee Coordinator (ESP32-C6, ESP-IDF)

Project: `firmware/idf/zigbee_coordinator_esp32c6/`

## What it does

- Starts as Zigbee **Coordinator** and forms a network
- Accepts commands from UART as newline-delimited JSON
- Emits events to UART as newline-delimited JSON

This coordinator is meant to be wired by UART to the Arduino **Hub Host**
(`firmware/arduino/hub_host_mqtt_uart/`).

## UART JSON protocol

Line framing: **1 JSON object per line** (`\n` delimited).

### Events (coordinator ➜ hub host)

```json
{"evt":"device_annce","ieee":"00124b0001abcd12","short":"0x1234"}
{"evt":"attr_report","ieee":"00124b0001abcd12","cluster":"onoff","attr":"onoff","value":1}
{"evt":"join_state","enabled":true,"duration":60}
```

### Commands (hub host ➜ coordinator)

```json
{"cmd":"permit_join","duration":60}
{"cmd":"zcl_onoff","ieee":"00124b0001abcd12","value":1}
{"cmd":"zcl_level","ieee":"00124b0001abcd12","value":128}
{"cmd":"remove_device","ieee":"00124b0001abcd12"}
```

## Build & flash

Requirements:

- ESP-IDF installed (v5.x recommended)
- Target: **ESP32-C6**

```bash
cd firmware/idf/zigbee_coordinator_esp32c6
idf.py set-target esp32c6
idf.py menuconfig   # optional (UART pins in "SmartHome Zigbee Coordinator")
idf.py build
idf.py flash monitor
```

## Wiring to Hub Host

Default UART config (can be changed via menuconfig):

- Coordinator UART TX GPIO **16** ➜ Hub Host RX2 GPIO **16**
- Coordinator UART RX GPIO **17** ➜ Hub Host TX2 GPIO **17**
- GND ↔ GND
- 115200 baud

If you swap pins on one side, swap on the other.

## Test plan

1) Flash coordinator, confirm it forms network (logs)
2) From hub host, send `{"cmd":"permit_join","duration":60}` over UART
3) Power on an end device → expect `device_annce` event
4) Send `zcl_onoff` / `zcl_level` commands → device changes → expect `attr_report`
