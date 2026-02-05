import React, { useState } from "react";
import { api } from "../api";

function todayUtc() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function EventsPage() {
  const [filters, setFilters] = useState({ homeId: "", deviceId: "", date: todayUtc(), type: "" });
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);

  async function load() {
    setError(null);
    try {
      const q = {};
      if (filters.homeId) q.homeId = filters.homeId;
      if (filters.deviceId) q.deviceId = filters.deviceId;
      if (filters.date) q.date = filters.date;
      if (filters.type) q.type = filters.type;
      q.limit = "200";
      const r = await api.listEvents(q);
      setItems(r.items || []);
    } catch (err) {
      setError(err?.message || "Không thể tải dữ liệu");
    }
  }

  return (
    <div>
      <div className="pageTitle">
        <h2>Tra cứu sự kiện</h2>
        <span className="subtitle">Events Explorer</span>
      </div>

      {error ? <div className="error">{error}</div> : null}

      <div className="card">
        <div className="row">
          <div>
            <div className="small">homeId</div>
            <input value={filters.homeId} onChange={(e) => setFilters({ ...filters, homeId: e.target.value })} />
          </div>

          <div>
            <div className="small">deviceId (db id)</div>
            <input value={filters.deviceId} onChange={(e) => setFilters({ ...filters, deviceId: e.target.value })} />
          </div>

          <div>
            <div className="small">Ngày (UTC)</div>
            <input value={filters.date} onChange={(e) => setFilters({ ...filters, date: e.target.value })} placeholder={todayUtc()} />
          </div>

          <div>
            <div className="small">type</div>
            <input value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })} placeholder="vd: motion.detected" />
          </div>

          <div style={{ alignSelf: "end" }}>
            <button className="primary" onClick={load}>
              Tải dữ liệu
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
                <th>time</th>
                <th>type</th>
                <th>device</th>
                <th>homeId</th>
                <th>data</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id}>
                  <td className="small">{e.createdAt}</td>
                  <td>
                    <code>{e.type}</code>
                  </td>
                  <td className="small">
                    <div>dbId={e.device?.id}</div>
                    <div>
                      <code>{e.device?.deviceId}</code>
                    </div>
                    <div>
                      <code>{e.device?.zigbeeIeee || ""}</code>
                    </div>
                  </td>
                  <td>{e.device?.homeId}</td>
                  <td className="small">
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(e.data || {}, null, 2)}</pre>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="small" style={{ marginBottom: 0, marginTop: 10 }}>
          * Các giá trị <code>type</code> và nội dung <code>data</code> đến từ backend/DB nên giữ nguyên.
        </p>
      </div>
    </div>
  );
}
