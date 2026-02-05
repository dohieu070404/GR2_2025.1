import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, Switch, Pressable, Alert } from "react-native";
import Slider from "@react-native-community/slider";
import { Ionicons } from "@expo/vector-icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Device, CommandStatus } from "../types";
import { apiSendCommand } from "../api/api";

function statusLabel(status: CommandStatus) {
  switch (status) {
    case "PENDING":
      return "PENDING";
    case "ACKED":
      return "ACKED";
    case "FAILED":
      return "FAILED";
    case "TIMEOUT":
      return "TIMEOUT";
    default:
      return String(status);
  }
}

export default function DeviceCard({ device }: { device: Device }) {
  const qc = useQueryClient();
  const [sending, setSending] = useState(false);

  const isGatePir = device.modelId === "GATE_PIR_V1";

  const effectiveState = device.stateCurrent?.state ?? device.lastState ?? null;

  const gateOpen = Boolean(effectiveState?.gate?.open ?? effectiveState?.relay ?? false);
  const motionLastAt = typeof effectiveState?.motion?.lastAt === "number" ? (effectiveState.motion.lastAt as number) : null;

  const relayValue = !!effectiveState?.relay;
  const pwmValue = typeof effectiveState?.pwm === "number" ? effectiveState.pwm : 0;
  const rgbValue = effectiveState?.rgb || { r: 0, g: 0, b: 0 };

  const temperatureValue = typeof effectiveState?.temperature === "number" ? effectiveState.temperature : null;
  const humidityValue = typeof effectiveState?.humidity === "number" ? effectiveState.humidity : null;

  const roomName = typeof device.room === "string" ? device.room : (device.room && typeof device.room === "object" ? (device.room as any).name : null);
  const roomLabel = roomName ? ` • ${roomName}` : "";

  const lastSeen = device.lastSeen ?? device.stateCurrent?.lastSeen ?? null;
  const online = device.online ?? device.stateCurrent?.online ?? null;

  const lastSeenLabel = lastSeen ? `Last seen: ${new Date(lastSeen).toLocaleString()}` : "Last seen: -";
  const onlineLabel = online == null ? "UNKNOWN" : online ? "ONLINE" : "OFFLINE";

  const pending = sending || device.lastCommand?.status === "PENDING";

  const identityLabel = useMemo(() => {
    // Prefer new scheme
    if (device.homeId != null && device.deviceId) {
      return `home/${device.homeId}/device/${device.deviceId}`;
    }
    // Legacy scheme
    if (device.topicBase) return device.topicBase;
    return `device#${device.id}`;
  }, [device.deviceId, device.homeId, device.id, device.topicBase]);

  const mutation = useMutation({
    mutationFn: async (payload: any) => {
      setSending(true);
      const res = await apiSendCommand(device.id, payload);
      return { payload, res };
    },
    onSuccess: ({ payload, res }) => {
      // New backend: returns { cmdId, status: "PENDING" }
      // Legacy backend: returns { ok: true }
      const cmdId = typeof res?.cmdId === "string" ? res.cmdId : null;

      if (cmdId) {
        const nowIso = new Date().toISOString();

        // Update devices cache with a client-only lastCommand helper.
        qc.setQueriesData({ queryKey: ["devices"] }, (old: any) => {
          if (!old?.devices) return old;
          return {
            ...old,
            devices: old.devices.map((d: Device) =>
              d.id === device.id
                ? {
                    ...d,
                    lastCommand: {
                      cmdId,
                      status: "PENDING" as const,
                      payload,
                      sentAt: nowIso,
                      ackedAt: null,
                      error: null,
                    },
                  }
                : d
            ),
          };
        });

        // Best-effort: update command history cache if the app is using it.
        qc.setQueryData(["deviceCommands", device.id], (old: any) => {
          if (!old?.items) return old;
          return {
            ...old,
            items: [
              {
                cmdId,
                status: "PENDING",
                payload,
                sentAt: nowIso,
                ackedAt: null,
                error: null,
              },
              ...old.items,
            ],
          };
        });

        return;
      }

      // Legacy fallback: optimistic state update
      qc.setQueriesData({ queryKey: ["devices"] }, (old: any) => {
        if (!old?.devices) return old;
        return {
          ...old,
          devices: old.devices.map((d: Device) => (d.id === device.id ? { ...d, lastState: payload } : d)),
        };
      });
    },
    onError: (e: any) => {
      const msg = e?.response?.data?.error || e?.message || "Failed to send command";
      Alert.alert("Command failed", typeof msg === "string" ? msg : JSON.stringify(msg));
    },
    onSettled: () => setSending(false),
  });

  // Notify user on failures/timeouts (once per cmdId+status)
  const lastNotifiedRef = useRef<string | null>(null);
  useEffect(() => {
    const c = device.lastCommand;
    if (!c?.cmdId || !c.status) return;

    if (c.status !== "FAILED" && c.status !== "TIMEOUT") return;

    const key = `${c.cmdId}:${c.status}`;
    if (lastNotifiedRef.current === key) return;
    lastNotifiedRef.current = key;

    const message = c.error ? `${c.status}: ${c.error}` : c.status;
    Alert.alert("Command", message, [
      c.payload
        ? {
            text: "Retry",
            onPress: () => mutation.mutate(c.payload),
          }
        : { text: "OK" },
      { text: "Dismiss", style: "cancel" },
    ]);
  }, [device.lastCommand?.cmdId, device.lastCommand?.status, device.lastCommand?.error]);

  const headerRight = useMemo(() => {
    return (
      <View style={styles.headerRight}>
        <View style={styles.statusRow}>
          <View
            style={[
              styles.dot,
              online == null ? styles.dotUnknown : online ? styles.dotOnline : styles.dotOffline,
            ]}
          />
          <Text style={styles.statusText}>{onlineLabel}</Text>
        </View>

        <Text style={styles.type}>{(isGatePir ? "GATE" : device.type).toUpperCase()}</Text>

        {pending ? <Text style={styles.sending}>Sending…</Text> : null}
        {device.lastCommand?.status ? (
          <Text
            style={[
              styles.cmdStatus,
              device.lastCommand.status === "ACKED" ? styles.cmdOk : null,
              device.lastCommand.status === "FAILED" || device.lastCommand.status === "TIMEOUT"
                ? styles.cmdBad
                : null,
            ]}
          >
            {statusLabel(device.lastCommand.status)}
          </Text>
        ) : null}
      </View>
    );
  }, [device.lastCommand?.status, device.type, online, onlineLabel, pending]);

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.iconWrap}>
          <Ionicons
            name={
              isGatePir
                ? "lock-open"
                : device.type === "relay"
                  ? "power"
                  : device.type === "dimmer"
                    ? "sunny"
                    : device.type === "rgb"
                      ? "color-palette"
                      : "thermometer"
            }
            size={18}
            color={"#111"}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.name}>{device.name}</Text>
          <Text style={styles.sub}>
            {identityLabel}
            {roomLabel}
            {device.claimed ? " • CLAIMED" : ""}
          </Text>
        </View>
        {headerRight}
      </View>

      <Text style={styles.meta}>{lastSeenLabel}</Text>

      {isGatePir ? (
        <View style={styles.block}>
          <View style={styles.row}>
            <Text style={styles.controlLabel}>Gate</Text>
            <Text style={styles.value}>{gateOpen ? "OPEN" : "CLOSED"}</Text>
          </View>
          <Text style={styles.meta}>Tap to open control + motion history</Text>
          <Text style={styles.meta}>
            Last motion: {motionLastAt ? new Date(motionLastAt).toLocaleString() : "—"}
          </Text>
        </View>
      ) : null}

      {!isGatePir && device.type === "relay" ? (
        <View style={styles.row}>
          <Text style={styles.controlLabel}>Power</Text>
          <Switch value={relayValue} onValueChange={(v) => mutation.mutate({ relay: v })} disabled={pending} />
        </View>
      ) : null}

      {!isGatePir && device.type === "dimmer" ? (
        <View style={styles.block}>
          <View style={styles.row}>
            <Text style={styles.controlLabel}>Brightness</Text>
            <Text style={styles.value}>{pwmValue}</Text>
          </View>
          <Slider
            minimumValue={0}
            maximumValue={255}
            value={pwmValue}
            onSlidingComplete={(v) => mutation.mutate({ pwm: Math.round(v) })}
            disabled={pending}
          />
        </View>
      ) : null}

      {!isGatePir && device.type === "rgb" ? (
        <View style={styles.block}>
          <View style={styles.row}>
            <Text style={styles.controlLabel}>RGB</Text>
            <View style={[styles.rgbPreview, { backgroundColor: `rgb(${rgbValue.r ?? 0},${rgbValue.g ?? 0},${rgbValue.b ?? 0})` }]} />
          </View>

          <View style={styles.row}>
            <Text style={styles.channel}>R</Text>
            <Text style={styles.value}>{rgbValue.r ?? 0}</Text>
          </View>
          <Slider
            minimumValue={0}
            maximumValue={255}
            value={rgbValue.r ?? 0}
            onSlidingComplete={(v) => mutation.mutate({ rgb: { ...rgbValue, r: Math.round(v) } })}
            disabled={pending}
          />

          <View style={styles.row}>
            <Text style={styles.channel}>G</Text>
            <Text style={styles.value}>{rgbValue.g ?? 0}</Text>
          </View>
          <Slider
            minimumValue={0}
            maximumValue={255}
            value={rgbValue.g ?? 0}
            onSlidingComplete={(v) => mutation.mutate({ rgb: { ...rgbValue, g: Math.round(v) } })}
            disabled={pending}
          />

          <View style={styles.row}>
            <Text style={styles.channel}>B</Text>
            <Text style={styles.value}>{rgbValue.b ?? 0}</Text>
          </View>
          <Slider
            minimumValue={0}
            maximumValue={255}
            value={rgbValue.b ?? 0}
            onSlidingComplete={(v) => mutation.mutate({ rgb: { ...rgbValue, b: Math.round(v) } })}
            disabled={pending}
          />

          <Pressable
            style={[styles.presetBtn, pending && { opacity: 0.6 }]}
            disabled={pending}
            onPress={() => mutation.mutate({ rgb: { r: 255, g: 255, b: 255 } })}
          >
            <Text style={styles.presetText}>Set White</Text>
          </Pressable>
        </View>
      ) : null}

      {!isGatePir && device.type === "sensor" ? (
        <View style={styles.block}>
          <View style={styles.row}>
            <Text style={styles.controlLabel}>Temperature</Text>
            <Text style={styles.value}>{temperatureValue != null ? `${temperatureValue.toFixed(1)} °C` : "-"}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.controlLabel}>Humidity</Text>
            <Text style={styles.value}>{humidityValue != null ? `${humidityValue.toFixed(1)} %` : "-"}</Text>
          </View>
        </View>
      ) : null}

      {(device.lastCommand?.status === "FAILED" || device.lastCommand?.status === "TIMEOUT") && device.lastCommand?.payload ? (
        <Pressable style={[styles.retryBtn, pending && { opacity: 0.6 }]} disabled={pending} onPress={() => mutation.mutate(device.lastCommand!.payload)}>
          <Text style={styles.retryText}>Retry last command</Text>
        </Pressable>
      ) : null}

      <Pressable
        style={[styles.otaBtn, pending && { opacity: 0.6 }]}
        disabled={pending}
        onPress={() => mutation.mutate({ ota: true })}
      >
        <Text style={styles.otaText}>OTA update</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderColor: "#eee", borderRadius: 12, padding: 12, backgroundColor: "#fff", gap: 8 },
  header: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  name: { fontSize: 16, fontWeight: "700" },
  sub: { fontSize: 12, color: "#666" },
  meta: { fontSize: 12, color: "#666" },
  headerRight: { alignItems: "flex-end", gap: 4 },
  type: { fontSize: 12, fontWeight: "700", color: "#333" },
  sending: { fontSize: 12, color: "#999" },
  cmdStatus: { fontSize: 12, fontWeight: "700", color: "#666" },
  cmdOk: { color: "#0a7" },
  cmdBad: { color: "#c00" },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  controlLabel: { fontSize: 14, fontWeight: "600" },
  value: { fontSize: 14, fontWeight: "700" },
  block: { gap: 8 },
  channel: { fontSize: 14, fontWeight: "700" },
  presetBtn: { paddingVertical: 10, borderRadius: 10, backgroundColor: "#111", alignItems: "center", marginTop: 8 },
  presetText: { color: "#fff", fontWeight: "700" },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  statusText: { fontSize: 12, fontWeight: "700", color: "#333" },
  dot: { width: 8, height: 8, borderRadius: 99 },
  dotOnline: { backgroundColor: "#0a7" },
  dotOffline: { backgroundColor: "#c00" },
  dotUnknown: { backgroundColor: "#999" },
  retryBtn: { paddingVertical: 10, borderRadius: 10, backgroundColor: "#fee", alignItems: "center" },
  retryText: { color: "#c00", fontWeight: "700" },
  iconWrap: { width: 32, height: 32, borderRadius: 10, backgroundColor: "#f5f5f5", alignItems: "center", justifyContent: "center" },
  rgbPreview: { width: 18, height: 18, borderRadius: 6, borderWidth: 1, borderColor: "#ddd" },
  otaBtn: { paddingVertical: 10, borderRadius: 10, backgroundColor: "#efefef", alignItems: "center" },
  otaText: { fontWeight: "700", color: "#111" },
});
