import React, { useMemo } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { useMutation } from "@tanstack/react-query";

import type { Device } from "../types";
import { apiSendCommand } from "../api/api";
import type { DevicePlugin, PluginSectionProps } from "./pluginTypes";

function getState(device: Device | null) {
  return (device?.stateCurrent?.state ?? device?.lastState ?? null) as any;
}

function GateCoreSection({ deviceId, device }: { deviceId: number; device: Device | null }) {
  const st = getState(device);
  const isOpen = typeof st?.gate?.open === "boolean" ? st.gate.open : null;

  const openGate = useMutation({
    mutationFn: () => apiSendCommand(deviceId, { action: "gate.open", params: { source: "mobile" } }),
  });
  const closeGate = useMutation({
    mutationFn: () => apiSendCommand(deviceId, { action: "gate.close", params: { source: "mobile" } }),
  });

  const busy = openGate.isPending || closeGate.isPending;
  const lastCmdId = useMemo(() => openGate.data?.cmdId || closeGate.data?.cmdId || null, [openGate.data, closeGate.data]);

  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>Gate</Text>
      <Text style={styles.value}>{isOpen == null ? "—" : isOpen ? "OPEN" : "CLOSED"}</Text>

      <View style={styles.row}>
        <Pressable style={[styles.btn, styles.btnPrimary]} onPress={() => openGate.mutate()} disabled={busy}>
          <Text style={styles.btnText}>Open</Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.btnSecondary]} onPress={() => closeGate.mutate()} disabled={busy}>
          <Text style={styles.btnText}>Close</Text>
        </Pressable>
      </View>

      {lastCmdId ? <Text style={styles.subtle}>Last cmdId: {lastCmdId}</Text> : null}
    </View>
  );
}

export const GateCorePlugin: DevicePlugin = {
  id: "gate.core",
  render: (props: PluginSectionProps) => <GateCoreSection deviceId={props.deviceId} device={props.device} />,
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
  row: { flexDirection: "row", gap: 10 },
  btn: { paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, flex: 1, alignItems: "center" },
  btnPrimary: { backgroundColor: "#111" },
  btnSecondary: { backgroundColor: "#555" },
  btnText: { color: "#fff", fontWeight: "900" },
  subtle: { marginTop: 8, color: "#666", fontSize: 12 },
});
