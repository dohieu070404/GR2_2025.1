import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, Alert, ScrollView } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { DevicesStackParamList } from "../navigation/AppNavigator";
import { apiClaimDevice, apiListHomes, apiListRooms } from "../api/api";
import type { Room } from "../types";
import { useHomeSelection } from "../context/HomeContext";

type Props = NativeStackScreenProps<DevicesStackParamList, "ClaimMqttDevice">;

export default function ClaimMqttDeviceScreen({ navigation }: Props) {
  const qc = useQueryClient();
  const { activeHomeId, activeRoomId } = useHomeSelection();

  const homesQuery = useQuery({ queryKey: ["homes"], queryFn: apiListHomes, refetchOnWindowFocus: true });
  const roomsQuery = useQuery({
    enabled: !!activeHomeId,
    queryKey: ["rooms", activeHomeId],
    queryFn: () => apiListRooms(activeHomeId!),
  });
  const rooms: Room[] = roomsQuery.data?.rooms ?? [];

  const activeHomeName = useMemo(() => {
    const homes = homesQuery.data?.homes ?? [];
    return homes.find((h) => h.id === activeHomeId)?.name ?? null;
  }, [homesQuery.data, activeHomeId]);

  const [serial, setSerial] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [name, setName] = useState("");
  const [roomId, setRoomId] = useState<number | null>(activeRoomId ?? null);
  const [roomName, setRoomName] = useState("");
  const [result, setResult] = useState<any>(null);

  const selectedRoomLabel = useMemo(() => {
    if (!roomId) return "(no room)";
    return rooms.find((r) => r.id === roomId)?.name ?? `#${roomId}`;
  }, [rooms, roomId]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!activeHomeId) throw new Error("Chưa chọn Home");
      const s = serial.trim();
      const c = setupCode.trim();
      if (!s) throw new Error("Serial không được rỗng");
      if (!c) throw new Error("Setup code không được rỗng");
      return apiClaimDevice({
        serial: s,
        setupCode: c,
        homeId: activeHomeId,
        name: name.trim() ? name.trim() : null,
        roomId,
        room: roomId ? null : roomName.trim() ? roomName.trim() : null,
      });
    },
    onSuccess: async (data) => {
      setResult(data);
      await qc.invalidateQueries({ queryKey: ["devices"] });
      Alert.alert("Success", "Đã claim thiết bị. Xem provisioning config bên dưới.");
    },
    onError: (e: any) => {
      const msg = e?.response?.data?.error || e?.message || "Claim failed";
      Alert.alert("Claim failed", typeof msg === "string" ? msg : JSON.stringify(msg));
    },
  });

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
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 12, gap: 12 }}>
      <View style={styles.card}>
        <Text style={styles.title}>Add MQTT device</Text>
        <Text style={styles.sub}>Home: {activeHomeName ?? `#${activeHomeId}`}</Text>
        <Text style={styles.sub}>Room: {selectedRoomLabel}</Text>
      </View>

      <View style={styles.form}>
        <Text style={styles.label}>Serial</Text>
        <TextInput style={styles.input} value={serial} onChangeText={setSerial} placeholder="SN-0001" autoCapitalize="characters" />

        <Text style={styles.label}>Setup code</Text>
        <TextInput style={styles.input} value={setupCode} onChangeText={setSetupCode} placeholder="12345678" secureTextEntry />

        <Text style={styles.label}>Name (optional)</Text>
        <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Relay 1" />

        <Text style={styles.label}>Room</Text>
        <View style={styles.chipRow}>
          <Pressable style={[styles.chip, roomId == null ? styles.chipActive : null]} onPress={() => setRoomId(null)}>
            <Text style={roomId == null ? styles.chipTextActive : styles.chipText}>None</Text>
          </Pressable>
          {rooms.slice(0, 12).map((r) => (
            <Pressable key={r.id} style={[styles.chip, roomId === r.id ? styles.chipActive : null]} onPress={() => setRoomId(r.id)}>
              <Text style={roomId === r.id ? styles.chipTextActive : styles.chipText}>{r.name}</Text>
            </Pressable>
          ))}
        </View>
        {roomId == null ? (
          <>
            <Text style={styles.label}>Or type room name (optional)</Text>
            <TextInput style={styles.input} value={roomName} onChangeText={setRoomName} placeholder="Phòng khách" />
          </>
        ) : null}

        <Pressable style={[styles.btn, styles.btnPrimary, mutation.isPending ? { opacity: 0.6 } : null]} onPress={() => mutation.mutate()} disabled={mutation.isPending}>
          <Text style={styles.btnPrimaryText}>{mutation.isPending ? "Claiming..." : "Claim"}</Text>
        </Pressable>
      </View>

      {result?.provisioning ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Provisioning config</Text>
          <Text style={styles.mono}>{JSON.stringify(result.provisioning, null, 2)}</Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fafafa" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 20 },
  card: { padding: 12, borderRadius: 12, backgroundColor: "#fff", borderWidth: 1, borderColor: "#eee", gap: 6 },
  title: { fontSize: 16, fontWeight: "900" },
  sub: { fontSize: 12, color: "#666" },
  form: { padding: 12, borderRadius: 12, backgroundColor: "#fff", borderWidth: 1, borderColor: "#eee", gap: 10 },
  label: { fontSize: 12, fontWeight: "900" },
  input: { borderWidth: 1, borderColor: "#ddd", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: "#fff" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: "#ddd", backgroundColor: "#fff" },
  chipActive: { backgroundColor: "#111", borderColor: "#111" },
  chipText: { fontWeight: "800", color: "#111", fontSize: 12 },
  chipTextActive: { fontWeight: "800", color: "#fff", fontSize: 12 },
  btn: { paddingVertical: 12, borderRadius: 12, alignItems: "center" },
  btnPrimary: { backgroundColor: "#111" },
  btnPrimaryText: { color: "#fff", fontWeight: "900" },
  sectionTitle: { fontWeight: "900" },
  mono: { fontFamily: "monospace", fontSize: 11, color: "#111" },
});
