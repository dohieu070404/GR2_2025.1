-- Sprint 3: DeviceEvent table for Zigbee event ingestion

CREATE TABLE `DeviceEvent` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `deviceId` INTEGER NOT NULL,
  `type` VARCHAR(120) NOT NULL,
  `data` JSON NULL,
  `sourceAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `DeviceEvent_deviceId_createdAt_idx`(`deviceId`, `createdAt`),
  INDEX `DeviceEvent_type_idx`(`type`),
  INDEX `DeviceEvent_sourceAt_idx`(`sourceAt`),

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `DeviceEvent`
  ADD CONSTRAINT `DeviceEvent_deviceId_fkey`
  FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Sprint 3: speed up Zigbee plane mapping ieee -> Device
CREATE INDEX `Device_zigbeeIeee_idx` ON `Device`(`zigbeeIeee`);
