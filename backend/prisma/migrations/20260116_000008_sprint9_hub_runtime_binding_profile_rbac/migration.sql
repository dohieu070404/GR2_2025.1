-- Sprint 9: Hub inventory manual + runtime/binding + profile/invites + everOnline tracking

-- 1) HomeMember role: add GUEST
ALTER TABLE `HomeMember`
  MODIFY COLUMN `role` ENUM('OWNER','ADMIN','MEMBER','GUEST') NOT NULL DEFAULT 'MEMBER';

-- 2) Minimal user profile
CREATE TABLE `UserProfile` (
  `userId` INTEGER NOT NULL,
  `displayName` VARCHAR(80) NULL,
  `avatarUrl` VARCHAR(500) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`userId`),
  INDEX `UserProfile_displayName_idx` (`displayName`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `UserProfile`
  ADD CONSTRAINT `UserProfile_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- 3) HomeInvite table
CREATE TABLE `HomeInvite` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `homeId` INTEGER NOT NULL,
  `code` VARCHAR(32) NOT NULL,
  `role` ENUM('OWNER','ADMIN','MEMBER','GUEST') NOT NULL DEFAULT 'MEMBER',
  `createdByUserId` INTEGER NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expiresAt` DATETIME(3) NULL,
  `acceptedByUserId` INTEGER NULL,
  `acceptedAt` DATETIME(3) NULL,
  `revokedAt` DATETIME(3) NULL,
  UNIQUE INDEX `HomeInvite_code_key` (`code`),
  INDEX `HomeInvite_homeId_idx` (`homeId`),
  INDEX `HomeInvite_createdByUserId_idx` (`createdByUserId`),
  INDEX `HomeInvite_expiresAt_idx` (`expiresAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `HomeInvite`
  ADD CONSTRAINT `HomeInvite_homeId_fkey`
  FOREIGN KEY (`homeId`) REFERENCES `Home`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `HomeInvite`
  ADD CONSTRAINT `HomeInvite_createdByUserId_fkey`
  FOREIGN KEY (`createdByUserId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `HomeInvite`
  ADD CONSTRAINT `HomeInvite_acceptedByUserId_fkey`
  FOREIGN KEY (`acceptedByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- 4) DeviceStateCurrent: add firstSeenAt + everOnline
ALTER TABLE `DeviceStateCurrent`
  ADD COLUMN `firstSeenAt` DATETIME(3) NULL,
  ADD COLUMN `everOnline` BOOLEAN NOT NULL DEFAULT false;

-- 5) HubInventory: pivot to serial + new statuses
UPDATE `HubInventory` SET `serial` = `hubId` WHERE `serial` IS NULL;

-- Expand enum temporarily to allow mapping from old values
ALTER TABLE `HubInventory`
  MODIFY COLUMN `status` ENUM('FACTORY_NEW','NEW','CLAIMED','BOUND','REVOKED','RETIRED') NOT NULL DEFAULT 'NEW';

UPDATE `HubInventory` SET `status` = 'NEW' WHERE `status` = 'FACTORY_NEW';
UPDATE `HubInventory` SET `status` = 'RETIRED' WHERE `status` = 'REVOKED';

-- Shrink enum to the new canonical set
ALTER TABLE `HubInventory`
  MODIFY COLUMN `status` ENUM('NEW','CLAIMED','BOUND','RETIRED') NOT NULL DEFAULT 'NEW';

-- Make serial required
ALTER TABLE `HubInventory`
  MODIFY COLUMN `serial` VARCHAR(80) NOT NULL;

-- Drop old hubId unique index and column
DROP INDEX `HubInventory_hubId_key` ON `HubInventory`;
ALTER TABLE `HubInventory` DROP COLUMN `hubId`;

-- 6) HubRuntime table (MQTT-derived)
CREATE TABLE `HubRuntime` (
  `hubId` VARCHAR(80) NOT NULL,
  `mac` VARCHAR(32) NULL,
  `ip` VARCHAR(64) NULL,
  `fwVersion` VARCHAR(50) NULL,
  `rssi` INTEGER NULL,
  `firstSeenAt` DATETIME(3) NULL,
  `lastSeenAt` DATETIME(3) NULL,
  `everOnline` BOOLEAN NOT NULL DEFAULT false,
  `online` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`hubId`),
  INDEX `HubRuntime_mac_idx` (`mac`),
  INDEX `HubRuntime_online_lastSeenAt_idx` (`online`, `lastSeenAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 7) HubBinding table
CREATE TABLE `HubBinding` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `inventorySerial` VARCHAR(80) NOT NULL,
  `hubId` VARCHAR(80) NOT NULL,
  `homeId` INTEGER NOT NULL,
  `ownerId` INTEGER NOT NULL,
  `activatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `HubBinding_inventorySerial_key` (`inventorySerial`),
  UNIQUE INDEX `HubBinding_hubId_key` (`hubId`),
  INDEX `HubBinding_homeId_idx` (`homeId`),
  INDEX `HubBinding_hubId_idx` (`hubId`),
  INDEX `HubBinding_inventorySerial_idx` (`inventorySerial`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `HubBinding`
  ADD CONSTRAINT `HubBinding_inventorySerial_fkey`
  FOREIGN KEY (`inventorySerial`) REFERENCES `HubInventory`(`serial`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `HubBinding`
  ADD CONSTRAINT `HubBinding_hubId_fkey`
  FOREIGN KEY (`hubId`) REFERENCES `HubRuntime`(`hubId`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `HubBinding`
  ADD CONSTRAINT `HubBinding_homeId_fkey`
  FOREIGN KEY (`homeId`) REFERENCES `Home`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `HubBinding`
  ADD CONSTRAINT `HubBinding_ownerId_fkey`
  FOREIGN KEY (`ownerId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
