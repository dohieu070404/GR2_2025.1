/**
 * Sprint 12: Device Descriptor + UI schema
 *
 * The goal is to provide a stable contract for the mobile app to render
 * device-specific UI via a plugin registry (without hardcoding by type).
 */

function safeObj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

/**
 * Build a full descriptor from ProductModel fields.
 *
 * @param {import('@prisma/client').ProductModel | null} productModel
 */
export function buildDescriptorFromProductModel(productModel) {
  const pm = productModel;
  const capabilities = safeObj(pm?.capabilities ?? null);
  const uiSchema = safeObj(pm?.uiSchema ?? null);

  // Convention: keep actions/stateMap inside capabilities (seeded in Sprint 12)
  // but also expose them as top-level keys for client convenience.
  const actions = Array.isArray(capabilities.actions) ? capabilities.actions : [];
  const stateMap = safeObj(capabilities.stateMap);

  return {
    modelId: pm?.id ?? null,
    capabilities,
    uiSchema,
    actions,
    stateMap,
  };
}

/**
 * A smaller summary to embed in list endpoints.
 *
 * @param {import('@prisma/client').ProductModel | null} productModel
 */
export function buildDescriptorSummaryFromProductModel(productModel) {
  const pm = productModel;
  const capabilities = safeObj(pm?.capabilities ?? null);
  const plugins = Array.isArray(capabilities.plugins) ? capabilities.plugins : [];

  return {
    modelId: pm?.id ?? null,
    plugins,
    // Keep minimal capability hints to pick the right renderer.
    capabilities: {
      plugins,
    },
  };
}
