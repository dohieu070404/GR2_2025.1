import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, FlatList, Pressable, TextInput, ActivityIndicator, Alert } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiCreateHome, apiListHomes } from "../api/api";
import { useHomeSelection } from "../context/HomeContext";
import type { Home } from "../types";

export default function HomesScreen({ navigation }: any) {
  const qc = useQueryClient();
  const { activeHomeId, setActiveHomeId, setActiveRoomId } = useHomeSelection();
  const [name, setName] = useState("");

  const homesQuery = useQuery({
    queryKey: ["homes"],
    queryFn: apiListHomes,
    refetchOnWindowFocus: true,
  });

  const createMutation = useMutation({
    mutationFn: async (homeName: string) => apiCreateHome({ name: homeName }),
    onSuccess: async (res) => {
      setName("");
      await qc.invalidateQueries({ queryKey: ["homes"] });
      // auto-select new home
      const created = (res as any)?.home;
      if (!created?.id) {
        Alert.alert("Create home failed", "Unexpected response: " + JSON.stringify(res));
        return;
      }
      setActiveHomeId(created.id);
      setActiveRoomId(null);
      navigation?.navigate?.("Rooms");
    },
    onError: (e: any) => {
      const msg = e?.response?.data?.error || e?.message || "Create home failed";
      Alert.alert("Create home failed", typeof msg === "string" ? msg : JSON.stringify(msg));
    },
  });

  const homes = homesQuery.data?.homes ?? [];

  const selectedHome = useMemo(() => homes.find((h) => h.id === activeHomeId) ?? null, [homes, activeHomeId]);

  function onSelect(home: Home) {
    setActiveHomeId(home.id);
    setActiveRoomId(null);
    navigation?.navigate?.("Rooms");
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Homes</Text>
        <Text style={styles.sub}>Chọn home đang active (thiết bị, Zigbee pairing, rooms sẽ theo home này).</Text>
      </View>

      <View style={styles.createRow}>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="New home name"
          style={styles.input}
          autoCapitalize="words"
        />
        <Pressable
          style={[styles.btn, styles.primaryBtn]}
          onPress={() => {
            const v = name.trim();
            if (!v) return;
            createMutation.mutate(v);
          }}
          disabled={createMutation.isPending}
        >
          <Text style={styles.primaryText}>{createMutation.isPending ? "..." : "Add"}</Text>
        </Pressable>
      </View>

      {selectedHome ? (
        <View style={styles.activeCard}>
          <Text style={styles.activeTitle}>Active home</Text>
          <Text style={styles.activeName}>{selectedHome.name}</Text>
        </View>
      ) : null}

      {homesQuery.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator />
          <Text>Loading...</Text>
        </View>
      ) : (
        <FlatList
          data={homes}
          keyExtractor={(h) => String(h.id)}
          contentContainerStyle={{ padding: 12, gap: 10 }}
          renderItem={({ item }) => {
            const active = item.id === activeHomeId;
            return (
              <Pressable onPress={() => onSelect(item)} style={[styles.card, active && styles.cardActive]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>{item.name}</Text>
                  <Text style={styles.cardSub}>Home ID: {item.id}</Text>
                </View>
                <Text style={[styles.badge, active && styles.badgeActive]}>{active ? "Active" : "Select"}</Text>
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>Chưa có home</Text>
              <Text style={styles.emptySub}>Tạo 1 home trước, sau đó tạo rooms và add thiết bị.</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fafafa" },
  header: { padding: 12, gap: 6 },
  title: { fontSize: 18, fontWeight: "700" },
  sub: { fontSize: 12, color: "#666" },

  createRow: { flexDirection: "row", gap: 10, paddingHorizontal: 12, paddingBottom: 10 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#fff",
  },
  btn: { paddingHorizontal: 14, justifyContent: "center", borderRadius: 12 },
  primaryBtn: { backgroundColor: "#111" },
  primaryText: { color: "#fff", fontWeight: "700" },

  activeCard: {
    marginHorizontal: 12,
    marginBottom: 10,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#eee",
    gap: 2,
  },
  activeTitle: { fontSize: 12, color: "#666" },
  activeName: { fontSize: 16, fontWeight: "800" },

  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },

  card: {
    flexDirection: "row",
    gap: 12,
    padding: 14,
    borderRadius: 16,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#eee",
    alignItems: "center",
  },
  cardActive: { borderColor: "#111" },
  cardTitle: { fontSize: 14, fontWeight: "800" },
  cardSub: { fontSize: 12, color: "#666" },

  badge: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "#efefef",
    fontWeight: "800",
  },
  badgeActive: { backgroundColor: "#111", color: "#fff" },

  empty: { padding: 20, alignItems: "center", gap: 6 },
  emptyTitle: { fontSize: 16, fontWeight: "700" },
  emptySub: { fontSize: 12, color: "#666", textAlign: "center" },
});
