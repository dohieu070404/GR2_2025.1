import React, { useEffect, useState } from "react";
import { api } from "../api";

export default function FleetPage() {
  const [hubs, setHubs] = useState([]);
  const [devices, setDevices] = useState([]);
  const [hubStatus, setHubStatus] = useState("");
  const [filter, setFilter] = useState({ homeId: "", modelId: "", online: "" });
  const [error, setError] = useState(null);

  async function loadHubs() {
    setError(null);
    try {
      const r = await api.listFleetHubs(hubStatus || undefined);
      setHubs(r.items || []);
    } catch (err) {
      setError(err?.message || "Không thể tải dữ liệu");
    }
  }

  async function loadDevices() {
    setError(null);
    try {
      const q = {};
      if (filter.homeId) q.homeId = filter.homeId;
      if (filter.modelId) q.modelId = filter.modelId;
      if (filter.online) q.online = filter.online;
      const r = await api.listFleetDevices(q);
      setDevices(r.items || []);
    } catch (err) {
      setError(err?.message || "Không thể tải dữ liệu");
    }
  }

  useEffect(() => {
    loadHubs();
    loadDevices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <div className="pageTitle">
        <h2>Đội thiết bị</h2>
        <span className="subtitle">Theo dõi Hub &amp; Thiết bị đang hoạt động</span>
      </div>

      {error ? <div className="error">{error}</div> : null}

      <div className="row">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Hubs</h3>

          <div className="row">
            <div>
              <div className="small">Trạng thái (status)</div>
              <select value={hubStatus} onChange={(e) => setHubStatus(e.target.value)}>
                {/* Không đổi value vì dùng trong query */}
                <option value="">Tất cả</option>
                <option value="online">Trực tuyến</option>
                <option value="offline">Ngoại tuyến</option>
              </select>
            </div>

            <div style={{ alignSelf: "end" }}>
              <button className="primary" onClick={loadHubs}>
                Làm mới
              </button>
            </div>
          </div>

          <div style={{ height: 12 }} />

          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>hubId</th>
                  <th>serial</th>
                  <th>home</th>
                  <th>Kết nối</th>
                  <th>lastSeen</th>
                  <th>fw</th>
                  <th>ip</th>
                  <th>rssi</th>
                </tr>
              </thead>
              <tbody>
                {hubs.map((h) => (
                  <tr key={h.hubId}>
                    <td>
                      <code>{h.hubId}</code>
                    </td>
                    <td>{h.serial || ""}</td>
                    <td>{h.boundHomeId}</td>
                    <td>
                      {h.online ? <span className="badge ok">Trực tuyến</span> : <span className="badge err">Ngoại tuyến</span>}
                    </td>
                    <td className="small">{h.lastSeen || ""}</td>
                    <td>{h.fwVersion || ""}</td>
                    <td>{h.ip || ""}</td>
                    <td>{h.rssi ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div style={{ height: 16 }} />

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Sức khỏe thiết bị</h3>

        <div className="row">
          <div>
            <div className="small">homeId</div>
            <input value={filter.homeId} onChange={(e) => setFilter({ ...filter, homeId: e.target.value })} />
          </div>

          <div>
            <div className="small">modelId</div>
            <input value={filter.modelId} onChange={(e) => setFilter({ ...filter, modelId: e.target.value })} />
          </div>

          <div>
            <div className="small">online</div>
            <select value={filter.online} onChange={(e) => setFilter({ ...filter, online: e.target.value })}>
              {/* Không đổi value vì dùng trong query */}
              <option value="">Tất cả</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </div>

          <div style={{ alignSelf: "end" }}>
            <button className="primary" onClick={loadDevices}>
              Làm mới
            </button>
          </div>
        </div>

        <div style={{ height: 12 }} />

        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>deviceDbId</th>
                <th>deviceId</th>
                <th>ieee</th>
                <th>protocol</th>
                <th>homeId</th>
                <th>Kết nối</th>
                <th>lastStateAt</th>
                <th>lastEventAt</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.deviceDbId}>
                  <td>{d.deviceDbId}</td>
                  <td>
                    <code>{d.deviceId}</code>
                  </td>
                  <td className="small">
                    <code>{d.ieee || ""}</code>
                  </td>
                  <td>{d.protocol}</td>
                  <td>{d.homeId}</td>
                  <td>
                    {d.online ? <span className="badge ok">Trực tuyến</span> : <span className="badge err">Ngoại tuyến</span>}
                  </td>
                  <td className="small">{d.lastStateAt || ""}</td>
                  <td className="small">{d.lastEventAt || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="small" style={{ marginBottom: 0, marginTop: 10 }}>
          * Lưu ý: các giá trị (protocol, status, ...) được lấy từ backend/DB nên giữ nguyên.
        </p>
      </div>
    </div>
  );
}
