import { emitToHome } from "./sse.js";

function getNumberEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Mark PENDING commands as TIMEOUT after COMMAND_TIMEOUT_MS.
 *
 * This runs in-process. For multi-instance production, consider moving this
 * into a dedicated worker, cron job, or DB scheduler to avoid duplicate work.
 */
export function startCommandTimeoutSweeper(prisma) {
  const timeoutMs = getNumberEnv("COMMAND_TIMEOUT_MS", 10_000);
  const intervalMs = getNumberEnv("COMMAND_SWEEP_INTERVAL_MS", 2_000);

  let running = false;

  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const cutoff = new Date(Date.now() - timeoutMs);

      // Fetch candidates (limit to keep the sweep cheap)
      const candidates = await prisma.command.findMany({
        where: {
          status: "PENDING",
          sentAt: { lt: cutoff },
        },
        select: {
          id: true,
          cmdId: true,
          sentAt: true,
          device: { select: { id: true, homeId: true, deviceId: true } },
        },
        orderBy: { sentAt: "asc" },
        take: 200,
      });

      if (candidates.length === 0) return;

      const now = new Date();
      for (const c of candidates) {
        // Update only if still pending (avoid racing with ACK)
        const updated = await prisma.command.updateMany({
          where: { id: c.id, status: "PENDING" },
          data: {
            status: "TIMEOUT",
            ackedAt: now,
            error: "TIMEOUT",
          },
        });
        if (updated.count !== 1) continue;

        emitToHome(c.device.homeId, "command_updated", {
          homeId: c.device.homeId,
          deviceDbId: c.device.id,
          deviceId: c.device.deviceId,
          cmdId: c.cmdId,
          status: "TIMEOUT",
          sentAt: c.sentAt?.toISOString?.() ?? null,
          ackedAt: now.toISOString(),
          error: "TIMEOUT",
        });
      }
    } catch (err) {
      console.warn("[CMD_TIMEOUT] sweep failed:", err?.message || err);
    } finally {
      running = false;
    }
  }, intervalMs).unref?.();
}

/**
 * Mark PENDING/SENT ResetRequests as TIMEOUT after RESET_REQUEST_TIMEOUT_MS.
 *
 * This runs in-process. For multi-instance production, consider moving this
 * into a dedicated worker/cron.
 */
export function startResetRequestTimeoutSweeper(prisma) {
  const timeoutMs = getNumberEnv("RESET_REQUEST_TIMEOUT_MS", 12_000);
  const intervalMs = getNumberEnv("RESET_REQUEST_SWEEP_INTERVAL_MS", 2_000);

  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const cutoff = new Date(Date.now() - timeoutMs);
      const candidates = await prisma.resetRequest.findMany({
        where: {
          status: { in: ["PENDING", "SENT"] },
          createdAt: { lt: cutoff },
        },
        select: {
          id: true,
          cmdId: true,
          createdAt: true,
          device: { select: { id: true, homeId: true, deviceId: true } },
        },
        orderBy: { createdAt: "asc" },
        take: 200,
      });
      if (candidates.length === 0) return;

      const now = new Date();
      for (const r of candidates) {
        const updated = await prisma.resetRequest.updateMany({
          where: { id: r.id, status: { in: ["PENDING", "SENT"] } },
          data: { status: "TIMEOUT", ackedAt: now, error: "TIMEOUT" },
        });
        if (updated.count !== 1) continue;
        emitToHome(r.device.homeId, "reset_request_updated", {
          homeId: r.device.homeId,
          deviceDbId: r.device.id,
          deviceId: r.device.deviceId,
          cmdId: r.cmdId,
          status: "TIMEOUT",
          ackedAt: now.toISOString(),
          error: "TIMEOUT",
        });
      }
    } catch (err) {
      console.warn("[RESET_TIMEOUT] sweep failed:", err?.message || err);
    } finally {
      running = false;
    }
  }, intervalMs).unref?.();
}
