-- Stripe refunds, disputes, and payouts (#55): one row per refund or dispute movement against a
-- recorded payment (the unique provider object key makes proposing its entry idempotent), payouts for
-- matching bank deposits, and the unapplied cash balance the provider holds for each customer.

CREATE TABLE `provider_adjustments` (
	`provider` text NOT NULL,
	`provider_object_id` text NOT NULL,
	`kind` text NOT NULL,
	`provider_payment_id` text NOT NULL,
	`payment_id` text NOT NULL,
	`invoice_id` text,
	`amount` integer NOT NULL,
	`fee` integer DEFAULT 0 NOT NULL,
	`entry_id` text,
	`occurred_on` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_adjustments_uq` ON `provider_adjustments` (`provider`,`provider_object_id`);--> statement-breakpoint
CREATE INDEX `provider_adjustments_payment_idx` ON `provider_adjustments` (`provider`,`provider_payment_id`);--> statement-breakpoint
CREATE INDEX `provider_adjustments_invoice_idx` ON `provider_adjustments` (`invoice_id`);--> statement-breakpoint
CREATE TABLE `provider_payouts` (
	`provider` text NOT NULL,
	`payout_id` text NOT NULL,
	`amount` integer NOT NULL,
	`arrival_date` text NOT NULL,
	`status` text NOT NULL,
	`bank_txn_id` text,
	`entry_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_payouts_uq` ON `provider_payouts` (`provider`,`payout_id`);--> statement-breakpoint
CREATE INDEX `provider_payouts_amount_idx` ON `provider_payouts` (`amount`);--> statement-breakpoint
ALTER TABLE `provider_customers` ADD `cash_balance` integer;--> statement-breakpoint
ALTER TABLE `provider_customers` ADD `cash_balance_checked_at` text;