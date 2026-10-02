# Backup and restore review — 2 October 2026

Reviewed GitHub main at `29c1cee` (v0.3.8), without accessing real vault data.
Cloudflare R2 support is already merged. The older main checkout at v0.3.7 has
four modified files whose differences disappear when end-of-line whitespace is ignored.

## Recommendation

Use a private R2 Standard bucket for direct encrypted uploads, retaining a local
cache and a separate disconnected USB archive. Scope object credentials to one
bucket; protect the Cloudflare owner account with MFA. Apply a 30-day bucket lock
to the backup prefix. A lock protects objects during retention, not the owner's
ability to change bucket policy. Confirm retained-history size before assuming
the 10 GB-month free allowance is sufficient.

Keep the existing Drive history until a synthetic restore on a fresh Windows
profile proves recovery of records, encrypted fields and documents. Switch every
PC together: folder and R2 targets do not synchronize with each other. Keep the
master password and instructions for accessing the bucket recoverable separately
from the PC. Losing the password makes encrypted backups unrecoverable.

## Current policy and strengths

- A sync pass runs every 30 seconds while the app is unlocked; snapshots are
  created when data changes. Lock/exit attempts a final flush. This is not a
  background backup service when the app is closed.
- Retention keeps all snapshots for two hours, hourly for 24 hours, daily for
  seven days, weekly for 30 days and monthly for six months, always retaining
  the newest snapshot.
- Snapshot manifests are uploaded last. Local cache survives a wholly empty
  bucket. Upload failures are reported and retried.
- Restore checks database size/hash and integrity before swapping the live
  database, and preserves pre-restore sidecars.
- The field key is backed up encrypted under the password-derived master key.
  Consequently, the complete backup plus master password is sufficient to
  decrypt credentials on another PC. README claims requiring the original OS
  keychain do not describe backup security accurately.
- Manifests expose document names, host names and sizes in plaintext. Current
  cipher documentation also needs reconciliation with the separate Claude
  cipher-audit branch; this review does not certify the advertised cipher.

## Gaps to resolve before relying on R2 alone

1. **Missing documents do not fail restore.** `engine.ts:995` silently skips
   missing blobs; `replicator.ts` similarly skips missing upload/download blobs
   while accepting/publishing the manifest. Require every referenced blob and
   authenticate its encrypted contents before declaring the snapshot complete
   or replacing the live vault.
2. **Partial remote deletion propagates locally.** `replicator.ts:214` deletes
   previously synchronized local snapshots missing remotely whenever even one
   complete remote snapshot remains. The empty-bucket safeguard does not cover
   a selective wipe. Use explicit authenticated prune records or independent
   local retention rather than interpreting remote absence as authorization.
3. **The extra copy mirrors pruning.** `refreshMirror` calls `copyBackupTree`
   with `prune: true`. It is useful redundancy, but should be complemented by
   an offline archive whose deletion policy is independent of synchronization.
4. **Keychain failure is outside database rollback.** `engine.ts:1064` writes
   the restored field key after swapping the database; failure can leave the
   new vault installed with the old keychain value. Include key replacement
   in the restore transaction/rollback and test failed credential-store writes.
5. **Success timestamps need clear meaning.** Snapshot creation records
   `lastBackupAt` even when R2 upload fails. Present local snapshot time and
   confirmed remote upload time separately.

## Verification limits

Static review only for the live service: no bucket credentials used, no real
vault opened, no deployment, merge or release performed. The default test run
cannot start under the available Linux Node 18.20.8 because the installed test
runner requires `node:util.styleText`. A Node 22 retry also failed at startup:
the Windows dependency tree lacks `@rolldown/binding-linux-x64-gnu`. No test
results are claimed; a Windows recovery drill remains required.

References: https://developers.cloudflare.com/r2/buckets/bucket-locks/,
https://developers.cloudflare.com/r2/pricing/,
https://developers.cloudflare.com/r2/reference/data-security/.
