# IPO Manager

Encrypted local vault and login automation for managing family IPO applications.

> **This is a self-built tool for personal use.** It stores extremely sensitive
> data (banking credentials, Aadhaar, PAN). Read the **Security Model** section
> below before putting any real data into it.

---

## What it does

- Stores family member profiles, bank accounts, and broker accounts in a **locally encrypted SQLite vault** (SQLCipher + AES-256-GCM field-level encryption + OS keychain).
- Imports your existing `Demat_Sheet.xlsx` (the layout where each sheet is a family and each column is a person).
- Shows families as a **collapsible tree**. Each family member has two buttons: 🏦 **Bank** and 📈 **Broker**, which launch a real Chrome window pre-logged-in.
- Auto-fills usernames + passwords and waits for the OTP from your Gmail (via Gmail API with read-only OAuth scope).
- Hands control back to you at the bank's IPO page — **you click "Submit" yourself for every bid**. This is intentional.
- Keeps an audit log of every login attempt, success or failure.

## Tech stack

| Layer | What |
|---|---|
| Shell | Electron 32 + Vite |
| UI | React 18 + TypeScript |
| Database | SQLite via `better-sqlite3-multiple-ciphers` (SQLCipher) |
| Master KDF | Argon2id (256 MB / 4 iters) |
| Field crypto | AES-256-GCM, key in Windows Credential Manager via `keytar` |
| Browser automation | Playwright (headed Chromium) |
| Email OTP | Gmail API + OAuth 2.0 (read-only scope) |
| Excel import | SheetJS |

---

## Prerequisites (Windows)

1. **Node.js 20 LTS or newer** — install from https://nodejs.org/. After installing, open PowerShell and verify:
   ```
   node --version
   npm --version
   ```

2. **Visual Studio Build Tools** (needed by `better-sqlite3-multiple-ciphers` and `keytar`, both of which compile native code). Easiest way:
   ```
   npm install --global windows-build-tools
   ```
   Or install "Desktop development with C++" via the Visual Studio Installer.

3. **Python 3.x** on PATH (also needed for native module builds).

---

## First-time setup

### Step 1 — Install dependencies

Open PowerShell in the project folder:
```
cd ipo-manager
npm install
```

This will also download Chromium for Playwright (~150 MB) on first run.

### Step 2 — Set up Gmail API (required for OTP fetching)

Since we're using OAuth (not app passwords), there's a small one-time setup:

1. Go to https://console.cloud.google.com/.
2. Create a new project named "IPO Manager" (or reuse an existing one).
3. In the left menu: **APIs & Services → Library** → search for "Gmail API" → **Enable**.
4. **APIs & Services → OAuth consent screen** → choose "External" → fill in app name, your email, and your email as the test user.
5. **APIs & Services → Credentials** → **+ Create Credentials → OAuth client ID** → application type **Desktop app** → name it "IPO Manager Desktop".
6. **Download JSON** — this gives you a file like `client_secret_xxxxx.json`.
7. Rename it to `gmail-credentials.json` and place it at:
   ```
   C:\Users\<YOU>\AppData\Roaming\IPO Manager\data\gmail-credentials.json
   ```
   (The `data` folder is created when you run the app for the first time. So launch the app once first, close it, then drop the JSON in.)

Note: This is a **personal-use** OAuth app. You don't need to publish or verify it. Google will show "App not verified" warnings the first time you sign in — click "Advanced" → "Go to IPO Manager (unsafe)". This is fine because the app *is* you.

### Step 3 — Run in dev mode

```
npm run dev
```

The app launches. First screen is the master password.

### Step 4 — Set your master password

Pick something **16+ characters**, mix of cases/digits/symbols, no dictionary words.
Suggested format: `Banyan-Quartz-Ladder-Helmet-7!`

**Write it on paper. Store the paper in a locker or sealed envelope.** If you lose this password, the vault is unrecoverable. There is no recovery flow — that's the point.

### Step 5 — Import your Excel

1. Move `Demat_Sheet.xlsx` to a non-cloud-synced folder (Desktop, Downloads, etc.).
2. Click **Import Excel** in the sidebar.
3. Select the file. Importer parses 8 family sheets and ~35 members.
4. After successful import, **shred the source file**:
   ```
   # Open PowerShell as admin and run:
   sdelete -p 7 -s -z "C:\path\to\Demat_Sheet.xlsx"
   ```
   (Get sdelete from https://learn.microsoft.com/en-us/sysinternals/downloads/sdelete)

   Then **change every password** that was in the Excel. The file's `@Abhi123` protection was weak; assume those credentials are compromised.

### Step 6 — Test a bank login

1. Click any family in the sidebar to expand it.
2. Click the 🏦 **AU** button next to a member.
3. Chrome opens, navigates to AU Bank, fills the username, then the password.
4. When OTP arrives in Gmail, app reads it and fills the OTP field.
5. Browser stays open at the post-login dashboard. **You take it from here** — go to the IPO section, place your bid, click submit yourself.

If selectors are wrong (AU Bank may have changed its login page), the automation will pause. Inspect the live page, update selectors in `src/main/automation/auBank.ts`, restart `npm run dev`.

---

## Building a Windows installer

```
npm run build:win
```

Output goes to `dist/`. The installer is a standard NSIS `.exe`. **Do not distribute this** — it's for your personal use only.

---

## Security model

### Layers of encryption

```
┌─────────────────────────────────────────────────────────┐
│  Master password (your brain / paper)                   │
│      ↓ Argon2id (256MB, 4 iters)                        │
│  256-bit raw key                                        │
│      ↓                                                  │
│  SQLCipher decrypts entire .db file (AES-256-CBC+HMAC)  │
│      ↓                                                  │
│  Field-level AES-256-GCM blobs in DB rows               │
│      ↑ key from Windows Credential Manager              │
│  Plaintext credentials in memory only when needed       │
└─────────────────────────────────────────────────────────┘
```

What this means in practice:

- **DB file stolen alone** → useless without master password. Argon2id makes brute-force prohibitive.
- **DB file + master password (e.g., shoulder-surfed)** → still useless without OS-level access to your Windows account, because field-level keys live in Credential Manager.
- **Full machine compromise (malware running as you)** → game over. No software vault survives this. Mitigate with: dedicated machine, BitLocker, no other software installed, automatic Windows updates.

### Auto-lock

After 5 minutes of inactivity, the DB connection closes and the app returns to the unlock screen. The field-level key stays in memory until app exit (this is a tradeoff — re-deriving Argon2id every action would be too slow).

### What the app **does not** do

- Does not connect to the internet except for Gmail OAuth and the bank/broker sites you click into.
- Does not send any data to Anthropic, the developer, or anywhere else.
- Does not store screenshots, browser history, or cookies in any cloud.
- Does not place IPO bids automatically — you click submit on every one.

### What the app **cannot** protect against

- A stolen, unlocked laptop with the vault unlocked.
- Keyloggers or screen recorders running on your Windows account.
- Coercion (someone forcing you to enter the master password).
- You sharing the vault.db file or the master password.

---

## Project layout

```
ipo-manager/
├── src/
│   ├── main/                       # Electron main process (Node)
│   │   ├── index.ts                # App lifecycle, window mgmt, auto-lock
│   │   ├── ipc.ts                  # IPC handlers
│   │   ├── db/
│   │   │   ├── connection.ts       # SQLCipher init
│   │   │   └── schema.sql          # Tables
│   │   ├── crypto/
│   │   │   ├── master.ts           # Argon2id
│   │   │   └── field.ts            # AES-256-GCM + keytar
│   │   ├── importer/
│   │   │   └── excel.ts            # Demat_Sheet.xlsx parser
│   │   ├── automation/
│   │   │   ├── browser.ts          # Playwright launcher
│   │   │   ├── auBank.ts           # AU Bank login (real)
│   │   │   ├── stubs.ts            # Yes/SBI/Kotak/brokers (templates)
│   │   │   └── registry.ts         # code → adapter resolver
│   │   └── email/
│   │       └── gmail.ts            # Gmail API + OAuth + OTP fetcher
│   ├── preload/
│   │   └── index.ts                # contextBridge API
│   └── renderer/                   # React UI
│       ├── index.html
│       └── src/
│           ├── main.tsx
│           ├── App.tsx
│           ├── styles.css
│           └── pages/
│               ├── Unlock.tsx      # Master password screen
│               └── Dashboard.tsx   # Family tree + login buttons
├── docs/
│   └── ADDING_NEW_BANK.md          # How to wire a new bank/broker adapter
├── package.json
├── tsconfig.json
├── electron.vite.config.ts
└── README.md
```

---

## Adding new banks/brokers

See `docs/ADDING_NEW_BANK.md`.

## Roadmap (suggested — none of these are built yet)

- Document upload UI (Aadhaar/PAN/Cheque scans, encrypted at rest).
- TOTP support for brokers that allow it (Zerodha, Angel One).
- IPO calendar scraper (NSE/BSE upcoming IPOs).
- Bid tracker page with allotment status.
- Encrypted backup to external drive.
- Per-relative authorization PDF storage.

---

## Operational checklist before going live

- [ ] Master password written on paper, stored physically secure.
- [ ] BitLocker enabled on the system drive.
- [ ] Windows Hello / strong account password enabled.
- [ ] No cloud sync covering `%APPDATA%\IPO Manager`.
- [ ] Gmail account has 2-Step Verification on.
- [ ] Original `Demat_Sheet.xlsx` shredded after import.
- [ ] All passwords previously in the Excel rotated to fresh ones.
- [ ] Written authorization (even informal WhatsApp) from each adult relative whose accounts are stored.
- [ ] Audit log reviewed weekly.
