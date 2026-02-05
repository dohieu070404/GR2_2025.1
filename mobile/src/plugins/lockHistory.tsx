import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { useQuery } from "@tanstack/react-query";

import { apiGetDeviceEvents } from "../api/api";
import type { DeviceEvent } from "../types";
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

function renderEventLine(e: DeviceEvent) {
  const data: any = e.data ?? {};
  if (e.type === "lock.unlock") {
    const method = data.method ?? "?";
    const ok = data.success;
    const slot = data.slot != null ? ` slot=${data.slot}` : "";
    return `${method} · success=${String(ok)}${slot}`;
  }
  if (e.type === "lock.credential_changed") {
    return `${data.op ?? "?"} ${data.type ?? "?"} slot=${data.slot ?? "?"}`;
  }
  return JSON.stringify(data);
}

function LockHistorySection({ deviceId }: { deviceId: number }) {
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

  const lockEvents = useMemo(() => {
    const items = eventsQuery.data?.events || [];
    return items.filter((e) => e.type === "lock.unlock" || e.type === "lock.credential_changed" || e.type === "lock.lock");
  }, [eventsQuery.data]);

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.sectionTitle}>History</Text>
        <View style={styles.row}>
          <Pressable style={styles.smallBtn} onPress={() => setDayOffset((v) => v - 1)}>
            <Text style={styles.smallBtnText}>◀</Text>
          </Pressable>
          <Text style={styles.dateText}>{dateStr}</Text>
          <Pressable style={styles.smallBtn} onPress={() => setDayOffset((v) => v + 1)}>
            <Text style={styles.smallBtnText}>▶</Text>
          </Pressable>
        </View>
      </View>

      {eventsQuery.isLoading ? (
        <Text style={styles.subtle}>Loading…</Text>
      ) : lockEvents.length ? (
        <View style={{ gap: 8, marginTop: 10 }}>
          {lockEvents.slice(-80).map((e) => (
            <View key={String(e.id)} style={styles.eventRow}>
              <Text style={styles.eventTime}>{e.sourceAt ? formatLocalTime(e.sourceAt) : "—"}</Text>
              <Text style={styles.eventText}>{e.type}</Text>
              <Text style={styles.eventSub}>{renderEventLine(e)}</Text>
            </View>
          ))}
        </View>
      ) : (
        <Text style={styles.subtle}>(no events)</Text>
      )}
    </View>
  );
}

export const LockHistoryPlugin: DevicePlugin = {
  id: "lock.history",
  render: (props: PluginSectionProps) => <LockHistorySection deviceId={props.deviceId} />,
};

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 12,
    padding: 16,
    backgroundColor: "#fff",
  },
  headerRow: { gap: 10 },
  sectionTitle: { fontSize: 14, fontWeight: "800" },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  subtle: { marginTop: 10, color: "#666" },
  dateText: { fontSize: 12, fontWeight: "900" },
  smallBtn: { borderWidth: 1, borderColor: "#ddd", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  smallBtnText: { fontSize: 12, fontWeight: "800" },
  eventRow: { gap: 2, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: "#eee" },
  eventTime: { fontWeight: "900", fontSize: 12 },
  eventText: { fontWeight: "800", fontSize: 12 },
  eventSub: { fontSize: 12, color: "#333" },
});
