import type { Device, DeviceDescriptor } from "../types";

export type UiSection = {
  id: string;
  plugin: string;
  view?: string;
  title?: string;
  // allow future extension without breaking clients
  [k: string]: any;
};

export type PluginSectionProps = {
  deviceId: number;
  device: Device | null;
  descriptor: DeviceDescriptor;
  section: UiSection;
};

export type DevicePlugin = {
  id: string;
  render: (props: PluginSectionProps) => JSX.Element | null;
};
