-- Bank feed sync status (#57): when the last sync attempt finished, its counts, and Plaid's error
-- message; and a flag for new accounts Plaid reported at an existing login (#12).

ALTER TABLE `bank_connections` ADD `error_message` text;--> statement-breakpoint
ALTER TABLE `bank_connections` ADD `last_sync_attempt_at` text;--> statement-breakpoint
ALTER TABLE `bank_connections` ADD `last_sync_added` integer;--> statement-breakpoint
ALTER TABLE `bank_connections` ADD `last_sync_modified` integer;--> statement-breakpoint
ALTER TABLE `bank_connections` ADD `last_sync_removed` integer;--> statement-breakpoint
ALTER TABLE `bank_connections` ADD `new_accounts_available` integer DEFAULT false NOT NULL;