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

## Status snapshot

| Critical audit item                | Status |
|------------------------------------|--------|
| #1 No backup mechanism             | ✅ done (Phase 4) |
| #2 Browser profiles unencrypted    | ✅ done (Phase 6) |
| #3 CAPTCHA upload silent/uncapped  | ✅ done (Phase 6) |
| #4 No manual lock button           | ✅ done (Phase 6) |
| #5 No tests at all                 | ✅ done (Phase 6) |

All 5 audit-critical items shipped. Next sweep is the high-impact 🟡 items: missing DB indexes, log rotation, audit-log UI, auto-update wiring, dashboard.tsx component split. After that, the new features from the audit roadmap (auto-bid scheduler, allotment tracker, tax helper).
