-- Public timestamps of the chain heads (#11, SPEC §6.5): OpenTimestamps proofs and RFC 3161 tokens
-- over a digest of both chain heads, so someone without the database can check the books existed by
-- a given time. Rows are append-only like chain_checkpoints (0001_invariants.sql): the heads, digest,
-- service and creation time never change, a pending proof may be completed or marked failed once,
-- and nothing is deleted.

CREATE TABLE `chain_anchors` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`service` text NOT NULL,
	`ledger_seq` integer NOT NULL,
	`ledger_hash` text NOT NULL,
	`audit_seq` integer NOT NULL,
	`audit_hash` text NOT NULL,
	`digest` text NOT NULL,
	`status` text NOT NULL,
	`proof` text,
	`attested_at` text,
	`block_height` integer,
	`reason` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	CONSTRAINT "chain_anchors_kind_ck" CHECK("chain_anchors"."kind" in ('ots','rfc3161')),
	CONSTRAINT "chain_anchors_status_ck" CHECK("chain_anchors"."status" in ('pending','complete','failed'))
);
--> statement-breakpoint
CREATE INDEX `chain_anchors_ledger_idx` ON `chain_anchors` (`ledger_seq`);--> statement-breakpoint
CREATE INDEX `chain_anchors_digest_idx` ON `chain_anchors` (`digest`);
--> statement-breakpoint

CREATE TRIGGER chain_anchors_fixed BEFORE UPDATE ON chain_anchors
WHEN NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind OR NEW.service IS NOT OLD.service
  OR NEW.ledger_seq IS NOT OLD.ledger_seq OR NEW.ledger_hash IS NOT OLD.ledger_hash
  OR NEW.audit_seq IS NOT OLD.audit_seq OR NEW.audit_hash IS NOT OLD.audit_hash
  OR NEW.digest IS NOT OLD.digest OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'invariant: anchors are append-only');
END;
--> statement-breakpoint

-- Only a pending anchor changes (its proof, attempts, error), and only by staying pending or
-- becoming complete or failed. Complete and failed rows are frozen.
CREATE TRIGGER chain_anchors_status BEFORE UPDATE ON chain_anchors
WHEN OLD.status <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'invariant: only a pending anchor can change');
END;
--> statement-breakpoint

CREATE TRIGGER chain_anchors_no_delete BEFORE DELETE ON chain_anchors
BEGIN
  SELECT RAISE(ABORT, 'invariant: anchors are append-only');
END;
