ALTER TABLE `notes` MODIFY COLUMN `body` text;--> statement-breakpoint
ALTER TABLE `notes` ADD `status` enum('pending','processing','completed','failed') DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE `notes` ADD `failure_reason` varchar(500);--> statement-breakpoint
ALTER TABLE `notes` ADD `image_key` varchar(512);--> statement-breakpoint
ALTER TABLE `notes` ADD `image_mime_type` varchar(100);--> statement-breakpoint
ALTER TABLE `notes` ADD `concepts` json;--> statement-breakpoint
UPDATE `notes` SET `concepts` = '[]' WHERE `concepts` IS NULL;--> statement-breakpoint
ALTER TABLE `notes` ADD `extracted_text` text;--> statement-breakpoint
ALTER TABLE `notes` ADD `deleted_at` timestamp;--> statement-breakpoint
ALTER TABLE `notes` ADD `processing_generation` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `notes` ADD `processing_attempt_token` varchar(36);--> statement-breakpoint
CREATE INDEX `notes_deleted_at_idx` ON `notes` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `notes_status_idx` ON `notes` (`status`);