-- Sprint 11: TH_SENSOR_V1 type-first pairing + Identify claim badge

-- Add claimed flag to Device
ALTER TABLE `Device`
  ADD COLUMN `claimed` BOOLEAN NOT NULL DEFAULT false;
