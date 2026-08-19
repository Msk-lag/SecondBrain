CREATE TABLE `note_relations` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`note_a_id` varchar(36) NOT NULL,
	`note_b_id` varchar(36) NOT NULL,
	`source_note_id` varchar(36) NOT NULL,
	`relation_type` varchar(32) NOT NULL,
	`type_direction` enum('a-to-b','b-to-a','none') NOT NULL DEFAULT 'none',
	`description` varchar(500) NOT NULL,
	`relatedness` decimal(3,2) NOT NULL,
	`note_a_fingerprint` varchar(64) NOT NULL,
	`note_b_fingerprint` varchar(64) NOT NULL,
	`deleted_at` datetime,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `note_relations_id` PRIMARY KEY(`id`),
	CONSTRAINT `note_relations_user_id_note_a_id_note_b_id_unique` UNIQUE(`user_id`,`note_a_id`,`note_b_id`),
	CONSTRAINT `note_relations_note_a_id_lt_note_b_id` CHECK(`note_relations`.`note_a_id` < `note_relations`.`note_b_id`),
	CONSTRAINT `note_relations_source_note_id_is_endpoint` CHECK(`note_relations`.`source_note_id` = `note_relations`.`note_a_id` or `note_relations`.`source_note_id` = `note_relations`.`note_b_id`)
);
--> statement-breakpoint
ALTER TABLE `notes` ADD `relation_status` enum('pending','completed','failed');--> statement-breakpoint
ALTER TABLE `notes` ADD `relation_fingerprint` varchar(64);--> statement-breakpoint
ALTER TABLE `note_relations` ADD CONSTRAINT `note_relations_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `note_relations` ADD CONSTRAINT `note_relations_note_a_id_notes_id_fk` FOREIGN KEY (`note_a_id`) REFERENCES `notes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `note_relations` ADD CONSTRAINT `note_relations_note_b_id_notes_id_fk` FOREIGN KEY (`note_b_id`) REFERENCES `notes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `note_relations` ADD CONSTRAINT `note_relations_source_note_id_notes_id_fk` FOREIGN KEY (`source_note_id`) REFERENCES `notes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `note_relations_note_a_id_idx` ON `note_relations` (`note_a_id`);--> statement-breakpoint
CREATE INDEX `note_relations_note_b_id_idx` ON `note_relations` (`note_b_id`);