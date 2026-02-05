import React, { useEffect, useState } from "react";
import { api } from "../api";

export default function FirmwareReleasesPage() {
  const [items, setItems] = useState([]);
  const [form, setForm] = useState({ version: "", url: "", sha256: "", size: "", notes: "" });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const r = await api.listFirmwareReleases();
    setItems(r.items || []);
  }

  useEffect(() => {
    refresh().catch((e) => setErr(e?.message || String(e)));
  }, []);

  async function createRelease() {
    setErr(null);
    setBusy(true);
    try {
      // Không đổi targetType/value vì dùng trong DB/backend
      await api.createFirmwareRelease({
        targetType: "HUB",
        version: form.version.trim(),
        url: form.url.trim(),
        sha256: form.sha256.trim(),
        size: form.size.trim() ? Number(form.size.trim()) : undefined,
        notes: form.notes.trim() || undefined
      });
      setForm({ version: "", url: "", sha256: "", size: "", notes: "" });
      await refresh();
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="pageTitle">
        <h2>Bản phát hành firmware (Hub OTA)</h2>
        <span className="subtitle">Firmware Releases</span>
      </div>

      <p className="small" style={{ marginTop: 0 }}>
        Tạo bản ghi phát hành firmware (file nhị phân phải truy cập được qua HTTP/HTTPS).
      </p>

      {err ? <div className="error">{err}</div> : null}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Tạo bản phát hành</h3>

        <div className="grid2">
          <label>
            Phiên bản (version)
            <input
              value={form.version}
              onChange={(e) => setForm({ ...form, version: e.target.value })}
              placeholder="hub_host@1.0.1"
            />
          </label>

          <label>
            Kích thước (bytes, tùy chọn)
            <input value={form.size} onChange={(e) => setForm({ ...form, size: e.target.value })} placeholder="..." />
          </label>

          <label className="col2">
            URL
            <input
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="http://<host>/firmware.bin"
            />
          </label>

          <label className="col2">
            SHA256 (hex)
            <input value={form.sha256} onChange={(e) => setForm({ ...form, sha256: e.target.value })} placeholder="64-hex" />
          </label>

          <label className="col2">
            Ghi chú (notes)
            <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="tùy chọn" />
          </label>
        </div>

        <div style={{ height: 12 }} />

        <button className="primary" disabled={busy} onClick={createRelease}>
          Tạo
        </button>
      </div>

      <div style={{ height: 16 }} />

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Danh sách bản phát hành</h3>

        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Version</th>
                <th>SHA256</th>
                <th>Size</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td>{r.id}</td>
                  <td>{r.version}</td>
                  <td className="mono">{r.sha256}</td>
                  <td>{r.size ?? ""}</td>
                  <td>{r.createdAt ? new Date(r.createdAt).toLocaleString() : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="small" style={{ marginBottom: 0, marginTop: 10 }}>
          * Các giá trị <code>version</code>, <code>sha256</code>... được lưu trong DB nên giữ nguyên.
        </p>
      </div>
    </div>
  );
}
