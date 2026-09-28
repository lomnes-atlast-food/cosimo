-- Recurring templates (#24): one table for recurring invoices, bills, and journal entries, plus a
-- run table that makes each occurrence idempotent and links generated documents back. Existing
-- recurring invoices move over with the same IDs, and the old table is dropped.

CREATE TABLE `recurring_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`contact_id` text,
	`run_mode` text DEFAULT 'draft' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`unit` text NOT NULL,
	`interval` integer DEFAULT 1 NOT NULL,
	`anchor_day` integer,
	`start_date` text NOT NULL,
	`end_date` text,
	`max_occurrences` integer,
	`next_index` integer DEFAULT 0 NOT NULL,
	`next_date` text,
	`last_run_date` text,
	`last_error` text,
	`last_error_at` text,
	`template_json` text NOT NULL,
	`created_by_actor` text DEFAULT 'user' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recurring_templates_due_idx` ON `recurring_templates` (`status`,`next_date`);--> statement-breakpoint
CREATE TABLE `recurring_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`occurrence_index` integer NOT NULL,
	`scheduled_date` text NOT NULL,
	`status` text NOT NULL,
	`doc_type` text,
	`doc_id` text,
	`send_status` text DEFAULT 'not_needed' NOT NULL,
	`error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `recurring_templates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recurring_runs_template_date_uq` ON `recurring_runs` (`template_id`,`scheduled_date`);--> statement-breakpoint
CREATE INDEX `recurring_runs_doc_idx` ON `recurring_runs` (`doc_type`,`doc_id`);--> statement-breakpoint
CREATE INDEX `recurring_runs_send_idx` ON `recurring_runs` (`send_status`);--> statement-breakpoint
ALTER TABLE `bills` ADD `recurring_id` text;--> statement-breakpoint

-- 1. Copy each recurring invoice. The old schedule stepped from the previous date, so the next
--    date becomes the new start (occurrence 0). Frequencies map to a unit and interval; auto-send
--    becomes post_and_send, otherwise draft. A template past its end date has ended.
INSERT INTO `recurring_templates` (
  `id`, `kind`, `name`, `contact_id`, `run_mode`, `status`, `unit`, `interval`, `anchor_day`,
  `start_date`, `end_date`, `max_occurrences`, `next_index`, `next_date`, `last_run_date`,
  `template_json`, `created_by_actor`, `created_at`, `updated_at`
)
SELECT
  r.id,
  'invoice',
  r.name,
  r.customer_id,
  CASE WHEN r.auto_send THEN 'post_and_send' ELSE 'draft' END,
  CASE
    WHEN r.end_date IS NOT NULL AND r.next_date > r.end_date THEN 'ended'
    WHEN r.is_active THEN 'active'
    ELSE 'paused'
  END,
  CASE r.frequency WHEN 'weekly' THEN 'week' WHEN 'yearly' THEN 'year' ELSE 'month' END,
  CASE r.frequency WHEN 'quarterly' THEN 3 ELSE 1 END,
  NULL,
  r.next_date,
  r.end_date,
  NULL,
  0,
  CASE WHEN r.end_date IS NOT NULL AND r.next_date > r.end_date THEN NULL ELSE r.next_date END,
  (SELECT max(i.issue_date) FROM invoices i WHERE i.recurring_id = r.id),
  json_object(
    'memo', json_extract(r.template_json, '$.memo'),
    'terms', json_extract(r.template_json, '$.terms'),
    'due_days', r.due_days,
    'lines', json(coalesce(json_extract(r.template_json, '$.lines'), '[]'))
  ),
  'user',
  r.created_at,
  r.created_at
FROM recurring_invoices r;
--> statement-breakpoint

-- 2. Record the invoices each template already created as runs, so the history shows them and
--    they link back. They predate the new start, so their indexes count back from -1. A manual
--    edit could have left two invoices on one date; the unique (template, date) key keeps the first.
INSERT OR IGNORE INTO `recurring_runs` (
  `id`, `template_id`, `occurrence_index`, `scheduled_date`, `status`, `doc_type`, `doc_id`,
  `send_status`, `created_at`
)
SELECT
  i.id,
  i.recurring_id,
  -ROW_NUMBER() OVER (PARTITION BY i.recurring_id ORDER BY i.issue_date DESC, i.created_at DESC, i.id DESC),
  i.issue_date,
  'created',
  'invoice',
  i.id,
  CASE WHEN i.sent_at IS NOT NULL THEN 'sent' ELSE 'not_needed' END,
  i.created_at
FROM invoices i
WHERE i.recurring_id IN (SELECT id FROM recurring_templates)
ORDER BY i.recurring_id, i.issue_date, i.created_at, i.id;
--> statement-breakpoint

-- 3. Heal drift. The old monthly step clamped to short months and then kept the clamped day, so a
--    template started on the 31st slid to the 28th for good. When the first invoice's day is 28 or
--    later and after the current next date's day, anchor on the first invoice's day...
UPDATE `recurring_templates` SET `anchor_day` = (
  SELECT CAST(substr(min(i.issue_date), 9, 2) AS INTEGER) FROM invoices i
  WHERE i.recurring_id = recurring_templates.id
)
WHERE `unit` IN ('month', 'year')
  AND `next_date` IS NOT NULL
  AND (
    SELECT CAST(substr(min(i.issue_date), 9, 2) AS INTEGER) FROM invoices i
    WHERE i.recurring_id = recurring_templates.id
  ) >= 28
  AND (
    SELECT CAST(substr(min(i.issue_date), 9, 2) AS INTEGER) FROM invoices i
    WHERE i.recurring_id = recurring_templates.id
  ) > CAST(substr(`next_date`, 9, 2) AS INTEGER);
--> statement-breakpoint

-- ...and move the next date (the new start) to that day, clamped to its month's length.
UPDATE `recurring_templates` SET
  `next_date` = substr(`next_date`, 1, 8) || printf('%02d', min(`anchor_day`,
    CAST(strftime('%d', `next_date`, 'start of month', '+1 month', '-1 day') AS INTEGER))),
  `start_date` = substr(`next_date`, 1, 8) || printf('%02d', min(`anchor_day`,
    CAST(strftime('%d', `next_date`, 'start of month', '+1 month', '-1 day') AS INTEGER)))
WHERE `anchor_day` IS NOT NULL;
--> statement-breakpoint

DROP TABLE `recurring_invoices`;
