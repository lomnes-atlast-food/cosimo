-- Accounting invariants enforced in the database (SPEC §6).
-- Every statement is separated by a drizzle statement breakpoint so the migrator can
-- execute them one by one (trigger bodies contain semicolons).

-- 1. Entries cannot be inserted already posted; they must go draft -> posted so the
--    balance check below runs against their lines.
CREATE TRIGGER je_no_insert_posted BEFORE INSERT ON journal_entries
WHEN NEW.status = 'posted' OR NEW.chain_seq IS NOT NULL OR NEW.entry_hash IS NOT NULL OR NEW.prev_hash IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'invariant: entries must be inserted unposted without chain fields');
END;
--> statement-breakpoint

-- Chain fields can only be set as part of posting.
CREATE TRIGGER je_chain_fields_only_when_posting BEFORE UPDATE ON journal_entries
WHEN OLD.status <> 'posted' AND NEW.status <> 'posted'
  AND (NEW.chain_seq IS NOT NULL OR NEW.entry_hash IS NOT NULL OR NEW.prev_hash IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'invariant: chain fields are set only when posting');
END;
--> statement-breakpoint

-- 12. Rejected entries never post (and never come back).
CREATE TRIGGER je_rejected_final BEFORE UPDATE ON journal_entries
WHEN OLD.status = 'rejected' AND NEW.status <> 'rejected'
BEGIN
  SELECT RAISE(ABORT, 'invariant: rejected entries cannot change status');
END;
--> statement-breakpoint

-- 1, 3, 4, 11. Posting checks: balanced, >= 2 lines, base currency, lock dates, chain continuity.
CREATE TRIGGER je_post_checks BEFORE UPDATE OF status ON journal_entries
WHEN NEW.status = 'posted' AND OLD.status <> 'posted'
BEGIN
  SELECT CASE
    WHEN (SELECT count(*) FROM journal_lines WHERE entry_id = NEW.id) < 2
      THEN RAISE(ABORT, 'invariant: a posted entry needs at least two lines')
    WHEN (SELECT coalesce(sum(amount), 0) FROM journal_lines WHERE entry_id = NEW.id) <> 0
      THEN RAISE(ABORT, 'invariant: entry does not balance')
    WHEN EXISTS (SELECT 1 FROM journal_lines WHERE entry_id = NEW.id
                 AND currency <> (SELECT base_currency FROM org_settings WHERE id = 1))
      THEN RAISE(ABORT, 'invariant: line currency must equal the org base currency')
    WHEN EXISTS (SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id
                 WHERE l.entry_id = NEW.id AND a.is_active = 0)
      THEN RAISE(ABORT, 'invariant: cannot post to an inactive account')
    WHEN (SELECT hard_lock_date FROM org_settings WHERE id = 1) IS NOT NULL
         AND NEW.date <= (SELECT hard_lock_date FROM org_settings WHERE id = 1)
      THEN RAISE(ABORT, 'invariant: entry date is on or before the hard lock date')
    WHEN (SELECT soft_lock_date FROM org_settings WHERE id = 1) IS NOT NULL
         AND NEW.date <= (SELECT soft_lock_date FROM org_settings WHERE id = 1)
         AND NOT EXISTS (SELECT 1 FROM posting_context WHERE actor = 'user' AND role = 'owner'
                         AND note IS NOT NULL AND trim(note) <> '')
      THEN RAISE(ABORT, 'invariant: entry date is on or before the soft lock date')
    WHEN NEW.posted_at IS NULL OR NEW.chain_seq IS NULL OR NEW.prev_hash IS NULL OR NEW.entry_hash IS NULL
      THEN RAISE(ABORT, 'invariant: posting requires chain fields')
    WHEN NEW.chain_seq <> coalesce((SELECT max(chain_seq) FROM journal_entries), 0) + 1
      THEN RAISE(ABORT, 'invariant: chain_seq must extend the ledger chain')
    WHEN NEW.prev_hash <> coalesce(
           (SELECT entry_hash FROM journal_entries WHERE chain_seq = NEW.chain_seq - 1),
           (SELECT value FROM schema_meta WHERE key = 'ledger_genesis'))
      THEN RAISE(ABORT, 'invariant: prev_hash must equal the current ledger chain head')
  END;
END;
--> statement-breakpoint

-- 2. Posted entries are immutable except for linking the reversing entry once.
CREATE TRIGGER je_posted_immutable BEFORE UPDATE ON journal_entries
WHEN OLD.status = 'posted'
BEGIN
  SELECT CASE
    WHEN OLD.reversed_by_entry_id IS NOT NULL OR NEW.reversed_by_entry_id IS NULL
      OR NEW.id IS NOT OLD.id OR NEW.date IS NOT OLD.date OR NEW.memo IS NOT OLD.memo
      OR NEW.status IS NOT OLD.status OR NEW.source_type IS NOT OLD.source_type
      OR NEW.source_id IS NOT OLD.source_id OR NEW.reverses_entry_id IS NOT OLD.reverses_entry_id
      OR NEW.created_by IS NOT OLD.created_by OR NEW.created_by_actor IS NOT OLD.created_by_actor
      OR NEW.created_at IS NOT OLD.created_at OR NEW.posted_at IS NOT OLD.posted_at
      OR NEW.posted_by IS NOT OLD.posted_by OR NEW.lock_override_note IS NOT OLD.lock_override_note
      OR NEW.chain_seq IS NOT OLD.chain_seq OR NEW.prev_hash IS NOT OLD.prev_hash
      OR NEW.entry_hash IS NOT OLD.entry_hash
    THEN RAISE(ABORT, 'invariant: posted entries are immutable; use a reversal')
  END;
END;
--> statement-breakpoint

CREATE TRIGGER je_posted_no_delete BEFORE DELETE ON journal_entries
WHEN OLD.status = 'posted'
BEGIN
  SELECT RAISE(ABORT, 'invariant: posted entries cannot be deleted; use a reversal');
END;
--> statement-breakpoint

CREATE TRIGGER jl_no_insert_into_posted BEFORE INSERT ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id = NEW.entry_id) = 'posted'
BEGIN
  SELECT RAISE(ABORT, 'invariant: cannot add lines to a posted entry');
END;
--> statement-breakpoint

CREATE TRIGGER jl_currency_on_insert BEFORE INSERT ON journal_lines
WHEN NEW.currency <> (SELECT base_currency FROM org_settings WHERE id = 1)
BEGIN
  SELECT RAISE(ABORT, 'invariant: line currency must equal the org base currency');
END;
--> statement-breakpoint

CREATE TRIGGER jl_posted_no_update BEFORE UPDATE ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id = OLD.entry_id) = 'posted'
  OR (SELECT status FROM journal_entries WHERE id = NEW.entry_id) = 'posted'
BEGIN
  SELECT RAISE(ABORT, 'invariant: lines of posted entries are immutable');
END;
--> statement-breakpoint

CREATE TRIGGER jl_currency_on_update BEFORE UPDATE ON journal_lines
WHEN NEW.currency <> (SELECT base_currency FROM org_settings WHERE id = 1)
BEGIN
  SELECT RAISE(ABORT, 'invariant: line currency must equal the org base currency');
END;
--> statement-breakpoint

CREATE TRIGGER jl_posted_no_delete BEFORE DELETE ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id = OLD.entry_id) = 'posted'
BEGIN
  SELECT RAISE(ABORT, 'invariant: lines of posted entries cannot be deleted');
END;
--> statement-breakpoint

-- 4. Base currency cannot change once anything is posted.
CREATE TRIGGER org_settings_currency_fixed BEFORE UPDATE OF base_currency ON org_settings
WHEN NEW.base_currency <> OLD.base_currency
  AND EXISTS (SELECT 1 FROM journal_entries WHERE status = 'posted')
BEGIN
  SELECT RAISE(ABORT, 'invariant: base currency cannot change after posting');
END;
--> statement-breakpoint

-- 5. Account type integrity.
CREATE TRIGGER accounts_type_fixed BEFORE UPDATE OF type ON accounts
WHEN NEW.type <> OLD.type AND EXISTS (
  SELECT 1 FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
  WHERE l.account_id = OLD.id AND e.status = 'posted')
BEGIN
  SELECT RAISE(ABORT, 'invariant: account type cannot change once it has posted lines');
END;
--> statement-breakpoint

CREATE TRIGGER accounts_system_no_delete BEFORE DELETE ON accounts
WHEN OLD.is_system = 1 OR EXISTS (SELECT 1 FROM journal_lines WHERE account_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'invariant: system accounts and accounts with lines cannot be deleted');
END;
--> statement-breakpoint

CREATE TRIGGER accounts_system_key_fixed BEFORE UPDATE ON accounts
WHEN OLD.is_system = 1 AND (NEW.is_system <> 1 OR NEW.system_key IS NOT OLD.system_key OR NEW.type <> OLD.type)
BEGIN
  SELECT RAISE(ABORT, 'invariant: system accounts keep their type and key');
END;
--> statement-breakpoint

-- 10, 11. Audit log is append-only and chained.
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'invariant: audit log is append-only');
END;
--> statement-breakpoint

CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'invariant: audit log is append-only');
END;
--> statement-breakpoint

CREATE TRIGGER audit_chain_extend BEFORE INSERT ON audit_log
BEGIN
  SELECT CASE
    WHEN NEW.seq <> coalesce((SELECT max(seq) FROM audit_log), 0) + 1
      THEN RAISE(ABORT, 'invariant: audit seq must extend the audit chain')
    WHEN NEW.prev_hash <> coalesce(
           (SELECT hash FROM audit_log WHERE seq = NEW.seq - 1),
           (SELECT value FROM schema_meta WHERE key = 'audit_genesis'))
      THEN RAISE(ABORT, 'invariant: audit prev_hash must equal the current audit chain head')
  END;
END;
--> statement-breakpoint

-- Checkpoints are append-only (only the exported_to marker may be filled in).
CREATE TRIGGER checkpoints_append_only BEFORE UPDATE ON chain_checkpoints
WHEN NEW.chain IS NOT OLD.chain OR NEW.seq IS NOT OLD.seq OR NEW.head_hash IS NOT OLD.head_hash
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'invariant: checkpoints are append-only');
END;
--> statement-breakpoint

CREATE TRIGGER checkpoints_no_delete BEFORE DELETE ON chain_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'invariant: checkpoints are append-only');
END;
--> statement-breakpoint

-- Genesis values are fixed once written.
CREATE TRIGGER schema_meta_genesis_fixed BEFORE UPDATE ON schema_meta
WHEN OLD.key IN ('ledger_genesis', 'audit_genesis', 'org_id')
BEGIN
  SELECT RAISE(ABORT, 'invariant: chain genesis is fixed');
END;
--> statement-breakpoint

CREATE TRIGGER schema_meta_genesis_no_delete BEFORE DELETE ON schema_meta
WHEN OLD.key IN ('ledger_genesis', 'audit_genesis', 'org_id')
BEGIN
  SELECT RAISE(ABORT, 'invariant: chain genesis is fixed');
END;
--> statement-breakpoint

-- 7.4 Completed reconciliations are locked.
CREATE TRIGGER recon_items_locked_insert BEFORE INSERT ON reconciliation_items
WHEN (SELECT status FROM reconciliations WHERE id = NEW.reconciliation_id) = 'completed'
BEGIN
  SELECT RAISE(ABORT, 'invariant: completed reconciliations are locked');
END;
--> statement-breakpoint

CREATE TRIGGER recon_items_locked_delete BEFORE DELETE ON reconciliation_items
WHEN (SELECT status FROM reconciliations WHERE id = OLD.reconciliation_id) = 'completed'
BEGIN
  SELECT RAISE(ABORT, 'invariant: completed reconciliations are locked');
END;
--> statement-breakpoint

CREATE TRIGGER recon_locked_update BEFORE UPDATE ON reconciliations
WHEN OLD.status = 'completed' AND NOT (NEW.status = 'undone'
  AND NEW.statement_end_date IS OLD.statement_end_date
  AND NEW.statement_ending_balance IS OLD.statement_ending_balance
  AND NEW.cleared_balance IS OLD.cleared_balance)
BEGIN
  SELECT RAISE(ABORT, 'invariant: completed reconciliations are locked (undo only)');
END;
