import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, Alert, ScrollView } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { SettingsStackParamList } from "../navigation/AppNavigator";
import { apiActivateHub, apiListHomes } from "../api/api";
import { useHomeSelection } from "../context/HomeContext";

type Props = NativeStackScreenProps<SettingsStackParamList, "AddHub">;

export default function AddHubScreen({ navigation }: Props) {
  const qc = useQueryClient();
  const { activeHomeId } = useHomeSelection();

  const homesQuery = useQuery({ queryKey: ["homes"], queryFn: apiListHomes, refetchOnWindowFocus: true });
  const homes = homesQuery.data?.homes ?? [];
  const activeHomeName = useMemo(() => homes.find((h) => h.id === activeHomeId)?.name ?? null, [homes, activeHomeId]);

  // Sprint 9: inventory serial printed on the box (usually matches hubId, e.g. hub-c55494)
  const [serial, setSerial] = useState("hub-c55494");
  const [setupCode, setSetupCode] = useState("");
  const [name, setName] = useState("Living Hub");

  const mutation = useMutation({
    mutationFn: async () => {
      if (!activeHomeId) throw new Error("Chưa chọn Home");
      const h = serial.trim();
      const c = setupCode.trim();
      if (!h) throw new Error("serial không được rỗng");
      if (!c) throw new Error("setup code không được rỗng");
      return apiActivateHub({ serial: h, setupCode: c, homeId: activeHomeId, name: name.trim() ? name.trim() : null });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["hubs"] });
      Alert.alert("Success", "Đã kích hoạt HUB vào Home.");
    },
    onError: (e: any) => {
      const msg = e?.response?.data?.error || e?.message || "Activate hub failed";
      Alert.alert("Activate hub failed", typeof msg === "string" ? msg : JSON.stringify(msg));
    },
  });

  if (!activeHomeId) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Chưa chọn Home</Text>
        <Text style={styles.sub}>Vui lòng vào tab Home để chọn/tạo Home trước khi activate HUB.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 12, gap: 12 }}>
      <View style={styles.card}>
        <Text style={styles.title}>Add Hub</Text>
        <Text style={styles.sub}>Home: {activeHomeName ?? `#${activeHomeId}`}</Text>
      </View>

      <View style={styles.form}>
        <Text style={styles.label}>Serial</Text>
        <TextInput style={styles.input} value={serial} onChangeText={setSerial} placeholder="hub-c55494" autoCapitalize="none" />

        <Text style={styles.label}>Setup code</Text>
        <TextInput style={styles.input} value={setupCode} onChangeText={setSetupCode} placeholder="12345678" secureTextEntry />

        <Text style={styles.label}>Name (optional)</Text>
        <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Living Hub" />

        <Pressable style={[styles.btn, styles.btnPrimary, mutation.isPending ? { opacity: 0.6 } : null]} onPress={() => mutation.mutate()} disabled={mutation.isPending}>
          <Text style={styles.btnPrimaryText}>{mutation.isPending ? "Activating..." : "Activate hub"}</Text>
        </Pressable>
      </View>

      {mutation.data?.hub ? (
        <View style={styles.card}>
          <Text style={styles.title}>Hub status</Text>
          <Text style={styles.sub}>Hub ID: {mutation.data.hub.hubId}</Text>
          <Text style={styles.sub}>Online: {mutation.data.hub.online ? "ONLINE" : "OFFLINE"}</Text>
          <Text style={styles.sub}>MAC: {mutation.data.runtime?.mac ?? mutation.data.hub.mac ?? "-"}</Text>
          <Text style={styles.sub}>IP: {mutation.data.runtime?.ip ?? mutation.data.hub.ip ?? "-"}</Text>
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
  btn: { paddingVertical: 12, borderRadius: 12, alignItems: "center" },
  btnPrimary: { backgroundColor: "#111" },
  btnPrimaryText: { color: "#fff", fontWeight: "900" },
});
