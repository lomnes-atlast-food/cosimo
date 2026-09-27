CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`subtype` text DEFAULT 'other' NOT NULL,
	`parent_id` text,
	`tax_line` text,
	`description` text,
	`is_active` integer DEFAULT true NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	`system_key` text,
	`currency` text DEFAULT 'USD' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	CONSTRAINT "accounts_type_ck" CHECK("accounts"."type" in ('asset','liability','equity','income','expense'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_code_uq` ON `accounts` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_system_key_uq` ON `accounts` (`system_key`);--> statement-breakpoint
CREATE TABLE `attachment_links` (
	`attachment_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	PRIMARY KEY(`attachment_id`, `target_type`, `target_id`),
	FOREIGN KEY (`attachment_id`) REFERENCES `attachments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `attachment_links_target_idx` ON `attachment_links` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`storage_key` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`uploaded_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	`at` text NOT NULL,
	`user_id` text,
	`api_token_id` text,
	`oauth_client_id` text,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`before_json` text,
	`after_json` text,
	`ip` text,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_log_seq_uq` ON `audit_log` (`seq`);--> statement-breakpoint
CREATE INDEX `audit_log_target_idx` ON `audit_log` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `audit_log_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE TABLE `bank_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text,
	`ledger_account_id` text NOT NULL,
	`provider_account_id` text,
	`name` text NOT NULL,
	`mask` text,
	`kind` text DEFAULT 'checking' NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`ledger_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bank_accounts_ledger_uq` ON `bank_accounts` (`ledger_account_id`);--> statement-breakpoint
CREATE TABLE `bank_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'plaid' NOT NULL,
	`item_id` text NOT NULL,
	`access_token_enc` text NOT NULL,
	`institution_name` text,
	`institution_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`error_code` text,
	`sync_cursor` text,
	`last_synced_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bank_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`bank_account_id` text NOT NULL,
	`provider_transaction_id` text,
	`pending_transaction_id` text,
	`batch_id` text,
	`date` text NOT NULL,
	`amount` integer NOT NULL,
	`description` text NOT NULL,
	`normalized_description` text NOT NULL,
	`payee` text,
	`is_pending` integer DEFAULT false NOT NULL,
	`dedupe_hash` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`matched_entry_id` text,
	`rule_id` text,
	`suggestion_json` text,
	`review_item_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`bank_account_id`) REFERENCES `bank_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bank_tx_provider_uq` ON `bank_transactions` (`bank_account_id`,`provider_transaction_id`) WHERE "bank_transactions"."provider_transaction_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `bank_tx_dedupe_uq` ON `bank_transactions` (`bank_account_id`,`dedupe_hash`);--> statement-breakpoint
CREATE INDEX `bank_tx_status_idx` ON `bank_transactions` (`status`,`date`);--> statement-breakpoint
CREATE INDEX `bank_tx_account_date_idx` ON `bank_transactions` (`bank_account_id`,`date`);--> statement-breakpoint
CREATE TABLE `bill_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`bill_id` text NOT NULL,
	`description` text NOT NULL,
	`amount` integer NOT NULL,
	`expense_account_id` text NOT NULL,
	`line_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`bill_id`) REFERENCES `bills`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`expense_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `bill_lines_bill_idx` ON `bill_lines` (`bill_id`);--> statement-breakpoint
CREATE TABLE `bills` (
	`id` text PRIMARY KEY NOT NULL,
	`vendor_id` text NOT NULL,
	`bill_number` text,
	`issue_date` text NOT NULL,
	`due_date` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`amount_paid` integer DEFAULT 0 NOT NULL,
	`memo` text,
	`entry_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`voided_at` text,
	FOREIGN KEY (`vendor_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `bills_vendor_idx` ON `bills` (`vendor_id`);--> statement-breakpoint
CREATE TABLE `chain_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`chain` text NOT NULL,
	`seq` integer NOT NULL,
	`head_hash` text NOT NULL,
	`reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`exported_to` text
);
--> statement-breakpoint
CREATE INDEX `chain_checkpoints_chain_idx` ON `chain_checkpoints` (`chain`,`seq`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`user_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `comments_target_idx` ON `comments` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`phone` text,
	`address_json` text,
	`tax_id_last4` text,
	`is_1099_vendor` integer DEFAULT false NOT NULL,
	`default_account_id` text,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`archived_at` text
);
--> statement-breakpoint
CREATE INDEX `contacts_name_idx` ON `contacts` (`name`);--> statement-breakpoint
CREATE TABLE `csv_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`bank_account_id` text NOT NULL,
	`column_map_json` text NOT NULL,
	`date_format` text NOT NULL,
	`amount_mode` text NOT NULL,
	`sign_convention` text DEFAULT 'positive_is_deposit' NOT NULL,
	`skip_rows` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`bank_account_id`) REFERENCES `bank_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `csv_profiles_bank_account_id_unique` ON `csv_profiles` (`bank_account_id`);--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`bank_account_id` text NOT NULL,
	`source` text NOT NULL,
	`filename` text,
	`file_hash` text,
	`row_count` integer DEFAULT 0 NOT NULL,
	`imported_count` integer DEFAULT 0 NOT NULL,
	`duplicate_count` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`bank_account_id`) REFERENCES `bank_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `invoice_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`description` text NOT NULL,
	`quantity_milli` integer DEFAULT 1000 NOT NULL,
	`unit_price` integer NOT NULL,
	`amount` integer NOT NULL,
	`income_account_id` text NOT NULL,
	`line_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`income_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `invoice_lines_invoice_idx` ON `invoice_lines` (`invoice_id`);--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`number` text NOT NULL,
	`customer_id` text NOT NULL,
	`issue_date` text NOT NULL,
	`due_date` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`subtotal` integer DEFAULT 0 NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`amount_paid` integer DEFAULT 0 NOT NULL,
	`memo` text,
	`terms` text,
	`entry_id` text,
	`recurring_id` text,
	`created_by` text,
	`created_by_actor` text DEFAULT 'user' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`sent_at` text,
	`last_reminder_at` text,
	`voided_at` text,
	FOREIGN KEY (`customer_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_number_uq` ON `invoices` (`number`);--> statement-breakpoint
CREATE INDEX `invoices_customer_idx` ON `invoices` (`customer_id`);--> statement-breakpoint
CREATE TABLE `journal_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`memo` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`source_type` text DEFAULT 'manual' NOT NULL,
	`source_id` text,
	`reverses_entry_id` text,
	`reversed_by_entry_id` text,
	`created_by` text,
	`created_by_actor` text DEFAULT 'user' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`posted_at` text,
	`posted_by` text,
	`lock_override_note` text,
	`chain_seq` integer,
	`prev_hash` text,
	`entry_hash` text,
	CONSTRAINT "journal_entries_status_ck" CHECK("journal_entries"."status" in ('draft','pending_review','posted','rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `journal_entries_chain_seq_uq` ON `journal_entries` (`chain_seq`);--> statement-breakpoint
CREATE INDEX `journal_entries_date_idx` ON `journal_entries` (`date`);--> statement-breakpoint
CREATE INDEX `journal_entries_status_idx` ON `journal_entries` (`status`);--> statement-breakpoint
CREATE INDEX `journal_entries_source_idx` ON `journal_entries` (`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `journal_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`account_id` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`description` text,
	`contact_id` text,
	`line_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "journal_lines_amount_int" CHECK(typeof("journal_lines"."amount") = 'integer')
);
--> statement-breakpoint
CREATE INDEX `journal_lines_entry_idx` ON `journal_lines` (`entry_id`);--> statement-breakpoint
CREATE INDEX `journal_lines_account_idx` ON `journal_lines` (`account_id`);--> statement-breakpoint
CREATE TABLE `org_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`body_md` text NOT NULL,
	`author_actor` text NOT NULL,
	`author_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `org_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`org_id` text NOT NULL,
	`legal_name` text NOT NULL,
	`dba` text,
	`entity_type` text DEFAULT 'single_member_llc' NOT NULL,
	`tax_id_last4` text,
	`address_json` text,
	`base_currency` text DEFAULT 'USD' NOT NULL,
	`fiscal_year_start_month` integer DEFAULT 1 NOT NULL,
	`default_basis` text DEFAULT 'cash' NOT NULL,
	`books_start_date` text,
	`soft_lock_date` text,
	`hard_lock_date` text,
	`invoice_prefix` text DEFAULT 'INV-' NOT NULL,
	`next_invoice_number` integer DEFAULT 1001 NOT NULL,
	`logo_attachment_id` text,
	`review_threshold` integer DEFAULT 250000 NOT NULL,
	`invoice_color` text DEFAULT '#1f3a5f' NOT NULL,
	`payment_instructions` text,
	`default_terms` text DEFAULT 'Net 30' NOT NULL,
	`reminders_enabled` integer DEFAULT false NOT NULL,
	`plaid_env` text,
	`plaid_client_id` text,
	`plaid_secret_enc` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	CONSTRAINT "org_settings_singleton" CHECK("org_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `payment_applications` (
	`payment_id` text NOT NULL,
	`document_type` text NOT NULL,
	`document_id` text NOT NULL,
	`amount` integer NOT NULL,
	`applied_date` text,
	PRIMARY KEY(`payment_id`, `document_type`, `document_id`),
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payment_applications_amount_pos" CHECK("payment_applications"."amount" > 0)
);
--> statement-breakpoint
CREATE INDEX `payment_applications_doc_idx` ON `payment_applications` (`document_type`,`document_id`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`direction` text NOT NULL,
	`contact_id` text NOT NULL,
	`date` text NOT NULL,
	`amount` integer NOT NULL,
	`bank_account_id` text NOT NULL,
	`method` text,
	`reference` text,
	`memo` text,
	`entry_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`voided_at` text,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bank_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payments_amount_pos" CHECK("payments"."amount" > 0)
);
--> statement-breakpoint
CREATE INDEX `payments_contact_idx` ON `payments` (`contact_id`);--> statement-breakpoint
CREATE TABLE `posting_context` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`actor` text NOT NULL,
	`role` text NOT NULL,
	`note` text
);
--> statement-breakpoint
CREATE TABLE `reconciliation_items` (
	`reconciliation_id` text NOT NULL,
	`journal_line_id` text NOT NULL,
	PRIMARY KEY(`reconciliation_id`, `journal_line_id`),
	FOREIGN KEY (`reconciliation_id`) REFERENCES `reconciliations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`journal_line_id`) REFERENCES `journal_lines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reconciliation_items_line_idx` ON `reconciliation_items` (`journal_line_id`);--> statement-breakpoint
CREATE TABLE `reconciliations` (
	`id` text PRIMARY KEY NOT NULL,
	`bank_account_id` text NOT NULL,
	`statement_end_date` text NOT NULL,
	`statement_ending_balance` integer NOT NULL,
	`beginning_balance` integer DEFAULT 0 NOT NULL,
	`cleared_balance` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'in_progress' NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`completed_by` text,
	`completed_at` text,
	`undone_by` text,
	`undone_at` text,
	FOREIGN KEY (`bank_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `recurring_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`name` text NOT NULL,
	`frequency` text NOT NULL,
	`next_date` text NOT NULL,
	`end_date` text,
	`due_days` integer DEFAULT 30 NOT NULL,
	`template_json` text NOT NULL,
	`auto_send` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `review_items` (
	`id` text PRIMARY KEY NOT NULL,
	`item_type` text NOT NULL,
	`item_id` text NOT NULL,
	`proposed_by_actor` text NOT NULL,
	`proposed_by_id` text,
	`reason` text NOT NULL,
	`rationale` text,
	`payload_json` text,
	`original_payload_json` text,
	`amount` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`decided_at` text,
	`decision_note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `review_items_status_idx` ON `review_items` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `review_policy` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`actor` text NOT NULL,
	`condition_json` text DEFAULT '{}' NOT NULL,
	`action` text NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`conditions_json` text NOT NULL,
	`actions_json` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`times_applied` integer DEFAULT 0 NOT NULL,
	`created_by_actor` text DEFAULT 'user' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `schema_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
