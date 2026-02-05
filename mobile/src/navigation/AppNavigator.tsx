import React from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Ionicons } from "@expo/vector-icons";

import { useAuth } from "../auth/AuthContext";
import LoginScreen from "../screens/LoginScreen";
import RegisterScreen from "../screens/RegisterScreen";
import DashboardScreen from "../screens/DashboardScreen";
import DevicesScreen from "../screens/DevicesScreen";
import DeviceFormScreen from "../screens/DeviceFormScreen";
import DeviceDetailsScreen from "../screens/DeviceDetailsScreen";
import ServoGateScreen from "../screens/ServoGateScreen";
import SmartLockScreen from "../screens/SmartLockScreen";
import AddDeviceScreen from "../screens/AddDeviceScreen";
import ClaimMqttDeviceScreen from "../screens/ClaimMqttDeviceScreen";
import ZigbeePairingScreen from "../screens/ZigbeePairingScreen";
import ZigbeeAddDeviceScreen from "../screens/ZigbeeAddDeviceScreen";
import ThSensorScreen from "../screens/ThSensorScreen";
import SettingsScreen from "../screens/SettingsScreen";
import AddHubScreen from "../screens/AddHubScreen";
import DiagnosticsScreen from "../screens/DiagnosticsScreen";
import HomesScreen from "../screens/HomesScreen";
import RoomsScreen from "../screens/RoomsScreen";

export type AuthStackParamList = {
  Login: undefined;
  Register: undefined;
};

export type HomeStackParamList = {
  HomesHome: undefined;
  Rooms: undefined;
};

export type DevicesStackParamList = {
  DevicesHome: undefined;
  DeviceDetails: { deviceId: number };
  ServoGate: { deviceId: number };
  SmartLock: { deviceId: number };
  ThSensor: { deviceId: number };
  DeviceForm: { mode: "create" } | { mode: "edit"; deviceId: number };
  AddDevice: undefined;
  ClaimMqttDevice: undefined;
  ZigbeePairing: undefined;
  ZigbeeAddDevice: {
    ieee: string;
    pairingToken?: string | null;
    hubId?: string | null;
    suggestedType?: import("../types").DeviceType | null;
    suggestedModelId?: string | null;
    model?: string | null;
    manufacturer?: string | null;
    swBuildId?: string | null;
  };
};

export type SettingsStackParamList = {
  SettingsHome: undefined;
  AddHub: undefined;
  Diagnostics: undefined;
};

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const HomeStack = createNativeStackNavigator<HomeStackParamList>();
const DevicesStack = createNativeStackNavigator<DevicesStackParamList>();
const SettingsStack = createNativeStackNavigator<SettingsStackParamList>();
const Tabs = createBottomTabNavigator();

function HomeStackNavigator() {
  return (
    <HomeStack.Navigator>
      <HomeStack.Screen name="HomesHome" component={HomesScreen} options={{ title: "Homes" }} />
      <HomeStack.Screen name="Rooms" component={RoomsScreen} options={{ title: "Rooms" }} />
    </HomeStack.Navigator>
  );
}

function DevicesStackNavigator() {
  return (
    <DevicesStack.Navigator>
      <DevicesStack.Screen name="DevicesHome" component={DevicesScreen} options={{ title: "Devices" }} />
      <DevicesStack.Screen name="AddDevice" component={AddDeviceScreen} options={{ title: "Add" }} />
      <DevicesStack.Screen name="ClaimMqttDevice" component={ClaimMqttDeviceScreen} options={{ title: "Add MQTT device" }} />
      <DevicesStack.Screen name="ServoGate" component={ServoGateScreen} options={{ title: "Gate" }} />
      <DevicesStack.Screen name="SmartLock" component={SmartLockScreen} options={{ title: "Smart Lock" }} />
      <DevicesStack.Screen name="ThSensor" component={ThSensorScreen} options={{ title: "TH Sensor" }} />
      <DevicesStack.Screen name="DeviceDetails" component={DeviceDetailsScreen} options={{ title: "Device" }} />
      <DevicesStack.Screen
        name="DeviceForm"
        component={DeviceFormScreen}
        options={({ route }) => ({ title: route.params.mode === "create" ? "Add device" : "Edit device" })}
      />
      <DevicesStack.Screen name="ZigbeePairing" component={ZigbeePairingScreen} options={{ title: "Zigbee Pairing" }} />
      <DevicesStack.Screen name="ZigbeeAddDevice" component={ZigbeeAddDeviceScreen} options={{ title: "Add Zigbee device" }} />
    </DevicesStack.Navigator>
  );
}

function SettingsStackNavigator() {
  return (
    <SettingsStack.Navigator>
      <SettingsStack.Screen name="SettingsHome" component={SettingsScreen} options={{ title: "Settings" }} />
      <SettingsStack.Screen name="AddHub" component={AddHubScreen} options={{ title: "Add Hub" }} />
      <SettingsStack.Screen name="Diagnostics" component={DiagnosticsScreen} options={{ title: "Diagnostics" }} />
    </SettingsStack.Navigator>
  );
}

function MainTabs() {
  return (
    <Tabs.Navigator
      screenOptions={({ route }) => ({
        tabBarIcon: ({ color, size }) => {
          const name =
            route.name === "Home" ? "home" : route.name === "Dashboard" ? "stats-chart" : route.name === "Devices" ? "hardware-chip" : "settings";
          // @ts-ignore - Ionicons has dynamic names
          return <Ionicons name={name} size={size} color={color} />;
        },
      })}
    >
      <Tabs.Screen name="Home" component={HomeStackNavigator} options={{ headerShown: false }} />
      <Tabs.Screen name="Dashboard" component={DashboardScreen} />
      <Tabs.Screen name="Devices" component={DevicesStackNavigator} options={{ headerShown: false }} />
      <Tabs.Screen name="Settings" component={SettingsStackNavigator} options={{ headerShown: false }} />
    </Tabs.Navigator>
  );
}

export default function AppNavigator() {
  const { token } = useAuth();

  return (
    <NavigationContainer>
      {token ? (
        <MainTabs />
      ) : (
        <AuthStack.Navigator>
          <AuthStack.Screen name="Login" component={LoginScreen} options={{ title: "Login" }} />
          <AuthStack.Screen name="Register" component={RegisterScreen} options={{ title: "Register" }} />
        </AuthStack.Navigator>
      )}
    </NavigationContainer>
  );
}
