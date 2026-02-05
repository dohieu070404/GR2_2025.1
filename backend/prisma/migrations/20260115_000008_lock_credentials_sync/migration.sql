-- Sprint 5: SmartLock credentials + sync state

CREATE TABLE `LockSyncState` (
  `deviceId` INTEGER NOT NULL,
  `version` INTEGER NOT NULL DEFAULT 0,
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`deviceId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `LockSyncState`
  ADD CONSTRAINT `LockSyncState_deviceId_fkey`
  FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE `LockCredential` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `deviceId` INTEGER NOT NULL,
  `type` ENUM('PIN', 'RFID') NOT NULL,
  `slot` INTEGER NOT NULL,
  `label` VARCHAR(80) NULL,
  `secretHash` VARCHAR(191) NOT NULL,
  `revokedAt` DATETIME(3) NULL,
  `syncVersion` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `LockCredential_deviceId_type_slot_key`(`deviceId`, `type`, `slot`),
  INDEX `LockCredential_deviceId_type_revokedAt_idx`(`deviceId`, `type`, `revokedAt`),
  INDEX `LockCredential_deviceId_revokedAt_idx`(`deviceId`, `revokedAt`),

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `LockCredential`
  ADD CONSTRAINT `LockCredential_deviceId_fkey`
  FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
