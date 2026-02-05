import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator, Alert } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { DevicesStackParamList } from "../navigation/AppNavigator";
import { apiHubPairingDiscovered, apiHubPairingOpen, apiHubPairingReject, apiListHomes, apiListHubs } from "../api/api";
import type { ZigbeeDiscoveredDevice } from "../types";
import { useHomeSelection } from "../context/HomeContext";

type Props = NativeStackScreenProps<DevicesStackParamList, "ZigbeePairing">;

export default function ZigbeePairingScreen({ navigation }: Props) {
  const qc = useQueryClient();
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
  const hubs = hubsQuery.data?.hubs ?? [];
  const [selectedHubId, setSelectedHubId] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedHubId && hubs.length > 0) setSelectedHubId(hubs[0].hubId);
  }, [hubs, selectedHubId]);
  const effectiveHubId = selectedHubId || hubs[0]?.hubId || null;

  const openPairMutation = useMutation({
    mutationFn: async (durationSec: number) => {
      if (!activeHomeId) throw new Error("Chưa chọn Home");
      if (!effectiveHubId) throw new Error("Chưa có HUB (hãy claim hub trước)");
      // Sprint 11: type-first pairing (Xiaomi-style)
      return apiHubPairingOpen({ hubId: effectiveHubId, homeId: activeHomeId, durationSec, mode: "TYPE_FIRST" });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["zigbee", "pairing", "discovered"] }),
    onError: (e: any) => {
      const msg = e?.response?.data?.error || e?.message || "Open pairing failed";
      Alert.alert("Open pairing failed", typeof msg === "string" ? msg : JSON.stringify(msg));
    },
  });

  const pairingToken = openPairMutation.data?.token || null;
  const pairingExpiresAtIso = openPairMutation.data?.expiresAt || null;

  const discoveredQuery = useQuery({
    enabled: !!effectiveHubId && !!pairingToken,
    queryKey: ["zigbee", "pairing", "discovered", { hubId: effectiveHubId, token: pairingToken }],
    queryFn: () => apiHubPairingDiscovered({ hubId: effectiveHubId!, token: pairingToken! }),
    // While pairing window is open, poll frequently so UI feels realtime.
    refetchInterval: pairingToken ? 2000 : 30_000,
    refetchOnWindowFocus: true,
  });

  const rejectMutation = useMutation({
    mutationFn: async (ieee: string) => {
      if (!effectiveHubId) throw new Error("Missing hubId");
      if (!pairingToken) throw new Error("Missing token");
      return apiHubPairingReject({ hubId: effectiveHubId, token: pairingToken, ieee });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["zigbee", "pairing", "discovered"] }),
    onError: (e: any) => {
      const msg = e?.response?.data?.error || e?.message || "Reject failed";
      Alert.alert("Reject failed", typeof msg === "string" ? msg : JSON.stringify(msg));
    },
  });

  const devices = discoveredQuery.data?.devices ?? [];

  // Countdown UI
  const [remainingSec, setRemainingSec] = useState<number | null>(null);
  useEffect(() => {
    if (!pairingExpiresAtIso) {
      setRemainingSec(null);
      return;
    }
    const expiresMs = Date.parse(pairingExpiresAtIso);
    const tick = () => {
      const now = Date.now();
      const sec = Math.max(0, Math.ceil((expiresMs - now) / 1000));
      setRemainingSec(sec);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [pairingExpiresAtIso]);

  function confirmReject(item: ZigbeeDiscoveredDevice) {
    Alert.alert("Ignore device?", item.ieee, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Ignore",
        style: "destructive",
        onPress: () => rejectMutation.mutate(item.ieee),
      },
    ]);
  }

  if (!activeHomeId) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Chưa chọn Home</Text>
        <Text style={styles.sub}>Vui lòng vào tab Home để chọn/tạo Home trước khi Zigbee pairing.</Text>
        <Pressable
          style={[styles.actionBtn, styles.primaryBtn]}
          onPress={() => {
            // Switch to Home tab
            // @ts-ignore
            navigation.getParent()?.navigate("Home");
          }}
        >
          <Text style={styles.primaryText}>Đi đến Home</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Zigbee pairing</Text>
          <Text style={styles.sub}>Home: {activeHomeName ?? `#${activeHomeId}`}</Text>
          <Text style={styles.sub}>Hub: {effectiveHubId ?? "(none)"}</Text>
          <Text style={styles.sub}>Open pairing, power on Zigbee devices nearby, then confirm to add.</Text>
        </View>
      </View>

      {hubs.length > 0 ? (
        <View style={styles.hubRow}>
          {hubs.map((h) => (
            <Pressable
              key={h.id}
              style={[styles.hubChip, effectiveHubId === h.hubId ? styles.hubChipActive : null]}
              onPress={() => setSelectedHubId(h.hubId)}
            >
              <Text style={effectiveHubId === h.hubId ? styles.hubChipTextActive : styles.hubChipText}>
                {h.name ? h.name : h.hubId}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <View style={styles.emptyHub}>
          <Text style={styles.emptySub}>No HUB in this home. Go to Settings → Add Hub.</Text>
        </View>
      )}

      <View style={styles.actionsRow}>
        <Pressable
          style={[styles.actionBtn, styles.primaryBtn]}
          onPress={() => openPairMutation.mutate(60)}
          disabled={openPairMutation.isPending || !effectiveHubId}
        >
          <Text style={styles.primaryText}>{openPairMutation.isPending ? "Opening..." : "Open 60s"}</Text>
        </Pressable>
        <Pressable
          style={[styles.actionBtn, styles.secondaryBtn]}
          onPress={() => openPairMutation.mutate(180)}
          disabled={openPairMutation.isPending || !effectiveHubId}
        >
          <Text style={styles.secondaryText}>Open 180s</Text>
        </Pressable>
      </View>

      {openPairMutation.data?.token ? (
        <View style={styles.sessionCard}>
          <Text style={styles.sessionTitle}>Pairing session</Text>
          <Text style={styles.sessionLine}>Hub: {openPairMutation.data.hubId}</Text>
          <Text style={styles.sessionLine}>Token: {openPairMutation.data.token}</Text>
          <Text style={styles.sessionLine}>Expires: {openPairMutation.data.expiresAt}</Text>
          {remainingSec != null ? <Text style={styles.sessionLine}>Countdown: {remainingSec}s</Text> : null}
        </View>
      ) : null}

      {discoveredQuery.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator />
          <Text>Loading...</Text>
        </View>
      ) : (
        <FlatList
          data={devices}
          keyExtractor={(d) => `${d.hubId}:${d.ieee}`}
          contentContainerStyle={{ padding: 12, gap: 10 }}
          renderItem={({ item }) => (
            <View style={styles.item}>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{item.ieee}</Text>
                <Text style={styles.meta}>
                  Hub: {item.hubId}
                  {item.shortAddr != null ? ` • Short: ${item.shortAddr}` : ""}
                </Text>
                {item.model || item.manufacturer ? (
                  <Text style={styles.meta}>Model: {item.model ?? "-"} • Mfg: {item.manufacturer ?? "-"}</Text>
                ) : null}
                {item.swBuildId ? <Text style={styles.meta}>SW: {item.swBuildId}</Text> : null}
                {item.updatedAt ? <Text style={styles.meta}>Seen: {item.updatedAt}</Text> : null}
              </View>

              <View style={styles.itemActions}>
                <Pressable
                  style={[styles.smallBtn, styles.addBtn]}
                  onPress={() =>
                    navigation.navigate("ZigbeeAddDevice", {
                      ieee: item.ieee,
                      model: item.model ?? null,
                      manufacturer: item.manufacturer ?? null,
                      pairingToken: pairingToken ?? null,
                      hubId: effectiveHubId ?? null,
                      suggestedModelId: item.suggestedModelId ?? null,
                      suggestedType: item.suggestedType ?? null,
                    })
                  }
                >
                  <Text style={styles.addText}>Add</Text>
                </Pressable>
                <Pressable style={[styles.smallBtn, styles.ignoreBtn]} onPress={() => confirmReject(item)}>
                  <Text style={styles.ignoreText}>Ignore</Text>
                </Pressable>
              </View>
            </View>
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No discovered devices</Text>
              <Text style={styles.emptySub}>Tap “Open” then reset/power-on Zigbee peripherals to join the hub.</Text>
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
  hubRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 12, paddingBottom: 12 },
  hubChip: { paddingVertical: 8, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: "#ddd", backgroundColor: "#fff" },
  hubChipActive: { backgroundColor: "#111", borderColor: "#111" },
  hubChipText: { fontWeight: "800", color: "#111", fontSize: 12 },
  hubChipTextActive: { fontWeight: "800", color: "#fff", fontSize: 12 },
  emptyHub: { paddingHorizontal: 12, paddingBottom: 12 },
  actionsRow: { flexDirection: "row", gap: 10, paddingHorizontal: 12, paddingBottom: 12 },
  actionBtn: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: "center" },
  primaryBtn: { backgroundColor: "#111" },
  primaryText: { color: "#fff", fontWeight: "700" },
  secondaryBtn: { backgroundColor: "#efefef" },
  secondaryText: { fontWeight: "700" },
  sessionCard: {
    marginHorizontal: 12,
    marginBottom: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#eee",
    gap: 4,
  },
  sessionTitle: { fontWeight: "700" },
  sessionLine: { fontSize: 12, color: "#444" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 20 },
  item: { flexDirection: "row", gap: 10, padding: 12, borderRadius: 12, backgroundColor: "#fff", borderWidth: 1, borderColor: "#eee" },
  name: { fontSize: 14, fontWeight: "700" },
  meta: { fontSize: 12, color: "#666" },
  itemActions: { gap: 8, justifyContent: "center" },
  smallBtn: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, alignItems: "center" },
  addBtn: { backgroundColor: "#111" },
  addText: { color: "#fff", fontWeight: "700" },
  ignoreBtn: { backgroundColor: "#fee" },
  ignoreText: { color: "#c00", fontWeight: "700" },
  empty: { padding: 20, alignItems: "center", gap: 6 },
  emptyTitle: { fontSize: 16, fontWeight: "700" },
  emptySub: { fontSize: 12, color: "#666", textAlign: "center" },
});
