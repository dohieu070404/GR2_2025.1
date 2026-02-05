-- Add firmwareType to Device
ALTER TABLE `Device` ADD COLUMN `firmwareType` VARCHAR(50) NULL;

-- Create DeviceStateHistory
CREATE TABLE `DeviceStateHistory` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `deviceId` INTEGER NOT NULL,
    `state` JSON NULL,
    `online` BOOLEAN NOT NULL DEFAULT false,
    `lastSeen` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `DeviceStateHistory_deviceId_idx`(`deviceId`),
    INDEX `DeviceStateHistory_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `DeviceStateHistory` ADD CONSTRAINT `DeviceStateHistory_deviceId_fkey`
FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
