# IPO Manager - Project Progress

**Last updated:** 2026-05-06
**Project root:** `H:\ipo-manager_1\ipo-manager`
**Stack:** Electron + React + TypeScript + SQLCipher vault + Playwright automation + Express/WebSocket web mode

---

## Current state

- The folder contains a working application, build outputs, Windows installer artifacts, and a substantial codebase under `src/`.
- This folder is **not currently a Git repository**. There is no `.git` directory in the project root or immediate parent.
- `npm run build` succeeds and refreshes the `out/` build artifacts.
- A packaged Windows installer already exists in `dist/` (`IPO Manager Setup 0.1.0.exe`).
- `tsc --noEmit` now passes cleanly.

---

## What is implemented

### Core vault and data model

- Encrypted vault unlock/create flow with Argon2id-derived master key.
- SQLCipher database plus field-level AES-GCM encryption using Windows Credential Manager.
- Family/member CRUD, ordering, notes, and family-level `min_balance`.
- Expanded schema for:
  - bank and broker balances
  - broker portfolio report storage + parsed holdings/summaries
  - IPO bid runs
  - IPO catalog cache
  - audit logging

### Desktop app

- Electron shell with preload bridge and auto-lock after inactivity.
- Import from the existing Demat Excel layout.
- Export decrypted data back to XLSX.
- Gmail OAuth status + reconnect flow in the UI.

### Automation

- **AU Bank**:
  - login flow
  - balance fetch with savings/deposit split
  - keep-alive
  - assisted AU IPO prepare + confirm flow
- **Zerodha**:
  - login with TOTP
  - funds / portfolio / positions balance fetch
  - holdings XLSX download
  - parsed portfolio storage and viewer support
- Additional adapters exist for:
  - banks: `YES`, `SBI`, `KOTAK`
  - brokers: `DHAN`, `ANGEL`, `MIRAE`, `SHOONYA`, `FYERS`, `GROWW`

### Renderer / dashboard

- Family tree + View All layout
- Member add/edit/delete
- Bank and broker credential forms
- TOTP secret field with live "Generate Code"
- Family and grand-total balance aggregation
- Balance aging display
- Gmail status pill and reconnect action
- Broker portfolio download/view actions
- AU IPO modal flow with cached issue catalog and bid history

### Web mode

- Express + WebSocket server in `web-server.ts`
- Shared unlock session for multiple browser clients on the LAN
- Browser-based import/export
- Browser-based CRUD for families/members
- Bank/broker login endpoints
- OTP prompts delivered over WebSocket

---

## Verified on 2026-05-06

### Passing

- `npm run build`

- `tsc --noEmit`

---

## Important gaps and caveats

### Typecheck is now clean

- Strict TypeScript now passes again.
- The old logo-file note is no longer relevant; the missing piece was a renderer-side `*.png` module declaration, not absent assets.

### Web mode is not feature-parity with Electron

- `src/renderer/src/lib/webApi.ts` intentionally returns "Electron only" errors for:
  - Gmail status/connect
  - broker portfolio download/view
  - IPO catalog
  - AU IPO prepare/confirm/history
- `web-server.ts` does not mirror all Electron behavior yet:
  - broker balances are not returned in `/api/families/:id/members`
  - broker `fetchBalance` is not wired through like Electron's `login:broker`

### Partial adapter maturity

- Only **Zerodha** implements portfolio report download/parsing.
- Only **AU Bank** implements the assisted IPO bid prepare/submit flow.
- Other bank/broker adapters exist in code but still need live verification.

### Small cleanup item

- `src/preload/index.ts` still exposes `member.detail`, but there is no matching `member:detail` handler in `src/main/ipc.ts`. Current UI uses `member.fullDetail`, so this looks stale rather than blocking.

---

## Recommended next steps

1. Decide whether web mode should stay "basic shared access" or become full-featured.
   - If it should stay limited, hide/disable Electron-only buttons in browser mode.
   - If it should match desktop, bring `web-server.ts` to parity for broker balances, reports, Gmail, and IPO actions.

2. Run live verification on the remaining adapters in a controlled order.
   - Banks: `KOTAK`, `YES`, `SBI`
   - Brokers: `DHAN`, `ANGEL`, `MIRAE`, `SHOONYA`, `FYERS`, `GROWW`

3. Put the project under Git before the next round of work.
   - Right now there is no local history for the recent additions to web mode, reports, and AU IPO flows.

4. After the cleanup pass, refresh the user-facing docs.
   - `README.md` and `INSTRUCTIONS.txt` still describe the app broadly, but they do not fully capture the newer AU IPO and Zerodha portfolio/report functionality or the current web-mode limitations.
