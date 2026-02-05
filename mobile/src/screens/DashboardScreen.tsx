import React, { useEffect, useMemo } from "react";
import { View, Text, StyleSheet, FlatList, RefreshControl, ActivityIndicator } from "react-native";
import { useQuery } from "@tanstack/react-query";

import { apiListDevices, apiListHomes } from "../api/api";
import DeviceCard from "../components/DeviceCard";
import { useHomeSelection } from "../context/HomeContext";

export default function DashboardScreen() {
  const { isHydrated, activeHomeId, setActiveHomeId, activeRoomId, setActiveRoomId } = useHomeSelection();

  const homesQuery = useQuery({ queryKey: ["homes"], queryFn: apiListHomes });
  const homes = homesQuery.data?.homes ?? [];

  useEffect(() => {
    if (!isHydrated) return;
    if (activeHomeId == null && homes.length > 0) {
      setActiveHomeId(homes[0].id);
      setActiveRoomId(null);
    }
  }, [isHydrated, activeHomeId, homes.length]);

  const activeHome = useMemo(() => homes.find((h) => h.id === activeHomeId) ?? null, [homes, activeHomeId]);

  const devicesQuery = useQuery({
    queryKey: ["devices", { homeId: activeHomeId, roomId: activeRoomId }],
    queryFn: () => apiListDevices({ homeId: activeHomeId ?? undefined, roomId: activeRoomId ?? undefined }),
    enabled: !!activeHomeId,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const devices = devicesQuery.data?.devices ?? [];

  if (homesQuery.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
        <Text>Loading homes...</Text>
      </View>
    );
  }

  if (!activeHomeId) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Chưa có Home</Text>
        <Text style={styles.sub}>Vào tab Home để tạo/chọn Home trước.</Text>
      </View>
    );
  }

  if (devicesQuery.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
        <Text>Loading devices...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.banner}>
        <Text style={styles.bannerTitle}>{activeHome?.name ?? `Home #${activeHomeId}`}</Text>
        <Text style={styles.bannerSub}>{activeRoomId ? `Room filter: #${activeRoomId}` : "All rooms"}</Text>
      </View>

      <FlatList
        data={devices}
        keyExtractor={(d) => String(d.id)}
        contentContainerStyle={{ padding: 12, gap: 10 }}
        renderItem={({ item }) => <DeviceCard device={item} />}
        refreshControl={<RefreshControl refreshing={devicesQuery.isFetching} onRefresh={() => devicesQuery.refetch()} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No devices</Text>
            <Text style={styles.emptySub}>Go to Devices tab to add your first device.</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fafafa" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 20 },
  title: { fontSize: 18, fontWeight: "800" },
  sub: { fontSize: 12, color: "#666", textAlign: "center" },
  banner: {
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 6,
  },
  bannerTitle: { fontSize: 18, fontWeight: "800" },
  bannerSub: { fontSize: 12, color: "#666" },
  empty: { padding: 20, alignItems: "center", gap: 6 },
  emptyTitle: { fontSize: 16, fontWeight: "700" },
  emptySub: { fontSize: 12, color: "#666", textAlign: "center" },
});
