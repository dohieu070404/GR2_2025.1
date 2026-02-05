import jwt from "jsonwebtoken";

function getJwtSecret() {
  return process.env.JWT_SECRET || "dev_secret_change_me";
}

export function authRequired(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing Bearer token" });
  }

  try {
    const payload = jwt.verify(token, getJwtSecret());
    const rawId = payload?.id ?? payload?.sub;
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(401).json({ error: "Invalid token payload" });
    }
    req.user = { id, email: payload?.email ?? null, isAdmin: !!payload?.isAdmin };
    return next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
