import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, TextInput } from "react-native";
import { useMutation } from "@tanstack/react-query";

import type { Device } from "../types";
import { apiSendCommand } from "../api/api";
import type { DevicePlugin, PluginSectionProps } from "./pluginTypes";

function parseIntSafe(v: string, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

function getState(device: Device | null) {
  return (device?.stateCurrent?.state ?? device?.lastState ?? null) as any;
}

function LightControlSection({ deviceId, device }: { deviceId: number; device: Device | null }) {
  const st = getState(device);
  const isOn = typeof st?.light?.on === "boolean" ? st.light.on : null;

  const toggle = useMutation({
    mutationFn: () => apiSendCommand(deviceId, { action: "light.set", params: { on: !isOn } }),
  });

  const busy = toggle.isPending;
  const lastCmdId = useMemo(() => toggle.data?.cmdId || null, [toggle.data]);

  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>Light</Text>
      <Text style={styles.value}>{isOn == null ? "—" : isOn ? "ON" : "OFF"}</Text>

      <Pressable style={[styles.btn, styles.btnPrimary]} onPress={() => toggle.mutate()} disabled={busy}>
        <Text style={styles.btnText}>{isOn ? "Turn off" : "Turn on"}</Text>
      </Pressable>

      {lastCmdId ? <Text style={styles.subtle}>Last cmdId: {lastCmdId}</Text> : null}
    </View>
  );
}

function LightTimeoutSection({ deviceId }: { deviceId: number }) {
  const [sec, setSec] = useState("30");

  const setTimeoutMutation = useMutation({
    mutationFn: () => apiSendCommand(deviceId, { action: "light.set_timeout", params: { sec: parseIntSafe(sec, 30) } }),
  });

  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>Light timeout</Text>
      <Text style={styles.subtle}>Auto-off timeout in seconds (device-side rule).</Text>

      <View style={styles.row}>
        <TextInput
          style={styles.inputSmall}
          value={sec}
          onChangeText={setSec}
          keyboardType="number-pad"
          placeholder="sec"
        />
        <Pressable
          style={[styles.btn, styles.btnPrimary, { flex: 1, alignItems: "center" }]}
          onPress={() => setTimeoutMutation.mutate()}
          disabled={setTimeoutMutation.isPending}
        >
          <Text style={styles.btnText}>Apply</Text>
        </Pressable>
      </View>

      {setTimeoutMutation.data?.cmdId ? <Text style={styles.subtle}>Last cmdId: {setTimeoutMutation.data.cmdId}</Text> : null}
      {setTimeoutMutation.error ? <Text style={styles.error}>Error: {String(setTimeoutMutation.error as any)}</Text> : null}
    </View>
  );
}

function LightSwitchSection(props: PluginSectionProps) {
  const view = (props.section?.view || "control").toString();
  if (view === "timeout") {
    return <LightTimeoutSection deviceId={props.deviceId} />;
  }
  return <LightControlSection deviceId={props.deviceId} device={props.device} />;
}

export const LightSwitchPlugin: DevicePlugin = {
  id: "light.switch",
  render: (props) => <LightSwitchSection {...props} />,
};

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 12,
    padding: 16,
    backgroundColor: "#fff",
  },
  sectionTitle: { fontSize: 14, fontWeight: "800" },
  value: { fontSize: 28, fontWeight: "900", marginTop: 8, marginBottom: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 12 },
  subtle: { marginTop: 8, color: "#666", fontSize: 12 },
  error: { marginTop: 8, color: "#b00020", fontSize: 12, fontWeight: "700" },
  inputSmall: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    width: 90,
    backgroundColor: "#fafafa",
  },
  btn: { paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12 },
  btnPrimary: { backgroundColor: "#111" },
  btnText: { color: "#fff", fontWeight: "900" },
});
