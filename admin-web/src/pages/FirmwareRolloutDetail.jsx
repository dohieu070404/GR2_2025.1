import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";

const STATE_VI = {
  SUCCESS: "Thành công",
  FAILED: "Thất bại",
  RUNNING: "Đang chạy",
  DOWNLOADING: "Đang tải xuống",
  APPLYING: "Đang áp dụng",
  CREATED: "Mới tạo",
  PAUSED: "Tạm dừng"
};

function Badge({ state }) {
  const cls =
    state === "SUCCESS"
      ? "badge ok"
      : state === "FAILED"
      ? "badge err"
      : state === "RUNNING" || state === "DOWNLOADING" || state === "APPLYING"
      ? "badge warn"
      : "badge";

  return (
    <span className={cls} title={STATE_VI[state] || ""}>
      {state}
    </span>
  );
}

export default function FirmwareRolloutDetailPage() {
  const { id } = useParams();
  const rolloutId = Number(id);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  async function refresh() {
    const r = await api.getFirmwareRollout(String(rolloutId));
    setData(r);
  }

  useEffect(() => {
    if (!rolloutId) return;
    refresh().catch((e) => setErr(e?.message || String(e)));
    const t = setInterval(() => {
      refresh().catch(() => {});
    }, 2500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rolloutId]);

  async function start() {
    setErr(null);
    try {
      await api.startFirmwareRollout(String(rolloutId));
      await refresh();
    } catch (e) {
      setErr(e?.message || String(e));
    }
  }

  async function pause() {
    setErr(null);
    try {
      await api.pauseFirmwareRollout(String(rolloutId));
      await refresh();
    } catch (e) {
      setErr(e?.message || String(e));
    }
  }

  if (!rolloutId || Number.isNaN(rolloutId)) return <div>Mã rollout không hợp lệ</div>;

  const ro = data?.rollout;
  const rel = data?.release;
  const progress = data?.progress || [];

  return (
    <div>
      <div className="pageTitle">
        <h2>Triển khai #{rolloutId}</h2>
        <span className="subtitle">Rollout detail</span>
      </div>

      {err ? <div className="error">{err}</div> : null}

      <div className="card">
        <div className="row" style={{ alignItems: "center" }}>
          <div>
            <div className="small">Bản phát hành (Release)</div>
            <div>
              <b>{rel?.version || ""}</b> <span className="small">(#{rel?.id || ""})</span>
            </div>
            <div className="small mono" style={{ marginTop: 6 }}>
              {rel?.sha256 || ""}
            </div>
          </div>

          <div>
            <div className="small">Trạng thái</div>
            <div style={{ marginTop: 4 }}>
              <Badge state={ro?.status || ""} />
            </div>
          </div>

          <div style={{ marginLeft: "auto" }}>
            <button className="primary" onClick={start} disabled={ro?.status === "RUNNING"}>
              Bắt đầu
            </button>
            <span style={{ marginLeft: 8 }} />
            <button className="danger" onClick={pause} disabled={ro?.status !== "RUNNING"}>
              Tạm dừng
            </button>
          </div>
        </div>

        <p className="small" style={{ marginBottom: 0, marginTop: 10 }}>
          * Các mã trạng thái (RUNNING/SUCCESS/...) được lưu/điều khiển ở backend nên giữ nguyên.
        </p>
      </div>

      <div style={{ height: 16 }} />

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Tiến độ</h3>

        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Hub</th>
                <th>Kết nối</th>
                <th>State</th>
                <th>Attempt</th>
                <th>CmdId</th>
                <th>Sent</th>
                <th>Ack</th>
                <th>Last msg</th>
              </tr>
            </thead>
            <tbody>
              {progress.map((p) => (
                <tr key={p.hubId}>
                  <td className="mono">{p.hubId}</td>
                  <td>
                    <span className={p.online ? "badge ok" : "badge err"}>{p.online ? "Trực tuyến" : "Ngoại tuyến"}</span>
                  </td>
                  <td>
                    <Badge state={p.state} />
                  </td>
                  <td>{p.attempt}</td>
                  <td className="mono">{p.cmdId || ""}</td>
                  <td>{p.sentAt ? new Date(p.sentAt).toLocaleString() : ""}</td>
                  <td>{p.ackedAt ? new Date(p.ackedAt).toLocaleString() : ""}</td>
                  <td className="small">{p.lastMsg || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
