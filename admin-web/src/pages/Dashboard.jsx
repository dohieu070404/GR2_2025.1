import React, { useEffect, useState } from "react";
import { api } from "../api";

export default function DashboardPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .dashboard()
      .then((d) => setData(d))
      .catch((err) => setError(err?.message || "Không thể tải dữ liệu"));
  }, []);

  return (
    <div>
      <div className="pageTitle">
        <h2>Tổng quan</h2>
        <span className="subtitle">Số liệu nhanh</span>
      </div>

      {error ? <div className="error">{error}</div> : null}

      <div className="row">
        <div className="card">
          <div className="small">Hub trực tuyến</div>
          <h1 style={{ margin: "8px 0 0" }}>{data ? data.hubOnline : "–"}</h1>
        </div>
        <div className="card">
          <div className="small">Hub ngoại tuyến</div>
          <h1 style={{ margin: "8px 0 0" }}>{data ? data.hubOffline : "–"}</h1>
        </div>
        <div className="card">
          <div className="small">Lệnh lỗi (24h)</div>
          <h1 style={{ margin: "8px 0 0" }}>{data ? data.cmdFail24h : "–"}</h1>
        </div>
      </div>

      <div style={{ height: 16 }} />

      <div className="card">
        <div className="small">Gợi ý thao tác</div>
        <ul style={{ marginTop: 10 }}>
          <li>
            <b>Tồn kho</b>: tạo theo lô serial Hub/Device và mã cài đặt.
          </li>
          <li>
            <b>Đội thiết bị</b>: theo dõi online/offline, lastSeen, fwVersion.
          </li>
          <li>
            <b>Lệnh</b>: thử lại các lệnh pending/failed (chỉ lệnh không nhạy cảm).
          </li>
        </ul>
      </div>
    </div>
  );
}
