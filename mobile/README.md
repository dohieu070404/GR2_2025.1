

---

````md
# Mobile App (React Native + Expo)

Hướng dẫn chạy **mobile app SmartHome** ở môi trường local/dev.

---

## 1. Yêu cầu

- Node.js (>= 18)
- npm
- Expo CLI / Expo Dev Client
- Backend đang chạy (mặc định port `3000`)

---

## 2. Cài đặt

Cài dependencies:

```bash
npm install
````

---

## 3. Cấu hình môi trường

Copy file env mẫu:

```bash
cp .env.example .env
```

Chỉnh `.env`:

```env
# dev | staging | prod
EXPO_PUBLIC_APP_ENV=dev

# Backend API URL (backend mặc định port 3000)
# KHÔNG dùng localhost khi chạy trên thiết bị thật
EXPO_PUBLIC_API_URL=http://192.168.1.10:3000
```

Ghi chú:

* **Android emulator**: dùng `http://10.0.2.2:3000`
* **Điện thoại thật**: dùng IP LAN của máy chạy backend
* Nếu không set `EXPO_PUBLIC_API_URL`, app sẽ tự dò IP của Metro host và dùng `:3000`

---

## 4. Chạy ứng dụng

```bash
npm run start
```

* Nhấn `a` để mở Android emulator
* Hoặc mở bằng Expo Dev Client trên điện thoại

---

## 5. Yêu cầu backend

Backend cần:

* API chạy tại `EXPO_PUBLIC_API_URL`
* Hỗ trợ JWT (`Authorization: Bearer <token>`)
* SSE endpoint:

  ```
  GET /events
  ```

> Nếu backend đặt sau nginx/reverse proxy, cần **tắt buffer cho SSE**.

---

## 6. MQTT (ghi chú)

Mobile **không cần cấu hình MQTT topic**.
Toàn bộ topic được backend quản lý theo dạng:

```
home/<homeId>/device/<deviceId>/set
home/<homeId>/device/<deviceId>/ack
home/<homeId>/device/<deviceId>/state
home/<homeId>/device/<deviceId>/status
```

---

## 7. Tính năng cơ bản

* Login / logout
* Add Hub
* Add MQTT device
* Zigbee pairing
* Điều khiển thiết bị (command + trạng thái)
* Online / Offline
* Reset connection / Factory reset

```

---