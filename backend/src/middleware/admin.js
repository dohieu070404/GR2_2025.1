function isProd() {
  return process.env.NODE_ENV === "production";
}

/**
 * Admin guard.
 *
 * Rules:
 * - Normal path: JWT must include isAdmin=true.
 * - Dev shortcut (optional): x-admin-token matches ADMIN_TOKEN env.
 *   This is useful for local tooling, but should NOT be relied on for production.
 */
export function adminRequired(req, res, next) {
  if (req.user?.isAdmin) return next();

  const token = (process.env.ADMIN_TOKEN || "").toString();
  const header = (req.headers["x-admin-token"] || "").toString();

  if (token && header && header === token) {
    // Keep a visible warning for operators.
    // eslint-disable-next-line no-console
    console.warn(
      `[SECURITY] adminRequired bypass via x-admin-token (userId=${req.user?.id ?? "?"}, prod=${isProd()})`
    );
    return next();
  }

  return res.status(403).json({ error: "Admin required" });
}
