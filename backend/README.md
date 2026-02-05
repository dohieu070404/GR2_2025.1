
---

````md
# SmartHome Backend

Backend SmartHome v5 sử dụng:

- Node.js / Express
- Prisma
- MySQL
- MQTT (Mosquitto)
- SSE realtime (`GET /events`)

Mục tiêu:
- Chạy được backend local bằng Docker
- Kết nối MQTT device / hub
- Mobile app dùng JWT + SSE

---

## 1. Yêu cầu

- Docker + Docker Compose
- (Tuỳ chọn) Node.js >= 18 để dev local
- (Tuỳ chọn) `mosquitto_pub`, `mosquitto_sub` để test MQTT

---

## 2. Chạy backend bằng Docker (khuyến nghị)

Từ thư mục `backend/`:

```bash
docker compose up -d --build
````

Lệnh này sẽ:

* Start MySQL
* Start Mosquitto (username/password, không anonymous)
* Build & start backend
* Tự động chạy Prisma migration (`prisma migrate deploy`)

---

## 3. Các service & port

* Backend API: [http://localhost:3000](http://localhost:3000)
* MySQL: localhost:3307
* MQTT: localhost:1883
* MQTT WebSocket: localhost:9001

---

## 4. Tài khoản mặc định (seed)

* **Admin**

  * `admin@example.com / admin123`
* **Demo user**

  * `demo@example.com / demo123`

---

## 5. Auth & JWT

Backend dùng **JWT Bearer token**:

```
Authorization: Bearer <token>
```

Login:

```
POST /auth/login
```

Register:

```
POST /auth/register
```

---

## 6. SSE realtime (cho mobile)

Endpoint:

```
GET /events
```

* Auth bằng JWT
* Mobile dùng để nhận realtime update:

  * device state
  * device status
  * command status

> Nếu backend chạy sau nginx / proxy, cần **tắt buffer cho SSE**.

---

## 7. MQTT contract (bắt buộc cho device MQTT)

Backend quản lý topic, device **không tự chọn topic**.

### Topics

```
home/<homeId>/device/<deviceId>/set
home/<homeId>/device/<deviceId>/ack
home/<homeId>/device/<deviceId>/state
home/<homeId>/device/<deviceId>/status
```

### Payload cơ bản

**Command (set):**

```json
{
  "cmdId": "uuid",
  "ts": 1234567890,
  "payload": {}
}
```

**ACK:**

```json
{
  "cmdId": "uuid",
  "ok": true,
  "ts": 123
}
```

**State (retain):**

```json
{
  "ts": 123,
  "state": {}
}
```

---

## 8. Reset backend & database

Xoá toàn bộ data (DB + volume):

```bash
docker compose down -v
```

---

## 9. Health check

* [http://localhost:3000/healthz](http://localhost:3000/healthz)
* [http://localhost:3000/readyz](http://localhost:3000/readyz)

---

## 10. Ghi chú

* Backend hỗ trợ multi-home, multi-user
* MQTT topic luôn scoped theo `homeId + deviceId`
* Command có tracking: `PENDING → ACKED / FAILED / TIMEOUT`
* Mobile app **không polling nhiều**, ưu tiên SSE

Chi tiết nâng cao xem thêm trong thư mục `docs/`.

```

---


```
