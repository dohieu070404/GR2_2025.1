-- Sprint 1: ProductModel catalog + modelId mapping + Xiaomi-style hub activation fields

-- 1) ProductModel catalog
CREATE TABLE `ProductModel` (
  `id` VARCHAR(50) NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `manufacturer` VARCHAR(120) NOT NULL,
  `protocol` ENUM('HUB','MQTT','ZIGBEE') NOT NULL,
  `fingerprintManuf` VARCHAR(120) NULL,
  `fingerprintModel` VARCHAR(120) NULL,
  `capabilities` JSON NULL,
  `uiSchema` JSON NULL,
  `defaultConfig` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 2) Extend inventory statuses to include BOUND
ALTER TABLE `HubInventory`
  MODIFY COLUMN `status` ENUM('FACTORY_NEW','CLAIMED','BOUND','REVOKED') NOT NULL DEFAULT 'FACTORY_NEW';

ALTER TABLE `DeviceInventory`
  MODIFY COLUMN `status` ENUM('FACTORY_NEW','CLAIMED','BOUND','REVOKED') NOT NULL DEFAULT 'FACTORY_NEW';

-- 3) Extend device lifecycle to Xiaomi-aligned values (keep legacy values)
ALTER TABLE `Device`
  MODIFY COLUMN `lifecycleStatus` ENUM('FACTORY_NEW','CLAIMING','NEW_IN_BOX','ACTIVATING','BOUND','ACTIVE','UNBOUND','REUSED') NOT NULL DEFAULT 'BOUND';

-- 4) Add modelId mappings
ALTER TABLE `HubInventory`
  ADD COLUMN `modelId` VARCHAR(50) NULL;

CREATE INDEX `HubInventory_modelId_idx` ON `HubInventory`(`modelId`);

ALTER TABLE `HubInventory`
  ADD CONSTRAINT `HubInventory_modelId_fkey`
  FOREIGN KEY (`modelId`) REFERENCES `ProductModel`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `DeviceInventory`
  ADD COLUMN `modelId` VARCHAR(50) NULL;

CREATE INDEX `DeviceInventory_modelId_idx` ON `DeviceInventory`(`modelId`);

ALTER TABLE `DeviceInventory`
  ADD CONSTRAINT `DeviceInventory_modelId_fkey`
  FOREIGN KEY (`modelId`) REFERENCES `ProductModel`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `Device`
  ADD COLUMN `modelId` VARCHAR(50) NULL;

CREATE INDEX `Device_modelId_idx` ON `Device`(`modelId`);

ALTER TABLE `Device`
  ADD CONSTRAINT `Device_modelId_fkey`
  FOREIGN KEY (`modelId`) REFERENCES `ProductModel`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
