---

```md
# Firmware

Mục tiêu:  
- Tránh **flash nhầm firmware**
- Giảm **chồng chéo**
- Đảm bảo **reset end-to-end** với backend (`reset_connection`, `factory_reset`)

Repo v5 chỉ coi **2 firmware dưới đây là canonical** để demo / chạy cơ bản.

---

## 1. ESP32 MQTT Device (thiết bị con – MQTT)

Dùng cho: relay, sensor MQTT, device WiFi.

### Flash file

```

firmware/arduino/esp32_smarthome_mqtt/esp32_smarthome_mqtt.ino

```

### MQTT topics (bắt buộc khớp backend)

- Subscribe:
```

home/<homeId>/device/<deviceId>/set

```

- Publish:
```

home/<homeId>/device/<deviceId>/ack     (QoS 1, retain=false)
home/<homeId>/device/<deviceId>/state   (retain=true)
home/<homeId>/device/<deviceId>/status  (retain=true, LWT offline)

```

### Reset workflow (bắt buộc)

Backend gửi mgmt command vào topic `.../set`:

- `reset_connection`
- Xoá WiFi + MQTT credentials trong NVS
- Giữ `homeId`, `deviceId`
- Reboot

- `factory_reset`
- Xoá toàn bộ NVS
- Cho phép claim lại sang home khác
- Reboot

Device **phải ACK đúng `cmdId`** lên `.../ack`.

---

## 2. Hub Host (ESP32 – MQTT ↔ Zigbee UART bridge)

Dùng cho: hub trung tâm, forward Zigbee ↔ backend.

### Flash file

```

firmware/arduino/hub_host_mqtt_uart/hub_host_mqtt_uart.ino

```

### MQTT topics (cơ bản)

- Publish:
```

home/hub/<hubId>/status        (retain=true, LWT offline)
home/zb/<ieee>/state           (retain=true)
home/zb/<ieee>/event
home/zb/<ieee>/cmd_result

```

- Subscribe:
```

home/zb/<ieee>/set

```

### Chức năng chính

- Bridge UART Zigbee ↔ MQTT
- Forward state / event / cmd_result lên backend
- Nhận command từ backend và gửi xuống Zigbee end-device
- Gửi hub status (online/offline, fwVersion…)

---

## 3. Zigbee coordinator & end-device

Firmware Zigbee **chỉ cần chạy được** để demo:

- Coordinator: ESP32-C6 (UART ↔ Hub Host)
- End-device: sensor / gate / lock Zigbee

Chi tiết Zigbee firmware xem riêng trong thư mục `firmware/arduino/zigbee_*`  
(không bắt buộc cho setup cơ bản).

---

## 4. Lưu ý quan trọng

- **Chỉ flash đúng 2 file canonical ở trên** để tránh lỗi:
- `esp32_smarthome_mqtt.ino`
- `hub_host_mqtt_uart.ino`
- Các firmware cũ / thử nghiệm **không dùng cho production**
- Backend chịu trách nhiệm:
- Provisioning MQTT
- Quản lý topic
- Reset / factory reset
- Claim & binding

---

## 5. Tài liệu liên quan

- Backend & MQTT contract: xem `README.md` (root)
- Mobile app: xem `mobile/README.md`
- Chi tiết firmware nâng cao: xem `firmware/README.md`
```

---

