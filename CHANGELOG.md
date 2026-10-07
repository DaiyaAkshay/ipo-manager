# Changelog

## Unreleased

- Market Watch page (sidebar → Tools): open and upcoming NSE mainboard IPOs (SME issues are left out on purpose) with category-wise subscription, unofficial GMP (ipowatch.in, can be switched off), a transparent APPLY / CONSIDER / AVOID / WAIT checklist and rough retail allotment odds.
- Upcoming bonus, rights and split ex-dates with the last day to buy (T+1), plus board meetings proposing bonus, rights or preferential issues.
- Shareholder-quota picks: NSE-detected shareholder reservations and a local watchlist (parent symbol, subsidiary IPO, RHP date) that tells you which parent share to buy in each demat and by when. Stored in `data/market.json`, outside the vault; does not sync.
- AU Bank: reload past the "Session Expired" login interstitial; recognise the new CAPTCHA refresh control; stop the direct `iposmart.au.bank.in` fallback (root is now a 404 and deep links reject without the netbanking hand-off) and report the hand-off error instead; look for the "Service Request" menu.

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
