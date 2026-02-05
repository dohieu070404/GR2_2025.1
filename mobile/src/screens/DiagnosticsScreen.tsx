import React from "react";
import { View, Text, StyleSheet, Pressable, ScrollView } from "react-native";
import { useQuery } from "@tanstack/react-query";

import { apiMqttDiagnostics } from "../api/api";

export default function DiagnosticsScreen() {
  const q = useQuery({ queryKey: ["diag", "mqtt"], queryFn: apiMqttDiagnostics, refetchOnWindowFocus: true });

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 12, gap: 12 }}>
      <View style={styles.card}>
        <Text style={styles.title}>MQTT Diagnostics</Text>
        <Text style={styles.sub}>Backend will run a pub/sub roundtrip test on broker.</Text>

        <Pressable style={[styles.btn, styles.btnPrimary]} onPress={() => q.refetch()}>
          <Text style={styles.btnPrimaryText}>{q.isFetching ? "Running..." : "Run test"}</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Result</Text>
        {q.error ? <Text style={styles.err}>{String((q as any).error?.message || q.error)}</Text> : null}
        <Text style={styles.mono}>{q.data ? JSON.stringify(q.data, null, 2) : q.isLoading ? "Loading..." : "No data"}</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fafafa" },
  card: { padding: 12, borderRadius: 12, backgroundColor: "#fff", borderWidth: 1, borderColor: "#eee", gap: 8 },
  title: { fontSize: 16, fontWeight: "900" },
  sub: { fontSize: 12, color: "#666" },
  sectionTitle: { fontWeight: "900" },
  mono: { fontFamily: "monospace", fontSize: 11, color: "#111" },
  err: { color: "#c00" },
  btn: { paddingVertical: 12, borderRadius: 12, alignItems: "center" },
  btnPrimary: { backgroundColor: "#111" },
  btnPrimaryText: { color: "#fff", fontWeight: "900" },
});
