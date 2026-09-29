-- Online invoice payments (#55): provider settings on org_settings, pay-link and checkout state on
-- invoices, and tables for provider customers, received webhook events, and recorded provider
-- payments (the unique provider payment key makes recording idempotent).

CREATE TABLE `provider_customers` (
	`contact_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_customer_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`contact_id`, `provider`),
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `provider_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`event_id` text NOT NULL,
	`type` text NOT NULL,
	`received_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`processed_at` text,
	`result` text,
	`error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_events_event_uq` ON `provider_events` (`provider`,`event_id`);--> statement-breakpoint
CREATE INDEX `provider_events_pending_idx` ON `provider_events` (`processed_at`);--> statement-breakpoint
CREATE TABLE `provider_payments` (
	`provider` text NOT NULL,
	`provider_payment_id` text NOT NULL,
	`payment_id` text NOT NULL,
	`invoice_id` text,
	`gross` integer NOT NULL,
	`fee` integer,
	`fee_entry_id` text,
	`method_type` text,
	`balance_txn_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_payments_uq` ON `provider_payments` (`provider`,`provider_payment_id`);--> statement-breakpoint
CREATE INDEX `provider_payments_invoice_idx` ON `provider_payments` (`invoice_id`);--> statement-breakpoint
ALTER TABLE `invoices` ADD `online_pay_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD `manual_pay_url` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `pay_token_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD `pay_token_hash` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `pay_session_id` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `pay_session_amount` integer;--> statement-breakpoint
ALTER TABLE `invoices` ADD `pay_session_expires_at` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `online_pay_status` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `pay_link_opened_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_pay_token_hash_uq` ON `invoices` (`pay_token_hash`);--> statement-breakpoint
ALTER TABLE `org_settings` ADD `payment_provider` text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE `org_settings` ADD `payment_credentials_enc` text;--> statement-breakpoint
ALTER TABLE `org_settings` ADD `payment_options_json` text;--> statement-breakpoint
ALTER TABLE `org_settings` ADD `payment_clearing_account_id` text;--> statement-breakpoint
ALTER TABLE `org_settings` ADD `payment_fee_account_id` text;--> statement-breakpoint
ALTER TABLE `org_settings` ADD `online_pay_default` integer DEFAULT false NOT NULL;
