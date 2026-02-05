import React, { useState } from "react";
import { api } from "../api";

function todayUtc() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const STATUS_VI = {
  PENDING: "Đang chờ",
  ACKED: "Đã nhận",
  FAILED: "Thất bại",
  TIMEOUT: "Quá hạn"
};

export default function CommandsPage() {
  const [filters, setFilters] = useState({ status: "failed", deviceId: "", date: "" });
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setError(null);
    setLoading(true);
    try {
      const q = {};
      if (filters.status) q.status = String(filters.status).toUpperCase();
      if (filters.deviceId) q.deviceId = filters.deviceId;
      if (filters.date) q.date = filters.date;
      q.limit = "200";
      const r = await api.listCommands(q);
      setItems(r.items || []);
    } catch (err) {
      setError(err?.message || "Không thể tải dữ liệu");
    } finally {
      setLoading(false);
    }
  }

  async function retry(id) {
    setError(null);
    try {
      await api.retryCommand(id);
      await load();
    } catch (err) {
      setError(err?.message || "Thử lại thất bại");
    }
  }

  return (
    <div>
      <div className="pageTitle">
        <h2>Trung tâm lệnh</h2>
        <span className="subtitle">Command Center</span>
      </div>

      {error ? <div className="error">{error}</div> : null}

      <div className="card">
        <div className="row">
          <div>
            <div className="small">Trạng thái (status)</div>
            <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
              {/* Không đổi value vì dùng trong query */}
              <option value="">Tất cả</option>
              <option value="pending">Đang chờ</option>
              <option value="acked">Đã nhận</option>
              <option value="failed">Thất bại</option>
              <option value="timeout">Quá hạn</option>
            </select>
          </div>

          <div>
            <div className="small">deviceId (db id)</div>
            <input value={filters.deviceId} onChange={(e) => setFilters({ ...filters, deviceId: e.target.value })} />
          </div>

          <div>
            <div className="small">Ngày (UTC)</div>
            <input
              placeholder={todayUtc()}
              value={filters.date}
              onChange={(e) => setFilters({ ...filters, date: e.target.value })}
            />
          </div>

          <div style={{ alignSelf: "end" }}>
            <button className="primary" onClick={load} disabled={loading}>
              {loading ? "Đang tải..." : "Tải dữ liệu"}
            </button>
          </div>
        </div>

        <div style={{ height: 12 }} />
        <div className="small">Số bản ghi: {items.length}</div>
      </div>

      <div style={{ height: 16 }} />

      <div className="card">
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>sentAt</th>
                <th>status</th>
                <th>latency</th>
                <th>device</th>
                <th>cmdId</th>
                <th>payload</th>
                <th>action</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => {
                const st = String(c.status || "").toUpperCase();
                const badge =
                  st === "ACKED" ? "ok" : st === "PENDING" ? "warn" : st === "TIMEOUT" ? "warn" : "err";

                return (
                  <tr key={c.id}>
                    <td className="small">{c.sentAt}</td>
                    <td>
                      <span className={`badge ${badge}`} title={STATUS_VI[st] || ""}>
                        {st}
                      </span>
                    </td>
                    <td className="small">{c.latencyMs != null ? `${c.latencyMs} ms` : ""}</td>
                    <td className="small">
                      <div>dbId={c.device?.id}</div>
                      <div>
                        <code>{c.device?.deviceId}</code>
                      </div>
                      <div>{c.device?.protocol}</div>
                      <div>
                        <code>{c.device?.zigbeeIeee || ""}</code>
                      </div>
                    </td>
                    <td className="small">
                      <code>{c.cmdId}</code>
                    </td>
                    <td className="small">
                      <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(c.payload || {}, null, 2)}</pre>
                    </td>
                    <td>
                      {st === "FAILED" || st === "TIMEOUT" || st === "PENDING" ? (
                        <button className="danger" onClick={() => retry(String(c.id))}>
                          Thử lại
                        </button>
                      ) : null}
                      {c.error ? <div className="small">{c.error}</div> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="small" style={{ marginBottom: 0, marginTop: 10 }}>
          * Các mã <code>status</code> và nội dung <code>payload</code> đến từ backend/DB nên giữ nguyên.
        </p>
      </div>
    </div>
  );
}
