import React, { useMemo } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useQuery } from "@tanstack/react-query";

import type { DevicesStackParamList } from "../navigation/AppNavigator";
import { apiListHubs, apiListHomes } from "../api/api";
import { useHomeSelection } from "../context/HomeContext";

type Props = NativeStackScreenProps<DevicesStackParamList, "AddDevice">;

export default function AddDeviceScreen({ navigation }: Props) {
  const { activeHomeId } = useHomeSelection();

  const homesQuery = useQuery({ queryKey: ["homes"], queryFn: apiListHomes, refetchOnWindowFocus: true });
  const activeHomeName = useMemo(() => {
    const homes = homesQuery.data?.homes ?? [];
    return homes.find((h) => h.id === activeHomeId)?.name ?? null;
  }, [homesQuery.data, activeHomeId]);

  const hubsQuery = useQuery({
    enabled: !!activeHomeId,
    queryKey: ["hubs", { homeId: activeHomeId }],
    queryFn: () => apiListHubs(activeHomeId!),
    refetchOnWindowFocus: true,
  });
  const hubCount = hubsQuery.data?.hubs?.length ?? 0;

  if (!activeHomeId) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Chưa chọn Home</Text>
        <Text style={styles.sub}>Vui lòng vào tab Home để chọn/tạo Home trước khi thêm thiết bị.</Text>
        <Pressable
          style={[styles.btn, styles.btnPrimary]}
          onPress={() => {
            // @ts-ignore
            navigation.getParent()?.navigate("Home");
          }}
        >
          <Text style={styles.btnPrimaryText}>Đi đến Home</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Add device</Text>
        <Text style={styles.sub}>Home: {activeHomeName ?? `#${activeHomeId}`}</Text>
        <Text style={styles.note}>Flow chuẩn: Claim HUB trước, rồi mới add Zigbee devices.</Text>
      </View>

      {hubCount === 0 ? (
        <View style={styles.warn}>
          <Text style={styles.warnTitle}>Chưa có HUB</Text>
          <Text style={styles.warnText}>Bạn cần claim HUB vào Home trước khi add Zigbee devices.</Text>
          <Text style={styles.warnText}>Vào tab Settings → Add Hub.</Text>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>MQTT device (manual add)</Text>
        <Text style={styles.cardSub}>Nhập Serial + Setup code để claim thiết bị vật lý.</Text>
        <Pressable style={[styles.btn, styles.btnPrimary]} onPress={() => navigation.navigate("ClaimMqttDevice")}>
          <Text style={styles.btnPrimaryText}>Add MQTT device</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Zigbee device (via HUB)</Text>
        <Text style={styles.cardSub}>Chọn HUB đã claim → mở pairing → confirm.</Text>
        <Pressable
          style={[styles.btn, styles.btnSecondary, hubCount === 0 ? { opacity: 0.5 } : null]}
          onPress={() => navigation.navigate("ZigbeePairing")}
          disabled={hubCount === 0}
        >
          <Text style={styles.btnSecondaryText}>Zigbee pairing</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fafafa", padding: 12, gap: 12 },
  header: { gap: 4 },
  title: { fontSize: 18, fontWeight: "800" },
  sub: { fontSize: 12, color: "#666" },
  note: { fontSize: 12, color: "#333" },
  warn: { padding: 12, borderRadius: 12, borderWidth: 1, borderColor: "#f2c", backgroundColor: "#fff" },
  warnTitle: { fontWeight: "900" },
  warnText: { fontSize: 12, color: "#444", marginTop: 4 },
  card: { padding: 12, borderRadius: 12, borderWidth: 1, borderColor: "#eee", backgroundColor: "#fff", gap: 8 },
  cardTitle: { fontSize: 14, fontWeight: "900" },
  cardSub: { fontSize: 12, color: "#666" },
  btn: { paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, alignItems: "center" },
  btnPrimary: { backgroundColor: "#111" },
  btnPrimaryText: { color: "#fff", fontWeight: "800" },
  btnSecondary: { backgroundColor: "#efefef" },
  btnSecondaryText: { color: "#111", fontWeight: "800" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 20 },
});
