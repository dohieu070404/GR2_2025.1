import React, { useMemo } from "react";
import { View, Text, StyleSheet, Pressable, FlatList, ActivityIndicator } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { DevicesStackParamList } from "../navigation/AppNavigator";
import { apiListDevices, apiListHomes, apiListRooms } from "../api/api";
import DeviceCard from "../components/DeviceCard";
import { useHomeSelection } from "../context/HomeContext";
import type { Room } from "../types";

type Props = NativeStackScreenProps<DevicesStackParamList, "DevicesHome">;

export default function DevicesScreen({ navigation }: Props) {
  const qc = useQueryClient();
  const { activeHomeId, activeRoomId, setActiveRoomId } = useHomeSelection();

  const homesQuery = useQuery({ queryKey: ["homes"], queryFn: apiListHomes, refetchOnWindowFocus: true });
  const activeHomeName = useMemo(() => {
    const homes = homesQuery.data?.homes ?? [];
    return homes.find((h) => h.id === activeHomeId)?.name ?? null;
  }, [homesQuery.data, activeHomeId]);

  const roomsQuery = useQuery({
    enabled: !!activeHomeId,
    queryKey: ["rooms", activeHomeId],
    queryFn: () => apiListRooms(activeHomeId!),
    refetchOnWindowFocus: true,
  });

  const rooms: Room[] = roomsQuery.data?.rooms ?? [];
  const activeRoomName = useMemo(() => {
    if (!activeRoomId) return null;
    return rooms.find((r) => r.id === activeRoomId)?.name ?? null;
  }, [rooms, activeRoomId]);

  const devicesQuery = useQuery({
    enabled: !!activeHomeId,
    queryKey: ["devices", { homeId: activeHomeId, roomId: activeRoomId ?? null }],
    queryFn: () => apiListDevices({ homeId: activeHomeId!, roomId: activeRoomId ?? null }),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const devices = devicesQuery.data?.devices ?? [];

  if (!activeHomeId) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Chưa chọn Home</Text>
        <Text style={styles.sub}>Vui lòng vào tab Home để chọn/tạo Home trước khi quản lý thiết bị.</Text>
        <Pressable
          style={[styles.btn, styles.btnPrimary]}
          onPress={() => {
            // Switch to Home tab
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
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.title}>Devices</Text>
          <Text style={styles.sub}>Home: {activeHomeName ?? `#${activeHomeId}`}</Text>
          <Text style={styles.sub}>Room: {activeRoomId ? activeRoomName ?? `#${activeRoomId}` : "All"}</Text>
        </View>

        <View style={{ gap: 8 }}>
          <Pressable style={[styles.smallBtn, styles.smallBtnPrimary]} onPress={() => navigation.navigate("AddDevice")}>
            <Text style={styles.smallBtnPrimaryText}>+ Add</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.roomBar}>
        <Pressable
          style={[styles.chip, activeRoomId == null ? styles.chipActive : null]}
          onPress={() => setActiveRoomId(null)}
        >
          <Text style={activeRoomId == null ? styles.chipTextActive : styles.chipText}>All</Text>
        </Pressable>
        {rooms.slice(0, 12).map((r) => (
          <Pressable
            key={r.id}
            style={[styles.chip, activeRoomId === r.id ? styles.chipActive : null]}
            onPress={() => setActiveRoomId(r.id)}
          >
            <Text style={activeRoomId === r.id ? styles.chipTextActive : styles.chipText}>{r.name}</Text>
          </Pressable>
        ))}
      </View>

      {devicesQuery.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator />
          <Text>Loading...</Text>
        </View>
      ) : (
        <FlatList
          data={devices}
          keyExtractor={(d) => String(d.id)}
          contentContainerStyle={{ padding: 12, gap: 12, paddingBottom: 40 }}
          renderItem={({ item }) => (
            <Pressable
              // Sprint 12: Device detail is rendered via descriptor + plugin registry.
              onPress={() => navigation.navigate("DeviceDetails", { deviceId: item.id })}
              style={({ pressed }) => [pressed ? { opacity: 0.85 } : null]}
            >
              <DeviceCard device={item} />
            </Pressable>
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No devices</Text>
              <Text style={styles.emptySub}>Add a device (MQTT or Zigbee).</Text>
              <Pressable
                style={[styles.btn, styles.btnPrimary]}
                onPress={() => navigation.navigate("AddDevice")}
              >
                <Text style={styles.btnPrimaryText}>Add device</Text>
              </Pressable>
            </View>
          }
          onRefresh={async () => {
            await qc.invalidateQueries({ queryKey: ["devices"] });
          }}
          refreshing={devicesQuery.isFetching && !devicesQuery.isLoading}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fafafa" },
  header: { padding: 12, flexDirection: "row", gap: 10, alignItems: "flex-start" },
  title: { fontSize: 18, fontWeight: "800" },
  sub: { fontSize: 12, color: "#666" },

  roomBar: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: "#ddd", backgroundColor: "#fff" },
  chipActive: { backgroundColor: "#111", borderColor: "#111" },
  chipText: { fontWeight: "800", color: "#111", fontSize: 12 },
  chipTextActive: { fontWeight: "800", color: "#fff", fontSize: 12 },

  smallBtn: { paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, alignItems: "center" },
  smallBtnPrimary: { backgroundColor: "#111" },
  smallBtnPrimaryText: { color: "#fff", fontWeight: "800" },
  smallBtnSecondary: { backgroundColor: "#efefef" },
  smallBtnSecondaryText: { color: "#111", fontWeight: "800" },

  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 20 },
  btn: { paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, alignItems: "center" },
  btnPrimary: { backgroundColor: "#111" },
  btnPrimaryText: { color: "#fff", fontWeight: "800" },

  empty: { padding: 20, gap: 8, alignItems: "center" },
  emptyTitle: { fontSize: 16, fontWeight: "800" },
  emptySub: { fontSize: 12, color: "#666", textAlign: "center" },
});
