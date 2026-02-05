import React, { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";

import type { Device } from "../types";
import type { DevicePlugin, PluginSectionProps } from "./pluginTypes";

function normalizeLockState(state: any): string {
  const st = state?.lock?.state;
  if (typeof st === "string" && st.length) return st;
  if (typeof state?.locked === "boolean") return state.locked ? "LOCKED" : "UNLOCKED";
  return "UNKNOWN";
}

function getState(device: Device | null) {
  return (device?.stateCurrent?.state ?? device?.lastState ?? null) as any;
}

function formatEpochMs(ms: number) {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

function LockStatusCard({ device }: { device: Device | null }) {
  const state = getState(device);
  const lockState = normalizeLockState(state);
  const lastAction: any = state?.lastAction ?? state?.lock?.lastAction ?? null;
  const lockoutUntil: number | null =
    typeof state?.lock?.lockoutUntil === "number" ? state.lock.lockoutUntil : null;
  const inLockout = useMemo(() => {
    if (!lockoutUntil) return false;
    return Date.now() < lockoutUntil;
  }, [lockoutUntil]);

  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>Status</Text>

      <Text style={styles.value}>{lockState}</Text>

      <Text style={styles.label}>Last action</Text>
      <Text style={styles.small}>
        {lastAction
          ? `${lastAction.type ?? "?"} · ${lastAction.method ?? "?"} · success=${String(
              lastAction.success
            )}`
          : "(none)"}
      </Text>

      <Text style={[styles.label, { marginTop: 10 }]}>Lockout</Text>
      <Text style={styles.small}>
        {lockoutUntil ? `${inLockout ? "ACTIVE" : "ended"} · until ${formatEpochMs(lockoutUntil)}` : "—"}
      </Text>
    </View>
  );
}

function LockCoreSection(props: PluginSectionProps) {
  // Only one view for now
  return <LockStatusCard device={props.device} />;
}

export const LockCorePlugin: DevicePlugin = {
  id: "lock.core",
  render: (props) => <LockCoreSection {...props} />,
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
  value: { fontSize: 28, fontWeight: "900", marginTop: 8, marginBottom: 10 },
  label: { fontSize: 12, fontWeight: "800", color: "#666" },
  small: { fontSize: 12, color: "#333", marginTop: 4 },
});
