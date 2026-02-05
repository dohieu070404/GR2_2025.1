import type { DevicePlugin } from "./pluginTypes";

import { TemperatureHumidityPlugin } from "./temperatureHumidity";
import { LockCorePlugin } from "./lockCore";
import { LockHistoryPlugin } from "./lockHistory";
import { LockCredentialsPlugin } from "./lockCredentials";
import { GateCorePlugin } from "./gateCore";
import { MotionSensorPlugin } from "./motionSensor";
import { LightSwitchPlugin } from "./lightSwitch";

// Sprint 12: plugin registry
// The DeviceDetail screen renders sections from descriptor.uiSchema.sections.

const plugins: Record<string, DevicePlugin> = {
  [TemperatureHumidityPlugin.id]: TemperatureHumidityPlugin,
  [LockCorePlugin.id]: LockCorePlugin,
  [LockHistoryPlugin.id]: LockHistoryPlugin,
  [LockCredentialsPlugin.id]: LockCredentialsPlugin,
  [GateCorePlugin.id]: GateCorePlugin,
  [MotionSensorPlugin.id]: MotionSensorPlugin,
  [LightSwitchPlugin.id]: LightSwitchPlugin,
};

export function getPlugin(id: string): DevicePlugin | null {
  return plugins[id] || null;
}

export function listRegisteredPlugins() {
  return Object.keys(plugins).sort();
}
