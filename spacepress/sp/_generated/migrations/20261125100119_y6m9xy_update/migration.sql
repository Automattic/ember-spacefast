CREATE TABLE `{prefix}sp_reactions` (
	`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
	`messageId` BIGINT UNSIGNED NOT NULL,
	`personId` BIGINT NOT NULL,
	`content` VARCHAR(100) NOT NULL,
	`author` BIGINT,
	`createdAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updatedAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`deletedAt` CHAR(24),
	`deletedBy` BIGINT,
	`deletedGroup` VARCHAR(36),
	`_live` TINYINT(1) DEFAULT 1,
	PRIMARY KEY (`id`),
	KEY `deletedAt_idx` (`deletedAt`),
	UNIQUE KEY `idx_messageId_personId_content` (`messageId`, `personId`, `content`, `_live`),
	CONSTRAINT `sp_reactions_messageId_fk` FOREIGN KEY (`messageId`) REFERENCES `{prefix}sp_messages` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
--> statement-breakpoint
CREATE TABLE `{prefix}sp_profiles` (
	`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
	`personId` BIGINT NOT NULL,
	`name` VARCHAR(80) DEFAULT '' NOT NULL,
	`bio` LONGTEXT DEFAULT ('') NOT NULL,
	`timeZone` VARCHAR(100) DEFAULT '' NOT NULL,
	`role` VARCHAR(30) DEFAULT '' NOT NULL,
	`status` VARCHAR(30) DEFAULT 'active' NOT NULL,
	`author` BIGINT,
	`createdAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updatedAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`deletedAt` CHAR(24),
	`deletedBy` BIGINT,
	`deletedGroup` VARCHAR(36),
	`_live` TINYINT(1) DEFAULT 1,
	PRIMARY KEY (`id`),
	UNIQUE KEY `personId_unique` (`personId`, `_live`),
	KEY `deletedAt_idx` (`deletedAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
--> statement-breakpoint
CREATE TABLE `{prefix}sp_workspaces` (
	`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
	`singleton` BIGINT NOT NULL,
	`name` VARCHAR(80) DEFAULT 'Ember' NOT NULL,
	`tagline` LONGTEXT DEFAULT ('') NOT NULL,
	`logo` LONGTEXT DEFAULT ('') NOT NULL,
	`restrictRoomCreation` TINYINT(1) DEFAULT 0 NOT NULL,
	`openSignUp` TINYINT(1) DEFAULT 0 NOT NULL,
	`joinLink` TINYINT(1) DEFAULT 0 NOT NULL,
	`joinCode` VARCHAR(80) DEFAULT '' NOT NULL,
	`navigationIcons` LONGTEXT DEFAULT ('{}') NOT NULL,
	`author` BIGINT,
	`createdAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updatedAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`deletedAt` CHAR(24),
	`deletedBy` BIGINT,
	`deletedGroup` VARCHAR(36),
	`_live` TINYINT(1) DEFAULT 1,
	PRIMARY KEY (`id`),
	UNIQUE KEY `singleton_unique` (`singleton`, `_live`),
	KEY `deletedAt_idx` (`deletedAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
--> statement-breakpoint
CREATE TABLE `{prefix}sp_recent_searches` (
	`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
	`personId` BIGINT NOT NULL,
	`query` LONGTEXT NOT NULL,
	`author` BIGINT,
	`createdAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updatedAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`deletedAt` CHAR(24),
	`deletedBy` BIGINT,
	`deletedGroup` VARCHAR(36),
	`_live` TINYINT(1) DEFAULT 1,
	PRIMARY KEY (`id`),
	KEY `deletedAt_idx` (`deletedAt`),
	KEY `idx_personId_id` (`personId`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
--> statement-breakpoint
ALTER TABLE `{prefix}sp_rooms` DROP INDEX `closed_queried`;
--> statement-breakpoint
ALTER TABLE `{prefix}sp_rooms` ADD COLUMN `directKey` LONGTEXT DEFAULT ('') NOT NULL;
--> statement-breakpoint
ALTER TABLE `{prefix}sp_rooms` ADD COLUMN `archived` TINYINT(1) DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `{prefix}sp_rooms` ADD COLUMN `position` BIGINT DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `{prefix}sp_rooms` ADD INDEX `idx_closed_archived` (`closed`, `archived`);
--> statement-breakpoint
ALTER TABLE `{prefix}sp_rooms` ADD INDEX `archived_queried` (`archived`);
--> statement-breakpoint
ALTER TABLE `{prefix}sp_memberships` ADD COLUMN `lastReadId` BIGINT DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `{prefix}sp_memberships` ADD COLUMN `involvement` VARCHAR(20) DEFAULT 'mentions' NOT NULL;
--> statement-breakpoint
ALTER TABLE `{prefix}sp_memberships` ADD COLUMN `favorite` TINYINT(1) DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `{prefix}sp_memberships` ADD COLUMN `position` BIGINT DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `{prefix}sp_memberships` ADD COLUMN `seenAt` BIGINT DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `{prefix}sp_memberships` ADD COLUMN `typingUntil` BIGINT DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `{prefix}sp_memberships` ADD INDEX `favorite_queried` (`favorite`);
--> statement-breakpoint
ALTER TABLE `{prefix}sp_memberships` ADD INDEX `position_queried` (`position`);
--> statement-breakpoint
ALTER TABLE `{prefix}sp_memberships` ADD INDEX `seenAt_queried` (`seenAt`);
--> statement-breakpoint
ALTER TABLE `{prefix}sp_messages` ADD COLUMN `markup` LONGTEXT DEFAULT ('') NOT NULL;
--> statement-breakpoint
ALTER TABLE `{prefix}sp_messages` ADD COLUMN `parentId` BIGINT DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `{prefix}sp_messages` ADD COLUMN `inRoom` TINYINT(1) DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `{prefix}sp_messages` ADD COLUMN `removed` TINYINT(1) DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `{prefix}sp_messages` ADD COLUMN `editedAt` VARCHAR(24) DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `{prefix}sp_messages` ADD INDEX `idx_roomId_inRoom_id` (`roomId`, `inRoom`, `id`);
--> statement-breakpoint
ALTER TABLE `{prefix}sp_messages` ADD INDEX `idx_parentId_id` (`parentId`, `id`);
--> statement-breakpoint
ALTER TABLE `{prefix}sp_messages` ADD INDEX `authorId_queried` (`authorId`);
--> statement-breakpoint
ALTER TABLE `{prefix}sp_messages` ADD INDEX `inRoom_queried` (`inRoom`);
--> statement-breakpoint
ALTER TABLE `{prefix}sp_messages` ADD INDEX `removed_queried` (`removed`);
