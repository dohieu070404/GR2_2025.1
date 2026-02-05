import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, TextInput } from "react-native";
import { useMutation } from "@tanstack/react-query";

import { apiSendCommand } from "../api/api";
import type { DevicePlugin, PluginSectionProps } from "./pluginTypes";

function parseIntSafe(v: string, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

function LockCredentialsSection({ deviceId }: { deviceId: number }) {
  const [pinSlot, setPinSlot] = useState("0");
  const [pinLabel, setPinLabel] = useState("");
  const [pinValue, setPinValue] = useState("");

  const [rfidSlot, setRfidSlot] = useState("0");
  const [rfidLabel, setRfidLabel] = useState("");
  const [rfidUid, setRfidUid] = useState("");

  const addPin = useMutation({
    mutationFn: async () => {
      const slot = parseIntSafe(pinSlot, 0);
      return apiSendCommand(deviceId, {
        action: "lock.add_pin",
        params: {
          slot,
          label: pinLabel.trim() || undefined,
          pin: pinValue.trim(),
        },
      });
    },
  });

  const delPin = useMutation({
    mutationFn: async () => {
      const slot = parseIntSafe(pinSlot, 0);
      return apiSendCommand(deviceId, { action: "lock.delete_pin", params: { slot } });
    },
  });

  const addRfid = useMutation({
    mutationFn: async () => {
      const slot = parseIntSafe(rfidSlot, 0);
      return apiSendCommand(deviceId, {
        action: "lock.add_rfid",
        params: {
          slot,
          label: rfidLabel.trim() || undefined,
          uid: rfidUid.trim(),
        },
      });
    },
  });

  const delRfid = useMutation({
    mutationFn: async () => {
      const slot = parseIntSafe(rfidSlot, 0);
      return apiSendCommand(deviceId, { action: "lock.delete_rfid", params: { slot } });
    },
  });

  const busy = addPin.isPending || delPin.isPending || addRfid.isPending || delRfid.isPending;
  const lastCmdId = useMemo(() => {
    return (
      addPin.data?.cmdId ||
      delPin.data?.cmdId ||
      addRfid.data?.cmdId ||
      delRfid.data?.cmdId ||
      null
    );
  }, [addPin.data, delPin.data, addRfid.data, delRfid.data]);

  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>Credentials</Text>
      <Text style={styles.subtle}>
        PIN/RFID are sent to the lock via Zigbee. The backend stores only hashes for auditing.
      </Text>

      <View style={styles.block}>
        <Text style={styles.blockTitle}>PIN</Text>
        <View style={styles.row}>
          <TextInput
            style={styles.inputSmall}
            value={pinSlot}
            onChangeText={setPinSlot}
            keyboardType="number-pad"
            placeholder="slot"
          />
          <TextInput
            style={styles.input}
            value={pinLabel}
            onChangeText={setPinLabel}
            placeholder="label (optional)"
          />
        </View>
        <TextInput
          style={styles.input}
          value={pinValue}
          onChangeText={setPinValue}
          placeholder="pin (4-12 digits)"
          keyboardType="number-pad"
          secureTextEntry
        />
        <View style={styles.row}>
          <Pressable
            style={[styles.btn, styles.btnPrimary]}
            onPress={() => addPin.mutate()}
            disabled={busy}
          >
            <Text style={styles.btnText}>Add/Update</Text>
          </Pressable>
          <Pressable
            style={[styles.btn, styles.btnSecondary]}
            onPress={() => delPin.mutate()}
            disabled={busy}
          >
            <Text style={styles.btnText}>Delete</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.block}>
        <Text style={styles.blockTitle}>RFID</Text>
        <View style={styles.row}>
          <TextInput
            style={styles.inputSmall}
            value={rfidSlot}
            onChangeText={setRfidSlot}
            keyboardType="number-pad"
            placeholder="slot"
          />
          <TextInput
            style={styles.input}
            value={rfidLabel}
            onChangeText={setRfidLabel}
            placeholder="label (optional)"
          />
        </View>
        <TextInput
          style={styles.input}
          value={rfidUid}
          onChangeText={setRfidUid}
          placeholder="uid hex (eg: a1b2c3d4)"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={styles.row}>
          <Pressable
            style={[styles.btn, styles.btnPrimary]}
            onPress={() => addRfid.mutate()}
            disabled={busy}
          >
            <Text style={styles.btnText}>Add/Update</Text>
          </Pressable>
          <Pressable
            style={[styles.btn, styles.btnSecondary]}
            onPress={() => delRfid.mutate()}
            disabled={busy}
          >
            <Text style={styles.btnText}>Delete</Text>
          </Pressable>
        </View>
      </View>

      {lastCmdId ? <Text style={styles.subtle}>Last cmdId: {lastCmdId}</Text> : null}
      {(addPin.error || delPin.error || addRfid.error || delRfid.error) ? (
        <Text style={styles.error}>
          Error: {String((addPin.error || delPin.error || addRfid.error || delRfid.error) as any)}
        </Text>
      ) : null}
    </View>
  );
}

export const LockCredentialsPlugin: DevicePlugin = {
  id: "lock.credentials",
  render: (props: PluginSectionProps) => <LockCredentialsSection deviceId={props.deviceId} />,
};

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 12,
    padding: 16,
    backgroundColor: "#fff",
  },
  sectionTitle: { fontSize: 14, fontWeight: "800" },
  subtle: { marginTop: 6, color: "#666", fontSize: 12 },
  error: { marginTop: 6, color: "#b00020", fontSize: 12, fontWeight: "700" },
  block: { marginTop: 14, gap: 10 },
  blockTitle: { fontSize: 13, fontWeight: "900" },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flex: 1,
    backgroundColor: "#fafafa",
  },
  inputSmall: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    width: 80,
    backgroundColor: "#fafafa",
  },
  btn: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10 },
  btnPrimary: { backgroundColor: "#111" },
  btnSecondary: { backgroundColor: "#555" },
  btnText: { color: "#fff", fontWeight: "800" },
});
