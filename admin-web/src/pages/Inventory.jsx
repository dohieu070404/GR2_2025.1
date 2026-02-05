import React, { useEffect, useMemo, useState } from "react";
import { api } from "../api";

function downloadText(filename, text, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function detectDelimiter(line) {
  const s = String(line || "");
  const comma = (s.match(/,/g) || []).length;
  const semi = (s.match(/;/g) || []).length;
  const tab = (s.match(/\t/g) || []).length;
  if (tab > comma && tab > semi) return "\t";
  if (semi > comma) return ";";
  return ",";
}

function splitCsvLine(line, delimiter) {
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      // Escape: "" inside quotes
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (ch === delimiter && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }

    cur += ch;
  }

  out.push(cur);
  return out;
}

function parseCsv(text) {
  const raw = String(text || "").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { headers: [], rows: [], delimiter: "," };

  const delimiter = detectDelimiter(lines[0]);
  const headers = splitCsvLine(lines[0], delimiter).map((h) => h.trim());

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i], delimiter);
    rows.push(cols);
  }

  return { headers, rows, delimiter };
}

function canonHeader(h) {
  return String(h || "")
    .trim()
    .replace(/^\uFEFF/, "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

const HUB_HEADER_ALIASES = {
  hubid: "hubId",
  hub: "hubId",
  serial: "serial",
  sn: "serial",
  modelid: "modelId",
  model: "modelId",
  status: "status",
  trangthai: "status",
  setupcode: "setupCode",
  setup: "setupCode",
  setupcodeplaintext: "setupCode"
};

const DEVICE_HEADER_ALIASES = {
  serial: "serial",
  sn: "serial",
  deviceuuid: "deviceUuid",
  uuid: "deviceUuid",
  typedefault: "typeDefault",
  type: "typeDefault",
  loai: "typeDefault",
  protocol: "protocol",
  giaothuc: "protocol",
  model: "model",
  modelid: "modelId",
  status: "status",
  trangthai: "status",
  setupcode: "setupCode",
  setup: "setupCode",
  setupcodeplaintext: "setupCode"
};

function buildItemsFromCsv(text, kind) {
  const { headers, rows, delimiter } = parseCsv(text);
  const errors = [];

  if (!headers.length) {
    return { items: [], errors: ["CSV trống hoặc không có header."], headers: [], delimiter };
  }

  const aliases = kind === "hubs" ? HUB_HEADER_ALIASES : DEVICE_HEADER_ALIASES;
  const mapped = headers.map((h) => aliases[canonHeader(h)] || null);

  const unknownHeaders = headers
    .map((h, i) => ({ h, i }))
    .filter(({ i }) => !mapped[i])
    .map(({ h }) => h);

  const items = [];

  rows.forEach((cols, idx) => {
    const rowNum = idx + 2; // + header
    const obj = {};

    for (let i = 0; i < mapped.length; i++) {
      const field = mapped[i];
      if (!field) continue;
      const v = (cols[i] ?? "").trim();
      if (v !== "") obj[field] = v;
    }

    // Skip empty row
    if (Object.keys(obj).length === 0) return;

    if (kind === "hubs") {
      if (!obj.hubId && obj.serial) obj.hubId = obj.serial;
      if (!obj.serial && obj.hubId) obj.serial = obj.hubId;
      if (!obj.status) obj.status = "FACTORY_NEW";

      const missing = [];
      if (!obj.hubId && !obj.serial) missing.push("hubId/serial");
      if (!obj.modelId) missing.push("modelId");
      if (!obj.setupCode) missing.push("setupCode");

      if (missing.length) {
        errors.push(`Dòng ${rowNum}: thiếu ${missing.join(", ")}`);
        return;
      }

      items.push(obj);
      return;
    }

    // devices
    if (!obj.status) obj.status = "FACTORY_NEW";

    const missing = [];
    if (!obj.serial) missing.push("serial");
    if (!obj.protocol) missing.push("protocol");
    if (!obj.typeDefault) missing.push("typeDefault");
    if (!obj.modelId) missing.push("modelId");
    if (!obj.setupCode) missing.push("setupCode");

    if (missing.length) {
      errors.push(`Dòng ${rowNum}: thiếu ${missing.join(", ")}`);
      return;
    }

    // Defaults (không bắt buộc giống seed.js, nhưng giúp import nhanh)
    if (!obj.deviceUuid) obj.deviceUuid = `dev-${obj.serial}`;
    if (!obj.model) obj.model = String(obj.modelId).toLowerCase().replace(/_/g, "-");

    items.push(obj);
  });

  return { items, errors, headers, delimiter, unknownHeaders };
}

const HUB_TEMPLATE_CSV =
  "hubId,serial,modelId,status,setupCode\n" +
  "hub-demo,hub-demo,HUB_V1,FACTORY_NEW,00000000\n";

const DEVICE_TEMPLATE_CSV =
  "serial,deviceUuid,typeDefault,protocol,model,modelId,status,setupCode\n" +
  "dev-serial-001,dev-001,dimmer,MQTT,dimmer-v1,DIMMER_V1,FACTORY_NEW,00000000\n" +
  "zb-serial-001,dev-zb-001,sensor,ZIGBEE,th-sensor-v1,TH_SENSOR_V1,FACTORY_NEW,00000000\n";

export default function InventoryPage() {
  const [models, setModels] = useState([]);
  const [hubInv, setHubInv] = useState([]);
  const [devInv, setDevInv] = useState([]);
  const [error, setError] = useState(null);

  const [newModel, setNewModel] = useState({
    id: "",
    name: "",
    manufacturer: "SmartHome",
    protocol: "ZIGBEE"
  });

  const [hubBatch, setHubBatch] = useState({ count: 5, prefix: "hub-", modelId: "HUB_V1" });
  const [devBatch, setDevBatch] = useState({
    count: 5,
    prefix: "SN-",
    protocol: "ZIGBEE",
    type: "relay",
    modelId: "TH_SENSOR_V1"
  });

  // --- Manual add (đủ trường như seed.js) ---
  const [newHubItem, setNewHubItem] = useState({
    hubId: "",
    serial: "",
    modelId: "HUB_V1",
    status: "FACTORY_NEW",
    setupCode: ""
  });

  const [newDeviceItem, setNewDeviceItem] = useState({
    serial: "",
    deviceUuid: "",
    typeDefault: "relay",
    protocol: "ZIGBEE",
    model: "",
    modelId: "TH_SENSOR_V1",
    status: "FACTORY_NEW",
    setupCode: ""
  });

  // --- CSV import ---
  const [hubCsv, setHubCsv] = useState({ fileName: "", items: [], errors: [], headers: [], delimiter: "," });
  const [devCsv, setDevCsv] = useState({ fileName: "", items: [], errors: [], headers: [], delimiter: "," });
  const [importing, setImporting] = useState({ kind: null, done: 0, total: 0 });

  async function refresh() {
    setError(null);
    try {
      const [m, h, d] = await Promise.all([api.listModels(), api.listHubInventory(), api.listDeviceInventory()]);
      setModels(m.models || []);
      setHubInv(h.items || []);
      setDevInv(d.items || []);
    } catch (err) {
      setError(err?.message || "Không thể tải dữ liệu");
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function createModel(e) {
    e.preventDefault();
    setError(null);
    try {
      await api.createModel({ ...newModel });
      setNewModel({ id: "", name: "", manufacturer: "SmartHome", protocol: "ZIGBEE" });
      await refresh();
    } catch (err) {
      setError(err?.message || "Tạo model thất bại");
    }
  }

  async function genHubs() {
    setError(null);
    try {
      const r = await api.genHubInventory(hubBatch);
      alert(
        `Đã tạo ${r.items?.length || 0} hub.\n\nDòng đầu tiên:\n${JSON.stringify(r.items?.[0] || {}, null, 2)}`
      );
      await refresh();
    } catch (err) {
      setError(err?.message || "Tạo hub thất bại");
    }
  }

  async function genDevices() {
    setError(null);
    try {
      const r = await api.genDeviceInventory(devBatch);
      alert(
        `Đã tạo ${r.items?.length || 0} thiết bị.\n\nDòng đầu tiên:\n${JSON.stringify(r.items?.[0] || {}, null, 2)}`
      );
      await refresh();
    } catch (err) {
      setError(err?.message || "Tạo thiết bị thất bại");
    }
  }

  async function exportCsv(kind) {
    setError(null);
    try {
      const csv = await api.exportInventoryCsv(kind);
      downloadText(`export_${kind}.csv`, String(csv), "text/csv;charset=utf-8");
    } catch (err) {
      setError(err?.message || "Xuất file thất bại");
    }
  }

  async function createHubManual(e) {
    e.preventDefault();
    setError(null);

    const payload = {
      hubId: (newHubItem.hubId || newHubItem.serial || "").trim(),
      serial: (newHubItem.serial || newHubItem.hubId || "").trim(),
      modelId: (newHubItem.modelId || "").trim(),
      status: (newHubItem.status || "FACTORY_NEW").trim(),
      setupCode: (newHubItem.setupCode || "").trim()
    };

    if (!payload.hubId) return setError("Thiếu hubId/serial");
    if (!payload.serial) payload.serial = payload.hubId;
    if (!payload.modelId) return setError("Thiếu modelId");
    if (!payload.setupCode) return setError("Thiếu setupCode (8 chữ số). Ví dụ: 00000000");
    if (!/^\d{8}$/.test(payload.setupCode)) return setError("setupCode phải gồm đúng 8 chữ số (VD: 00000000)");

    try {
      const r = await api.createHubInventoryItem(payload);
      alert(`Đã thêm HubInventory: ${payload.hubId}`);
      setNewHubItem({ hubId: "", serial: "", modelId: payload.modelId, status: payload.status, setupCode: "" });
      await refresh();
      return r;
    } catch (err) {
      setError(err?.message || "Thêm hub thất bại");
    }
  }

  async function createDeviceManual(e) {
    e.preventDefault();
    setError(null);

    const payload = {
      serial: (newDeviceItem.serial || "").trim(),
      deviceUuid: (newDeviceItem.deviceUuid || "").trim(),
      typeDefault: (newDeviceItem.typeDefault || "").trim(),
      protocol: (newDeviceItem.protocol || "").trim(),
      model: (newDeviceItem.model || "").trim(),
      modelId: (newDeviceItem.modelId || "").trim(),
      status: (newDeviceItem.status || "FACTORY_NEW").trim(),
      setupCode: (newDeviceItem.setupCode || "").trim()
    };

    if (!payload.serial) return setError("Thiếu serial");
    if (!payload.protocol) return setError("Thiếu protocol");
    if (!payload.typeDefault) return setError("Thiếu typeDefault");
    if (!payload.modelId) return setError("Thiếu modelId");
    if (!payload.setupCode) return setError("Thiếu setupCode (8 chữ số). Ví dụ: 00000000");
    if (!/^\d{8}$/.test(payload.setupCode)) return setError("setupCode phải gồm đúng 8 chữ số (VD: 00000000)");

    // Defaults giống import
    if (!payload.deviceUuid) payload.deviceUuid = `dev-${payload.serial}`;
    if (!payload.model) payload.model = String(payload.modelId).toLowerCase().replace(/_/g, "-");

    try {
      const r = await api.createDeviceInventoryItem(payload);
      alert(`Đã thêm DeviceInventory: ${payload.serial}`);
      setNewDeviceItem({
        serial: "",
        deviceUuid: "",
        typeDefault: payload.typeDefault,
        protocol: payload.protocol,
        model: "",
        modelId: payload.modelId,
        status: payload.status,
        setupCode: ""
      });
      await refresh();
      return r;
    } catch (err) {
      setError(err?.message || "Thêm thiết bị thất bại");
    }
  }

  async function onPickCsv(kind, file) {
    setError(null);
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = buildItemsFromCsv(text, kind);
      const nextState = {
        fileName: file.name,
        items: parsed.items,
        errors: parsed.errors,
        headers: parsed.headers,
        delimiter: parsed.delimiter
      };

      if (kind === "hubs") setHubCsv(nextState);
      else setDevCsv(nextState);

      if (parsed.errors.length) {
        console.warn("CSV parse errors:", parsed.errors);
      }
    } catch (err) {
      setError(err?.message || "Đọc CSV thất bại");
    }
  }

  async function importCsv(kind) {
    setError(null);

    const state = kind === "hubs" ? hubCsv : devCsv;
    const items = state.items || [];

    if (!items.length) {
      setError("Không có dòng hợp lệ để nhập.");
      return;
    }

    try {
      setImporting({ kind, done: 0, total: items.length });

      // Thử bulk trước (nếu backend hỗ trợ), nếu lỗi thì fallback từng dòng.
      try {
        if (kind === "hubs") await api.createHubInventoryBulk(items);
        else await api.createDeviceInventoryBulk(items);
        setImporting({ kind: null, done: items.length, total: items.length });
      } catch (bulkErr) {
        console.warn("Bulk import failed, fallback single-item:", bulkErr);

        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (kind === "hubs") await api.createHubInventoryItem(item);
          else await api.createDeviceInventoryItem(item);
          setImporting({ kind, done: i + 1, total: items.length });
        }

        setImporting({ kind: null, done: items.length, total: items.length });
      }

      alert(`Đã nhập ${items.length} dòng (${kind === "hubs" ? "Hub" : "Thiết bị"}).`);

      if (kind === "hubs") setHubCsv({ fileName: "", items: [], errors: [], headers: [], delimiter: "," });
      else setDevCsv({ fileName: "", items: [], errors: [], headers: [], delimiter: "," });

      await refresh();
    } catch (err) {
      setImporting({ kind: null, done: 0, total: 0 });
      setError(err?.message || "Nhập CSV thất bại");
    }
  }

  const importingText = useMemo(() => {
    if (!importing.kind) return null;
    const label = importing.kind === "hubs" ? "Hub" : "Thiết bị";
    return `Đang nhập CSV (${label}): ${importing.done}/${importing.total}`;
  }, [importing]);

  return (
    <div>
      <div className="pageTitle">
        <h2>Tồn kho</h2>
        <span className="subtitle">Quản lý model &amp; tạo kho Hub/Thiết bị</span>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {importingText ? <div className="small">{importingText}</div> : null}

      <div className="row">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Model sản phẩm (ProductModel)</h3>

          <form onSubmit={createModel}>
            <div className="row">
              <div>
                <div className="small">Mã (id)</div>
                <input value={newModel.id} onChange={(e) => setNewModel({ ...newModel, id: e.target.value })} />
              </div>
              <div>
                <div className="small">Giao thức (protocol)</div>
                <select
                  value={newModel.protocol}
                  onChange={(e) => setNewModel({ ...newModel, protocol: e.target.value })}
                >
                  {/* Không đổi value vì dùng trong DB */}
                  <option value="HUB">HUB</option>
                  <option value="MQTT">MQTT</option>
                  <option value="ZIGBEE">ZIGBEE</option>
                </select>
              </div>
            </div>

            <div style={{ height: 8 }} />

            <div className="row">
              <div>
                <div className="small">Tên (name)</div>
                <input value={newModel.name} onChange={(e) => setNewModel({ ...newModel, name: e.target.value })} />
              </div>
              <div>
                <div className="small">Nhà sản xuất (manufacturer)</div>
                <input
                  value={newModel.manufacturer}
                  onChange={(e) => setNewModel({ ...newModel, manufacturer: e.target.value })}
                />
              </div>
            </div>

            <div style={{ height: 12 }} />

            <button className="primary" type="submit">
              Tạo
            </button>
          </form>

          <div style={{ height: 12 }} />
          <div className="small">Số model: {models.length}</div>
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>Tạo HubInventory (theo lô)</h3>

          <div className="row">
            <div>
              <div className="small">Số lượng (count)</div>
              <input
                type="number"
                value={hubBatch.count}
                onChange={(e) => setHubBatch({ ...hubBatch, count: Number(e.target.value) })}
              />
            </div>
            <div>
              <div className="small">Tiền tố (prefix)</div>
              <input value={hubBatch.prefix} onChange={(e) => setHubBatch({ ...hubBatch, prefix: e.target.value })} />
            </div>
            <div>
              <div className="small">Model (modelId)</div>
              <input value={hubBatch.modelId} onChange={(e) => setHubBatch({ ...hubBatch, modelId: e.target.value })} />
            </div>
          </div>

          <div style={{ height: 12 }} />

          <button className="primary" onClick={genHubs}>
            Tạo
          </button>
          <button style={{ marginLeft: 8 }} onClick={() => exportCsv("hubs")}>
            Xuất CSV
          </button>

          <div style={{ height: 8 }} />
          <div className="small">Số dòng HubInventory: {hubInv.length}</div>
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>Tạo DeviceInventory (theo lô)</h3>

          <div className="row">
            <div>
              <div className="small">Số lượng (count)</div>
              <input
                type="number"
                value={devBatch.count}
                onChange={(e) => setDevBatch({ ...devBatch, count: Number(e.target.value) })}
              />
            </div>
            <div>
              <div className="small">Tiền tố (prefix)</div>
              <input value={devBatch.prefix} onChange={(e) => setDevBatch({ ...devBatch, prefix: e.target.value })} />
            </div>
          </div>

          <div style={{ height: 8 }} />

          <div className="row">
            <div>
              <div className="small">Giao thức (protocol)</div>
              <select
                value={devBatch.protocol}
                onChange={(e) => setDevBatch({ ...devBatch, protocol: e.target.value })}
              >
                {/* Không đổi value vì dùng trong DB */}
                <option value="MQTT">MQTT</option>
                <option value="ZIGBEE">ZIGBEE</option>
              </select>
            </div>

            <div>
              <div className="small">Loại (type)</div>
              <select value={devBatch.type} onChange={(e) => setDevBatch({ ...devBatch, type: e.target.value })}>
                {/* Không đổi value vì dùng trong DB */}
                <option value="relay">relay</option>
                <option value="dimmer">dimmer</option>
                <option value="rgb">rgb</option>
                <option value="sensor">sensor</option>
              </select>
            </div>

            <div>
              <div className="small">Model (modelId)</div>
              <input value={devBatch.modelId} onChange={(e) => setDevBatch({ ...devBatch, modelId: e.target.value })} />
            </div>
          </div>

          <div style={{ height: 12 }} />

          <button className="primary" onClick={genDevices}>
            Tạo
          </button>
          <button style={{ marginLeft: 8 }} onClick={() => exportCsv("devices")}>
            Xuất CSV
          </button>

          <div style={{ height: 8 }} />
          <div className="small">Số dòng DeviceInventory: {devInv.length}</div>
        </div>
      </div>

      <div style={{ height: 16 }} />

      <div className="row">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Thêm HubInventory (thủ công)</h3>
          <div className="small">
            Thêm đủ trường giống seed (hubId/serial, modelId, status, setupCode...). SetupCode sẽ được backend hash thành setupCodeHash.
          </div>

          <form onSubmit={createHubManual}>
            <div className="row">
              <div>
                <div className="small">hubId</div>
                <input value={newHubItem.hubId} onChange={(e) => setNewHubItem({ ...newHubItem, hubId: e.target.value })} />
              </div>
              <div>
                <div className="small">serial</div>
                <input value={newHubItem.serial} onChange={(e) => setNewHubItem({ ...newHubItem, serial: e.target.value })} />
              </div>
            </div>

            <div style={{ height: 8 }} />

            <div className="row">
              <div>
                <div className="small">modelId</div>
                <input value={newHubItem.modelId} onChange={(e) => setNewHubItem({ ...newHubItem, modelId: e.target.value })} />
              </div>
              <div>
                <div className="small">status</div>
                <input value={newHubItem.status} onChange={(e) => setNewHubItem({ ...newHubItem, status: e.target.value })} />
              </div>
            </div>

            <div style={{ height: 8 }} />

            <div>
              <div className="small">setupCode (bắt buộc, 8 chữ số)</div>
              <input
                value={newHubItem.setupCode}
                onChange={(e) => setNewHubItem({ ...newHubItem, setupCode: e.target.value })}
                placeholder="VD: 00000000"
                inputMode="numeric"
                pattern="[0-9]{8}"
                maxLength={8}
              />
            </div>

            <div style={{ height: 12 }} />
            <button className="primary" type="submit">Thêm Hub</button>
          </form>
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>Thêm DeviceInventory (thủ công)</h3>
          <div className="small">
            Thêm đủ trường giống seed (serial, deviceUuid, typeDefault, protocol, model, modelId, status, setupCode...).
          </div>

          <form onSubmit={createDeviceManual}>
            <div className="row">
              <div>
                <div className="small">serial</div>
                <input value={newDeviceItem.serial} onChange={(e) => setNewDeviceItem({ ...newDeviceItem, serial: e.target.value })} />
              </div>
              <div>
                <div className="small">deviceUuid</div>
                <input value={newDeviceItem.deviceUuid} onChange={(e) => setNewDeviceItem({ ...newDeviceItem, deviceUuid: e.target.value })} placeholder="Để trống = dev-serial" />
              </div>
            </div>

            <div style={{ height: 8 }} />

            <div className="row">
              <div>
                <div className="small">typeDefault</div>
                <select value={newDeviceItem.typeDefault} onChange={(e) => setNewDeviceItem({ ...newDeviceItem, typeDefault: e.target.value })}>
                  {/* Không đổi value vì dùng trong DB */}
                  <option value="relay">relay</option>
                  <option value="dimmer">dimmer</option>
                  <option value="rgb">rgb</option>
                  <option value="sensor">sensor</option>
                </select>
              </div>
              <div>
                <div className="small">protocol</div>
                <select value={newDeviceItem.protocol} onChange={(e) => setNewDeviceItem({ ...newDeviceItem, protocol: e.target.value })}>
                  {/* Không đổi value vì dùng trong DB */}
                  <option value="MQTT">MQTT</option>
                  <option value="ZIGBEE">ZIGBEE</option>
                </select>
              </div>
            </div>

            <div style={{ height: 8 }} />

            <div className="row">
              <div>
                <div className="small">modelId</div>
                <input value={newDeviceItem.modelId} onChange={(e) => setNewDeviceItem({ ...newDeviceItem, modelId: e.target.value })} />
              </div>
              <div>
                <div className="small">model (tuỳ chọn)</div>
                <input value={newDeviceItem.model} onChange={(e) => setNewDeviceItem({ ...newDeviceItem, model: e.target.value })} placeholder="Để trống = từ modelId" />
              </div>
            </div>

            <div style={{ height: 8 }} />

            <div className="row">
              <div>
                <div className="small">status</div>
                <input value={newDeviceItem.status} onChange={(e) => setNewDeviceItem({ ...newDeviceItem, status: e.target.value })} />
              </div>
              <div>
                <div className="small">setupCode (bắt buộc, 8 chữ số)</div>
                <input
                  value={newDeviceItem.setupCode}
                  onChange={(e) => setNewDeviceItem({ ...newDeviceItem, setupCode: e.target.value })}
                  placeholder="VD: 00000000"
                  inputMode="numeric"
                  pattern="[0-9]{8}"
                  maxLength={8}
                />
              </div>
            </div>

            <div style={{ height: 12 }} />
            <button className="primary" type="submit">Thêm Thiết bị</button>
          </form>
        </div>
      </div>

      <div style={{ height: 16 }} />

      <div className="row">
        <div className="card">
          <div className="row" style={{ alignItems: "center" }}>
            <h3 style={{ margin: 0 }}>Nhập CSV HubInventory</h3>
            <div style={{ flex: 1 }} />
            <button onClick={() => downloadText("hub_inventory_template.csv", HUB_TEMPLATE_CSV, "text/csv;charset=utf-8")}>Tải mẫu CSV</button>
          </div>

          <div style={{ height: 10 }} />
          <input type="file" accept=".csv,text/csv" onChange={(e) => onPickCsv("hubs", e.target.files?.[0])} />

          {hubCsv.fileName ? (
            <div style={{ marginTop: 10 }}>
              <div className="small">File: <b>{hubCsv.fileName}</b> | Dòng hợp lệ: {hubCsv.items.length} | Lỗi: {hubCsv.errors.length}</div>
              {hubCsv.errors.length ? (
                <details style={{ marginTop: 6 }}>
                  <summary className="small">Xem lỗi (tối đa 10)</summary>
                  <ul className="small">
                    {hubCsv.errors.slice(0, 10).map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                </details>
              ) : null}

              <div style={{ height: 10 }} />
              <button className="primary" disabled={importing.kind !== null} onClick={() => importCsv("hubs")}>Nhập</button>
            </div>
          ) : (
            <div className="small" style={{ marginTop: 8 }}>
              Header hỗ trợ: hubId, serial, modelId, status, setupCode
            </div>
          )}
        </div>

        <div className="card">
          <div className="row" style={{ alignItems: "center" }}>
            <h3 style={{ margin: 0 }}>Nhập CSV DeviceInventory</h3>
            <div style={{ flex: 1 }} />
            <button onClick={() => downloadText("device_inventory_template.csv", DEVICE_TEMPLATE_CSV, "text/csv;charset=utf-8")}>Tải mẫu CSV</button>
          </div>

          <div style={{ height: 10 }} />
          <input type="file" accept=".csv,text/csv" onChange={(e) => onPickCsv("devices", e.target.files?.[0])} />

          {devCsv.fileName ? (
            <div style={{ marginTop: 10 }}>
              <div className="small">File: <b>{devCsv.fileName}</b> | Dòng hợp lệ: {devCsv.items.length} | Lỗi: {devCsv.errors.length}</div>
              {devCsv.errors.length ? (
                <details style={{ marginTop: 6 }}>
                  <summary className="small">Xem lỗi (tối đa 10)</summary>
                  <ul className="small">
                    {devCsv.errors.slice(0, 10).map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                </details>
              ) : null}

              <div style={{ height: 10 }} />
              <button className="primary" disabled={importing.kind !== null} onClick={() => importCsv("devices")}>Nhập</button>
            </div>
          ) : (
            <div className="small" style={{ marginTop: 8 }}>
              Header hỗ trợ: serial, deviceUuid, typeDefault, protocol, model, modelId, status, setupCode
            </div>
          )}
        </div>
      </div>

      <div style={{ height: 16 }} />

      <div className="card">
        <div className="row" style={{ alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>Danh sách model</h3>
          <div style={{ flex: 1 }} />
          <button onClick={() => exportCsv("models")}>Xuất CSV</button>
        </div>

        <div style={{ height: 10 }} />

        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Mã (id)</th>
                <th>Tên (name)</th>
                <th>Nhà sản xuất</th>
                <th>Giao thức (protocol)</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.id}>
                  <td>
                    <code>{m.id}</code>
                  </td>
                  <td>{m.name}</td>
                  <td>{m.manufacturer}</td>
                  <td>{m.protocol}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ height: 16 }} />

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Danh sách HubInventory</h3>

        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Mã hub (hubId)</th>
                <th>Serial</th>
                <th>Trạng thái (status)</th>
                <th>Model (modelId)</th>
                <th>Home gắn (boundHomeId)</th>
                <th>Kết nối</th>
                <th>Lần thấy cuối (lastSeen)</th>
              </tr>
            </thead>
            <tbody>
              {hubInv.map((r) => (
                <tr key={r.id}>
                  <td>
                    <code>{r.hubId}</code>
                  </td>
                  <td className="mono">{r.serial ?? ""}</td>
                  <td>{r.status}</td>
                  <td>{r.modelId}</td>
                  <td>{r.boundHomeId ?? ""}</td>
                  <td>
                    {r.runtime?.online ? (
                      <span className="badge ok">Trực tuyến</span>
                    ) : (
                      <span className="badge err">Ngoại tuyến</span>
                    )}
                  </td>
                  <td className="small">{r.runtime?.lastSeen || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ height: 16 }} />

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Danh sách DeviceInventory</h3>

        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Serial (serial)</th>
                <th>deviceUuid</th>
                <th>typeDefault</th>
                <th>Giao thức (protocol)</th>
                <th>model</th>
                <th>Model (modelId)</th>
                <th>Trạng thái (status)</th>
                <th>Đã gắn (bound)</th>
              </tr>
            </thead>
            <tbody>
              {devInv.map((r) => (
                <tr key={r.id}>
                  <td>
                    <code>{r.serial}</code>
                  </td>
                  <td className="mono">{r.deviceUuid ?? ""}</td>
                  <td>{r.typeDefault ?? ""}</td>
                  <td>{r.protocol}</td>
                  <td className="mono">{r.model ?? ""}</td>
                  <td>{r.modelId}</td>
                  <td>{r.status}</td>
                  <td className="small">{r.boundDevice ? `dbId=${r.boundDevice.deviceDbId}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
