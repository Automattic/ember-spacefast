ALTER TABLE `{prefix}sp_profiles` ADD COLUMN `avatar` LONGTEXT DEFAULT ('') NOT NULL;
--> statement-breakpoint
ALTER TABLE `{prefix}sp_service_deliveries` ADD COLUMN `responseId` VARCHAR(126) DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `{prefix}sp_service_deliveries` ADD INDEX `idx_responseId` (`responseId`);
