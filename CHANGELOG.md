# Changelog

## Unreleased

- YES Bank: type the Login ID and password into the visible fields. The new Oracle JET login page has hidden autofill decoys (#username/#password) that the old selectors picked first, so the Login ID was never entered.
- Kotak: the login is now one screen. The CRN goes in #userName and the password in #credentialInputField (a masked text box), then "Secure login". The old two-step flow remains as a fallback.
- Kotak balance is read as a loan/overdraft: "Withdrawable: ₹x | Outstanding: ₹y". Kotak is left out of savings, FD, family minimum-balance and grand totals, and shows Avail / O/S chips.
- PNB: open the retail login form directly. The landing page's link opens a new tab that the automation never saw. Generic adapters now click a "Retail users" link only when the login form isn't already on screen.

## 0.3.10

- Merge concurrent bank/broker balance observations per account when all other vault records match; preserve login history from both PCs.
- Use timestamp + UUID snapshot IDs and detect collisions in older timestamp-only snapshots instead of silently losing an upload.
- Reserve the vault during restore preparation and block manual sync during bank/broker operations, including logins that start during a network request.
- Keep changes made during keychain access or upload dirty for the next snapshot, using the live DB hash and document references captured with the snapshot.
- Store successful balance fetch times in millisecond UTC precision. Same-time observations use a deterministic tie-break; keep Windows clocks synchronized.
- Upgrade every Windows PC sharing the backup to 0.3.10 before concurrent use. Earlier builds cannot discover the new snapshot directory names. Existing snapshots and encrypted vault files remain readable.

## 0.3.9

- Faster R2 unlock: fetch the newest snapshot first and download older history in small batches.
- Protect documents referenced by remote or bucket-locked snapshots during cleanup.
- Carry encrypted Gmail setup and sign-in between PCs sharing the vault.
- Improve sync on lock/quit, conflict safety copies, restore publication retries, and backup status messages.
- List cloud-only snapshots in Restore and keep dialog actions visible while scrolling.
- Correct the vault cipher documentation to SQLite3MC ChaCha20-Poly1305 and explicitly preserve the existing format.
- Refuse incomplete document backups and restores; roll back a restore if saving its field key fails.
- Add an Electron test runner so encrypted database and restore tests run instead of being skipped.
