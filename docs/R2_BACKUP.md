# Backup to Cloudflare R2

Backups can go straight to a Cloudflare R2 bucket instead of a Google Drive / OneDrive folder.
The old setup depended on the Drive desktop app staying installed, running and signed in on every
PC. When it didn't, backups silently stopped. R2 removes that dependency.

## What is uploaded

Exactly what went into the Drive folder, and it is all encrypted on the PC before upload:

| Object | Protected by |
|--------|--------------|
| `snapshots/<id>/vault.db` | SQLCipher, key = Argon2id(master password) |
| `snapshots/<id>/field-key.bin` | AES-256-GCM with the master key |
| `blobs/<uuid>.enc` | AES-256-GCM with the field key |
| `snapshots/<id>/vault.meta.json` | not secret (Argon2 salt + parameters) |
| `snapshots/<id>/manifest.json` | **plaintext**: document file names, PC host names, sizes, lineage |

Anyone who gets the bucket can try to guess the master password offline. The protections are
Argon2id with 256 MB of memory and a long master password. Keep the API token scoped to this one
bucket.

## One-time setup (Cloudflare dashboard)

1. **R2 → Create bucket**, for example `ipo-manager-backup`. Location: Automatic (or APAC).
2. **Recommended: R2 → bucket → Settings → Bucket lock rules**. Add a rule for prefix
   `ipo-manager/` with a retention of, say, 30 days. A stolen token or a broken PC then can't delete
   recent backups. The app treats refused deletes as normal and retries them later, so old
   snapshots are removed once the lock expires.
3. **R2 → Manage API tokens → Create API token**:
   - Permission: **Object Read & Write**
   - Specify bucket: **only** `ipo-manager-backup`
   - Copy the **Access Key ID** and **Secret Access Key**. The secret is shown once.
4. Note the **Account ID**, shown on the R2 overview page (32 hex characters).

Cost: a vault is tens of MB, which fits in R2's free tier (10 GB of storage, 1M writes and 10M
reads a month, no egress fees). The sync loop makes one list call every 30 s per open PC, which is
far under the limits. A card on the Cloudflare account is required even on the free tier.

## In the app (on every PC)

Backup & Sync → **Cloudflare R2** → enter the Account ID, bucket, Access Key ID and Secret Access
Key, then click **Test connection** and **Use Cloudflare R2**.

- **First PC:** leave "Upload the existing backup history" ticked. The Drive folder's snapshots are
  uploaded, so history and sync lineage carry on unbroken.
- **Other PCs:** this can stay ticked or not; either works. Switch **every** PC. A PC still on the
  Drive folder no longer sees changes from R2 PCs, and the reverse is also true.
- The secret is stored in Windows Credential Manager, never in `backup.config.json`.

**Extra copy (optional):** pick a USB disk or NAS folder. After every upload the full encrypted
history is copied into `IPO Manager backup copy` inside that folder. To restore from it, use
Restore → choose that subfolder.

## How it works

`backup/replicator.ts` keeps `%APPDATA%\ipo-manager\data\r2-cache` in step with the bucket. The
engine (`backup/engine.ts`) uses that cache folder exactly as it used the Drive folder, so the
sync rules in `backup/syncPolicy.ts` are unchanged. These cover lineage, the dirty hash, conflicts
and retention. The cache also gives each PC a full local copy of the backup history.

Safety rules (tested in `tests/backup/replicator.test.ts`):

- `manifest.json` is uploaded last, and a snapshot's documents are uploaded before its manifest.
  R2 is strongly consistent, so "manifest exists" means "complete".
- Another PC's upload in progress appears as an empty folder in the cache. The engine reports it
  as pending and does not build on an older snapshot.
- Deletes only follow snapshots both sides were known to have. Nothing local is deleted when the
  bucket looks empty, for example with a wrong prefix or a wiped bucket.
- A pruned snapshot is remembered and never downloaded again, even while a bucket lock refuses the
  delete.
- A remote document is deleted only after it has gone unreferenced for 24 h.
- Offline: data stays on the PC, the status pill shows "R2 offline — retrying", and sync resumes
  by itself.

## Switching back

Backup & Sync → Folder → **Use this folder instead of R2**. The bucket is left untouched.
