import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";

const ROLLOUT_STATUS_VI = {
  SUCCESS: "Thành công",
  FAILED: "Thất bại",
  RUNNING: "Đang chạy",
  PAUSED: "Tạm dừng",
  CREATED: "Mới tạo"
};

function Badge({ state }) {
  const cls =
    state === "SUCCESS"
      ? "badge ok"
      : state === "FAILED"
      ? "badge err"
      : state === "RUNNING"
      ? "badge warn"
      : "badge";
  return (
    <span className={cls} title={ROLLOUT_STATUS_VI[state] || ""}>
      {state}
    </span>
  );
}

export default function FirmwareRolloutsPage() {
  const navigate = useNavigate();
  const [releases, setReleases] = useState([]);
  const [hubs, setHubs] = useState([]);
  const [rollouts, setRollouts] = useState([]);
  const [releaseId, setReleaseId] = useState("");
  const [hubFilter, setHubFilter] = useState("");
  const [selectedHubs, setSelectedHubs] = useState({});
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [rRel, rHub, rRo] = await Promise.all([
      api.listFirmwareReleases(),
      api.listFleetHubs(),
      api.listFirmwareRollouts()
    ]);
    setReleases(rRel.items || []);
    setHubs(rHub.items || []);
    setRollouts(rRo.items || []);
  }

  useEffect(() => {
    refresh().catch((e) => setErr(e?.message || String(e)));
  }, []);

  const filteredHubs = useMemo(() => {
    const q = hubFilter.trim().toLowerCase();
    if (!q) return hubs;
    return hubs.filter(
      (h) => String(h.hubId).toLowerCase().includes(q) || String(h.serial || "").toLowerCase().includes(q)
    );
  }, [hubs, hubFilter]);

  async function createRollout() {
    setErr(null);
    setBusy(true);
    try {
      const hubIds = Object.keys(selectedHubs).filter((k) => selectedHubs[k]);
      if (!releaseId) throw new Error("Vui lòng chọn 1 bản phát hành");
      if (!hubIds.length) throw new Error("Vui lòng chọn ít nhất 1 hub");
      const r = await api.createFirmwareRollout({ releaseId: Number(releaseId), hubIds });
      const id = r.rollout?.id;
      await refresh();
      if (id) navigate(`/firmware/rollouts/${id}`);
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="pageTitle">
        <h2>Triển khai firmware</h2>
        <span className="subtitle">Firmware Rollouts</span>
      </div>

      {err ? <div className="error">{err}</div> : null}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Tạo rollout</h3>

        <div className="row">
          <div>
            <label>
              Bản phát hành (Release)
              <select value={releaseId} onChange={(e) => setReleaseId(e.target.value)}>
                <option value="">-- chọn --</option>
                {releases.map((r) => (
                  <option key={r.id} value={String(r.id)}>
                    #{r.id} {r.version}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div>
            <label>
              Lọc hub
              <input value={hubFilter} onChange={(e) => setHubFilter(e.target.value)} placeholder="hubId hoặc serial" />
            </label>
          </div>
        </div>

        <div
          className="tableWrap"
          style={{ maxHeight: 280, padding: 10, marginTop: 12, minWidth: 320 }}
        >
          {filteredHubs.map((h) => (
            <label
              key={h.hubId}
              style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8 }}
            >
              <input
                type="checkbox"
                checked={!!selectedHubs[h.hubId]}
                onChange={(e) => setSelectedHubs({ ...selectedHubs, [h.hubId]: e.target.checked })}
              />
              <span className="mono">{h.hubId}</span>
              {h.serial ? <span className="small">serial: {h.serial}</span> : null}
              <span className={h.online ? "badge ok" : "badge err"}>{h.online ? "Trực tuyến" : "Ngoại tuyến"}</span>
            </label>
          ))}
        </div>

        <button className="primary" disabled={busy} onClick={createRollout} style={{ marginTop: 12 }}>
          Tạo rollout
        </button>
      </div>

      <div style={{ height: 16 }} />

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Các rollout đã tạo</h3>

        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Status</th>
                <th>Release</th>
                <th>Counts</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rollouts.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/firmware/rollouts/${r.id}`} className="mono">
                      #{r.id}
                    </Link>
                  </td>
                  <td>
                    <Badge state={r.status} />
                  </td>
                  <td>{r.release?.version || ""}</td>
                  <td className="small">
                    {Object.entries(r.counts || {}).map(([k, v]) => (
                      <span key={k} style={{ marginRight: 10 }}>
                        {k}:{String(v)}
                      </span>
                    ))}
                  </td>
                  <td>{r.updatedAt ? new Date(r.updatedAt).toLocaleString() : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="small" style={{ marginBottom: 0, marginTop: 10 }}>
          * Các mã <code>status</code> và số liệu <code>counts</code> đến từ backend/DB nên giữ nguyên.
        </p>
      </div>
    </div>
  );
}
