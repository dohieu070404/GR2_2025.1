import React from "react";
import { View, Text, StyleSheet, Pressable, Alert } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useAuth } from "../auth/AuthContext";
import { API_URL, APP_ENV } from "../config";
import type { SettingsStackParamList } from "../navigation/AppNavigator";

export default function SettingsScreen() {
  const { user, logout } = useAuth();
  const qc = useQueryClient();
  const navigation = useNavigation<NativeStackNavigationProp<SettingsStackParamList>>();

  async function onLogout() {
    Alert.alert("Logout?", "You will need to login again.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Logout",
        style: "destructive",
        onPress: async () => {
          await logout();
          qc.clear();
        },
      },
    ]);
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Account</Text>

      <View style={styles.card}>
        <Text style={styles.label}>Name</Text>
        <Text style={styles.value}>{user?.name ?? "-"}</Text>

        <Text style={styles.label}>Email</Text>
        <Text style={styles.value}>{user?.email ?? "-"}</Text>

        <Text style={styles.label}>API</Text>
        <Text style={styles.value}>{API_URL}</Text>

        <Text style={styles.label}>Env</Text>
        <Text style={styles.value}>{APP_ENV}</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Onboarding & Diagnostics</Text>
        <Pressable style={[styles.smallBtn, styles.primaryBtn]} onPress={() => navigation.navigate("AddHub")}>
          <Text style={styles.primaryText}>Add Hub</Text>
        </Pressable>
        <Pressable style={[styles.smallBtn, styles.secondaryBtn]} onPress={() => navigation.navigate("Diagnostics")}>
          <Text style={styles.secondaryText}>MQTT Diagnostics</Text>
        </Pressable>
      </View>

      <Pressable style={styles.button} onPress={onLogout}>
        <Text style={styles.buttonText}>Logout</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fafafa", padding: 12, gap: 12 },
  title: { fontSize: 18, fontWeight: "700" },
  card: { borderWidth: 1, borderColor: "#eee", borderRadius: 12, padding: 12, backgroundColor: "#fff", gap: 8 },
  label: { fontSize: 12, color: "#666", fontWeight: "700" },
  value: { fontSize: 14, fontWeight: "600" },
  button: { marginTop: 10, backgroundColor: "#111", padding: 14, borderRadius: 10, alignItems: "center" },
  buttonText: { color: "#fff", fontWeight: "700" },
  smallBtn: { paddingVertical: 12, borderRadius: 10, alignItems: "center" },
  primaryBtn: { backgroundColor: "#111" },
  primaryText: { color: "#fff", fontWeight: "800" },
  secondaryBtn: { backgroundColor: "#efefef" },
  secondaryText: { color: "#111", fontWeight: "800" },
});
