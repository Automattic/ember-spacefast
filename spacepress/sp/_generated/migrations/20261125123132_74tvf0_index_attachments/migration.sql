ALTER TABLE `{prefix}sp_attachments` ADD INDEX `personId_queried` (`personId`);
--> statement-breakpoint
ALTER TABLE `{prefix}sp_attachments` ADD INDEX `status_queried` (`status`);
