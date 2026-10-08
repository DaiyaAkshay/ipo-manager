# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

IPO Manager is a Windows desktop app (Electron + React + TypeScript) that stores family member banking/broker credentials in a locally encrypted vault and automates login to Indian bank/broker portals for IPO applications. It never submits bids — it hands control back to the user at the bank's IPO page.

## Commands

```bash
npm install          # also downloads Playwright Chromium (~150 MB)
npm run dev          # dev mode (hot reload)
npm run build        # compile to out/
npm run build:win    # Windows NSIS installer → dist/
npm test             # vitest (pure modules: backup/syncPolicy, backup/replicator, email/otpParse, logging redaction)
npx tsc --noEmit     # type-check — keep at 0 errors
```

Keep sync decisions in `backup/syncPolicy.ts` and OTP parsing in `email/otpParse.ts` pure (no Electron/keytar/native imports) so they stay unit-testable.

## Architecture

Three Electron processes with strict isolation:

```
src/main/        — Node process, all privileged logic
src/preload/     — context bridge, exposes window.api to renderer
src/renderer/    — React UI, no Node access
```

### Main process (`src/main/`)

| Module | Role |
|--------|------|
| `index.ts` | App entry, window creation, 5-min auto-lock timer |
| `ipc.ts` | All IPC handlers — the single integration point between renderer and main |
| `crypto/master.ts` | Argon2id KDF → 32-byte vault key (256 MB memory, 4 iters) |
| `crypto/field.ts` | AES-256-GCM field encryption; key lives in Windows Credential Manager via `keytar` |
| `db/connection.ts` | Opens SQLite3MC ChaCha20 DB; pins `cipher='chacha20'`, keys with `x'hex'` text (PBKDF2'd by SQLite3MC) |
| `db/schema.sql` | Source of truth for all tables |
| `automation/browser.ts` | Playwright headed Chromium, per-member-per-bank persistent profile |
| `automation/registry.ts` | Maps bank/broker codes (`AU`, `YES`, `ZERODHA`, …) to adapters + OTP presets |
| `automation/auBank.ts` | Only fully implemented adapter; use as template for new ones |
| `automation/stubs.ts` | All other banks/brokers — just open the login URL, user fills in manually |
| `email/gmail.ts` | Gmail API OAuth (loopback + PKCE) OTP fetcher; throws `GmailAuthError` → callers fall back to manual OTP |
| `backup/engine.ts` | Drive-folder snapshot sync: 30 s loop, dirty-hash + lineage, conflict → user choice (policy in `backup/syncPolicy.ts`) |
| `backup/appSettings.ts` | Carries the Gmail setup between PCs as field-key-encrypted `settings/gmail-<ms>.enc` next to the snapshots (newest wins; decision logic pure + tested) |
| `backup/replicator.ts` + `objectStore.ts` | Cloudflare R2 target: keeps `data/r2-cache` (the engine's root in R2 mode) in step with the bucket; optional extra-copy folder. See `docs/R2_BACKUP.md` |
| `importer/excel.ts` | SheetJS importer for `Demat_Sheet.xlsx` |
| `market/intel.ts` + `market/service.ts` | Market Watch (mainboard only): NSE IPO/subscription, GMP (ipowatch, optional), bonus/rights ex-dates, board-meeting proposals, shareholder-quota watchlist (`data/market.json`). Keep `intel.ts` pure — tested in `tests/market` |

### Preload (`src/preload/index.ts`)

Exposes `window.api` via `contextBridge`. The type `Api` exported from this file is the contract the renderer relies on. Any new IPC channel needs a handler in `ipc.ts` **and** an entry here.

### Renderer (`src/renderer/src/`)

Plain React 18, no state library. `App.tsx` is a three-state machine: `loading → unlock → unlocked`. Only two pages: `Unlock.tsx` and `Dashboard.tsx`.

## Security model — dual encryption layer

1. **SQLite3MultipleCiphers ChaCha20-Poly1305** (DB file, `cipher='chacha20'`, non-legacy — NOT SQLCipher; the Android viewer depends on this format): key = Argon2id hash of master password, never stored anywhere. It is passed as the string `x'<hex>'`, which SQLite3MC runs through PBKDF2-HMAC-SHA256 (64007 iterations, salt = first 16 bytes of the file) — it is not used as a raw key. Wrong password → `INVALID_MASTER_PASSWORD` thrown in `openDb()`.
2. **Field-level AES-256-GCM** (`crypto/field.ts`): wraps PAN, Aadhaar, account numbers, passwords. Key is a random 32-byte value stored in Windows Credential Manager. An attacker needs both the DB file, the master password **and** OS-level access to read credentials.

`pan_last4` / `aadhaar_last4` / `account_last4` columns store plaintext tails only, for fast list rendering without decryption.

## Data stored on disk (`%APPDATA%\IPO Manager\`)

| Path | Contents |
|------|----------|
| `data/vault.db` | SQLite3MC ChaCha20-Poly1305 encrypted database |
| `data/vault.meta.json` | Argon2id salt (not secret) |
| `data/gmail-credentials.json` | OAuth client secret (user-provided, not in repo) |
| `browser-profiles/<profileKey>/` | Persistent Chromium sessions per member×bank |

## Adding a new bank or broker adapter

See `docs/ADDING_NEW_BANK.md` for the full guide. Short version:

1. Capture stable selectors from the real login page (prefer `#id`, `[name]`, `[data-testid]` — avoid CSS classes).
2. Identify the OTP email pattern; add to `OTP_PRESETS` in `email/gmail.ts` if missing.
3. Replace the stub in `automation/stubs.ts` with a real adapter (use `auBank.ts` as template).
4. Register it in `automation/registry.ts`.

Bank login pages break every 6-12 months — the `audit_log` table records last-success timestamps.

## IPC channel conventions

All channels are defined in `ipc.ts` (`registerIpcHandlers`) and mirrored in `preload/index.ts`. Channel naming: `noun:verb` (e.g. `vault:unlock`, `login:bank`). The renderer never calls `ipcRenderer` directly — always through `window.api`.
