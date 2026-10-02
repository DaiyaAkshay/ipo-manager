# Changelog

## 0.3.9

- Faster R2 unlock: fetch the newest snapshot first and download older history in small batches.
- Protect documents referenced by remote or bucket-locked snapshots during cleanup.
- Carry encrypted Gmail setup and sign-in between PCs sharing the vault.
- Improve sync on lock/quit, conflict safety copies, restore publication retries, and backup status messages.
- List cloud-only snapshots in Restore and keep dialog actions visible while scrolling.
- Correct the vault cipher documentation to SQLite3MC ChaCha20-Poly1305 and explicitly preserve the existing format.
- Refuse incomplete document backups and restores; roll back a restore if saving its field key fails.
- Add an Electron test runner so encrypted database and restore tests run instead of being skipped.
