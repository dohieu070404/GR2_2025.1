-- Create the initial schema for SmartHome (MySQL).
--
-- IMPORTANT:
-- - This migration targets MySQL 8.0+
-- - For a clean install, run: `npx prisma migrate deploy`

-- CreateTable
CREATE TABLE `User` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(60) NOT NULL,
  `email` VARCHAR(120) NOT NULL,
  `passwordHash` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `User_email_key`(`email`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Home` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(80) NOT NULL,
  `ownerId` INTEGER NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `Home_ownerId_idx`(`ownerId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `HomeMember` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `homeId` INTEGER NOT NULL,
  `userId` INTEGER NOT NULL,
  `role` ENUM('OWNER', 'ADMIN', 'MEMBER') NOT NULL DEFAULT 'MEMBER',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `HomeMember_homeId_userId_key`(`homeId`, `userId`),
  INDEX `HomeMember_userId_idx`(`userId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Room` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `homeId` INTEGER NOT NULL,
  `name` VARCHAR(80) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `Room_homeId_name_key`(`homeId`, `name`),
  INDEX `Room_homeId_idx`(`homeId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Device` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(80) NOT NULL,
  `type` ENUM('relay', 'dimmer', 'rgb', 'sensor') NOT NULL,
  `protocol` ENUM('MQTT', 'ZIGBEE') NOT NULL DEFAULT 'MQTT',
  `firmwareVersion` VARCHAR(50) NULL,
  `deviceId` VARCHAR(36) NOT NULL,
  `homeId` INTEGER NOT NULL,
  `roomId` INTEGER NULL,
  `legacyTopicBase` VARCHAR(200) NULL,
  `legacyRoomName` VARCHAR(80) NULL,
  `hubId` VARCHAR(191) NULL,
  `zigbeeIeee` VARCHAR(191) NULL,
  `createdById` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `Device_deviceId_key`(`deviceId`),
  INDEX `Device_homeId_idx`(`homeId`),
  INDEX `Device_roomId_idx`(`roomId`),
  INDEX `Device_createdById_idx`(`createdById`),
  INDEX `Device_legacyTopicBase_idx`(`legacyTopicBase`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DeviceStateCurrent` (
  `deviceId` INTEGER NOT NULL,
  `state` JSON NULL,
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `lastSeen` DATETIME(3) NULL,
  `online` BOOLEAN NOT NULL DEFAULT false,

  PRIMARY KEY (`deviceId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Command` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `deviceId` INTEGER NOT NULL,
  `cmdId` VARCHAR(36) NOT NULL,
  `payload` JSON NOT NULL,
  `status` ENUM('PENDING', 'ACKED', 'FAILED', 'TIMEOUT') NOT NULL DEFAULT 'PENDING',
  `sentAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `ackedAt` DATETIME(3) NULL,
  `error` TEXT NULL,

  UNIQUE INDEX `Command_deviceId_cmdId_key`(`deviceId`, `cmdId`),
  INDEX `Command_deviceId_status_sentAt_idx`(`deviceId`, `status`, `sentAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ZigbeeDiscoveredDevice` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `ownerId` INTEGER NOT NULL,
  `hubId` VARCHAR(191) NOT NULL,
  `pairingToken` VARCHAR(191) NOT NULL,
  `ieee` VARCHAR(191) NOT NULL,
  `shortAddr` INTEGER NULL,
  `model` VARCHAR(191) NULL,
  `manufacturer` VARCHAR(191) NULL,
  `suggestedType` ENUM('relay', 'dimmer', 'rgb', 'sensor') NULL,
  `status` ENUM('PENDING', 'CONFIRMED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `ZigbeeDiscoveredDevice_hubId_ieee_key`(`hubId`, `ieee`),
  INDEX `ZigbeeDiscoveredDevice_ownerId_status_idx`(`ownerId`, `status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Home`
  ADD CONSTRAINT `Home_ownerId_fkey`
  FOREIGN KEY (`ownerId`) REFERENCES `User`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `HomeMember`
  ADD CONSTRAINT `HomeMember_homeId_fkey`
  FOREIGN KEY (`homeId`) REFERENCES `Home`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `HomeMember`
  ADD CONSTRAINT `HomeMember_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Room`
  ADD CONSTRAINT `Room_homeId_fkey`
  FOREIGN KEY (`homeId`) REFERENCES `Home`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Device`
  ADD CONSTRAINT `Device_homeId_fkey`
  FOREIGN KEY (`homeId`) REFERENCES `Home`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Device`
  ADD CONSTRAINT `Device_roomId_fkey`
  FOREIGN KEY (`roomId`) REFERENCES `Room`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Device`
  ADD CONSTRAINT `Device_createdById_fkey`
  FOREIGN KEY (`createdById`) REFERENCES `User`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DeviceStateCurrent`
  ADD CONSTRAINT `DeviceStateCurrent_deviceId_fkey`
  FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Command`
  ADD CONSTRAINT `Command_deviceId_fkey`
  FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ZigbeeDiscoveredDevice`
  ADD CONSTRAINT `ZigbeeDiscoveredDevice_ownerId_fkey`
  FOREIGN KEY (`ownerId`) REFERENCES `User`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
