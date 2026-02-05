

````md
# SmartHome v5 – Setup & Run cơ bản

README này hướng dẫn **chạy hệ thống SmartHome v5 ở local**: backend, admin web, MQTT, claim hub & device, Zigbee pairing cơ bản.

---

## 1. Yêu cầu

- Docker + Docker Compose
- Node.js (>= 18)
- npm
- (Tuỳ chọn) Mosquitto client (`mosquitto_pub`, `mosquitto_sub`)

---

## 2. Khởi chạy nhanh (Docker)

Từ thư mục `backend/`:

```bash
docker compose up -d
````

Các service được mở:

* Backend API: [http://localhost:3000](http://localhost:3000)
* MySQL: localhost:3307
* MQTT: localhost:1883
* MQTT WebSocket: localhost:9001

Chạy migration DB:

```bash
cd backend
npm install
npx prisma migrate deploy
```

---

## 3. Tài khoản mặc định (Seed)

Hệ thống có sẵn user seed:

* **Admin**

  * Email: `admin@example.com`
  * Password: `admin123`

* **Demo user**

  * Email: `demo@example.com`
  * Password: `demo123`

---

## 4. Admin Web

Chạy backend trước, sau đó:

```bash
cd admin-web
npm install
npm run dev
```

Mở trình duyệt:

* Admin UI: [http://localhost:5173](http://localhost:5173)
* Backend API: [http://localhost:3000](http://localhost:3000)

Đăng nhập bằng tài khoản admin.

---

## 5. Tạo Inventory (Admin)

> Setup code được lưu **dạng hash (bcrypt)** trong DB.
> Plaintext chỉ trả **một lần** khi tạo.

### 5.1 Tạo Hub (thủ công)

```bash
curl -X POST http://localhost:3000/admin/inventory/hubs/manual \
  -H "Authorization: Bearer <ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "serial": "hub-c55494",
    "setupCode": "12345678",
    "model": "HUB_V1"
  }'
```

Response trả về `serial`, `setupCodePlaintext` và `qrPayload` để app scan.

### 5.2 Tạo Device (MQTT hoặc Zigbee)

```bash
curl -X POST http://localhost:3000/admin/inventory/devices \
  -H "Authorization: Bearer <ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "serial": "SN-0001",
    "type": "relay",
    "protocol": "MQTT",
    "modelId": "DIMMER_V1"
  }'
```

---

## 6. Claim Hub vào Home

```bash
curl -X POST http://localhost:3000/hubs/activate \
  -H "Authorization: Bearer <USER_JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "serial": "hub-c55494",
    "setupCode": "12345678",
    "homeId": 1,
    "name": "Living Hub"
  }'
```

Lấy danh sách hub theo home:

```bash
curl "http://localhost:3000/hubs?homeId=1" \
  -H "Authorization: Bearer <JWT>"
```

---

## 7. Claim MQTT Device

```bash
curl -X POST http://localhost:3000/devices/claim \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "serial": "SN-0001",
    "setupCode": "<DEVICE_SETUP_CODE>",
    "homeId": 1,
    "name": "Relay 1"
  }'
```

Backend trả về **provisioning config** cho firmware ESP32:

* MQTT host / port
* username / password
* topics

> Với thiết bị thật, cần set:
>
> ```env
> MQTT_PUBLIC_HOST=<LAN_IP>
> ```
>
> để firmware kết nối được broker.

---

## 8. Zigbee Pairing (cơ bản)

Yêu cầu: hub đã được claim vào home.

### Mở phiên pairing

```bash
curl -X POST http://localhost:3000/zigbee/pairing/open \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "hubId": "hub-c55494",
    "durationSec": 60,
    "mode": "TYPE_FIRST",
    "expectedModelId": "TH_SENSOR_V1"
  }'
```

### Xem thiết bị Zigbee được phát hiện

```bash
curl "http://localhost:3000/zigbee/discovered?homeId=1" \
  -H "Authorization: Bearer <JWT>"
```

### Confirm thiết bị

```bash
curl -X POST http://localhost:3000/zigbee/pairing/confirm \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "hubId": "hub-c55494",
    "token": "<token>",
    "ieee": "<zigbee_ieee>"
  }'
```

---

## 9. Reset thiết bị

### Reset kết nối (giữ binding)

```bash
curl -X POST http://localhost:3000/devices/<deviceId>/reset-connection \
  -H "Authorization: Bearer <JWT>"
```

### Factory reset (unbind, cho phép claim sang home khác)

```bash
curl -X POST http://localhost:3000/devices/<deviceId>/factory-reset \
  -H "Authorization: Bearer <JWT>"
```

---

## 10. MQTT Diagnostics

Kiểm tra MQTT (pub/sub roundtrip):

```bash
curl http://localhost:3000/diagnostics/mqtt \
  -H "Authorization: Bearer <JWT>"
```

---

## 11. Mobile App

```bash
cd mobile
npm install
npm run start
```

Chức năng cơ bản:

* Add Hub
* Add MQTT device
* Zigbee pairing
* Reset / Factory reset
* MQTT diagnostics

---

## 12. Firmware

Xem chi tiết tại `firmware/README.md`.

Firmware chính:

* Hub Host (ESP32):
  `firmware/arduino/hub_host_mqtt_uart/hub_host_mqtt_uart.ino`
* MQTT Device (ESP32):
  `firmware/arduino/esp32_smarthome_mqtt/esp32_smarthome_mqtt.ino`

```

---

