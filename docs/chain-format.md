# Chain format (v1)

Cosimo keeps two append-only hash chains per organization (SPEC §6.5):

- the **ledger chain**: one link per posted journal entry, stored on `journal_entries` (`chain_seq`, `prev_hash`, `entry_hash`);
- the **audit chain**: one link per audit log row, stored on `audit_log` (`seq`, `prev_hash`, `hash`).

## Tamper-evident, not tamper-proof

The chains make changes to history **detectable**, not impossible. Anyone with full write access to
the database file can rewrite every row *and* recompute every hash, producing a chain that verifies
on its own. What they cannot do is make that rewritten chain match a chain head recorded somewhere
they don't control: a checkpoint emailed to the owner or written to backup storage, the head hash
printed in the footer of a report a CPA already holds, or the year-end package. Keep copies of
checkpoints outside the database if you need to prove the books were not rewritten.

## Hash function

`hash = lowercase_hex( SHA-256( UTF8( prev_hash_hex || canonical_json(payload) ) ) )`

`||` is string concatenation: the 64-character lowercase hex of the previous link's hash followed by
the canonical JSON text, encoded as UTF-8 and hashed once.

The first link uses a genesis value derived from the org ID:

- ledger: `SHA-256("cosimo:ledger:genesis:v1:" + org_id)`
- audit: `SHA-256("cosimo:audit:genesis:v1:" + org_id)`

The genesis values are also stored in `schema_meta` (`ledger_genesis`, `audit_genesis`) and are immutable.

## Canonical JSON

- Object keys sorted by UTF-16 code unit order (all keys are ASCII, so this equals byte order).
- No insignificant whitespace: `{"a":1,"b":[true,null]}`.
- Numbers are integers only (money is integer cents). Floats, NaN, and Infinity are errors. `-0` is written `0`.
- Strings are escaped exactly as ECMAScript `JSON.stringify` does: `"` → `\"`, `\` → `\\`, control
  characters as `\b \f \n \r \t` or `\u00XX`, everything else (including non-ASCII and emoji) as raw UTF-8.
  Python's `json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)` produces
  identical output for these payloads.
- Dates are `YYYY-MM-DD` strings; timestamps are ISO 8601 UTC strings as stored.
- `null` is written for absent optional values; no key is ever omitted.

## Ledger payload

```json
{
  "v": 1, "chain": "ledger", "org_id": "...", "chain_seq": 1,
  "id": "...", "date": "YYYY-MM-DD", "memo": "..." | null,
  "source_type": "manual", "source_id": null, "reverses_entry_id": null,
  "created_by": "..." | null, "created_by_actor": "user",
  "posted_at": "ISO timestamp", "posted_by": "..." | null, "lock_override_note": null,
  "lines": [
    { "id": "...", "account_id": "...", "amount": 12345, "currency": "USD",
      "description": null, "contact_id": null, "line_order": 0 }
  ]
}
```

Lines are sorted by `line_order`, then `id`. `reversed_by_entry_id` is deliberately **not** hashed:
it is the one field set after posting (once) to link the reversing entry, which is itself a new link
in the chain carrying `reverses_entry_id`.

## Audit payload

```json
{
  "v": 1, "chain": "audit", "org_id": "...", "seq": 1, "id": "...", "at": "ISO timestamp",
  "user_id": null, "api_token_id": null, "oauth_client_id": null,
  "actor": "user", "action": "entry.post", "target_type": "journal_entry", "target_id": "...",
  "before_json": "<stored JSON text or null>", "after_json": "<stored JSON text or null>", "ip": null
}
```

`before_json` and `after_json` are hashed as the exact stored strings.

## Database enforcement

Triggers (org migration `0001_invariants.sql`) ensure a new link always has `seq = max + 1` and
`prev_hash` equal to the current head, so nothing can be inserted into the middle of a chain through
the application's connection. SHA-256 itself is computed by the application because SQLite has no
built-in SHA-256; verification recomputes every hash.

## Verification

`cosimo verify <org>` (and the Settings button) walks both chains from genesis and reports the first
broken link: a gap or insertion (`seq` mismatch), a broken back-link (`prev_hash` mismatch), or an
altered record (recomputed hash differs). `cosimo doctor` checks the last 1,000 links of each chain.

## Checkpoints

`chain_checkpoints` records the chain head (`seq`, `head_hash`) after each day with activity and at
every lock date change. The ledger head also appears in every report footer and in the year-end package.

## Test vectors

`packages/core/src/chain.vectors.test.ts` contains fixed inputs and expected hashes. CI runs it on
Linux, macOS, and Windows.
