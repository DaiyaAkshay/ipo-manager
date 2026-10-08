# Changelog

## 0.3.14

- Zerodha/Dhan/Angel: after "Save & Open", the broker card shows the downloaded report's portfolio value and time when that is newer than the last login balance. Previously the older login figure always won.
- Dhan: Journal by Dhan has its own login now. The holdings download logs in there (mobile → OTP → PIN) instead of stalling on the login page. A login already on the dashboard (QR scanned, or done by hand) is recognised at once. The "login with mobile" switch is matched more loosely, and diagnostics reach the log.

## 0.3.13

- Kotak balance: click "View balance" to unmask the amounts (and open Loans if needed) before reading Withdrawable / Outstanding. On failure, the log lists the balance-related labels on the page with digits masked.

## 0.3.12

- Removed CAPTCHA auto-solving (no Anthropic API key or usage tracking) and the in-app OTP popup. You type the CAPTCHA in the bank window. OTPs come from Gmail/TOTP when available; otherwise a banner asks you to type the OTP in the bank window.
- Every bank and broker login (HDFC, ICICI, Axis, BoB, PNB, SBI, Kotak, YES, Dhan, mStock, Angel, Zerodha) now waits for you to finish the OTP in the browser before reading the balance. Without the popup they used to read it too early.
- Gmail sign-in dialog: Close/Cancel, Esc, and clear OK / Save & sign in / Reconnect buttons with inline errors.

## 0.3.11

- YES Bank: type the Login ID and password into the visible fields. The new Oracle JET login page has hidden autofill decoys (#username/#password) that the old selectors picked first, so the Login ID was never entered.
- Kotak: the login is now one screen. The CRN goes in #userName and the password in #credentialInputField (a masked text box), then "Secure login". The old two-step flow remains as a fallback.
- Kotak balance is read as a loan/overdraft: "Withdrawable: ₹x | Outstanding: ₹y". Kotak is left out of savings, FD, family minimum-balance and grand totals, and shows Avail / O/S chips.
- PNB: open the retail login form directly. The landing page's link opens a new tab that the automation never saw. Generic adapters now click a "Retail users" link only when the login form isn't already on screen.
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
