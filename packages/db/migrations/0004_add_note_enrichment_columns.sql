ALTER TABLE `notes` ADD `embedding` vector(1536);--> statement-breakpoint
ALTER TABLE `notes` ADD `embedding_model` varchar(64);--> statement-breakpoint
ALTER TABLE `notes` ADD `embedding_fingerprint` varchar(64);--> statement-breakpoint
ALTER TABLE `notes` ADD `enrichment_status` enum('pending','completed','failed');--> statement-breakpoint
CREATE INDEX `notes_enrichment_status_idx` ON `notes` (`enrichment_status`);
