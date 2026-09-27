-- Hierarchical chart of accounts (#18): a sub-account carries its top-level account's type,
-- detail type (subtype), and tax line. Nothing here changes a type, so the accounts_type_fixed
-- and accounts_system_key_fixed triggers cannot abort it.

-- 1. Detach sub-accounts that cannot stay where they are: a system account (system accounts are
--    always top level), a parent that no longer exists, or a parent of another type.
UPDATE accounts SET parent_id = NULL
WHERE parent_id IS NOT NULL AND (
  is_system = 1
  OR NOT EXISTS (SELECT 1 FROM accounts p WHERE p.id = accounts.parent_id)
  OR type <> (SELECT p.type FROM accounts p WHERE p.id = accounts.parent_id)
);
--> statement-breakpoint

-- 2. Copy each top-level account's detail type and tax line down its whole subtree.
WITH RECURSIVE tree(id, subtype, tax_line, depth) AS (
  SELECT id, subtype, tax_line, 0 FROM accounts WHERE parent_id IS NULL
  UNION ALL
  SELECT c.id, t.subtype, t.tax_line, t.depth + 1
  FROM accounts c JOIN tree t ON c.parent_id = t.id
  WHERE t.depth < 50
)
UPDATE accounts SET
  subtype = (SELECT t.subtype FROM tree t WHERE t.id = accounts.id),
  tax_line = (SELECT t.tax_line FROM tree t WHERE t.id = accounts.id)
WHERE id IN (SELECT t.id FROM tree t WHERE t.depth > 0);
