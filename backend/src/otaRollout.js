import crypto from "crypto";

function log(level, msg, extra) {
  const base = `[OTA] ${msg}`;
  // eslint-disable-next-line no-console
  console[level](base, extra ?? "");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function publishHubOtaCmd(mqttClient, hubId, payload) {
  const topic = `home/hub/${hubId}/ota/cmd`;
  if (!mqttClient.connected) {
    log("warn", "MQTT not connected; skip OTA publish", { topic, hubId });
    return false;
  }
  mqttClient.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => {
    if (err) log("warn", `publish failed topic=${topic}`, { err: err?.message || String(err) });
  });
  return true;
}

export function startOtaRolloutEngine(prisma, mqttClient) {
  const INTERVAL_MS = Number(process.env.OTA_ROLLOUT_TICK_MS || 3000);
  const MAX_ATTEMPTS = Number(process.env.OTA_ROLLOUT_MAX_ATTEMPTS || 3);
  const CONCURRENCY_PER_ROLLOUT = Number(process.env.OTA_ROLLOUT_CONCURRENCY || 2);
  const ATTEMPT_TIMEOUT_MS = Number(process.env.OTA_ROLLOUT_ATTEMPT_TIMEOUT_MS || 8 * 60 * 1000);

  let running = false;

  async function tickOnce() {
    if (running) return;
    running = true;
    try {
      if (!mqttClient.connected) return;
      const rollouts = await prisma.firmwareRollout.findMany({
        where: { status: "RUNNING" },
        select: { id: true, releaseId: true },
        orderBy: { updatedAt: "asc" },
        take: 25,
      });

      for (const ro of rollouts) {
        // eslint-disable-next-line no-await-in-loop
        await handleRollout(ro.id);
      }
    } catch (e) {
      log("warn", "tick failed", { err: e?.message || String(e) });
    } finally {
      running = false;
    }
  }

  async function handleRollout(rolloutId) {
    const rollout = await prisma.firmwareRollout.findUnique({
      where: { id: rolloutId },
      include: {
        release: true,
        progress: { include: { hub: { select: { hubId: true, online: true } } } },
      },
    });
    if (!rollout || rollout.status !== "RUNNING") return;

    // 1) Convert stuck DOWNLOADING/APPLYING to FAILED on timeout.
    const now = Date.now();
    const timedOut = rollout.progress.filter((p) =>
      (p.state === "DOWNLOADING" || p.state === "APPLYING") && p.sentAt && now - p.sentAt.getTime() > ATTEMPT_TIMEOUT_MS
    );

    for (const p of timedOut) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.firmwareRolloutProgress.update({
        where: { rolloutId_hubId: { rolloutId, hubId: p.hubId } },
        data: { state: "FAILED", lastMsg: `TIMEOUT after ${Math.round(ATTEMPT_TIMEOUT_MS / 1000)}s` },
      });
    }

    // 2) Determine candidates to send
    const refreshed = await prisma.firmwareRolloutProgress.findMany({
      where: { rolloutId },
      include: { hub: { select: { hubId: true, online: true } } },
    });

    const eligible = refreshed
      .filter((p) => (p.state === "PENDING" || p.state === "FAILED") && p.attempt < MAX_ATTEMPTS && p.hub?.online)
      .slice(0, CONCURRENCY_PER_ROLLOUT);

    for (const p of eligible) {
      const cmdId = crypto.randomUUID();
      const payload = {
        ts: Date.now(),
        cmdId,
        version: rollout.release.version,
        url: rollout.release.url,
        sha256: rollout.release.sha256,
        size: rollout.release.size ?? undefined,
      };

      // Optimistically mark as DOWNLOADING before publish (idempotency on retries)
      // eslint-disable-next-line no-await-in-loop
      await prisma.firmwareRolloutProgress.update({
        where: { rolloutId_hubId: { rolloutId, hubId: p.hubId } },
        data: {
          state: "DOWNLOADING",
          attempt: { increment: 1 },
          cmdId,
          sentAt: new Date(),
          ackedAt: null,
          lastMsg: "sent",
        },
      });

      publishHubOtaCmd(mqttClient, p.hubId, payload);
      // eslint-disable-next-line no-await-in-loop
      await sleep(50);
    }

    // 3) Mark DONE if terminal
    const after = await prisma.firmwareRolloutProgress.findMany({
      where: { rolloutId },
      select: { state: true, attempt: true },
    });
    const terminal = after.every((p) => p.state === "SUCCESS" || (p.state === "FAILED" && p.attempt >= MAX_ATTEMPTS));
    if (terminal) {
      await prisma.firmwareRollout.update({ where: { id: rolloutId }, data: { status: "DONE" } }).catch(() => {});
    }
  }

  const timer = setInterval(tickOnce, INTERVAL_MS);
  timer.unref?.();
  log("log", `rollout engine started (tick=${INTERVAL_MS}ms, maxAttempts=${MAX_ATTEMPTS}, conc=${CONCURRENCY_PER_ROLLOUT})`);

  return {
    stop: () => clearInterval(timer),
  };
}
