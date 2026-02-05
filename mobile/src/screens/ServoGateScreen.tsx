import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, FlatList } from "react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { DevicesStackParamList } from "../navigation/AppNavigator";
import { apiListDevices, apiSendCommand, apiGetDeviceEvents } from "../api/api";

type Props = NativeStackScreenProps<DevicesStackParamList, "ServoGate">;

function formatLocalTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString();
  } catch {
    return iso;
  }
}

function toIsoDate(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export default function ServoGateScreen({ route }: Props) {
  const deviceId = route.params.deviceId;

  const devicesQuery = useQuery({
    queryKey: ["devices", "all"],
    queryFn: () => apiListDevices(),
    staleTime: 5000,
  });

  const device = devicesQuery.data?.devices?.find((d) => d.id === deviceId) || null;
  const state: any = device?.stateCurrent?.state ?? device?.lastState ?? null;

  const gateOpen: boolean = Boolean(state?.gate?.open ?? state?.relay ?? false);
  const lightOn: boolean = Boolean(state?.light?.on ?? (typeof state?.pwm === "number" ? state.pwm > 0 : false));
  const motionLastAt: number | null =
    typeof state?.motion?.lastAt === "number" ? state.motion.lastAt : null;

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

  const motionEvents = useMemo(() => {
    const items = eventsQuery.data?.events || [];
    return items.filter((e) => e.type === "motion.detected");
  }, [eventsQuery.data]);

  const sendCmd = useMutation({
    mutationFn: (action: "gate.open" | "gate.close") =>
      apiSendCommand(deviceId, { action, params: { source: "mobile" } }),
  });

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{device ? device.name : `Device #${deviceId}`}</Text>

      <View style={styles.card}>
        <Text style={styles.label}>Gate</Text>
        <Text style={styles.value}>{gateOpen ? "OPEN" : "CLOSED"}</Text>

        <View style={styles.row}>
          <Pressable
            style={[styles.btn, styles.btnPrimary]}
            onPress={() => sendCmd.mutate("gate.open")}
            disabled={sendCmd.isPending}
          >
            <Text style={styles.btnText}>Open</Text>
          </Pressable>
          <Pressable
            style={[styles.btn, styles.btnSecondary]}
            onPress={() => sendCmd.mutate("gate.close")}
            disabled={sendCmd.isPending}
          >
            <Text style={styles.btnText}>Close</Text>
          </Pressable>
        </View>

        <Text style={styles.subtle}>Light: {lightOn ? "ON" : "OFF"}</Text>
        <Text style={styles.subtle}>
          Last motion: {motionLastAt ? new Date(motionLastAt).toLocaleString() : "—"}
        </Text>
      </View>

      <View style={styles.historyHeader}>
        <Text style={styles.label}>Motion history</Text>
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

      <FlatList
        data={motionEvents}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={{ paddingBottom: 40 }}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {eventsQuery.isLoading ? "Loading…" : "No motion events"}
          </Text>
        }
        renderItem={({ item }) => {
          const when = item.sourceAt ?? item.createdAt ?? "";
          return (
            <View style={styles.eventRow}>
              <Text style={styles.eventTime}>{when ? formatLocalTime(when) : "—"}</Text>
              <Text style={styles.eventText}>motion.detected</Text>
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  title: { fontSize: 20, fontWeight: "700", marginBottom: 12 },
  card: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  label: { fontSize: 14, fontWeight: "600" },
  value: { fontSize: 28, fontWeight: "800", marginTop: 4, marginBottom: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  btn: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10 },
  btnPrimary: { backgroundColor: "#111" },
  btnSecondary: { backgroundColor: "#555" },
  btnText: { color: "#fff", fontWeight: "700" },
  subtle: { marginTop: 8, color: "#444" },
  historyHeader: { marginBottom: 10, gap: 8 },
  dateText: { fontSize: 14, fontWeight: "700" },
  smallBtn: { borderWidth: 1, borderColor: "#ddd", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  smallBtnText: { fontSize: 14 },
  eventRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
    paddingVertical: 10,
  },
  eventTime: { fontWeight: "700" },
  eventText: { color: "#333" },
  empty: { color: "#777", paddingVertical: 16 },
});
