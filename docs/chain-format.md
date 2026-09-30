# Chain format (v1)

Cosimo keeps two append-only hash chains per organization (SPEC §6.5):

- the **ledger chain**: one link per posted journal entry, stored on `journal_entries` (`chain_seq`, `prev_hash`, `entry_hash`);
- the **audit chain**: one link per audit log row, stored on `audit_log` (`seq`, `prev_hash`, `hash`).

## Tamper-evident, not tamper-proof

The chains make changes to history **detectable**, not impossible. Anyone with full write access to
the database file can rewrite every row *and* recompute every hash, producing a chain that verifies
on its own. What they cannot do is make that rewritten chain match a chain head recorded somewhere
they don't control: a public timestamp (see [Anchors](#anchors-public-timestamps)), the head hash
printed in the footer of a report a CPA already holds, or the year-end package.

Public timestamps are the part a third party can rely on without trusting the owner: the proofs are
issued by OpenTimestamps (anchored in Bitcoin) and an RFC 3161 timestamp authority, and a rewrite
can't obtain a proof dated before the rewrite. It shows up either as a digest mismatch or as a gap in
coverage. Anchor rows live in the same database, so someone who rewrites the books can also delete
them; what they can't do is replace them with earlier-dated ones. That is why coverage (below)
matters.

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
Checkpoints live in the same database as the chains; the public timestamps below are the copy that
lives elsewhere.

## Anchors (public timestamps)

Once a day, when either chain moved (and on "Timestamp now", `cosimo anchor`, and each year-end
package), Cosimo timestamps both chain heads publicly. Turn it off with `anchoring.enabled = false`
(see [deployment.md](deployment.md#public-timestamps)).

### Preimage and digest

The **anchor preimage** is this text, UTF-8, LF line endings, with a trailing newline:

```
cosimo-anchor v1
org <org_id>
ledger <seq> <hash>
audit <seq> <hash>
```

`<seq>` and `<hash>` are the ledger and audit chain heads (`chain_seq`/`entry_hash` and
`seq`/`hash` of the last link; seq 0 with the genesis hash for an empty chain). The **digest** is
`lowercase_hex(SHA-256(preimage))`. Only the digest leaves the server. Saved as
`anchor-<ledger seq>.txt`, the preimage is the file the proofs below timestamp, so standard tools check
it directly. `chain.vectors.test.ts` has test vectors.

### Proofs

Each proof is one row of `chain_anchors` (`kind`, `service`, the heads, `digest`, `status`, `proof` as
base64, `attested_at`, `block_height`). Rows are append-only: the heads, digest, service and creation
time never change, a pending proof can only become complete or failed, and rows can't be deleted
(triggers in org migration `0009_chain_anchors.sql`).

- **OpenTimestamps** (`kind = 'ots'`, one row per calendar). Cosimo appends a random 16-byte nonce to
  the digest, hashes it, and posts that commitment to the calendar's `/digest`. The proof is a
  standard detached `.ots` file for the preimage: `sha256(file)`, then `append(nonce)`, `sha256`, then
  the calendar's operations ending in a pending attestation. Every 3 hours the server asks the calendar
  (`GET /timestamp/<commitment>`) for the path to a Bitcoin block; once there, it checks the block's
  merkle root with the block explorer (`anchoring.bitcoin_api`) and the row completes with the block
  height and block time. A proof still pending after 7 days is marked failed.
- **RFC 3161** (`kind = 'rfc3161'`). The DER `TimeStampReq` carries a SHA-256 message imprint of the
  digest, a random nonce, and `certReq`. The stored proof is the whole `TimeStampResp` (a `.tsr`
  file). Before storing, Cosimo checks the imprint and nonce, the signed `messageDigest` against the
  `TSTInfo`, the CMS signature over the signed attributes with the embedded certificate, that the
  certificate is for timestamping and valid at `genTime`, and that it chains to a trusted root:
  FreeTSA's (built in) or one in `anchoring.tsa_ca_file`. `attested_at` is the token's `genTime`.

### Checking a proof yourself

You need the preimage (`anchor-<n>.txt`) and a proof: download both from Settings > Integrity >
Independent timestamps, or take them from `anchors/` in a year-end package. None of this needs Cosimo.

1. Check the preimage names the chain heads you care about: `sha256sum anchor-<n>.txt` equals the
   digest, and the `ledger`/`audit` lines match `entry_hash` at `chain_seq` n and `hash` at that
   audit `seq` in an export of the books ([export-format.md](export-format.md)). Recompute the chain
   up to those links as described above.
2. OpenTimestamps: install the reference client (`pip install opentimestamps-client`). A pending
   proof completes with `ots upgrade anchor-<n>.txt.ots`. With a Bitcoin node (`--bitcoin-node` or a
   local `bitcoind`), `ots verify anchor-<n>.txt.ots` checks the proof against the block and prints
   its time. Without one, `ots info anchor-<n>.txt.ots` ends with the block height and "Bitcoin block
   merkle root"; compare that with the block's `merkle_root` on any explorer (for example
   `https://blockstream.info/api/block-height/<height>`, then `/api/block/<hash>`).
3. RFC 3161: fetch the authority's root yourself (for FreeTSA, `https://freetsa.org/files/cacert.pem`
   and `https://freetsa.org/files/tsa.crt`) and run
   `openssl ts -verify -data anchor-<n>.txt -in anchor-<n>.tsr -CAfile cacert.pem -untrusted tsa.crt`.
   `openssl ts -reply -in anchor-<n>.tsr -text` shows the time.

The proof then shows the books through ledger link n existed in that form by the stated time.

### Verification and coverage

`cosimo verify` (and Settings > Verify) checks every stored anchor that isn't failed:

- its ledger and audit hashes still equal the chains' hashes at those sequence numbers;
- its digest is the digest of its preimage;
- its proof commits to that digest (OpenTimestamps replay; the RFC 3161 checks above, including the
  trusted root), and a complete OpenTimestamps proof has a Bitcoin attestation at the stored height;
- with network access (the CLI default; `--offline` skips it, and so does the Settings button), each
  Bitcoin attestation matches its block's merkle root and time from `anchoring.bitcoin_api`. If the
  explorer can't be reached, this is reported as not checked and doesn't fail verification.

Any mismatch fails verification. **Coverage** is reported, never a failure:

- `anchored_through`: the furthest ledger link a complete proof covers, and the earliest time a proof
  shows for it;
- `earliest_anchor_at`: the first timestamp;
- `unanchored_links`: ledger links after `anchored_through` (normally only today's);
- `late_entries`: entries whose first covering proof is more than 48 hours after their `posted_at`.

`posted_at` is itself in the database, so `late_entries` only helps against careless edits. The signal
a verifier should read is the anchor timeline: a business that has used Cosimo for three years should
have proofs going back three years. Books whose first timestamp is last week have only been
timestamped since last week, whatever their entries' dates say.

## Test vectors

`packages/core/src/chain.vectors.test.ts` contains fixed inputs and expected hashes, including the
anchor preimage and digest. CI runs it on Linux, macOS, and Windows.
