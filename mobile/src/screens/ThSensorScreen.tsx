import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, FlatList, RefreshControl, Pressable } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { DevicesStackParamList } from "../navigation/AppNavigator";
import { apiDeviceHistory, apiListDevices } from "../api/api";
import type { Device } from "../types";

type Props = NativeStackScreenProps<DevicesStackParamList, "ThSensor">;

function fmtTs(ts?: string | null) {
  if (!ts) return "-";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function fmtYYYYMMDDLocal(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export default function ThSensorScreen({ route }: Props) {
  const qc = useQueryClient();
  const deviceId = route.params.deviceId;
  const [dateStr, setDateStr] = useState(() => fmtYYYYMMDDLocal(new Date()));

  const devicesQuery = useQuery({
    queryKey: ["devices", "all"],
    queryFn: () => apiListDevices(),
    refetchInterval: 2000,
    refetchOnWindowFocus: true,
  });

  const device: Device | null = useMemo(() => {
    return devicesQuery.data?.devices?.find((d) => d.id === deviceId) ?? null;
  }, [devicesQuery.data, deviceId]);

  const historyQuery = useQuery({
    queryKey: ["deviceHistoryDaily", deviceId, dateStr],
    queryFn: () => apiDeviceHistory(deviceId, dateStr),
    enabled: !!deviceId,
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
  });

  const state = (device?.stateCurrent?.state || {}) as any;
  const temp = typeof state.temperature === "number" ? state.temperature : null;
  const hum = typeof state.humidity === "number" ? state.humidity : null;
  const online = device?.stateCurrent?.online ?? null;
  const lastSeen = device?.stateCurrent?.lastSeen ?? null;
  const claimed = device?.claimed ?? false;

  const points = historyQuery.data?.points ?? [];

  return (
    <View style={styles.container}>
      <View style={styles.headerCard}>
        <Text style={styles.title}>{device?.name || "TH Sensor"}</Text>
        <Text style={styles.subTitle}>Model: {device?.modelId || "-"}</Text>
        <Text style={styles.subTitle}>IEEE: {device?.zigbeeIeee || "-"}</Text>

        <View style={styles.kpiRow}>
          <View style={styles.kpiBox}>
            <Text style={styles.kpiLabel}>Nhiệt độ</Text>
            <Text style={styles.kpiValue}>{temp != null ? `${temp.toFixed(2)} °C` : "-"}</Text>
          </View>
          <View style={styles.kpiBox}>
            <Text style={styles.kpiLabel}>Độ ẩm</Text>
            <Text style={styles.kpiValue}>{hum != null ? `${hum.toFixed(2)} %` : "-"}</Text>
          </View>
        </View>

        <View style={styles.metaRow}>
          <Text style={styles.metaText}>Status: {online == null ? "-" : online ? "ONLINE" : "OFFLINE"}</Text>
          <Text style={styles.metaText}>Last seen: {fmtTs(lastSeen)}</Text>
          <Text style={styles.metaText}>Claimed: {claimed ? "YES" : "NO"}</Text>
        </View>
      </View>

      <View style={styles.historyHeader}>
        <Text style={styles.sectionTitle}>History ({dateStr})</Text>
        <View style={styles.dateActions}>
          <Pressable
            style={styles.dateButton}
            onPress={() => {
              const d = new Date(dateStr + "T00:00:00");
              d.setDate(d.getDate() - 1);
              setDateStr(fmtYYYYMMDDLocal(d));
            }}
          >
            <Text style={styles.dateButtonText}>◀</Text>
          </Pressable>
          <Pressable
            style={styles.dateButton}
            onPress={() => {
              const d = new Date(dateStr + "T00:00:00");
              d.setDate(d.getDate() + 1);
              setDateStr(fmtYYYYMMDDLocal(d));
            }}
          >
            <Text style={styles.dateButtonText}>▶</Text>
          </Pressable>
        </View>
      </View>

      <FlatList
        data={points}
        keyExtractor={(item, idx) => `${item.ts}-${idx}`}
        refreshControl={
          <RefreshControl
            refreshing={devicesQuery.isFetching || historyQuery.isFetching}
            onRefresh={async () => {
              await qc.invalidateQueries({ queryKey: ["devices"] });
              await qc.invalidateQueries({ queryKey: ["deviceHistoryDaily", deviceId, dateStr] });
            }}
          />
        }
        renderItem={({ item }) => {
          return (
            <View style={styles.row}>
              <Text style={styles.rowTs}>{fmtTs(item.ts)}</Text>
              <Text style={styles.rowVal}>
                {typeof item.temperature === "number" ? `${item.temperature.toFixed(2)} °C` : "-"} /{" "}
                {typeof item.humidity === "number" ? `${item.humidity.toFixed(2)} %` : "-"}
              </Text>
            </View>
          );
        }}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {historyQuery.isLoading ? "Đang tải history…" : "Chưa có dữ liệu trong ngày."}
          </Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 12 },
  headerCard: { padding: 14, borderWidth: 1, borderRadius: 12 },
  title: { fontSize: 20, fontWeight: "700" },
  subTitle: { marginTop: 4, opacity: 0.8 },
  kpiRow: { flexDirection: "row", gap: 12, marginTop: 12 },
  kpiBox: { flex: 1, padding: 12, borderWidth: 1, borderRadius: 12 },
  kpiLabel: { opacity: 0.75 },
  kpiValue: { fontSize: 22, fontWeight: "700", marginTop: 6 },
  metaRow: { marginTop: 12, gap: 4 },
  metaText: { opacity: 0.85 },
  historyHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  sectionTitle: { fontSize: 16, fontWeight: "700" },
  dateActions: { flexDirection: "row", gap: 8 },
  dateButton: { paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderRadius: 10 },
  dateButtonText: { fontSize: 16 },
  row: { paddingVertical: 10, borderBottomWidth: 1, opacity: 0.95 },
  rowTs: { fontWeight: "600" },
  rowVal: { marginTop: 2 },
  empty: { paddingTop: 16, opacity: 0.8 },
});
