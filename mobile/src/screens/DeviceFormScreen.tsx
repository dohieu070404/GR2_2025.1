import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  Pressable,
  Alert,
  ActivityIndicator,
  ScrollView,
} from "react-native";
import { Picker } from "@react-native-picker/picker";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { DevicesStackParamList } from "../navigation/AppNavigator";
import { apiCreateDevice, apiListDevices, apiListRooms, apiUpdateDevice } from "../api/api";
import type { Device, DeviceType, Room } from "../types";
import { useHomeSelection } from "../context/HomeContext";

type Props = NativeStackScreenProps<DevicesStackParamList, "DeviceForm">;

function getRoomIdFromDevice(d: Device | null): number | null {
  if (!d) return null;
  if (typeof d.roomId === "number") return d.roomId;
  const r: any = d.room;
  if (r && typeof r === "object" && typeof r.id === "number") return r.id;
  return null;
}

export default function DeviceFormScreen({ route, navigation }: Props) {
  const qc = useQueryClient();
  const { activeHomeId, activeRoomId } = useHomeSelection();

  const isEdit = route.params.mode === "edit";
  const editingId = isEdit ? route.params.deviceId : null;

  // For edit: fetch all devices (across all homes the user can see) then locate the device.
  const devicesQuery = useQuery({
    enabled: isEdit && editingId != null,
    queryKey: ["devices", "all"],
    queryFn: () => apiListDevices(),
    refetchOnWindowFocus: true,
  });

  const editingDevice: Device | null = useMemo(() => {
    if (!isEdit || editingId == null) return null;
    return devicesQuery.data?.devices?.find((d) => d.id === editingId) ?? null;
  }, [isEdit, editingId, devicesQuery.data]);

  const targetHomeId = isEdit ? (editingDevice?.homeId ?? null) : activeHomeId;

  const roomsQuery = useQuery({
    enabled: !!targetHomeId,
    queryKey: ["rooms", targetHomeId],
    queryFn: () => apiListRooms(targetHomeId!),
    refetchOnWindowFocus: true,
  });
  const rooms: Room[] = roomsQuery.data?.rooms ?? [];

  const [name, setName] = useState("");
  const [type, setType] = useState<DeviceType>("relay");
  const [selectedRoomId, setSelectedRoomId] = useState<number | null>(activeRoomId ?? null);
  const [customRoomName, setCustomRoomName] = useState<string>("");

  useEffect(() => {
    if (!isEdit) return;
    if (!editingDevice) return;

    setName(editingDevice.name);
    setType(editingDevice.type);
    setSelectedRoomId(getRoomIdFromDevice(editingDevice));
    setCustomRoomName("");
  }, [isEdit, editingDevice]);

  // Keep create defaults aligned with current selection
  useEffect(() => {
    if (isEdit) return;
    setSelectedRoomId(activeRoomId ?? null);
  }, [isEdit, activeRoomId]);

  const busy =
    devicesQuery.isLoading || roomsQuery.isLoading;

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!targetHomeId) throw new Error("Chưa chọn Home");
      const n = name.trim();
      if (!n) throw new Error("Tên thiết bị không được rỗng");

      const rn = customRoomName.trim();

      return apiCreateDevice({
        homeId: targetHomeId,
        name: n,
        type,
        roomId: selectedRoomId,
        room: selectedRoomId ? null : rn ? rn : null,
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["devices"] });
      await qc.invalidateQueries({ queryKey: ["rooms"] });
      navigation.goBack();
    },
    onError: (e: any) => {
      const msg = e?.response?.data?.error || e?.message || "Create failed";
      Alert.alert("Create failed", typeof msg === "string" ? msg : JSON.stringify(msg));
    },
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (editingId == null) throw new Error("Missing deviceId");
      const n = name.trim();
      if (!n) throw new Error("Tên thiết bị không được rỗng");

      const rn = customRoomName.trim();

      return apiUpdateDevice(editingId, {
        name: n,
        type,
        roomId: selectedRoomId,
        room: selectedRoomId ? null : rn ? rn : null,
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["devices"] });
      await qc.invalidateQueries({ queryKey: ["rooms"] });
      navigation.goBack();
    },
    onError: (e: any) => {
      const msg = e?.response?.data?.error || e?.message || "Update failed";
      Alert.alert("Update failed", typeof msg === "string" ? msg : JSON.stringify(msg));
    },
  });

  const saving = createMutation.isPending || updateMutation.isPending;

  if (!isEdit && !activeHomeId) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Chưa chọn Home</Text>
        <Text style={styles.sub}>Vui lòng vào tab Home để chọn/tạo Home trước khi tạo thiết bị.</Text>
        <Pressable
          style={[styles.button, styles.buttonPrimary]}
          onPress={() => {
            // @ts-ignore
            navigation.getParent?.()?.navigate?.("Home");
          }}
        >
          <Text style={styles.buttonPrimaryText}>Đi đến Home</Text>
        </Pressable>
      </View>
    );
  }

  if (isEdit && devicesQuery.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
        <Text>Loading device...</Text>
      </View>
    );
  }

  if (isEdit && !editingDevice) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Device not found</Text>
        <Text style={styles.sub}>Thiết bị không tồn tại hoặc bạn không có quyền truy cập.</Text>
        <Pressable style={[styles.button, styles.buttonPrimary]} onPress={() => navigation.goBack()}>
          <Text style={styles.buttonPrimaryText}>Back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 12, gap: 12 }}>
      <View style={styles.infoCard}>
        <Text style={styles.infoTitle}>{isEdit ? "Edit device" : "Create device"}</Text>
        <Text style={styles.infoLine}>HomeId: {targetHomeId ?? "-"}</Text>
        {isEdit ? (
          <>
            <Text style={styles.infoLine}>DeviceId: {editingDevice?.deviceId ?? "-"}</Text>
            <Text style={styles.hint}>MQTT topics are managed by backend using: home/&lt;homeId&gt;/device/&lt;deviceId&gt;/...</Text>
          </>
        ) : (
          <Text style={styles.hint}>Tip: Dùng tab Zigbee để pair end-device Zigbee. Form này thường dùng cho MQTT devices.</Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Name</Text>
        <TextInput value={name} onChangeText={setName} placeholder="Lamp" style={styles.input} />

        <Text style={styles.label}>Type</Text>
        <View style={styles.pickerBox}>
          <Picker selectedValue={type} onValueChange={(v) => setType(v as DeviceType)}>
            <Picker.Item label="Relay (On/Off)" value="relay" />
            <Picker.Item label="Dimmer (0..255)" value="dimmer" />
            <Picker.Item label="RGB" value="rgb" />
            <Picker.Item label="Sensor (read-only)" value="sensor" />
          </Picker>
        </View>

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
            <Text style={styles.hintSmall}>Hoặc nhập tên room mới (optional)</Text>
            <TextInput
              value={customRoomName}
              onChangeText={setCustomRoomName}
              placeholder="Phòng khách"
              style={styles.input}
            />
          </>
        ) : null}

        <Pressable
          style={[styles.button, styles.buttonPrimary, (saving || busy) && { opacity: 0.6 }]}
          onPress={() => {
            if (isEdit) updateMutation.mutate();
            else createMutation.mutate();
          }}
          disabled={saving || busy}
        >
          <Text style={styles.buttonPrimaryText}>{saving ? "Saving..." : "Save"}</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fafafa" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 20 },
  title: { fontSize: 18, fontWeight: "800" },
  sub: { fontSize: 12, color: "#666", textAlign: "center" },

  infoCard: { padding: 12, borderRadius: 12, backgroundColor: "#fff", borderWidth: 1, borderColor: "#eee", gap: 6 },
  infoTitle: { fontSize: 14, fontWeight: "800" },
  infoLine: { fontSize: 12, color: "#444" },
  hint: { fontSize: 12, color: "#666", lineHeight: 18 },

  card: { padding: 12, borderRadius: 12, backgroundColor: "#fff", borderWidth: 1, borderColor: "#eee", gap: 10 },
  label: { fontSize: 12, fontWeight: "800" },
  input: { borderWidth: 1, borderColor: "#ddd", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: "#fff" },
  pickerBox: { borderWidth: 1, borderColor: "#ddd", borderRadius: 10, overflow: "hidden", backgroundColor: "#fff" },

  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: "#ddd", backgroundColor: "#fff" },
  chipActive: { backgroundColor: "#111", borderColor: "#111" },
  chipText: { fontWeight: "800", color: "#111", fontSize: 12 },
  chipTextActive: { fontWeight: "800", color: "#fff", fontSize: 12 },

  hintSmall: { fontSize: 12, color: "#666" },

  button: { paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, alignItems: "center" },
  buttonPrimary: { backgroundColor: "#111" },
  buttonPrimaryText: { color: "#fff", fontWeight: "800" },
});
