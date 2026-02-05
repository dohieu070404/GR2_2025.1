-- Sprint 8: Local automations (mini Xiaomi)

-- 1) AutomationRule (per-home rules)
CREATE TABLE `AutomationRule` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `homeId` INTEGER NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `version` INTEGER NOT NULL DEFAULT 0,
  `triggerType` ENUM('EVENT','STATE') NOT NULL,
  `trigger` JSON NOT NULL,
  `actions` JSON NOT NULL,
  `executionPolicy` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  INDEX `AutomationRule_homeId_enabled_idx`(`homeId`, `enabled`),
  INDEX `AutomationRule_homeId_updatedAt_idx`(`homeId`, `updatedAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `AutomationRule`
  ADD CONSTRAINT `AutomationRule_homeId_fkey`
  FOREIGN KEY (`homeId`) REFERENCES `Home`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 2) AutomationDeployment (hub sync state)
CREATE TABLE `AutomationDeployment` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `hubId` VARCHAR(80) NOT NULL,
  `homeId` INTEGER NOT NULL,
  `desiredVersion` INTEGER NOT NULL DEFAULT 0,
  `appliedVersion` INTEGER NOT NULL DEFAULT 0,
  `status` ENUM('SYNCING','APPLIED','FAILED') NOT NULL DEFAULT 'SYNCING',
  `lastMsg` TEXT NULL,
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE INDEX `AutomationDeployment_hubId_homeId_key`(`hubId`, `homeId`),
  INDEX `AutomationDeployment_homeId_updatedAt_idx`(`homeId`, `updatedAt`),
  INDEX `AutomationDeployment_hubId_updatedAt_idx`(`hubId`, `updatedAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `AutomationDeployment`
  ADD CONSTRAINT `AutomationDeployment_hubId_fkey`
  FOREIGN KEY (`hubId`) REFERENCES `Hub`(`hubId`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `AutomationDeployment`
  ADD CONSTRAINT `AutomationDeployment_homeId_fkey`
  FOREIGN KEY (`homeId`) REFERENCES `Home`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
