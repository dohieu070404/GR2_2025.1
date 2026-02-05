-- Inventory + hub + device lifecycle + reset requests + credentials

-- 1) Extend Device
ALTER TABLE `Device`
  ADD COLUMN `serial` VARCHAR(80) NULL,
  ADD COLUMN `lifecycleStatus` ENUM('FACTORY_NEW','CLAIMING','BOUND','ACTIVE','UNBOUND') NOT NULL DEFAULT 'BOUND',
  ADD COLUMN `boundAt` DATETIME(3) NULL,
  ADD COLUMN `unboundAt` DATETIME(3) NULL,
  ADD COLUMN `lastProvisionedAt` DATETIME(3) NULL;

CREATE UNIQUE INDEX `Device_serial_key` ON `Device`(`serial`);
CREATE INDEX `Device_hubId_idx` ON `Device`(`hubId`);

-- 2) ZigbeeDiscoveredDevice: add homeId to map hub -> home
ALTER TABLE `ZigbeeDiscoveredDevice` ADD COLUMN `homeId` INTEGER NULL;
CREATE INDEX `ZigbeeDiscoveredDevice_homeId_status_idx` ON `ZigbeeDiscoveredDevice`(`homeId`, `status`);

ALTER TABLE `ZigbeeDiscoveredDevice`
  ADD CONSTRAINT `ZigbeeDiscoveredDevice_homeId_fkey`
  FOREIGN KEY (`homeId`) REFERENCES `Home`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- 3) Inventory tables
CREATE TABLE `DeviceInventory` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `serial` VARCHAR(80) NOT NULL,
  `deviceUuid` VARCHAR(36) NOT NULL,
  `typeDefault` ENUM('relay','dimmer','rgb','sensor') NULL,
  `protocol` ENUM('MQTT','ZIGBEE') NOT NULL DEFAULT 'MQTT',
  `model` VARCHAR(80) NULL,
  `setupCodeHash` VARCHAR(191) NOT NULL,
  `status` ENUM('FACTORY_NEW','CLAIMED','REVOKED') NOT NULL DEFAULT 'FACTORY_NEW',
  `claimedAt` DATETIME(3) NULL,
  `claimedByUserId` INTEGER NULL,
  `claimedHomeId` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `DeviceInventory_serial_key`(`serial`),
  UNIQUE INDEX `DeviceInventory_deviceUuid_key`(`deviceUuid`),
  INDEX `DeviceInventory_claimedByUserId_idx`(`claimedByUserId`),
  INDEX `DeviceInventory_claimedHomeId_idx`(`claimedHomeId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `DeviceInventory`
  ADD CONSTRAINT `DeviceInventory_claimedByUserId_fkey`
  FOREIGN KEY (`claimedByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `DeviceInventory`
  ADD CONSTRAINT `DeviceInventory_claimedHomeId_fkey`
  FOREIGN KEY (`claimedHomeId`) REFERENCES `Home`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE `HubInventory` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `hubId` VARCHAR(80) NOT NULL,
  `serial` VARCHAR(80) NULL,
  `setupCodeHash` VARCHAR(191) NOT NULL,
  `status` ENUM('FACTORY_NEW','CLAIMED','REVOKED') NOT NULL DEFAULT 'FACTORY_NEW',
  `claimedAt` DATETIME(3) NULL,
  `claimedByUserId` INTEGER NULL,
  `claimedHomeId` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `HubInventory_hubId_key`(`hubId`),
  UNIQUE INDEX `HubInventory_serial_key`(`serial`),
  INDEX `HubInventory_claimedByUserId_idx`(`claimedByUserId`),
  INDEX `HubInventory_claimedHomeId_idx`(`claimedHomeId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `HubInventory`
  ADD CONSTRAINT `HubInventory_claimedByUserId_fkey`
  FOREIGN KEY (`claimedByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `HubInventory`
  ADD CONSTRAINT `HubInventory_claimedHomeId_fkey`
  FOREIGN KEY (`claimedHomeId`) REFERENCES `Home`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- 4) Hub table (bind hub -> home)
CREATE TABLE `Hub` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `hubId` VARCHAR(80) NOT NULL,
  `homeId` INTEGER NOT NULL,
  `name` VARCHAR(80) NULL,
  `firmwareVersion` VARCHAR(50) NULL,
  `lastSeen` DATETIME(3) NULL,
  `online` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `Hub_hubId_key`(`hubId`),
  INDEX `Hub_homeId_idx`(`homeId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Hub`
  ADD CONSTRAINT `Hub_homeId_fkey`
  FOREIGN KEY (`homeId`) REFERENCES `Home`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Connect Device.hubId -> Hub.hubId (best-effort; hubId is optional)
ALTER TABLE `Device`
  ADD CONSTRAINT `Device_hubId_fkey`
  FOREIGN KEY (`hubId`) REFERENCES `Hub`(`hubId`) ON DELETE SET NULL ON UPDATE CASCADE;

-- 5) Credentials (MVP supports shared broker user; DB is ready for rotate/revoke)
CREATE TABLE `DeviceCredential` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `deviceId` INTEGER NOT NULL,
  `username` VARCHAR(120) NOT NULL,
  `secretHash` VARCHAR(191) NOT NULL,
  `revokedAt` DATETIME(3) NULL,
  `rotatedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `DeviceCredential_deviceId_revokedAt_idx`(`deviceId`, `revokedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `DeviceCredential`
  ADD CONSTRAINT `DeviceCredential_deviceId_fkey`
  FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE `HubCredential` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `hubId` VARCHAR(80) NOT NULL,
  `username` VARCHAR(120) NOT NULL,
  `secretHash` VARCHAR(191) NOT NULL,
  `revokedAt` DATETIME(3) NULL,
  `rotatedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `HubCredential_hubId_revokedAt_idx`(`hubId`, `revokedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `HubCredential`
  ADD CONSTRAINT `HubCredential_hubId_fkey`
  FOREIGN KEY (`hubId`) REFERENCES `Hub`(`hubId`) ON DELETE CASCADE ON UPDATE CASCADE;

-- 6) ResetRequest audit + ack tracking
CREATE TABLE `ResetRequest` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `deviceId` INTEGER NOT NULL,
  `cmdId` VARCHAR(36) NOT NULL,
  `type` ENUM('RECONNECT','FACTORY_RESET') NOT NULL,
  `status` ENUM('PENDING','SENT','ACKED','FAILED','TIMEOUT') NOT NULL DEFAULT 'PENDING',
  `requestedByUserId` INTEGER NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `ackedAt` DATETIME(3) NULL,
  `error` TEXT NULL,

  UNIQUE INDEX `ResetRequest_deviceId_cmdId_key`(`deviceId`, `cmdId`),
  INDEX `ResetRequest_deviceId_status_createdAt_idx`(`deviceId`, `status`, `createdAt`),
  INDEX `ResetRequest_requestedByUserId_createdAt_idx`(`requestedByUserId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ResetRequest`
  ADD CONSTRAINT `ResetRequest_deviceId_fkey`
  FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `ResetRequest`
  ADD CONSTRAINT `ResetRequest_requestedByUserId_fkey`
  FOREIGN KEY (`requestedByUserId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
