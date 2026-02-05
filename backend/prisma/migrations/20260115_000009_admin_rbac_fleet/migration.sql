-- Sprint 6: Admin RBAC + hub runtime metadata

ALTER TABLE `User`
  ADD COLUMN `isAdmin` BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE `Hub`
  ADD COLUMN `mac` VARCHAR(32) NULL,
  ADD COLUMN `ip` VARCHAR(64) NULL,
  ADD COLUMN `rssi` INTEGER NULL;
