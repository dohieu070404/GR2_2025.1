# SmartLock UI (ESP8266)

Sprint 10: Firmware UI/offline cho SmartLock chạy trên **ESP8266 (NodeMCU / Wemos D1 mini)**.

## Tính năng

- Offline unlock bằng:
  - **PIN keypad 4x4** (đọc qua **PCF8574 I2C** để tiết kiệm GPIO)
  - **RFID RC522** (SPI)
- Lưu credential local theo slot:
  - PIN slots: `0..9`
  - RFID slots: `0..9`
  - Master PIN (optional)
- Anti brute-force:
  - Sai **5 lần liên tiếp** → lockout **30s** (hiển thị `LOCK`)
- UI:
  - Idle: `----`
  - Nhập PIN: hiển thị `****` (masked)
  - Success: `OPEN` + 1 beep pattern
  - Fail: `FAIL` + 3 beep fast
- UART newline JSON đến ESP32-C6 Zigbee bridge (**cmdId end-to-end**)

## Pin profiles (compile-time)

Chọn profile bằng macro:

- Arduino IDE: *Tools → Build Flags* (hoặc sửa trong code)
- PlatformIO: `-D LOCK_PIN_PROFILE=1`

Profiles:
- `LOCK_PIN_PROFILE=1` (**PROFILE_A**, recommended)
- `LOCK_PIN_PROFILE=2` (**PROFILE_B**, fallback)

Xem `pins.h` để biết GPIO cụ thể và lưu ý boot-strap.

## Libraries

Cài từ Arduino Library Manager:
- `ArduinoJson`
- `MFRC522`

## Wiring & contract

Xem tài liệu chi tiết (wiring table, UART JSON, schema examples, test steps):
- `docs/SMARTLOCK_ESP8266_C6.md`
