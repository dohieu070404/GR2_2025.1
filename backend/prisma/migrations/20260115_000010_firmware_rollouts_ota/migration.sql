-- Sprint 7: Hub OTA + firmware releases/rollouts

-- 0) Hub coordinator fw metadata (reported by Zigbee coordinator via hub_host)
ALTER TABLE `Hub`
  ADD COLUMN `coordinatorFirmwareVersion` VARCHAR(50) NULL,
  ADD COLUMN `coordinatorBuildTime` VARCHAR(80) NULL;

-- 1) FirmwareRelease catalog
CREATE TABLE `FirmwareRelease` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `targetType` ENUM('HUB') NOT NULL,
  `version` VARCHAR(60) NOT NULL,
  `url` VARCHAR(500) NOT NULL,
  `sha256` VARCHAR(64) NOT NULL,
  `size` INTEGER NULL,
  `notes` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  INDEX `FirmwareRelease_targetType_createdAt_idx`(`targetType`, `createdAt`),
  INDEX `FirmwareRelease_version_idx`(`version`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 2) FirmwareRollout
CREATE TABLE `FirmwareRollout` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `releaseId` INTEGER NOT NULL,
  `status` ENUM('DRAFT','RUNNING','PAUSED','DONE') NOT NULL DEFAULT 'DRAFT',
  `startedAt` DATETIME(3) NULL,
  `pausedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  INDEX `FirmwareRollout_releaseId_idx`(`releaseId`),
  INDEX `FirmwareRollout_status_updatedAt_idx`(`status`, `updatedAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `FirmwareRollout`
  ADD CONSTRAINT `FirmwareRollout_releaseId_fkey`
  FOREIGN KEY (`releaseId`) REFERENCES `FirmwareRelease`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 3) FirmwareRolloutTarget (rolloutId + hubId)
CREATE TABLE `FirmwareRolloutTarget` (
  `rolloutId` INTEGER NOT NULL,
  `hubId` VARCHAR(80) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`rolloutId`, `hubId`),
  INDEX `FirmwareRolloutTarget_hubId_idx`(`hubId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `FirmwareRolloutTarget`
  ADD CONSTRAINT `FirmwareRolloutTarget_rolloutId_fkey`
  FOREIGN KEY (`rolloutId`) REFERENCES `FirmwareRollout`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `FirmwareRolloutTarget`
  ADD CONSTRAINT `FirmwareRolloutTarget_hubId_fkey`
  FOREIGN KEY (`hubId`) REFERENCES `Hub`(`hubId`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 4) FirmwareRolloutProgress (rolloutId + hubId)
CREATE TABLE `FirmwareRolloutProgress` (
  `rolloutId` INTEGER NOT NULL,
  `hubId` VARCHAR(80) NOT NULL,
  `state` ENUM('PENDING','DOWNLOADING','APPLYING','SUCCESS','FAILED') NOT NULL DEFAULT 'PENDING',
  `attempt` INTEGER NOT NULL DEFAULT 0,
  `cmdId` VARCHAR(36) NULL,
  `sentAt` DATETIME(3) NULL,
  `ackedAt` DATETIME(3) NULL,
  `lastMsg` TEXT NULL,
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`rolloutId`, `hubId`),
  INDEX `FirmwareRolloutProgress_hubId_idx`(`hubId`),
  INDEX `FirmwareRolloutProgress_state_updatedAt_idx`(`state`, `updatedAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `FirmwareRolloutProgress`
  ADD CONSTRAINT `FirmwareRolloutProgress_rolloutId_fkey`
  FOREIGN KEY (`rolloutId`) REFERENCES `FirmwareRollout`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `FirmwareRolloutProgress`
  ADD CONSTRAINT `FirmwareRolloutProgress_hubId_fkey`
  FOREIGN KEY (`hubId`) REFERENCES `Hub`(`hubId`)
  ON DELETE CASCADE ON UPDATE CASCADE;
