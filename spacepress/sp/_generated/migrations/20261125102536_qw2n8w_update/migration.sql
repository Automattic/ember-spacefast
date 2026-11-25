CREATE TABLE `{prefix}sp_attachments` (
	`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
	`roomId` BIGINT UNSIGNED NOT NULL,
	`personId` BIGINT NOT NULL,
	`name` LONGTEXT NOT NULL,
	`type` LONGTEXT NOT NULL,
	`size` BIGINT NOT NULL,
	`status` VARCHAR(20) DEFAULT 'uploading' NOT NULL,
	`manifest` LONGTEXT DEFAULT ('') NOT NULL,
	`author` BIGINT,
	`createdAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updatedAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`deletedAt` CHAR(24),
	`deletedBy` BIGINT,
	`deletedGroup` VARCHAR(36),
	`_live` TINYINT(1) DEFAULT 1,
	PRIMARY KEY (`id`),
	KEY `deletedAt_idx` (`deletedAt`),
	CONSTRAINT `sp_attachments_roomId_fk` FOREIGN KEY (`roomId`) REFERENCES `{prefix}sp_rooms` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
--> statement-breakpoint
CREATE TABLE `{prefix}sp_attachment_devices` (
	`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
	`personId` BIGINT NOT NULL,
	`deviceId` VARCHAR(32) NOT NULL,
	`publicKey` VARCHAR(130) NOT NULL,
	`active` TINYINT(1) DEFAULT 1 NOT NULL,
	`author` BIGINT,
	`createdAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updatedAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`deletedAt` CHAR(24),
	`deletedBy` BIGINT,
	`deletedGroup` VARCHAR(36),
	`_live` TINYINT(1) DEFAULT 1,
	PRIMARY KEY (`id`),
	UNIQUE KEY `deviceId_unique` (`deviceId`, `_live`),
	KEY `deletedAt_idx` (`deletedAt`),
	KEY `idx_personId_active` (`personId`, `active`),
	KEY `active_queried` (`active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
--> statement-breakpoint
CREATE TABLE `{prefix}sp_invitations` (
	`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
	`email` LONGTEXT NOT NULL,
	`tokenHash` VARCHAR(64) NOT NULL,
	`expiresAt` CHAR(24) NOT NULL,
	`accepted` TINYINT(1) DEFAULT 0 NOT NULL,
	`author` BIGINT,
	`createdAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updatedAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`deletedAt` CHAR(24),
	`deletedBy` BIGINT,
	`deletedGroup` VARCHAR(36),
	`_live` TINYINT(1) DEFAULT 1,
	PRIMARY KEY (`id`),
	UNIQUE KEY `tokenHash_unique` (`tokenHash`, `_live`),
	KEY `deletedAt_idx` (`deletedAt`),
	KEY `idx_accepted_id` (`accepted`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
--> statement-breakpoint
CREATE TABLE `{prefix}sp_service_actors` (
	`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
	`name` VARCHAR(80) NOT NULL,
	`handle` VARCHAR(32) DEFAULT '' NOT NULL,
	`kind` VARCHAR(20) NOT NULL,
	`roomIds` LONGTEXT DEFAULT ('[]') NOT NULL,
	`enabled` TINYINT(1) DEFAULT 0 NOT NULL,
	`secretHash` VARCHAR(64) DEFAULT '' NOT NULL,
	`outgoingUrl` LONGTEXT DEFAULT ('') NOT NULL,
	`directMessages` TINYINT(1) DEFAULT 0 NOT NULL,
	`instructions` LONGTEXT DEFAULT ('') NOT NULL,
	`includeThreadRoot` TINYINT(1) DEFAULT 0 NOT NULL,
	`version` VARCHAR(64) DEFAULT '' NOT NULL,
	`author` BIGINT,
	`createdAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updatedAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`deletedAt` CHAR(24),
	`deletedBy` BIGINT,
	`deletedGroup` VARCHAR(36),
	`_live` TINYINT(1) DEFAULT 1,
	PRIMARY KEY (`id`),
	KEY `deletedAt_idx` (`deletedAt`),
	KEY `idx_kind_handle` (`kind`, `handle`),
	KEY `enabled_queried` (`enabled`),
	KEY `handle_queried` (`handle`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
--> statement-breakpoint
CREATE TABLE `{prefix}sp_service_deliveries` (
	`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
	`actorId` BIGINT UNSIGNED NOT NULL,
	`messageId` BIGINT UNSIGNED NOT NULL,
	`actorVersion` VARCHAR(64) NOT NULL,
	`sourceUpdatedAt` VARCHAR(24) NOT NULL,
	`status` VARCHAR(20) DEFAULT 'queued' NOT NULL,
	`replyHash` VARCHAR(64) DEFAULT '' NOT NULL,
	`author` BIGINT,
	`createdAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updatedAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`deletedAt` CHAR(24),
	`deletedBy` BIGINT,
	`deletedGroup` VARCHAR(36),
	`_live` TINYINT(1) DEFAULT 1,
	PRIMARY KEY (`id`),
	KEY `deletedAt_idx` (`deletedAt`),
	UNIQUE KEY `idx_actorId_messageId` (`actorId`, `messageId`, `_live`),
	CONSTRAINT `sp_service_deliveries_actorId_fk` FOREIGN KEY (`actorId`) REFERENCES `{prefix}sp_service_actors` (`id`) ON DELETE CASCADE,
	CONSTRAINT `sp_service_deliveries_messageId_fk` FOREIGN KEY (`messageId`) REFERENCES `{prefix}sp_messages` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
--> statement-breakpoint
CREATE TABLE `{prefix}sp_push_subscriptions` (
	`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
	`personId` BIGINT NOT NULL,
	`endpoint` LONGTEXT NOT NULL,
	`endpointHash` VARCHAR(64) NOT NULL,
	`publicKey` VARCHAR(87) NOT NULL,
	`author` BIGINT,
	`createdAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updatedAt` CHAR(24) DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`deletedAt` CHAR(24),
	`deletedBy` BIGINT,
	`deletedGroup` VARCHAR(36),
	`_live` TINYINT(1) DEFAULT 1,
	PRIMARY KEY (`id`),
	UNIQUE KEY `endpointHash_unique` (`endpointHash`, `_live`),
	KEY `deletedAt_idx` (`deletedAt`),
	KEY `idx_personId_id` (`personId`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
--> statement-breakpoint
ALTER TABLE `{prefix}sp_memberships` ADD INDEX `involvement_queried` (`involvement`);
--> statement-breakpoint
ALTER TABLE `{prefix}sp_messages` ADD COLUMN `attachmentId` BIGINT DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `{prefix}sp_messages` ADD COLUMN `cards` LONGTEXT DEFAULT ('') NOT NULL;
--> statement-breakpoint
ALTER TABLE `{prefix}sp_messages` ADD INDEX `clientId_queried` (`clientId`);
--> statement-breakpoint
ALTER TABLE `{prefix}sp_messages` ADD INDEX `createdAt_queried` (`createdAt`);
--> statement-breakpoint
ALTER TABLE `{prefix}sp_workspaces` ADD COLUMN `assistantsEnabled` TINYINT(1) DEFAULT 0 NOT NULL;
