CREATE TABLE `{prefix}sp_search_tokens` (
	`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
	`token` VARCHAR(100) NOT NULL,
	`roomId` BIGINT UNSIGNED NOT NULL,
	`messageId` BIGINT UNSIGNED NOT NULL,
	`author` BIGINT,
	`createdAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updatedAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`deletedAt` CHAR(24),
	`deletedBy` BIGINT,
	`deletedGroup` VARCHAR(36),
	`_live` TINYINT(1) DEFAULT 1,
	PRIMARY KEY (`id`),
	KEY `deletedAt_idx` (`deletedAt`),
	KEY `idx_token_messageId` (`token`, `messageId`),
	KEY `idx_messageId` (`messageId`),
	CONSTRAINT `sp_search_tokens_roomId_fk` FOREIGN KEY (`roomId`) REFERENCES `{prefix}sp_rooms` (`id`) ON DELETE CASCADE,
	CONSTRAINT `sp_search_tokens_messageId_fk` FOREIGN KEY (`messageId`) REFERENCES `{prefix}sp_messages` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
--> statement-breakpoint
CREATE TABLE `{prefix}sp_rate_counters` (
	`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
	`key` VARCHAR(100) NOT NULL,
	`window` BIGINT NOT NULL,
	`count` BIGINT NOT NULL,
	`author` BIGINT,
	`createdAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updatedAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`deletedAt` CHAR(24),
	`deletedBy` BIGINT,
	`deletedGroup` VARCHAR(36),
	`_live` TINYINT(1) DEFAULT 1,
	PRIMARY KEY (`id`),
	UNIQUE KEY `key_unique` (`key`, `_live`),
	KEY `deletedAt_idx` (`deletedAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
--> statement-breakpoint
CREATE TABLE `{prefix}sp_audit_events` (
	`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
	`actorId` BIGINT NOT NULL,
	`action` VARCHAR(40) NOT NULL,
	`subjectId` BIGINT NOT NULL,
	`details` LONGTEXT DEFAULT ('') NOT NULL,
	`author` BIGINT,
	`createdAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updatedAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`deletedAt` CHAR(24),
	`deletedBy` BIGINT,
	`deletedGroup` VARCHAR(36),
	`_live` TINYINT(1) DEFAULT 1,
	PRIMARY KEY (`id`),
	KEY `deletedAt_idx` (`deletedAt`),
	KEY `idx_subjectId` (`subjectId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
--> statement-breakpoint
CREATE TABLE `{prefix}sp_link_previews` (
	`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
	`key` VARCHAR(64) NOT NULL,
	`title` VARCHAR(160) NOT NULL,
	`description` LONGTEXT NOT NULL,
	`expiresAt` BIGINT NOT NULL,
	`author` BIGINT,
	`createdAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updatedAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`deletedAt` CHAR(24),
	`deletedBy` BIGINT,
	`deletedGroup` VARCHAR(36),
	`_live` TINYINT(1) DEFAULT 1,
	PRIMARY KEY (`id`),
	UNIQUE KEY `key_unique` (`key`, `_live`),
	KEY `deletedAt_idx` (`deletedAt`),
	KEY `idx_expiresAt` (`expiresAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
--> statement-breakpoint
ALTER TABLE `{prefix}sp_messages` DROP INDEX `authorId_queried`;
--> statement-breakpoint
ALTER TABLE `{prefix}sp_messages` ADD COLUMN `searchIndexed` TINYINT(1) DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `{prefix}sp_messages` ADD INDEX `idx_authorId_clientId` (`authorId`, `clientId`);
--> statement-breakpoint
ALTER TABLE `{prefix}sp_messages` ADD INDEX `idx_searchIndexed_id` (`searchIndexed`, `id`);
--> statement-breakpoint
ALTER TABLE `{prefix}sp_invitations` ADD COLUMN `domainVerification` TINYINT(1) DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `{prefix}sp_invitations` ADD INDEX `domainVerification_queried` (`domainVerification`);
