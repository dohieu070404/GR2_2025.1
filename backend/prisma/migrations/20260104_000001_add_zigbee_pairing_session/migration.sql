-- Add ZigbeePairingSession for persistent pairing sessions (survive backend restart)

CREATE TABLE `ZigbeePairingSession` (
    `token` VARCHAR(36) NOT NULL,
    `ownerId` INTEGER NOT NULL,
    `hubId` VARCHAR(80) NOT NULL,
    `homeId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,

    INDEX `ZigbeePairingSession_ownerId_idx`(`ownerId`),
    INDEX `ZigbeePairingSession_hubId_idx`(`hubId`),
    INDEX `ZigbeePairingSession_expiresAt_idx`(`expiresAt`),

    PRIMARY KEY (`token`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ZigbeePairingSession`
    ADD CONSTRAINT `ZigbeePairingSession_ownerId_fkey`
    FOREIGN KEY (`ownerId`) REFERENCES `User`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `ZigbeePairingSession`
    ADD CONSTRAINT `ZigbeePairingSession_homeId_fkey`
    FOREIGN KEY (`homeId`) REFERENCES `Home`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
