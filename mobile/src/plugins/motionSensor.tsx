import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { useQuery } from "@tanstack/react-query";

import type { Device } from "../types";
import { apiGetDeviceEvents } from "../api/api";
import type { DevicePlugin, PluginSectionProps } from "./pluginTypes";

function toIsoDate(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatLocalTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString();
  } catch {
    return iso;
  }
}

function getState(device: Device | null) {
  return (device?.stateCurrent?.state ?? device?.lastState ?? null) as any;
}

function MotionHistorySection({ deviceId, device }: { deviceId: number; device: Device | null }) {
  const st = getState(device);
  const lastAt: number | null = typeof st?.motion?.lastAt === "number" ? st.motion.lastAt : null;

  const [dayOffset, setDayOffset] = useState(0);
  const selectedDate = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    return d;
  }, [dayOffset]);
  const dateStr = useMemo(() => toIsoDate(selectedDate), [selectedDate]);

  const eventsQuery = useQuery({
    queryKey: ["deviceEvents", deviceId, dateStr],
    queryFn: () => apiGetDeviceEvents(deviceId, { date: dateStr, limit: 500 }),
    enabled: deviceId > 0,
  });

  const events = useMemo(() => {
    const items = eventsQuery.data?.events || [];
    return items.filter((e) => e.type === "motion.detected");
  }, [eventsQuery.data]);

  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>Motion</Text>
      <Text style={styles.subtle}>
        Last motion: {lastAt ? new Date(lastAt).toLocaleString() : "—"}
      </Text>

      <View style={[styles.row, { marginTop: 12 }] }>
        <Pressable style={styles.smallBtn} onPress={() => setDayOffset((v) => v - 1)}>
          <Text style={styles.smallBtnText}>◀</Text>
        </Pressable>
        <Text style={styles.dateText}>{dateStr}</Text>
        <Pressable style={styles.smallBtn} onPress={() => setDayOffset((v) => v + 1)}>
          <Text style={styles.smallBtnText}>▶</Text>
        </Pressable>
      </View>

      {eventsQuery.isLoading ? (
        <Text style={styles.subtle}>Loading…</Text>
      ) : events.length ? (
        <View style={{ gap: 8, marginTop: 10 }}>
          {events.slice(-80).map((e) => (
            <View key={String(e.id)} style={styles.eventRow}>
              <Text style={styles.eventTime}>{e.sourceAt ? formatLocalTime(e.sourceAt) : "—"}</Text>
              <Text style={styles.eventText}>motion.detected</Text>
            </View>
          ))}
        </View>
      ) : (
        <Text style={styles.subtle}>(no motion)</Text>
      )}
    </View>
  );
}

export const MotionSensorPlugin: DevicePlugin = {
  id: "motion.sensor",
  render: (props: PluginSectionProps) => <MotionHistorySection deviceId={props.deviceId} device={props.device} />,
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
  subtle: { marginTop: 8, color: "#666", fontSize: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  dateText: { fontSize: 12, fontWeight: "900" },
  smallBtn: { borderWidth: 1, borderColor: "#ddd", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  smallBtnText: { fontSize: 12, fontWeight: "800" },
  eventRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderBottomWidth: 1, borderBottomColor: "#eee", paddingVertical: 6 },
  eventTime: { fontWeight: "900", fontSize: 12 },
  eventText: { fontWeight: "800", fontSize: 12 },
});
