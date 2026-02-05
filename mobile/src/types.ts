export type DeviceType = "relay" | "dimmer" | "rgb" | "sensor";

export type DeviceLifecycleStatus = "FACTORY_NEW" | "CLAIMING" | "BOUND" | "ACTIVE" | "UNBOUND";

export type User = {
  id: number;
  name: string;
  email: string;
};

export type Home = {
  id: number;
  name: string;
  createdAt?: string;
  updatedAt?: string;
};

export type Room = {
  id: number;
  name: string;
  homeId: number;
  createdAt?: string;
  updatedAt?: string;
};

// Backend command lifecycle
export type CommandStatus = "PENDING" | "ACKED" | "FAILED" | "TIMEOUT";

export type DeviceStateCurrent = {
  state: any | null;
  updatedAt?: string | null;
  lastSeen?: string | null;
  online?: boolean | null;
};

export type DeviceCommand = {
  id?: number;
  cmdId: string;
  payload?: any;
  status: CommandStatus;
  sentAt?: string | null;
  ackedAt?: string | null;
  error?: string | null;
};

export type DeviceStateHistoryRow = {
  id: number;
  deviceId: number;
  state: any | null;
  online: boolean;
  lastSeen?: string | null;
  createdAt?: string;
};

export type DeviceEvent = {
  id: number;
  type: string;
  data: any;
  createdAt?: string | null;
  sourceAt?: string | null;
};

export type OtaCheckResult = {
  deviceId: number;
  current: string | null;
  available: { version: string | null; url: string } | null;
  note?: string | null;
};

export type Device = {
  id: number;
  name: string;
  type: DeviceType;

  // New backend fields
  homeId?: number;
  deviceId?: string; // UUID used in MQTT topic scheme
  protocol?: string | null;
  firmwareVersion?: string | null;
  serial?: string | null;
  modelId?: string | null;
  zigbeeIeee?: string | null;
  lifecycleStatus?: DeviceLifecycleStatus | null;
  // Sprint 11: Identify-confirmed claim badge
  claimed?: boolean | null;
  boundAt?: string | null;
  unboundAt?: string | null;

  // Room
  room?: { id: number; name: string } | string | null;
  roomId?: number | null;

  // Legacy field
  topicBase?: string;

  // Preferred: current state record
  stateCurrent?: DeviceStateCurrent | null;

  // Backward compatible flattened fields
  lastState?: any | null;
  lastSeen?: string | null;
  online?: boolean | null;

  // Client-only helper
  lastCommand?: {
    cmdId: string;
    status: CommandStatus;
    payload?: any;
    sentAt?: string | null;
    ackedAt?: string | null;
    error?: string | null;
  } | null;

  updatedAt?: string;
  createdAt?: string;
};

export type Hub = {
  id: number;
  hubId: string;
  homeId: number;
  name?: string | null;
  firmwareVersion?: string | null;
  mac?: string | null;
  ip?: string | null;
  lastSeen?: string | null;
  online?: boolean | null;
  createdAt?: string;
  updatedAt?: string;
};

export type MqttDiagnostics = {
  ok: boolean;
  diag?: any;
  test?: any;
  error?: any;
};

export type ZigbeeDiscoveredDevice = {
  id: number;
  hubId: string;
  pairingToken: string;
  ieee: string;
  shortAddr?: number | null;
  model?: string | null;
  manufacturer?: string | null;
  swBuildId?: string | null;
  suggestedModelId?: string | null;
  suggestedType?: DeviceType | null;
  status: "PENDING" | "CLAIMED" | "CONFIRMED" | "REJECTED";
  createdAt?: string;
  updatedAt?: string;
};

// ----------------------
// Sprint 12: Device Descriptor
// ----------------------

export type DeviceDescriptor = {
  modelId: string | null;
  capabilities: any;
  uiSchema: any;
  actions: any[];
  stateMap: any;
};

export type DeviceDescriptorSummary = {
  modelId: string | null;
  plugins: string[];
  capabilities: {
    plugins: string[];
  };
};
