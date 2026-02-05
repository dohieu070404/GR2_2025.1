---

```md
# Arduino Firmware (ESP32) – Build & Flash cơ bản

Thư mục này chứa **Arduino sketch chuẩn** (tên folder = tên `.ino`) để mở trực tiếp bằng Arduino IDE và flash.

---

## 1. Cài Arduino IDE & ESP32 core

1. Cài **Arduino IDE 2.x**
2. Mở **File → Preferences**  
   Thêm vào *Additional Boards Manager URLs*:

```

[https://espressif.github.io/arduino-esp32/package_esp32_index.json](https://espressif.github.io/arduino-esp32/package_esp32_index.json)

```

3. Vào **Tools → Board → Boards Manager**  
   Cài **esp32 by Espressif Systems**

---

## 2. Cài libraries bắt buộc

Vào **Tools → Manage Libraries…** và cài:

- ArduinoJson (v6)
- AsyncMqttClient
- AsyncTCP (ESP32)

> Nếu không tìm thấy `AsyncMqttClient`, cài thủ công bằng ZIP  
> (Sketch → Include Library → Add .ZIP Library…)

---

## 3. Hub Host (ESP32 – MQTT ↔ Zigbee UART)

Dùng cho **hub trung tâm**.

### Sketch

```

firmware/arduino/hub_host_mqtt_uart/hub_host_mqtt_uart.ino

```

### Cấu hình (sửa trong file `.ino`)

- WiFi:
  - `WIFI_SSID`
  - `WIFI_PASS`
- MQTT:
  - `MQTT_HOST`
  - `MQTT_PORT`
  - `MQTT_USER`
  - `MQTT_PASS`
- Hub:
  - `HUB_ID`
- UART (nếu khác mặc định):
  - `UART2_RX`
  - `UART2_TX`

### Board settings (gợi ý)

- Board: **ESP32 Dev Module**
- Upload Speed: 921600 (hoặc thấp hơn nếu không ổn định)
- Flash Size: 4MB
- Partition Scheme: Default

---

## 4. ESP32 MQTT Device

Dùng cho **relay / sensor MQTT**.

### Sketch

```

firmware/arduino/esp32_smarthome_mqtt/esp32_smarthome_mqtt.ino

```

### Cấu hình (sửa trong file `.ino`)

- WiFi / MQTT config
- `DEFAULT_HOME_ID`
- `DEFAULT_DEVICE_ID` (trùng `deviceId` trong backend)
- `RELAY_PIN` (GPIO điều khiển relay)

### Ghi chú

- Trạng thái relay được lưu trong **NVS** (reboot không mất state)

---

## 5. Build & Flash

- Chọn đúng **Board** và **COM port**
- Nhấn **Upload**

(Tuỳ chọn) xuất file `.bin`:
- **Sketch → Export Compiled Binary**

---

---

```

---
