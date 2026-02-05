# Zigbee End-Device Switch – ESP‑IDF skeleton

Project: `firmware/idf/zigbee_enddevice_switch/`

Thiết bị "công tắc" thường có 2 hướng:

1) **Switch điều khiển tải tại chỗ** (có relay) – thực chất giống On/Off Light.
2) **Switch gửi lệnh điều khiển thiết bị khác** (On/Off Switch) – gửi ZCL On/Off Toggle.

Trong ecosystem kiểu Xiaomi, (2) phổ biến và thường dùng binding/group để điều khiển đèn.

Skeleton này bạn có thể mở rộng để:

- Khi nhấn nút: gửi `toggle` tới coordinator, coordinator publish MQTT event.

Chú ý: app/back-end hiện tại thiên về "device state" hơn là "event", vì vậy bạn có thể bắt đầu với (1) trước.
