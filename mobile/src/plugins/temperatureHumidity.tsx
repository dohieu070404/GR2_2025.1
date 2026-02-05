import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { useQuery } from "@tanstack/react-query";

import type { Device } from "../types";
import { apiGetDeviceHistory } from "../api/api";
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

function getThState(device: Device | null) {
  const st: any = device?.stateCurrent?.state ?? device?.lastState ?? null;
  const t = typeof st?.temperature === "number" ? st.temperature : null;
  const h = typeof st?.humidity === "number" ? st.humidity : null;
  return { temperature: t, humidity: h };
}

function RealtimeSection({ device }: { device: Device | null }) {
  const { temperature, humidity } = getThState(device);

  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>Realtime</Text>

      <View style={styles.row}>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>Temperature</Text>
          <Text style={styles.metricValue}>
            {temperature == null ? "—" : `${temperature.toFixed(2)} °C`}
          </Text>
        </View>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>Humidity</Text>
          <Text style={styles.metricValue}>
            {humidity == null ? "—" : `${humidity.toFixed(2)} %`}
          </Text>
        </View>
      </View>
    </View>
  );
}

function HistoryDailySection({ deviceId }: { deviceId: number }) {
  const [dayOffset, setDayOffset] = useState(0);
  const selectedDate = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    return d;
  }, [dayOffset]);
  const dateStr = useMemo(() => toIsoDate(selectedDate), [selectedDate]);

  const historyQuery = useQuery({
    queryKey: ["deviceHistory", deviceId, dateStr],
    queryFn: () => apiGetDeviceHistory({ deviceId, date: dateStr }),
    enabled: deviceId > 0,
    // history doesn't need ultra-high frequency; SSE already updates realtime state.
    refetchInterval: 60_000,
  });

  const points = historyQuery.data?.points ?? [];
  const shown = points.slice(-60); // keep UI light

  return (
    <View style={styles.card}>
      <View style={styles.historyHeader}>
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

      {historyQuery.isLoading ? (
        <Text style={styles.subtle}>Loading…</Text>
      ) : shown.length ? (
        <View style={{ gap: 8 }}>
          {shown.map((p, idx) => (
            <View key={`${p.ts}-${idx}`} style={styles.historyRow}>
              <Text style={styles.historyTime}>{formatLocalTime(p.ts)}</Text>
              <Text style={styles.historyText}>
                {p.temperature == null ? "—" : `${p.temperature.toFixed(2)}°C`} · {p.humidity == null ? "—" : `${p.humidity.toFixed(2)}%`}
              </Text>
            </View>
          ))}
        </View>
      ) : (
        <Text style={styles.subtle}>(no points)</Text>
      )}
    </View>
  );
}

function TemperatureHumiditySection(props: PluginSectionProps) {
  const view = (props.section?.view || "realtime").toString();
  if (view === "history" || view === "history_daily") {
    return <HistoryDailySection deviceId={props.deviceId} />;
  }
  return <RealtimeSection device={props.device} />;
}

export const TemperatureHumidityPlugin: DevicePlugin = {
  id: "sensor.temperature_humidity",
  render: (props) => <TemperatureHumiditySection {...props} />,
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
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  metric: { flex: 1, gap: 4, marginTop: 12 },
  metricLabel: { fontSize: 12, color: "#666", fontWeight: "700" },
  metricValue: { fontSize: 22, fontWeight: "900" },
  subtle: { marginTop: 8, color: "#666" },

  historyHeader: { gap: 10 },
  dateText: { fontSize: 12, fontWeight: "900" },
  smallBtn: { borderWidth: 1, borderColor: "#ddd", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  smallBtnText: { fontSize: 12, fontWeight: "800" },
  historyRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  historyTime: { fontWeight: "800", fontSize: 12 },
  historyText: { color: "#333", fontSize: 12 },
});
