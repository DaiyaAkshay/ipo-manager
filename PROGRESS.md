# IPO Manager — Progress Log

A timestamped record of every meaningful change shipped, organized
oldest → newest. Use this as a changelog and as context when reviewing
the codebase later.

---

## Phase 1 — Foundation (pre-current-session work)

**Vault & data model**
- Encrypted SQLite vault via SQLCipher; master password derives the DB key with Argon2id.
- Tables for families, members, bank accounts, broker accounts, documents, IPO bids, audit log.
- Field-level AES-256-GCM encryption on top of SQLCipher for the most sensitive columns (PAN, Aadhaar, passwords). Field key lives in OS keychain via `keytar`.

**Login automation**
- Playwright-based persistent-context browsers, one profile per (member, bank/broker).
- 9 bank adapters: AU, YES, SBI, KOTAK, ICICI, BOB, PNB, HDFC, AXIS.
- 7 broker adapters: Zerodha, Dhan, Angel One, Mirae, Shoonya, Fyers, Groww.
- Each adapter implements: `login()`, `fetchBalance()`, optional `downloadPortfolioReport()`, optional `prepareIpoBid()` / `submitPreparedIpoBid()`.
- OTP fetching from Gmail via OAuth (googleapis).
- CAPTCHA solving via Anthropic Claude (AU Bank only).

**UI shell**
- React + TypeScript renderer. Dark vault aesthetic, monospace data, Fraunces display font.
- Sidebar with families nav, status pills (Gmail / CAPTCHA AI), tools.
- Main panel: All Members accordion view + per-family deep view.

**Other**
- Excel import/export for bulk member data.
- Per-broker portfolio report parsers (Zerodha / Dhan / Angel).
- BSE-sourced IPO catalog cache.

---

## Phase 2 — UX overhaul (current session)

### Round A — layout repairs and density

- **Lots +/- control** layout fixed (CSS specificity bug — `.form-field input { width:100% }` was overriding the `80px` width set on `.au-lot-input`).
- **Edit mode toggle** — single "Edit" button in the All Members header replaces per-row edit/delete buttons. Less clutter, same functionality.
- **Balance chips** restructured — Savings, FD, Total chips now flow inline with the action buttons (Edit / Chittorgarh / GMP / Refresh All AU / AU IPO) in one wrapping row, instead of stacking on two rows.
- **Sidebar status pills** simplified — single clickable pill per service (Gmail, CAPTCHA AI). Action buttons (Sign in / Clear / Reconnect / Set JSON) moved into the service-config modal footer.
- **Multi-line text** on `.btn-bulk` so "Refresh All AU" doesn't squeeze.
- **Chittorgarh + GMP buttons** moved out of `hasAnyAuBanks` guard — always visible.

### Round B — AU IPO multi-member bidding

- AU IPO dropdown in the All Members header lets you tick multiple members across families to bid for the same issue.
- **Family-level select-all checkbox** with `indeterminate` state (some / all / none selected).
- After picking members, the engine runs the bid prep + review modal per member in sequence.

### Round C — Login splash screen

- After the unlock password is accepted, a 1.8-second splash screen overlays the dashboard while it loads in the background.
- Counter-rotating gold rings around an "IPO" mark, app name fades in below, gold loading bar fills with √t easing (game-style).
- Web Audio API synthesizes a three-note D-major arpeggio (D5 → F#5 → A5) — no audio files needed.
- The Dashboard mounts behind the splash and pre-loads families/members/Gmail/CAPTCHA status. By the time the splash fades, data is ready.

---

## Phase 3 — Adapter reliability

- **Dhan PIN typing too fast** — `keyboard.type(digits, { delay: 0 })` was typing all 6 digits in one microtask; Dhan's auto-advance handler couldn't keep up → garbled PIN. Bumped to `delay: 60ms`.
- **Angel MPIN slow** — `delay: 5ms` was too fast for Angel's auto-advance; the multi-box validation step would fail and the adapter fell through to a slow per-digit click+fill loop. Bumped to `delay: 80ms` so the fast path succeeds on first try. Also removed an unnecessary 500ms idle wait before MPIN entry.
- **Dhan portfolio fetching slow** — stacked `waitForTimeout(1000)` calls after every navigation; replaced with `Promise.race` against actual page/popup events, dropped a redundant 800ms wait. Saves ~3-4s per portfolio download.

### Phase 3.5 — Cross-cutting fix: `Cannot find module './automation/browser'`

The lazy-loading `??= require('./automation/browser')` pattern in `ipc.ts` looked clever (defer playwright until needed) but was **broken in production** because electron-vite bundles everything into a single `out/main/index.js` — there is no `out/main/automation/browser.js` file at runtime for `require()` to find. Every broker click + AU IPO action would have thrown this.

Fixed by:
- Converting all 6 lazy `require()` calls to static `import` statements.
- Adding `asarUnpack` to `package.json` for playwright, playwright-core, and all native modules (argon2, better-sqlite3-multiple-ciphers, keytar, pngjs, tesseract.js) — these need to be real files on disk because the OS can't execute them from inside `app.asar`.
- More aggressive Chrome/Edge detection in `getPreferredBrowserExecutablePath()` — now searches per-user `%LOCALAPPDATA%` paths, Chromium, Brave.
- Clearer error message when no browser is found.

---

## Phase 4 — Comprehensive feature batch

### Schema migration
- New `email_password_enc` BLOB column on `members`. Idempotent migration in `db/connection.ts`.

### Backup engine (encrypted incremental)

**Layout on disk:**
```
<backup-root>/
├── meta.json
├── blobs/
│   └── <file_uuid>.enc        ← documents, stored once, referenced by many snapshots
└── snapshots/
    └── 2026-05-20T13-25-00.000Z/
        ├── vault.db           ← SQLCipher snapshot (master-key encrypted)
        ├── vault.meta.json    ← Argon2 salt + params (critical for cross-machine restore)
        ├── field-key.bin      ← field key, AES-256-GCM-encrypted with master key
        └── manifest.json
```

**Behaviors:**
- Incremental — documents (PDFs/JPEGs) only copied to `blobs/` if absent; reused across snapshots.
- Retention bands — keep ALL in last 24h, ONE per day in last 7d, ONE per week in last 30d, ONE per month in last 6mo, prune older.
- Garbage collection — after retention sweep, delete blobs no surviving manifest references.
- Auto-scheduler — fires 10s after unlock, then every 6h. Honors a per-call cooldown (≥4h between successful runs).
- Multi-machine sync — point backup folder at OneDrive/Drive/Dropbox; restore on the second machine from the same folder.

### Backup UI
- Sidebar pill: green if last backup <24h, yellow 24-72h, red >72h, muted if disabled. Spins while syncing.
- Backup settings modal: folder picker, enable/disable auto, Backup Now, Restore...
- Restore dialog: snapshots grouped by Last 24h / Last 7d / Last 30d / Last 6mo bands. "Restore from another machine..." reads from a foreign folder.

### Member edit modal — compact

- PAN / Aadhaar / Email / **Email Password** fields in the same 2-col grid as name/type/DOB/mobile.
- Document softcopies (PAN / Aadhaar / Cheque / Birth Cert) collapsed into **a single horizontal row of pills** with status dots (gray=absent, green=present, gold=pending, red=removed) and minimal `+ / ↻ / ↓ / ✕` icon-buttons.

### Member detail card

- Click any member name (in dashboard or spreadsheet view) → modal opens.
- **Table layout** with minimal padding:
  - Identity table — Name / PAN / Aadhaar / DOB on row 1, Mobile / Email (spans 2 cols) / Email Password on row 2.
  - Banks table — Bank / User ID / Password / Customer ID / Account No. / IFSC.
  - Brokers table — Broker / User ID / Password / Client ID / TOTP / Mobile / Email.
- **Click any cell to copy** to clipboard with toast confirmation. Secrets show as bullets in the UI; clipboard gets the real value.
- Modal widened to 1100px so 7-column broker table fits without horizontal scroll.

### Spreadsheet view

- New "Spreadsheet" entry in the sidebar nav.
- Rows = every member across all families. Columns = Family / Member / Mobile / each bank code with balance / each broker code with portfolio / Savings total / FD total / Grand total.
- Sortable on every column. Filterable by free-text search across name/family/mobile/email. Family dropdown filter.
- Member name → opens detail card.

### Factory reset

- Backup Settings → Danger zone → "Reset everything…"
- Type `RESET` to confirm. Wipes the entire `%APPDATA%\ipo-manager\data\` folder, browser profiles, and all three keychain entries (field key, gmail token, anthropic key). Backup folder is **never** touched.
- Triggers `vault:locked` → app re-checks status → boots into first-time setup screen on the spot.

---

## Phase 5 — Distribution & critical bug fixes

### NSIS installer

- `package.json` build config: `oneClick: false`, `allowToChangeInstallationDirectory: true`, desktop + Start Menu shortcuts, `runAfterFinish: true`. Filename: `IPO-Manager-Setup-0.1.0-x64.exe`.
- ~100 MB. No code signing (paid certs ~$200/yr).

### Bug: schema.sql ENOENT on fresh install

- First-time setup on a fresh PC failed with `ENOENT: no such file or directory, open '…\IPO Manager\src\main\db\schema.sql'`.
- Root cause: electron-vite bundles `.ts`/`.js` but not arbitrary `.sql` assets. The packaged app had no `schema.sql` on disk.
- Fix: inlined the schema as a TypeScript string in `src/main/db/schema.ts`; `connection.ts` imports it. The schema is now part of the JS bundle — no disk read at runtime.

### Bug: cross-machine restore — field key decryption failed

- Restoring on Machine B (different vault meta) failed with "Could not decrypt the field key with the master password" — even though the master password was correct.
- Root cause: Argon2id needs `password + salt`. The salt lives in `vault.meta.json`. Machine A's salt was random; Machine B had its own random salt. Same password + different salt = different key → can't decrypt field-key.bin.
- Fix:
  - `createSnapshot` now copies `vault.meta.json` into every snapshot.
  - `restoreSnapshot` takes the **password** (not a key), reads the snapshot's vault.meta.json, derives the snapshot-era master key, decrypts field-key.bin first (aborts cleanly if password is wrong — no disk changes yet), then copies DB + meta + documents + writes field key to keychain.
  - Added `deriveMasterKeyFromMeta(password, meta)` helper to `crypto/master.ts`.

---

## Phase 6 — Critical audit items closed

### #4 — Manual Lock Now

- `vault:lock` IPC handler: closes DB, wipes in-memory secrets, purges browser sessions, broadcasts `vault:locked`.
- 🔒 Lock button in the sidebar header.
- `Ctrl+L` / `Cmd+L` global keyboard shortcut.

### #2 — Browser session purge

- `purgeBrowserProfiles()` in `automation/browser.ts` closes live contexts then deletes every profile dir under `%APPDATA%\ipo-manager\browser-profiles\`. Retry-after-250ms for profiles Chromium is slow to release.
- Triggered automatically on every lock (manual + auto-lock).
- Manual "Clear browser sessions" button in Backup Settings → Danger zone.

### #3 — CAPTCHA cost guardrails

- New `src/main/ai/usage.ts`: per-day counter, token tracker, daily cap, consent flag, UTC date rollover.
- `canMakeCaptchaCall()` gate before every Anthropic upload: refuses if `CONSENT_REQUIRED` or `DAILY_CAP_REACHED` with a clear log line.
- Token counts pulled from `response.usage.input_tokens` / `output_tokens`. Failed calls counted too.
- Modal section: consent checkbox, daily cap input (0 = unlimited), today/lifetime usage, "Reset today's counter".
- Sidebar pill shows `(N/100)` — red when capped.
- Saving an API key auto-consents (the act of providing a paid key is opt-in).

### #5 — Tests

- `vitest` set up, `npm test` script.
- `tests/_stubs/keytar.ts` — in-memory keychain stub (real keytar needs OS credential manager).
- `tests/crypto/master.test.ts` — 8 tests: 32-byte output, deterministic same-input keys, password-sensitive, salt-sensitive (multi-machine bug), `deriveMasterKeyFromMeta` round-trip, password-strength rules.
- `tests/crypto/field.test.ts` — 7 tests: ASCII / Unicode / long-string round-trip, random IV uniqueness, GCM tamper detection, null handling, `lastN`.
- `tests/backup/engine.test.ts` — 4 tests covering snapshot + cross-salt restore + wrong-password abort. Conditionally skipped under vanilla Node because `better-sqlite3-multiple-ciphers` is compiled against Electron's Node ABI.
- **Result: 18 passing, 4 conditionally skipped.**

---

## Phase 7 — AU browser-window UX tweaks

### In-browser "↻ Balance" refresh button

- After AU login (whenever the Chromium window stays open), a small green **↻ Balance** button is injected bottom-left of the AU dashboard (opposite the bottom-right ⚡ APPLY button).
- Clicking it re-runs the real `fetchBalance` scrape on demand — for when the user transfers funds out to another account and the on-screen / in-app number goes stale — without re-logging in.
- Wiring: in-page button → `page.exposeFunction` binding → `runLogin` callback that re-scrapes, persists the new balance to the DB, and broadcasts `account:balanceUpdated`. The button flashes the fresh figure as confirmation; the dashboard patches it into state live (new `events.onBalanceUpdated` preload channel).
- Generic: implemented via optional `LoginAdapter.injectBalanceRefreshButton`, only wired for AU today. Self-heals via MutationObserver and re-injects after full navigations.

### Quieter CAPTCHA handoff when AI is off

- The "Auto-CAPTCHA failed" / "CAPTCHA field could not be located" banners no longer appear when **no Anthropic API key is configured** — auto-solving never ran, so the banner was misleading noise. New `isCaptchaAiAvailable()` gate guards all three overlay sites (main login, IPO-portal auth, input-not-found). The app still waits for manual CAPTCHA entry; it just doesn't nag.

### Bug: document download opened Documents instead of Downloads

- Clicking a member's PAN/Aadhaar saves the file to the user's Downloads folder, then opens that folder with the file selected. It was instead opening the default **Documents / This-PC** folder.
- Root cause: `openFolderContainingFile` spawned `explorer.exe /select,<path>`. Node's `spawn` auto-quotes the whole arg to `"/select,C:\…\pan (1).pdf"`. Every repeat download produces a spaced filename (`pan (1).pdf`, `pan (2).pdf`, …) via `uniquePath`, and explorer can't parse that quoted form — so it silently falls back to opening the default folder.
- Fix: replaced the manual spawn with Electron's `shell.showItemInFolder(filePath)` (correct quoting + file selection on every platform), with `shell.openPath(dir)` as fallback. Removed the now-unused `spawn` import.

### Auto-update: publish step + manual check affordance

The end-to-end auto-update plumbing already existed (`updater.ts` with
`electron-updater`, `initAutoUpdater()` in `index.ts`, the GitHub `publish`
config, version display, and the download/install banner). Two gaps closed:

- **Publishing.** `build:win` only builds the installer locally — it never
  uploaded to GitHub, so there was no `latest.yml` for the app to find. Added an
  `npm run release` script (`electron-vite build && electron-builder --win --publish always`) and a full [docs/RELEASING.md](docs/RELEASING.md) covering version bump, `GH_TOKEN`, and the draft-publish gotcha. **Verify `build.publish` owner/repo (`DaiyaAkshay/ipo-manager`) matches the real repo** — if wrong, updates are never found.
- **"Am I on the latest?" affordance.** Auto-check runs on launch but showed
  nothing when already current, and the `updater.checkNow` IPC wasn't surfaced.
  Added a ⟳ button next to the sidebar version that triggers a manual check,
  with explicit toast feedback ("You're on the latest version" / "Update
  available" / failure). A `manualUpdateCheckRef` keeps the passive launch check
  silent while giving manual checks real feedback.

### Fix: `balance_fetched_at` only moves on a real read

- Previously the timestamp was bumped after **every** post-login fetch attempt, including when the scrape returned nothing (login OK but couldn't read the number). That reset the UI "age" to "just now" on a balance that hadn't actually been refreshed — making stale numbers look fresh.
- Now `balance_fetched_at` is written **only** alongside a successful balance value, in both paths (post-login fetch and the in-browser ⟳ refresh button). A failed scrape leaves the stored balance and its timestamp untouched, so the displayed age always reflects when the shown number was actually fetched. The refresh button also no longer broadcasts `account:balanceUpdated` on a failed re-fetch.

### New broker: Suresh Rathi Securities

- Added a login adapter for **Suresh Rathi Securities** (`SURESH`) targeting its Meon white-label IPO portal (`ipo.meon.co.in/sureshrathi`) — the IPO-specific login, which is what this app is for. Follows the same fill-and-handoff pattern as the other broker terminals: navigates to the portal, best-effort fills client code / PAN + password via generic selectors, then hands off for manual OTP/CAPTCHA (`otpMode: 'manual'`).
- Wired through: new `automation/sureshRathi.ts`, registered in `automation/registry.ts` (`SURESH`), added to the renderer `BROKERS` list + `BROKER_THUMB` ('SR' initials — no logo, falls back gracefully), and the Excel importer's `BROKER_CODE_MAP` ("suresh" / "suresh rathi" / "rathi" → `SURESH`). Exporter picks it up automatically (reads codes from the DB). `broker_code` is free-text so no schema change was needed.
- If Suresh Rathi is actually used via a different portal (mSauda trading terminal or investwell), only `LOGIN_URL` in the adapter needs changing.

### New broker: Upstox

- Added a login adapter for **Upstox** (`UPSTOX`) targeting the web terminal `pro.upstox.com` (unauthenticated visits redirect into Upstox's mobile → OTP → PIN/DOB 2-factor flow; IPOs are applied from inside the terminal). Same fill-and-handoff pattern: best-effort fills mobile number / user id + password/PIN via generic selectors, then hands off for manual OTP (`otpMode: 'manual'`).
- Wired through: new `automation/upstox.ts`, registered in `registry.ts` (`UPSTOX`), added to renderer `BROKERS` + `BROKER_THUMB` ('UP'), and importer `BROKER_CODE_MAP` ("upstox" / "rksv" → `UPSTOX`).

### Member detail card — reveal passwords

- The click-to-copy member detail card masked passwords / PINs / TOTP secrets as bullets. Added a **👁 Show passwords / 🙈 Hide passwords** toggle in the card header — secrets stay masked by default (shoulder-surfing protection) but can be revealed on demand. Click-copy still copies the real value regardless of reveal state. `maskSecret(label, value, reveal)` gained the reveal flag.

### Audit: cross-PC sync (backup auto-sync on unlock)

Findings and fixes:
- **FIXED — silent divergence under clock skew (the main "less than ideal").** `autoSyncFromBackup` decided "is there newer data?" by comparing the remote snapshot's wall-clock timestamp (source PC's clock) against the local `lastBackupAt` (this PC's clock). When the two machines' clocks differed, a genuinely newer snapshot could carry an older-looking timestamp and never get pulled — the PCs would stay permanently out of sync. Switched to **snapshot-ID identity**: `lastSnapshotId` is the id this machine last created or synced to; if the folder's newest snapshot id differs, pull it. Clock-independent and exact.
- **FIXED — duplicate snapshots after a sync.** After restoring, the old code stamped `lastBackupAt` to the restored snapshot's (often old) timestamp, so the 10s post-unlock auto-backup would immediately re-snapshot identical data whenever that snapshot was >4h old — cluttering the folder and needlessly re-triggering the other PC's sync. Now stamps `lastBackupAt` to *now* after a sync.
- **Open (not fixed) — last-write-wins with no conflict detection.** If both PCs edit while offline, whoever backs up last silently overwrites the other's changes. This is inherent to full-snapshot replace; resolving it needs snapshot lineage / merge, which is a larger design change.
- **Open (not fixed) — `vaultId` is effectively dead.** `getBackupConfig()` mints a *random* vaultId per machine, and it's never validated on restore/sync, so it can't guard against pointing the folder at the wrong vault. Making it meaningful means adopting the folder's existing vaultId when a second machine attaches — deferred to avoid changing setup semantics here.

---

## Phase 8 — Full audit (v0.3.7, 2026-09-26)

### Cross-PC sync rewritten (fixes "data not syncing across devices")

Root cause: sync only ran once at unlock, only pulled when the snapshot id differed, and pushes happened only on the old 4 h backup timer. Nothing tracked whether local data had changed, and nothing recorded which snapshot a PC started from. One PC could keep pushing over the other's changes, or neither PC would push at all.
- **Dirty tracking:** the sha256 of the local DB is compared with `lastSyncedDbHash`.
- **Lineage:** manifests carry `parentSnapshotId`, `ancestors` and `supersedes`. Snapshot ids only increase, even under clock skew. The pure decision logic is in `backup/syncPolicy.ts` (30 unit tests).
- **Decisions:** fast-forward (pull), push, up-to-date, or **conflict**. A conflict shows a modal that asks the user to keep this PC's data or use the other PC's. Nothing is silently overwritten.
- **Timing:** a 30 s sync loop runs while unlocked. Local edits push after 90 s of no further changes, and again on lock, quit and Windows logoff.
- **Safety checks:** STILL_SYNCING checks (size and sha256) stop a PC from restoring a snapshot that Drive has only partly downloaded. Restores swap files atomically and roll back on failure. A password changed on another PC is detected at unlock and adopted.
- The sidebar pill and backup modal now show sync state, the last pull and its source PC, and the last error.

### Gmail re-authentication

- The status check now calls Gmail with the stored token (cached for 30 s) instead of just checking that a token exists. An expired token shows **Reconnect**, with a note that Google expires tokens after 7 days while the OAuth app is in "Testing" mode.
- The loopback flow uses PKCE (S256) and a state check, runs on a random port with a 5-minute timeout, and always shuts its server down. The old refresh token is only replaced after a new one arrives.
- When Gmail auth fails during a login, the app now asks for the OTP manually instead of opening a Google sign-in tab over the bank page. A `gmail:statusChanged` event updates the pill.
- OTP extraction moved to the pure `email/otpParse.ts`. It prefers the code nearest a keyword, handles `123-456` codes, and ignores PIN codes in addresses. It keeps a list of message ids already used and allows 30 s of clock skew.

### Bank/broker logins (checked live)

- RBI's `.bank.in` migration: HDFC, ICICI, Axis, BoB, YES, Kotak and SBI now try the new host first and fall back to the old one (`gotoFirstReachable`). The old YES and Axis hosts no longer resolve.
- SBI handles both the classic and the YONO login pages. Fyers was rewritten for `login.fyers.in`. Shoonya gets a fixed viewport so its ratio-based clicks land correctly.
- AU: fixed username selector, whole-rupee balances, and a crash when `className` is missing. Dhan balances are now sign-aware. Usernames are masked in warnings.
- One balance regex is shared by all adapters (Indian digit grouping, optional paise).

### Other fixes

- CAPTCHA AI: the retired Claude 3.x models were replaced (Sonnet 5 → Sonnet 4.6 → Haiku 4.5). Requests time out after 20 s, and consent migration no longer re-prompts.
- Logs: console lines are copied into `automation.log` with redaction (query strings, digit runs, email local parts).
- Auto-lock is extended to 2 h while an automation browser is open, so an IPO flow isn't cut off halfway.
- Excel import: unknown banks map to `UNKNOWN` instead of silently becoming AU.
- Renderer: fixed the "stale" badge caused by reading UTC as local time. Added error handling to import/export/OTP/delete/recharge. Event listeners now unsubscribe. Added the "All Balances (table)" view.
- Fixed all `tsc --noEmit` errors (the project type-checks cleanly for the first time). The main bundle is back to 537 kB after the google-auth-library import became type-only.

---

## Status snapshot

| Critical audit item                | Status |
|------------------------------------|--------|
| #1 No backup mechanism             | ✅ done (Phase 4) |
| #2 Browser profiles unencrypted    | ✅ done (Phase 6) |
| #3 CAPTCHA upload silent/uncapped  | ✅ done (Phase 6) |
| #4 No manual lock button           | ✅ done (Phase 6) |
| #5 No tests at all                 | ✅ done (Phase 6) |

All 5 audit-critical items shipped. Next sweep is the high-impact 🟡 items: missing DB indexes, log rotation, audit-log UI, auto-update wiring, dashboard.tsx component split. After that, the new features from the audit roadmap (auto-bid scheduler, allotment tracker, tax helper).
