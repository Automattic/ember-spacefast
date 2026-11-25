CREATE TABLE `{prefix}sp_rooms` (
	`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
	`name` VARCHAR(80) NOT NULL,
	`icon` VARCHAR(100) DEFAULT '' NOT NULL,
	`closed` TINYINT(1) DEFAULT 0 NOT NULL,
	`owner` BIGINT NOT NULL,
	`author` BIGINT,
	`createdAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updatedAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`deletedAt` CHAR(24),
	`deletedBy` BIGINT,
	`deletedGroup` VARCHAR(36),
	`_live` TINYINT(1) DEFAULT 1,
	PRIMARY KEY (`id`),
	KEY `deletedAt_idx` (`deletedAt`),
	KEY `closed_queried` (`closed`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
--> statement-breakpoint
CREATE TABLE `{prefix}sp_memberships` (
	`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
	`roomId` BIGINT UNSIGNED NOT NULL,
	`personId` BIGINT NOT NULL,
	`author` BIGINT,
	`createdAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updatedAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`deletedAt` CHAR(24),
	`deletedBy` BIGINT,
	`deletedGroup` VARCHAR(36),
	`_live` TINYINT(1) DEFAULT 1,
	PRIMARY KEY (`id`),
	KEY `deletedAt_idx` (`deletedAt`),
	UNIQUE KEY `idx_roomId_personId` (`roomId`, `personId`, `_live`),
	KEY `idx_personId` (`personId`),
	CONSTRAINT `sp_memberships_roomId_fk` FOREIGN KEY (`roomId`) REFERENCES `{prefix}sp_rooms` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
--> statement-breakpoint
CREATE TABLE `{prefix}sp_messages` (
	`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
	`roomId` BIGINT UNSIGNED NOT NULL,
	`authorId` BIGINT NOT NULL,
	`clientId` VARCHAR(80) NOT NULL,
	`body` LONGTEXT NOT NULL,
	`createdAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`author` BIGINT,
	`updatedAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`deletedAt` CHAR(24),
	`deletedBy` BIGINT,
	`deletedGroup` VARCHAR(36),
	`_live` TINYINT(1) DEFAULT 1,
	PRIMARY KEY (`id`),
	KEY `deletedAt_idx` (`deletedAt`),
	KEY `idx_roomId_id` (`roomId`, `id`),
	UNIQUE KEY `idx_roomId_authorId_clientId` (`roomId`, `authorId`, `clientId`, `_live`),
	CONSTRAINT `sp_messages_roomId_fk` FOREIGN KEY (`roomId`) REFERENCES `{prefix}sp_rooms` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
--> statement-breakpoint
CREATE TABLE `{prefix}sp__revisions` (
	`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
	`collection` VARCHAR(64) NOT NULL,
	`pk` VARCHAR(191) NOT NULL,
	`version` BIGINT DEFAULT 1 NOT NULL,
	`op` VARCHAR(16) DEFAULT 'update' NOT NULL,
	`at` CHAR(24) NOT NULL,
	`userId` BIGINT,
	`schemaMigration` VARCHAR(191),
	`row` LONGTEXT NOT NULL,
	`changed` LONGTEXT,
	PRIMARY KEY (`id`),
	KEY `row` (`collection`, `pk`),
	UNIQUE KEY `row_version` (`collection`, `pk`, `version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
