import React, { useMemo } from "react";
import { View, Text, StyleSheet, ScrollView } from "react-native";
import { useQuery } from "@tanstack/react-query";

import { apiGetDeviceDescriptor, apiListDevices } from "../api/api";
import type { Device, DeviceDescriptor } from "../types";
import { useHomeSelection } from "../context/HomeContext";
import { getPlugin, listRegisteredPlugins } from "../plugins/registry";
import type { UiSection } from "../plugins/pluginTypes";

type Props = {
  route: { params: { deviceId: number } };
};

function extractSections(descriptor: DeviceDescriptor | null): UiSection[] {
  const sections: any = descriptor?.uiSchema?.sections;
  if (Array.isArray(sections)) {
    return sections
      .filter((s) => s && typeof s === "object" && typeof s.plugin === "string")
      .map((s, idx) => ({
        id: String(s.id || idx),
        plugin: String(s.plugin),
        view: s.view != null ? String(s.view) : undefined,
        title: s.title != null ? String(s.title) : undefined,
        ...s,
      }));
  }

  // fallback: build sections from capabilities.plugins
  const plugins: any = descriptor?.capabilities?.plugins;
  if (Array.isArray(plugins) && plugins.length) {
    return plugins.map((p, idx) => ({ id: String(idx), plugin: String(p) }));
  }
  return [];
}

function DeviceHeader({ device, descriptor }: { device: Device | null; descriptor: DeviceDescriptor | null }) {
  const online = device?.stateCurrent?.online ?? device?.online ?? null;
  const lastSeen = device?.stateCurrent?.lastSeen ?? device?.lastSeen ?? null;
  const modelId = descriptor?.modelId ?? device?.modelId ?? "—";

  return (
    <View style={styles.headerCard}>
      <Text style={styles.title}>{device?.name ?? `Device #${device?.id ?? "?"}`}</Text>

      <View style={styles.row}>
        <Text style={styles.pill}>{modelId}</Text>
        <Text style={[styles.pill, online ? styles.pillOnline : styles.pillOffline]}>
          {online == null ? "UNKNOWN" : online ? "ONLINE" : "OFFLINE"}
        </Text>
        {device?.claimed ? <Text style={[styles.pill, styles.pillClaimed]}>CLAIMED</Text> : null}
      </View>

      <Text style={styles.subtle}>Last seen: {lastSeen ? new Date(lastSeen).toLocaleString() : "—"}</Text>
    </View>
  );
}

export default function DeviceDetailsScreen({ route }: Props) {
  const deviceId = route.params.deviceId;
  const { activeHomeId } = useHomeSelection();

  // Fetch devices within the active home so SSE updates can keep the object fresh
  const devicesQuery = useQuery({
    enabled: !!activeHomeId,
    queryKey: ["devices", { homeId: activeHomeId, roomId: null }],
    queryFn: () => apiListDevices({ homeId: activeHomeId!, roomId: null }),
  });

  const device = useMemo(() => {
    const list = devicesQuery.data?.devices ?? [];
    return list.find((d) => d.id === deviceId) ?? null;
  }, [devicesQuery.data, deviceId]);

  const descriptorQuery = useQuery({
    queryKey: ["deviceDescriptor", deviceId],
    queryFn: () => apiGetDeviceDescriptor(deviceId),
    enabled: deviceId > 0,
  });

  const descriptor = descriptorQuery.data?.descriptor ?? null;
  const sections = useMemo(() => extractSections(descriptor), [descriptor]);

  if (!activeHomeId) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Chưa chọn Home</Text>
        <Text style={styles.subtle}>Vui lòng chọn Home trước.</Text>
      </View>
    );
  }

  if (devicesQuery.isLoading) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Loading…</Text>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Device not found</Text>
        <Text style={styles.subtle}>deviceId={String(deviceId)}</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <DeviceHeader device={device} descriptor={descriptor} />

      {descriptorQuery.isLoading ? (
        <Text style={styles.subtle}>Loading descriptor…</Text>
      ) : !descriptor ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Descriptor</Text>
          <Text style={styles.subtle}>
            No descriptor found for modelId={String(device.modelId)}.
          </Text>
          <Text style={styles.subtle}>
            Registered plugins: {listRegisteredPlugins().join(", ")}
          </Text>
        </View>
      ) : null}

      {sections.map((s) => {
        const plugin = getPlugin(s.plugin);
        if (!plugin) {
          return (
            <View key={s.id} style={styles.card}>
              <Text style={styles.sectionTitle}>{s.title || s.plugin}</Text>
              <Text style={styles.subtle}>Missing plugin: {s.plugin}</Text>
            </View>
          );
        }
        return (
          <View key={s.id} style={styles.sectionWrap}>
            {plugin.render({
              deviceId: device.id,
              device,
              descriptor: descriptor!,
              section: s,
            })}
          </View>
        );
      })}

      {!sections.length && descriptor ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>No UI schema</Text>
          <Text style={styles.subtle}>ModelId={descriptor.modelId}</Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    gap: 12,
  },
  center: {
    flex: 1,
    padding: 16,
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
  },
  headerCard: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 12,
    padding: 16,
    backgroundColor: "#fff",
  },
  title: {
    fontSize: 18,
    fontWeight: "900",
  },
  subtle: {
    marginTop: 6,
    fontSize: 12,
    color: "#666",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 10,
    flexWrap: "wrap",
  },
  pill: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 12,
    fontWeight: "900",
  },
  pillOnline: { backgroundColor: "#d6ffe0", borderColor: "#8be4a5" },
  pillOffline: { backgroundColor: "#ffe0e0", borderColor: "#f0a0a0" },
  pillClaimed: { backgroundColor: "#e8e8ff", borderColor: "#b0b0ff" },
  sectionWrap: { gap: 8 },
  card: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 12,
    padding: 16,
    backgroundColor: "#fff",
  },
  sectionTitle: { fontSize: 14, fontWeight: "800" },
});
