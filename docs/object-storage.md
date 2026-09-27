# Object storage

Cosimo can put attachments (`storage.kind = "s3"`) and backups (`backups.mode = "s3"`) in any
S3-compatible bucket, through [Bun's built-in S3 client](https://bun.sh/docs/api/s3). There is no
provider-specific code: everything goes through the `storage.s3_*` settings (`s3_endpoint`,
`s3_bucket`, `s3_region`, `s3_access_key`, `s3_secret_key`), whichever provider they point at.
Attachments and backups share one bucket and one set of credentials; they're told apart by key
prefix.

## What lives where

| What | Key | Written by | Deleted by |
|---|---|---|---|
| An attachment | `<orgId>/<ulid>` | uploading a receipt, bill, or other attachment | never (the app is append-only; see below) |
| A backup | `backups/cosimo-backup-<timestamp>.zip` | `cosimo backup` (manual or the nightly job) | backup retention (`keep_daily`/`keep_weekly`/`keep_monthly`), or you |
| A doctor probe | `doctor/probe-<timestamp>` | `cosimo doctor`'s bucket check | the same check, right after |

**The app never deletes attachments.** The only place that calls delete on an attachment key is the
doctor storage probe, and that only touches its own probe object. Everything under an org's prefix
is safe to treat as append-only. The only things Cosimo itself deletes from the bucket are old
backups (retention) and its own doctor probes.

Every setting can also come from the environment as `COSIMO_STORAGE_S3_<KEY>` (for example
`COSIMO_STORAGE_S3_BUCKET`), which is how Fly and Docker deployments usually supply it — the
secret key in particular should never sit in the config file on a shared host.

## Providers

Cosimo doesn't care which of these you use; pick based on cost, region, and what you already run.

| Provider | Endpoint | Region | Credentials | Minimum permissions |
|---|---|---|---|---|
| AWS S3 | `https://s3.<region>.amazonaws.com` | the bucket's AWS region | an IAM user's access key | `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket` on the bucket |
| Google Cloud Storage | `https://storage.googleapis.com` | the bucket's location (e.g. `us-central1`), lowercased | an HMAC key for a service account (Cloud Storage → Settings → Interoperability, or `gcloud storage hmac create`) | `roles/storage.objectAdmin` on the bucket (or a custom role with get/create/delete/list) |
| Cloudflare R2 | `https://<account_id>.r2.cloudflarestorage.com` | `auto` | an R2 API token (Object Read & Write, scoped to the bucket) | Object Read & Write on the bucket |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | the bucket's region (e.g. `us-west-004`, shown next to the bucket) | an application key scoped to the bucket | Read and Write (and List) on that bucket |
| MinIO (self-hosted) | your server's URL | any non-empty value MinIO accepts (it doesn't enforce AWS regions) | an access key from an IAM-style policy | read/write/delete/list on the bucket |

GCS and B2 both speak the S3 API through a compatibility layer (GCS's is the XML API), which is why
they work here with no special code. For anything not listed, if it advertises S3 compatibility and
HMAC-style credentials, it should work the same way; `cosimo doctor` (below) is how you find out.

`cosimo init` and `cosimo config set storage.s3_region` don't validate the region string against a
provider's list, so a typo shows up as a failed `cosimo doctor` check, not a rejected answer.

## Protecting the bucket

The app's own writes are append-only (see above), so the risk to guard against is deleting the
wrong thing by hand, or an attacker with stolen credentials doing the same. The recommended setup,
for every provider above:

1. **Versioning on.** A delete or overwrite keeps the previous version instead of losing it.
2. **A short retention window for accidents:**
   - GCS: turn on **soft delete** (a bucket-level setting, independent of versioning) with a window
     like 90 days. Deleted objects are recoverable for that long with no lifecycle rule needed.
   - S3, R2, B2, MinIO: enable versioning and add a lifecycle rule that expires **noncurrent**
     versions after some number of days (or years, for compliance retention). Never expire the
     *current* version — that would defeat the point.
3. **Do not put a locked retention policy on the backup prefix** (S3 Object Lock in compliance
   mode, an R2 bucket lock, a locked GCS retention policy, or the equivalent). Cosimo's backup
   retention has no off switch, and setting the `keep_*` counts to 0 does not turn it off; it marks
   every backup for deletion. Under a lock those deletes fail, so `cosimo backup` reports a
   **warning** on every run (the backup itself still succeeds; see below) and the bucket keeps
   growing. `cosimo doctor`'s bucket check reports this as a failed delete. If you do want a lock,
   make it shorter than the youngest backup retention could remove (under 14 days with the default
   `keep_daily`), so it has always expired by the time Cosimo prunes.

Versioning with a noncurrent-version lifecycle rule (plus soft delete on GCS) protects against
accidental deletes without that conflict. Cosimo's pruning only turns a backup into a noncurrent
version, which the lifecycle rule keeps for as long as you choose. It doesn't stop someone holding
the keys from purging versions deliberately; for that you need a lock and the trade-off above.

## Backup retention across a bucket

`cosimo backup` (or the nightly job) uploads the ZIP, then applies retention: it lists everything
under `backups/`, works out what to keep with the same daily/weekly/monthly rule as local mode, and
deletes the rest. If the list or a delete fails — most likely a retention lock, but it could be any bucket
error — that key is skipped, not fatal: the backup you just took is still recorded as successful,
and the failure is reported as a **warning** (`cosimo backup` prints it; `BackupResult.warnings`
for anything scripting against it). The unpruned backup is picked up again next time.

## `cosimo doctor` in bucket mode

Two checks apply when `backups.mode = "s3"`:

- **`backups`**: freshness, from the last recorded backup (`last_backup` in instance settings), not
  a directory listing — there's no local directory to look at in bucket mode.
- **`backup_bucket`**: writes a small probe object under `doctor/`, lists that prefix to confirm the
  write is visible, then deletes it. This is deliberately the same three operations backup and
  retention use (write, list, delete), because providers differ most on `list` (`ListObjectsV2`) —
  a provider that works fine for the doctor's plain `storage` probe (put/get/delete) can still fail
  here. A failed delete gets a remediation pointing at a possible retention lock (see above); a
  failed list says the bucket needs `ListObjectsV2` support, which retention depends on.

## Moving an existing install into a bucket

An install that started with local attachments doesn't have to stay that way:

1. Configure `storage.s3_*` (`cosimo config set` or the environment) — you can do this while
   `storage.kind` is still `local`; only `cosimo move-attachments` and `cosimo doctor` read them
   until you flip the switch.
2. Run `cosimo move-attachments` (optionally `--dry-run` first). It copies every file under
   `storage.dir` into the bucket under the same key, skips anything already there with a matching
   size, and verifies every new copy by reading it back and checking its sha256. **It never deletes
   the local files.** It's safe to run while the server is up, since attachments are append-only.
3. Set `storage.kind = s3` (or `COSIMO_STORAGE_KIND=s3`) and restart.
4. Run `cosimo move-attachments` again to catch anything written to local storage in the moment
   between the copy and the restart.
5. `cosimo doctor` should now show `storage` passing against the bucket. The old local files are
   still on disk — nothing deletes them for you; once you've verified attachments open correctly,
   they're yours to archive or remove.

If you're also moving backups to the bucket (`backups.mode = "s3"`), no migration step is needed:
the next backup lands in the bucket, and `cosimo backup list` reads whichever mode is configured.

## Restoring from a bucket

`cosimo restore` only ever reads a local file — it doesn't reach into a bucket itself. To restore a
backup that lives in one:

```sh
cosimo backup list                          # find the name
cosimo backup download cosimo-backup-<timestamp>.zip
cosimo restore cosimo-backup-<timestamp>.zip
```

`backup download` validates the name and defaults to writing into `backups.dir`; `-o <path>` picks
somewhere else. `cosimo restore` given a bare backup name looks in the working directory first,
then in `backups.dir`. If it's in neither, the error suggests `cosimo backup download`.

`cosimo restore` itself needs no passphrase: the databases it writes back still hold their secrets
encrypted with the original master key, so restoring works as long as your config's master key
matches the backed-up instance's. What the passphrase unlocks is `secrets.enc` inside the ZIP
(present when `backups.include_secrets = true` and `COSIMO_BACKUP_PASSPHRASE` was set at backup
time) — a copy of that master key and a few other secrets that don't round-trip through the org
databases. This matters most for a bucket backup: if the instance it came from is gone along with
its config file, `secrets.enc` (decrypted with `decryptWithPassphrase` and the passphrase) is how
you recover the master key needed to read everything else. There's no CLI command for decrypting
it yet; keep the master key in a password manager as well.
