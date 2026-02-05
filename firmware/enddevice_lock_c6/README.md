# SmartLock Zigbee End-device Bridge (ESP32-C6)

Firmware cho **ESP32-C6** làm Zigbee end-device + bridge UART sang **ESP8266 lock UI**.


- Nhận Zigbee **lock action** từ coordinator (qua vendor/custom cluster) -> chuyển thành UART newline JSON command sang ESP8266.
- Nhận UART từ ESP8266:
  - `evt=cmd_result` -> publish Zigbee cmd_result (giữ nguyên `cmdId`)
  - `evt=event` -> publish Zigbee event (vd `lock.unlock`)
  - `evt=state` -> publish Zigbee state snapshot
- Periodic re-publish state snapshot để đảm bảo hub/backend luôn có retained state.

## UART

- Baud: `115200`
- Protocol: newline JSON

Xem chi tiết message schema tại `docs/SMARTLOCK_ESP8266_C6.md`.

## Pins

Mặc định (có thể chỉnh trong source):

- UART to ESP8266:
  - ESP32-C6 TX -> ESP8266 RX (GPIO3)
  - ESP32-C6 RX -> ESP8266 TX (GPIO1)

Trong code:

- `LOCK_UART_TX_PIN` (default `5`)
- `LOCK_UART_RX_PIN` (default `4`)

> Lưu ý: pin mapping tuỳ board ESP32-C6 bạn dùng.

## Build

Arduino IDE / Arduino CLI với board ESP32-C6.

Libraries:

- ArduinoJson
- Espressif Zigbee (đi cùng core ESP32-C6)

## Notes

- Basic fingerprint:
  - manufacturer: `SmartHome`
  - model: `LOCK_V2_DUALMCU`

Mục tiêu là để backend nhận đúng `ProductModel` hiện có.
