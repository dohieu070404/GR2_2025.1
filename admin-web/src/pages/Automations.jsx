import React, { useEffect, useMemo, useState } from "react";
import { api } from "../api";

export default function AutomationsPage() {
  const [homeIdInput, setHomeIdInput] = useState("");
  const homeId = useMemo(() => {
    const n = Number(homeIdInput);
    return Number.isInteger(n) && n > 0 ? n : null;
  }, [homeIdInput]);

  const [devices, setDevices] = useState([]);
  const [rules, setRules] = useState([]);
  const [version, setVersion] = useState(0);
  const [hubId, setHubId] = useState(null);
  const [deployment, setDeployment] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const [lockDevId, setLockDevId] = useState(null);
  const [gateDevId, setGateDevId] = useState(null);
  const [motionDevId, setMotionDevId] = useState(null);
  const [lightDevId, setLightDevId] = useState(null);
  const [autoOffSec, setAutoOffSec] = useState(30);

  const zbDevices = useMemo(() => devices.filter((d) => d.ieee), [devices]);

  const lockCandidates = useMemo(() => {
    return zbDevices.filter((d) => String(d.modelId || "").toLowerCase().includes("lock"));
  }, [zbDevices]);

  const gateCandidates = useMemo(() => {
    return zbDevices.filter((d) => String(d.modelId || "").toLowerCase().includes("gate"));
  }, [zbDevices]);

  const motionCandidates = useMemo(() => {
    // Most motion events currently come from the Gate PIR device.
    return zbDevices;
  }, [zbDevices]);

  const lightCandidates = useMemo(() => {
    return zbDevices;
  }, [zbDevices]);

  async function refresh() {
    if (!homeId) {
      setMsg("Vui lòng nhập homeId là số hợp lệ (vd: 1)");
      return;
    }

    setBusy(true);
    setMsg("");
    try {
      const [autoRes, devRes, hubsRes] = await Promise.all([
        api.listHomeAutomations(homeId),
        api.listFleetDevices({ homeId: String(homeId) }),
        api.listFleetHubs()
      ]);

      setRules(autoRes.rules || []);
      setVersion(autoRes.version || 0);
      setDevices(devRes.items || []);

      const hub = (hubsRes.items || []).find((h) => Number(h.boundHomeId) === homeId);
      setHubId(hub?.hubId || null);

      if (hub?.hubId) {
        const st = await api.getHubAutomationStatus(hub.hubId);
        setDeployment(st.deployment || null);
      } else {
        setDeployment(null);
      }

      // Friendly defaults
      if (!lockDevId && lockCandidates.length) setLockDevId(lockCandidates[0].deviceDbId);
      if (!gateDevId && gateCandidates.length) setGateDevId(gateCandidates[0].deviceDbId);
      if (!motionDevId && motionCandidates.length) setMotionDevId(motionCandidates[0].deviceDbId);
      if (!lightDevId && lightCandidates.length) setLightDevId(lightCandidates[0].deviceDbId);
    } catch (err) {
      setMsg(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    // auto refresh when homeId becomes valid
    if (homeId) {
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeId]);

  async function createTemplateLockGate() {
    if (!homeId) return;
    if (!lockDevId || !gateDevId) {
      setMsg("Vui lòng chọn cả Lock + Gate");
      return;
    }
    setBusy(true);
    setMsg("");
    try {
      // Lưu ý: Không đổi các trường/các mã ở body vì có thể được lưu trong DB.
      const body = {
        name: "Lock unlock -> Gate open",
        enabled: true,
        triggerType: "EVENT",
        trigger: {
          deviceId: lockDevId,
          eventType: "lock.unlock",
          dataMatch: { success: true }
        },
        actions: [
          {
            deviceId: gateDevId,
            action: "gate.open",
            params: { source: "auto" }
          }
        ],
        executionPolicy: { cooldownSec: 2 }
      };
      await api.createHomeAutomation(homeId, body);
      await refresh();
      setMsg("Đã tạo mẫu: Lock unlock -> Gate open");
    } catch (err) {
      setMsg(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function createTemplateMotionLight() {
    if (!homeId) return;
    if (!motionDevId || !lightDevId) {
      setMsg("Vui lòng chọn cả Motion + Light");
      return;
    }
    const sec = Math.max(1, Math.min(3600, Math.floor(autoOffSec || 0)));
    setBusy(true);
    setMsg("");
    try {
      // Lưu ý: Không đổi các trường/các mã ở body vì có thể được lưu trong DB.
      const body = {
        name: `Motion -> Light on (${sec}s auto-off)`,
        enabled: true,
        triggerType: "EVENT",
        trigger: {
          deviceId: motionDevId,
          eventType: "motion.detected",
          dataMatch: { level: 1 }
        },
        actions: [
          {
            deviceId: lightDevId,
            action: "light.set",
            params: { on: true, autoOffSec: sec, source: "auto" }
          }
        ],
        executionPolicy: { cooldownSec: 2 }
      };
      await api.createHomeAutomation(homeId, body);
      await refresh();
      setMsg("Đã tạo mẫu: Motion -> Light on + auto-off");
    } catch (err) {
      setMsg(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleRule(r, enabled) {
    setBusy(true);
    setMsg("");
    try {
      if (enabled) await api.enableAutomation(r.id);
      else await api.disableAutomation(r.id);
      await refresh();
    } catch (err) {
      setMsg(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteRule(r) {
    if (!window.confirm(`Xóa automation #${r.id}?`)) return;
    setBusy(true);
    setMsg("");
    try {
      await api.deleteAutomation(r.id);
      await refresh();
    } catch (err) {
      setMsg(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  const isSuccess = msg.startsWith("Đã") || msg.toLowerCase().includes("created");

  const msgStyle = {
    color: msg ? (isSuccess ? "#bbf7d0" : "#fca5a5") : undefined,
    marginBottom: 0
  };

  return (
    <div>
      <div className="pageTitle">
        <h2>Tự động hóa</h2>
        <span className="subtitle">Tạo/Quản lý rules theo homeId</span>
      </div>

      <div className="card">
        <div className="row" style={{ alignItems: "end" }}>
          <div>
            <label>homeId</label>
            <input
              value={homeIdInput}
              onChange={(e) => setHomeIdInput(e.target.value)}
              placeholder="vd: 1"
              style={{ width: 160 }}
            />
          </div>

          <div>
            <button className="primary" disabled={busy} onClick={refresh}>
              Làm mới
            </button>
          </div>

          <div style={{ flex: 1 }} />

          <div className="small">
            Phiên bản: <b>{version}</b>
            {hubId ? (
              <span>
                {" "}
                | Hub: <b>{hubId}</b>
              </span>
            ) : null}
          </div>
        </div>

        {msg ? <p className="small" style={msgStyle}>{msg}</p> : null}
      </div>

      <div style={{ height: 16 }} />

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Trạng thái triển khai (deployment)</h3>

        {deployment ? (
          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Desired</th>
                  <th>Applied</th>
                  <th>UpdatedAt</th>
                  <th>LastMsg</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{deployment.status}</td>
                  <td>{deployment.desiredVersion}</td>
                  <td>{deployment.appliedVersion}</td>
                  <td>{deployment.updatedAt}</td>
                  <td
                    style={{
                      maxWidth: 520,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap"
                    }}
                    title={deployment.lastMsg || ""}
                  >
                    {deployment.lastMsg || ""}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <div className="small">Chưa có deployment (tạo ít nhất 1 rule để trigger đồng bộ).</div>
        )}
      </div>

      <div style={{ height: 16 }} />

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Tạo mẫu nhanh (templates)</h3>

        <div className="row">
          <div style={{ minWidth: 260 }}>
            <b>Mẫu 1</b>: IF <code>lock.unlock</code> success=true THEN <code>gate.open</code>
            <div className="small">(Zigbee plane: chọn thiết bị theo DB id)</div>
          </div>

          <div>
            <label>Lock</label>
            <select value={lockDevId ?? ""} onChange={(e) => setLockDevId(Number(e.target.value) || null)}>
              <option value="">Chọn...</option>
              {(lockCandidates.length ? lockCandidates : zbDevices).map((d) => (
                <option key={d.deviceDbId} value={d.deviceDbId}>
                  #{d.deviceDbId} {d.modelId || ""} ({d.ieee})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label>Gate</label>
            <select value={gateDevId ?? ""} onChange={(e) => setGateDevId(Number(e.target.value) || null)}>
              <option value="">Chọn...</option>
              {(gateCandidates.length ? gateCandidates : zbDevices).map((d) => (
                <option key={d.deviceDbId} value={d.deviceDbId}>
                  #{d.deviceDbId} {d.modelId || ""} ({d.ieee})
                </option>
              ))}
            </select>
          </div>

          <div style={{ alignSelf: "end" }}>
            <button className="primary" disabled={busy || !homeId} onClick={createTemplateLockGate}>
              Tạo
            </button>
          </div>
        </div>

        <hr />

        <div className="row">
          <div style={{ minWidth: 260 }}>
            <b>Mẫu 2</b>: IF <code>motion.detected</code> THEN <code>light.set</code> on + auto-off
          </div>

          <div>
            <label>Motion device</label>
            <select value={motionDevId ?? ""} onChange={(e) => setMotionDevId(Number(e.target.value) || null)}>
              <option value="">Chọn...</option>
              {motionCandidates.map((d) => (
                <option key={d.deviceDbId} value={d.deviceDbId}>
                  #{d.deviceDbId} {d.modelId || ""} ({d.ieee})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label>Light device</label>
            <select value={lightDevId ?? ""} onChange={(e) => setLightDevId(Number(e.target.value) || null)}>
              <option value="">Chọn...</option>
              {lightCandidates.map((d) => (
                <option key={d.deviceDbId} value={d.deviceDbId}>
                  #{d.deviceDbId} {d.modelId || ""} ({d.ieee})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label>autoOffSec</label>
            <input
              type="number"
              value={autoOffSec}
              onChange={(e) => setAutoOffSec(Number(e.target.value))}
              style={{ width: 160 }}
            />
          </div>

          <div style={{ alignSelf: "end" }}>
            <button className="primary" disabled={busy || !homeId} onClick={createTemplateMotionLight}>
              Tạo
            </button>
          </div>
        </div>

        <p className="small" style={{ marginBottom: 0, marginTop: 10 }}>
          * Lưu ý: <b>Không đổi</b> các mã sự kiện/command (vd: <code>lock.unlock</code>, <code>gate.open</code>) vì chúng được xử lý ở backend và có thể lưu trong DB.
        </p>
      </div>

      <div style={{ height: 16 }} />

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Danh sách rules</h3>

        {rules.length ? (
          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Tên</th>
                  <th>Bật</th>
                  <th>Trigger</th>
                  <th>Actions</th>
                  <th>Version</th>
                  <th>UpdatedAt</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id}>
                    <td>{r.id}</td>
                    <td>{r.name}</td>
                    <td>
                      <input
                        type="checkbox"
                        checked={!!r.enabled}
                        onChange={(e) => toggleRule(r, e.target.checked)}
                        disabled={busy}
                      />
                    </td>
                    <td
                      className="small"
                      style={{
                        maxWidth: 320,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap"
                      }}
                      title={JSON.stringify(r.trigger)}
                    >
                      {r.triggerType}: {r.trigger?.eventType || ""}
                    </td>
                    <td
                      className="small"
                      style={{
                        maxWidth: 360,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap"
                      }}
                      title={JSON.stringify(r.actions)}
                    >
                      {Array.isArray(r.actions) ? r.actions.map((a) => a.action).join(", ") : ""}
                    </td>
                    <td>{r.version}</td>
                    <td className="small">{r.updatedAt}</td>
                    <td>
                      <button disabled={busy} onClick={() => deleteRule(r)}>
                        Xóa
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="small">Chưa có rule nào. Hãy tạo từ các mẫu phía trên.</div>
        )}
      </div>
    </div>
  );
}
