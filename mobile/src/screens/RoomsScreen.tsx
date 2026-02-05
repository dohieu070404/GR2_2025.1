import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, FlatList, Pressable, TextInput, ActivityIndicator, Alert } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiCreateRoom, apiListRooms, apiListHomes } from "../api/api";
import { useHomeSelection } from "../context/HomeContext";
import type { Room, Home } from "../types";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { HomesStackParamList } from "../navigation/AppNavigator";

export default function RoomsScreen({ navigation }: NativeStackScreenProps<HomesStackParamList, "Rooms">) {
  const qc = useQueryClient();
  const { activeHomeId, setActiveRoomId } = useHomeSelection();

  const homesQuery = useQuery({ queryKey: ["homes"], queryFn: apiListHomes });
  const homeName = useMemo(() => {
    const homes = homesQuery.data?.homes ?? [];
    return homes.find((h) => h.id === activeHomeId)?.name ?? null;
  }, [homesQuery.data, activeHomeId]);

  const roomsQuery = useQuery({
    enabled: !!activeHomeId,
    queryKey: ["rooms", activeHomeId],
    queryFn: () => apiListRooms(activeHomeId!),
    refetchOnWindowFocus: true,
  });

  const [name, setName] = useState("");
  const createMutation = useMutation({
    mutationFn: async () => {
      if (!activeHomeId) throw new Error("Chưa chọn Home");
      const n = name.trim();
      if (!n) throw new Error("Tên room không được rỗng");
      return apiCreateRoom(activeHomeId, { name: n });
    },
    onSuccess: () => {
      setName("");
      qc.invalidateQueries({ queryKey: ["rooms", activeHomeId] });
    },
    onError: (e: any) => {
      const msg = e?.response?.data?.error || e?.message || "Create room failed";
      Alert.alert("Create room failed", typeof msg === "string" ? msg : JSON.stringify(msg));
    },
  });

  const rooms = roomsQuery.data?.rooms ?? [];

  if (!activeHomeId) {
    return (
      <View style={styles.center}>
        <Text style={styles.h1}>Chưa chọn Home</Text>
        <Text style={styles.sub}>Vui lòng chọn hoặc tạo Home trước.</Text>
        <Pressable style={styles.primaryBtn} onPress={() => navigation.navigate("HomesHome")}>
          <Text style={styles.primaryText}>Đi đến Homes</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.h1}>Rooms</Text>
        <Text style={styles.sub}>Home: {homeName ?? `#${activeHomeId}`}</Text>
      </View>

      <View style={styles.form}>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Tên room (vd: Phòng khách)"
          style={styles.input}
        />
        <Pressable style={[styles.primaryBtn, { opacity: createMutation.isPending ? 0.6 : 1 }]} onPress={() => createMutation.mutate()}>
          <Text style={styles.primaryText}>{createMutation.isPending ? "Đang tạo..." : "Tạo room"}</Text>
        </Pressable>
      </View>

      {roomsQuery.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator />
          <Text>Loading rooms...</Text>
        </View>
      ) : (
        <FlatList
          data={rooms}
          keyExtractor={(r) => String(r.id)}
          contentContainerStyle={{ padding: 12, gap: 10 }}
          renderItem={({ item }) => (
            <Pressable
              style={styles.card}
              onPress={() => {
                setActiveRoomId(item.id);
                // Return to main usage screens after setting the default room filter
                // Parent navigator is the bottom tabs.
                // @ts-ignore
                navigation.getParent?.()?.navigate?.("Devices");
              }}
            >
              <Text style={styles.cardTitle}>{item.name}</Text>
              <Text style={styles.cardSub}>Tap để set filter room mặc định</Text>
            </Pressable>
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>Chưa có room</Text>
              <Text style={styles.emptySub}>Tạo room đầu tiên để phân loại thiết bị.</Text>
            </View>
          }
        />
      )}

      <View style={styles.footerRow}>
        <Pressable
          style={styles.secondaryBtn}
          onPress={() => {
            setActiveRoomId(null);
            // @ts-ignore
            navigation.getParent?.()?.navigate?.("Devices");
          }}
        >
          <Text style={styles.secondaryText}>Bỏ filter room</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fafafa" },
  header: { padding: 12, gap: 4 },
  h1: { fontSize: 18, fontWeight: "800" },
  sub: { fontSize: 12, color: "#666" },
  form: { paddingHorizontal: 12, paddingBottom: 10, gap: 10 },
  input: { backgroundColor: "#fff", borderWidth: 1, borderColor: "#eee", borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  primaryBtn: { backgroundColor: "#111", paddingVertical: 12, borderRadius: 12, alignItems: "center" },
  primaryText: { color: "#fff", fontWeight: "800" },
  secondaryBtn: { backgroundColor: "#efefef", paddingVertical: 12, borderRadius: 12, alignItems: "center", flex: 1 },
  secondaryText: { fontWeight: "800" },
  card: { backgroundColor: "#fff", borderWidth: 1, borderColor: "#eee", borderRadius: 14, padding: 12, gap: 4 },
  cardTitle: { fontSize: 14, fontWeight: "800" },
  cardSub: { fontSize: 12, color: "#666" },
  empty: { padding: 20, alignItems: "center", gap: 6 },
  emptyTitle: { fontSize: 16, fontWeight: "700" },
  emptySub: { fontSize: 12, color: "#666", textAlign: "center" },
  footerRow: { padding: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 20 },
});
