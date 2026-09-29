-- Pay-link failures (#58): the last failure's message and time on each invoice, and a count of
-- failed checkout creates that goes into the idempotency key so a retry isn't a replay.

ALTER TABLE `invoices` ADD `pay_attempt` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD `pay_error` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `pay_error_at` text;