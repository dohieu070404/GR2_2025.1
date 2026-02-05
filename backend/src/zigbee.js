// Zigbee helpers (Sprint 2)

/**
 * Normalize Zigbee IEEE 64-bit address:
 * - strip 0x prefix
 * - remove separators (: - spaces)
 * - lowercase
 * - must be 16 hex chars
 */
export function normalizeIeee(input) {
  if (input == null) return null;
  const s = String(input).trim().toLowerCase();
  const cleaned = s.replace(/^0x/, "").replace(/[^0-9a-f]/g, "");
  if (cleaned.length !== 16) return null;
  if (!/^[0-9a-f]{16}$/.test(cleaned)) return null;
  return cleaned;
}

function normStr(x) {
  if (x == null) return "";
  return String(x).trim();
}

function eqCi(a, b) {
  if (!a || !b) return false;
  return normStr(a).toLowerCase() === normStr(b).toLowerCase();
}

/**
 * Suggest ProductModels based on fingerprint.
 *
 * Score heuristic:
 * - exact manufacturer + model match: 100
 * - exact model match only: 70
 * - exact manufacturer match only: 30
 */
export function suggestModelsByFingerprint({ manufacturer, model }, productModels) {
  const manuf = normStr(manufacturer);
  const mod = normStr(model);

  const scored = [];
  for (const pm of productModels || []) {
    const pmManuf = normStr(pm.fingerprintManuf);
    const pmModel = normStr(pm.fingerprintModel);
    if (!pmManuf && !pmModel) continue;

    let score = 0;
    let match = "";

    const manufMatch = manuf && pmManuf && eqCi(manuf, pmManuf);
    const modelMatch = mod && pmModel && eqCi(mod, pmModel);

    if (manufMatch && modelMatch) {
      score = 100;
      match = "manuf+model";
    } else if (modelMatch) {
      score = 70;
      match = "model";
    } else if (manufMatch) {
      score = 30;
      match = "manuf";
    }

    if (score > 0) {
      scored.push({
        modelId: pm.id,
        name: pm.name,
        manufacturer: pm.manufacturer,
        protocol: pm.protocol,
        score,
        match,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.modelId.localeCompare(b.modelId));
  return scored;
}

export function guessDeviceTypeFromModelId(modelId) {
  if (!modelId) return "relay";
  const s = String(modelId).toUpperCase();
  if (s.includes("SENSOR") || s.includes("TH_")) return "sensor";
  if (s.includes("DIMMER")) return "dimmer";
  if (s.includes("RGB") || s.includes("LIGHT")) return "rgb";
  return "relay";
}
