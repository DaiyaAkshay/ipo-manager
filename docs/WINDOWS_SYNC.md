# Windows PC sync (0.3.10)

Use the same Cloudflare R2 bucket and prefix, master password, and shared vault
on every PC. All PCs must run 0.3.10 or later for the new snapshot names.

A successful bank or broker balance refresh stores its value and UTC fetch time.
After local changes settle for 90 seconds, the next 30-second sync poll uploads
an encrypted snapshot. Other unlocked, idle PCs pull it on their next poll;
offline or locked PCs catch up on reconnect/unlock. Transfer time adds to this
roughly two-to-three-minute normal delay.

Two PCs refreshing different accounts keep both updates. If both refresh one
account, the later fetch timestamp wins, even if its balance is smaller.
Same-time updates have a deterministic tie-break. Keep Windows automatic time
synchronization enabled. Login history from both PCs is preserved.

Automatic merging requires all other vault records to match. Concurrent changes
to credentials, families, documents, bids, or portfolio reports still show a
conflict. Resolve those deliberately; the losing local vault remains in its
safety-copy sidecar. Sync never closes a database held by a running bank/broker
operation. Manual Backup now asks you to wait for the operation to finish.

## Rollout from 0.3.9

1. Finish bank/broker operations. On the most up-to-date PC, use Backup now and
   confirm successful upload. Resolve existing conflicts deliberately.
2. Keep an independently retained copy of the encrypted backup. The optional
   mirror follows pruning and is not an independent retention policy.
3. Close IPO Manager on every PC. Install 0.3.10 on all of them before reopening
   shared use; 0.3.9 cannot discover the new UUID-suffixed snapshot directories.
4. Open the source PC, then the other PCs. Check their backup status and verify
   that a synthetic/test-account balance refresh appears on the other PC.
5. If a legacy snapshot ID collision is reported, stop shared writes and retain
   both local caches. It means older builds wrote different contents under one
   name; the app preserves both rather than choosing one silently.

No R2 migration, database re-encryption, or new service subscription is needed.
This change is tested for Windows PCs. Check Android viewer support before using
that viewer with new snapshot directory names.
