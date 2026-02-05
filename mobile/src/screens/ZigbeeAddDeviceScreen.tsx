import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, Alert, ScrollView } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { DevicesStackParamList } from "../navigation/AppNavigator";
import { apiHubPairingConfirm, apiListHomes, apiListRooms, apiZbConfirmDevice } from "../api/api";
import type { DeviceType, Room } from "../types";
import { useHomeSelection } from "../context/HomeContext";


type Props = NativeStackScreenProps<DevicesStackParamList, "ZigbeeAddDevice">;

const TYPE_CHOICES: Array<{ label: string; value: DeviceType }> = [
  { label: "Relay (On/Off)", value: "relay" },
  { label: "Dimmer (0..255)", value: "dimmer" },
  { label: "RGB", value: "rgb" },
  { label: "Sensor (read-only)", value: "sensor" },
];

export default function ZigbeeAddDeviceScreen({ route, navigation }: Props) {
  const qc = useQueryClient();
  const { ieee, model, manufacturer, pairingToken, hubId, suggestedType, suggestedModelId } = route.params;
  const { activeHomeId, activeRoomId } = useHomeSelection();

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

  const [name, setName] = useState<string>(model ? `${model}` : `Zigbee ${ieee.slice(-4)}`);
  const [type, setType] = useState<DeviceType>(suggestedType ?? "relay");
  const [selectedRoomId, setSelectedRoomId] = useState<number | null>(activeRoomId ?? null);
  const [customRoomName, setCustomRoomName] = useState<string>("");

  const selectedRoomLabel = useMemo(() => {
    if (!selectedRoomId) return "(no room)";
    return rooms.find((r) => r.id === selectedRoomId)?.name ?? `#${selectedRoomId}`;
  }, [rooms, selectedRoomId]);

  const confirmMutation = useMutation({
    mutationFn: async () => {
      if (!activeHomeId) throw new Error("Chưa chọn Home");
      const n = name.trim();
      if (!n) throw new Error("Tên thiết bị không được rỗng");

      const roomName = customRoomName.trim();

      // Sprint 11 preferred API (token-first)
      if (pairingToken && hubId) {
        return apiHubPairingConfirm({
          hubId,
          token: pairingToken,
          ieee,
          homeId: activeHomeId,
          roomId: selectedRoomId,
          room: selectedRoomId ? null : roomName ? roomName : null,
          name: n,
          type,
          modelId: suggestedModelId ?? null,
        });
      }

      // Back-compat alias
      return apiZbConfirmDevice(ieee, {
        homeId: activeHomeId,
        name: n,
        type,
        roomId: selectedRoomId,
        room: selectedRoomId ? null : roomName ? roomName : null,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["devices"] });
      qc.invalidateQueries({ queryKey: ["zigbee"] });
      navigation.goBack();
    },
    onError: (e: any) => {
      const msg = e?.response?.data?.error || e?.message || "Add device failed";
      Alert.alert("Add Zigbee device failed", typeof msg === "string" ? msg : JSON.stringify(msg));
    },
  });

  if (!activeHomeId) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Chưa chọn Home</Text>
        <Text style={styles.meta}>Vui lòng chọn Home trước khi add Zigbee device.</Text>
        <Pressable
          style={styles.primaryBtn}
          onPress={() => {
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
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 12, gap: 12 }}>
      <View style={styles.card}>
        <Text style={styles.title}>Zigbee device</Text>
        <Text style={styles.meta}>Home: {activeHomeName ?? `#${activeHomeId}`}</Text>
        <Text style={styles.meta}>IEEE: {ieee}</Text>
        {manufacturer || model ? (
          <Text style={styles.meta}>Model: {model ?? "-"} • Mfg: {manufacturer ?? "-"}</Text>
        ) : null}
        <Text style={styles.meta}>Room: {selectedRoomLabel}</Text>
      </View>

      <View style={styles.form}>
        <Text style={styles.label}>Name</Text>
        <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Living room light" />

        <Text style={styles.label}>Room</Text>
        <View style={styles.chipRow}>
          <Pressable
            style={[styles.chip, selectedRoomId == null ? styles.chipActive : null]}
            onPress={() => setSelectedRoomId(null)}
          >
            <Text style={selectedRoomId == null ? styles.chipTextActive : styles.chipText}>None</Text>
          </Pressable>
          {rooms.slice(0, 12).map((r) => (
            <Pressable
              key={r.id}
              style={[styles.chip, selectedRoomId === r.id ? styles.chipActive : null]}
              onPress={() => setSelectedRoomId(r.id)}
            >
              <Text style={selectedRoomId === r.id ? styles.chipTextActive : styles.chipText}>{r.name}</Text>
            </Pressable>
          ))}
        </View>

        {selectedRoomId == null ? (
          <>
            <Text style={styles.label}>Or type a room name (optional)</Text>
            <TextInput
              style={styles.input}
              value={customRoomName}
              onChangeText={setCustomRoomName}
              placeholder="Phòng khách"
            />
          </>
        ) : null}

        <Text style={styles.label}>Type</Text>
        <View style={{ gap: 8 }}>
          {TYPE_CHOICES.map((c) => (
            <Pressable
              key={c.value}
              style={[styles.typeBtn, type === c.value ? styles.typeBtnActive : null]}
              onPress={() => setType(c.value)}
            >
              <Text style={type === c.value ? styles.typeTextActive : styles.typeText}>{c.label}</Text>
            </Pressable>
          ))}
        </View>

        <Pressable
          style={[styles.primaryBtn, confirmMutation.isPending ? { opacity: 0.6 } : null]}
          onPress={() => confirmMutation.mutate()}
          disabled={confirmMutation.isPending}
        >
          <Text style={styles.primaryText}>{confirmMutation.isPending ? "Saving..." : "Save"}</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fafafa" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 20 },
  card: { padding: 12, borderRadius: 12, backgroundColor: "#fff", borderWidth: 1, borderColor: "#eee", gap: 6 },
  form: { padding: 12, borderRadius: 12, backgroundColor: "#fff", borderWidth: 1, borderColor: "#eee", gap: 10 },
  title: { fontSize: 16, fontWeight: "800" },
  meta: { fontSize: 12, color: "#666" },
  label: { fontSize: 12, fontWeight: "800" },
  input: { borderWidth: 1, borderColor: "#ddd", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: "#fff" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: "#ddd", backgroundColor: "#fff" },
  chipActive: { backgroundColor: "#111", borderColor: "#111" },
  chipText: { fontWeight: "800", color: "#111", fontSize: 12 },
  chipTextActive: { fontWeight: "800", color: "#fff", fontSize: 12 },
  typeBtn: { paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: "#ddd", backgroundColor: "#fff" },
  typeBtnActive: { borderColor: "#111", backgroundColor: "#111" },
  typeText: { fontWeight: "800", color: "#111" },
  typeTextActive: { fontWeight: "800", color: "#fff" },
  primaryBtn: { marginTop: 6, paddingVertical: 12, borderRadius: 12, alignItems: "center", backgroundColor: "#111" },
  primaryText: { color: "#fff", fontWeight: "800" },
});
