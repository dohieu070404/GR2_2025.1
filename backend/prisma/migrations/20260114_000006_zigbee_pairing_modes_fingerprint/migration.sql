-- Sprint 2: Zigbee pairing modes + fingerprint fields + ProductModel suggestion

-- 1) ZigbeePairingSession: add mode + flow-specific fields
ALTER TABLE `ZigbeePairingSession`
  ADD COLUMN `mode` ENUM('LEGACY','SERIAL_FIRST','TYPE_FIRST') NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN `claimedSerial` VARCHAR(80) NULL,
  ADD COLUMN `expectedModelId` VARCHAR(50) NULL;

CREATE INDEX `ZigbeePairingSession_mode_idx` ON `ZigbeePairingSession`(`mode`);
CREATE INDEX `ZigbeePairingSession_claimedSerial_idx` ON `ZigbeePairingSession`(`claimedSerial`);
CREATE INDEX `ZigbeePairingSession_expectedModelId_idx` ON `ZigbeePairingSession`(`expectedModelId`);

ALTER TABLE `ZigbeePairingSession`
  ADD CONSTRAINT `ZigbeePairingSession_expectedModelId_fkey`
  FOREIGN KEY (`expectedModelId`) REFERENCES `ProductModel`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 2) ZigbeeDiscoveredDevice: add fingerprint fields + suggested model mapping
ALTER TABLE `ZigbeeDiscoveredDevice`
  ADD COLUMN `swBuildId` VARCHAR(120) NULL,
  ADD COLUMN `suggestedModelId` VARCHAR(50) NULL;

CREATE INDEX `ZigbeeDiscoveredDevice_pairingToken_idx` ON `ZigbeeDiscoveredDevice`(`pairingToken`);
CREATE INDEX `ZigbeeDiscoveredDevice_suggestedModelId_idx` ON `ZigbeeDiscoveredDevice`(`suggestedModelId`);

ALTER TABLE `ZigbeeDiscoveredDevice`
  ADD CONSTRAINT `ZigbeeDiscoveredDevice_suggestedModelId_fkey`
  FOREIGN KEY (`suggestedModelId`) REFERENCES `ProductModel`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
