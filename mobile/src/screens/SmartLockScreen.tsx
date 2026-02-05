import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { DevicesStackParamList } from "../navigation/AppNavigator";
import {
  apiListDevices,
  apiGetDeviceStateCurrent,
  apiGetDeviceEvents,
  apiLockAddPin,
  apiLockDeletePin,
  apiLockAddRfid,
  apiLockDeleteRfid,
} from "../api/api";

type Props = NativeStackScreenProps<DevicesStackParamList, "SmartLock">;

function toIsoDate(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatLocalTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString();
  } catch {
    return iso;
  }
}

function normalizeLockState(s: any): string {
  const st = s?.lock?.state;
  if (typeof st === "string" && st.length) return st;
  if (typeof s?.locked === "boolean") return s.locked ? "LOCKED" : "UNLOCKED";
  return "UNKNOWN";
}

export default function SmartLockScreen({ route }: Props) {
  const deviceId = route.params.deviceId;

  const devicesQuery = useQuery({
    queryKey: ["devices", "all"],
    queryFn: () => apiListDevices(),
    staleTime: 5000,
  });

  const device = devicesQuery.data?.devices?.find((d) => d.id === deviceId) || null;

  const stateQuery = useQuery({
    queryKey: ["deviceStateCurrent", deviceId],
    queryFn: () => apiGetDeviceStateCurrent(deviceId),
    enabled: deviceId > 0,
  });

  const state: any = stateQuery.data?.state ?? device?.stateCurrent?.state ?? device?.lastState ?? null;
  const lockState = normalizeLockState(state);
  const lastAction: any = state?.lastAction ?? null;

  const dateStr = useMemo(() => toIsoDate(new Date()), []);

  const eventsQuery = useQuery({
    queryKey: ["deviceEvents", deviceId, dateStr],
    queryFn: () => apiGetDeviceEvents(deviceId, { date: dateStr, limit: 500 }),
    enabled: deviceId > 0,
  });

  const items = useMemo(() => {
    const evs = eventsQuery.data?.events ?? [];
    return evs.filter((e) => e.type === "lock.unlock" || e.type === "credential_changed");
  }, [eventsQuery.data]);

  // ----------------
  // PIN manage
  // ----------------
  const [pinSlot, setPinSlot] = useState("1");
  const [pinLabel, setPinLabel] = useState("");
  const [pinValue, setPinValue] = useState("");

  const addPin = useMutation({
    mutationFn: () =>
      apiLockAddPin(deviceId, {
        slot: Number(pinSlot),
        label: pinLabel.trim() ? pinLabel.trim() : undefined,
        pin: pinValue,
      }),
  });

  const delPin = useMutation({
    mutationFn: () => apiLockDeletePin(deviceId, Number(pinSlot)),
  });

  // ----------------
  // RFID manage
  // ----------------
  const [rfidSlot, setRfidSlot] = useState("1");
  const [rfidLabel, setRfidLabel] = useState("");
  const [rfidUid, setRfidUid] = useState("");

  const addRfid = useMutation({
    mutationFn: () =>
      apiLockAddRfid(deviceId, {
        slot: Number(rfidSlot),
        label: rfidLabel.trim() ? rfidLabel.trim() : undefined,
        uid: rfidUid,
      }),
  });

  const delRfid = useMutation({
    mutationFn: () => apiLockDeleteRfid(deviceId, Number(rfidSlot)),
  });

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Text style={styles.title}>{device ? device.name : `Device #${deviceId}`}</Text>

      <View style={styles.card}>
        <Text style={styles.label}>Status</Text>
        <Text style={styles.value}>{lockState}</Text>

        <Text style={[styles.label, { marginTop: 12 }]}>Last action</Text>
        <Text style={styles.small}>
          {lastAction
            ? `${lastAction.type ?? "?"} · ${lastAction.method ?? "?"} · success=${String(
                lastAction.success
              )}`
            : "(none)"}
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Today history ({dateStr})</Text>
        <FlatList
          data={items}
          keyExtractor={(it) => String(it.id)}
          style={{ marginTop: 8, maxHeight: 220 }}
          renderItem={({ item }) => (
            <View style={styles.eventRow}>
              <Text style={styles.eventTime}>{formatLocalTime(item.createdAt)}</Text>
              <Text style={styles.eventText}>
                {item.type}
                {item.type === "lock.unlock" ? ` · ${item.data?.method ?? ""} · ok=${String(item.data?.success)}` : ""}
                {item.type === "credential_changed" ? ` · ${item.data?.action ?? ""}` : ""}
              </Text>
            </View>
          )}
          ListEmptyComponent={<Text style={styles.small}>(no events)</Text>}
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Manage PIN</Text>
        <View style={styles.row}>
          <TextInput
            style={styles.input}
            value={pinSlot}
            onChangeText={setPinSlot}
            placeholder="slot"
            keyboardType="number-pad"
          />
          <TextInput
            style={[styles.input, { flex: 2 }]}
            value={pinLabel}
            onChangeText={setPinLabel}
            placeholder="label (optional)"
          />
        </View>
        <TextInput
          style={styles.input}
          value={pinValue}
          onChangeText={setPinValue}
          placeholder="PIN (digits)"
          keyboardType="number-pad"
          secureTextEntry
        />

        <View style={styles.row}>
          <Pressable
            style={[styles.btn, styles.btnPrimary]}
            onPress={() => addPin.mutate()}
            disabled={addPin.isPending}
          >
            <Text style={styles.btnText}>Add/Update</Text>
          </Pressable>
          <Pressable
            style={[styles.btn, styles.btnDanger]}
            onPress={() => delPin.mutate()}
            disabled={delPin.isPending}
          >
            <Text style={styles.btnText}>Delete</Text>
          </Pressable>
        </View>
        {!!addPin.data?.cmdId && <Text style={styles.small}>cmdId: {addPin.data.cmdId}</Text>}
        {!!delPin.data?.cmdId && <Text style={styles.small}>cmdId: {delPin.data.cmdId}</Text>}
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Manage RFID</Text>
        <View style={styles.row}>
          <TextInput
            style={styles.input}
            value={rfidSlot}
            onChangeText={setRfidSlot}
            placeholder="slot"
            keyboardType="number-pad"
          />
          <TextInput
            style={[styles.input, { flex: 2 }]}
            value={rfidLabel}
            onChangeText={setRfidLabel}
            placeholder="label (optional)"
          />
        </View>
        <TextInput
          style={styles.input}
          value={rfidUid}
          onChangeText={setRfidUid}
          placeholder="UID (hex)"
          autoCapitalize="none"
        />

        <View style={styles.row}>
          <Pressable
            style={[styles.btn, styles.btnPrimary]}
            onPress={() => addRfid.mutate()}
            disabled={addRfid.isPending}
          >
            <Text style={styles.btnText}>Add/Update</Text>
          </Pressable>
          <Pressable
            style={[styles.btn, styles.btnDanger]}
            onPress={() => delRfid.mutate()}
            disabled={delRfid.isPending}
          >
            <Text style={styles.btnText}>Delete</Text>
          </Pressable>
        </View>
        {!!addRfid.data?.cmdId && <Text style={styles.small}>cmdId: {addRfid.data.cmdId}</Text>}
        {!!delRfid.data?.cmdId && <Text style={styles.small}>cmdId: {delRfid.data.cmdId}</Text>}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 12 },
  title: { fontSize: 22, fontWeight: "700" },
  card: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 12,
    padding: 12,
  },
  label: { fontSize: 14, fontWeight: "600" },
  value: { fontSize: 20, fontWeight: "800", marginTop: 6 },
  small: { fontSize: 12, color: "#555", marginTop: 4 },
  row: { flexDirection: "row", gap: 8, marginTop: 8 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  btn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: "center",
  },
  btnPrimary: { backgroundColor: "#2563eb" },
  btnDanger: { backgroundColor: "#dc2626" },
  btnText: { color: "white", fontWeight: "700" },
  eventRow: { flexDirection: "row", gap: 8, paddingVertical: 6 },
  eventTime: { width: 90, fontSize: 12, color: "#666" },
  eventText: { flex: 1, fontSize: 12 },
});
