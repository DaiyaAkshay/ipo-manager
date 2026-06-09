/**
 * Database connection using SQLCipher.
 *
 * SQLCipher encrypts the entire .db file at rest with AES-256-CBC + HMAC-SHA512.
 * The encryption key is derived from the user's master password via Argon2id
 * (in master.ts) and never persisted to disk.
 *
 * Sensitive fields (passwords, account numbers, PAN, Aadhaar) are ALSO
 * encrypted at the field level using a separate key stored in the OS keychain
 * (see crypto/field.ts). This means even if an attacker gets the .db file
 * AND the master password, they still need OS-level access to read credentials.
 */

import Database from 'better-sqlite3-multiple-ciphers';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { SCHEMA_SQL } from './schema';

let db: Database.Database | null = null;

export function getDataDir(): string {
  // Optional override for diagnostics and data migration.
  if (process.env.IPO_DATA_DIR) {
    const dir = process.env.IPO_DATA_DIR;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }
  // Desktop app: use Electron's userData path.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    const dir = join(app.getPath('userData'), 'data');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    // Fallback for non-Electron maintenance scripts.
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    const dir = join(appData, 'ipo-manager', 'data');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }
}

export function getDbPath(): string {
  return join(getDataDir(), 'vault.db');
}

export function dbExists(): boolean {
  return existsSync(getDbPath());
}

export function openDb(rawKey: Buffer): Database.Database {
  if (db) return db;

  const dbPath = getDbPath();
  const newDb = !existsSync(dbPath);
  db = new Database(dbPath);

  // SQLCipher key as raw hex bytes.
  // Format: x'<hex>' tells SQLCipher to use the bytes directly (no KDF inside SQLCipher).
  // Our KDF (Argon2id) is stronger than SQLCipher's default PBKDF2, so we
  // pre-derive the key and pass it raw.
  const keyHex = rawKey.toString('hex');
  db.pragma(`key = "x'${keyHex}'"`);
  db.pragma('cipher_compatibility = 4');
  db.pragma('foreign_keys = ON');

  // Verify the key works by running a trivial query.
  // If the password is wrong, this throws.
  try {
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch (e) {
    db.close();
    db = null;
    throw new Error('INVALID_MASTER_PASSWORD');
  }

  if (!newDb) {
    // ── Versioned migration system ──────────────────────────────────────────
    // Each step is gated by SQLite's PRAGMA user_version. We start at whatever
    // the DB currently reports, run pending steps in order, and end with the
    // pragma updated to CURRENT_SCHEMA_VERSION. Idempotent across re-runs: a
    // DB already at the latest version runs zero migration SQL.
    //
    // CURRENT_SCHEMA_VERSION must match the highest step number below AND
    // the schema produced by schema.ts on fresh installs (which bumps the
    // pragma in its own INSERT at the bottom of SCHEMA_SQL).
    const CURRENT_SCHEMA_VERSION = 3;
    const startVersion = (db.pragma('user_version', { simple: true }) as number) || 0;

    if (startVersion < CURRENT_SCHEMA_VERSION) {
      console.log(`[DB] Migrating schema from v${startVersion} → v${CURRENT_SCHEMA_VERSION}`);
    }

    // Helper: column-exists check used by several legacy migrations.
    const hasColumn = (table: string, col: string): boolean => {
      const cols = db!.prepare(`PRAGMA table_info(${table})`).all() as any[];
      return cols.some((c: any) => c.name === col);
    };

    // Run each migration step inside a transaction so a half-applied schema
    // never persists. Bumps user_version on success.
    const runStep = (target: number, fn: () => void): void => {
      if (startVersion >= target) return;
      const txn = db!.transaction(() => {
        fn();
        db!.pragma(`user_version = ${target}`);
      });
      txn();
      console.log(`[DB] Migration v${target} applied.`);
    };

    // ── v1: legacy migrations (pre-versioning era) ─────────────────────────
    // These are the column-presence checks that existed before we introduced
    // user_version. They were already idempotent, so we wrap them and stamp
    // the DB as v1.
    runStep(1, () => {
      if (!hasColumn('members', 'display_order')) {
        db!.exec('ALTER TABLE members ADD COLUMN display_order INTEGER DEFAULT 0');
        db!.exec('UPDATE members SET display_order = rowid');
      }
      if (!hasColumn('members', 'email_password_enc')) {
        db!.exec('ALTER TABLE members ADD COLUMN email_password_enc BLOB');
      }
      if (!hasColumn('bank_accounts', 'balance')) {
        db!.exec('ALTER TABLE bank_accounts ADD COLUMN balance TEXT');
        db!.exec('ALTER TABLE bank_accounts ADD COLUMN balance_fetched_at DATETIME');
      }
      if (!hasColumn('broker_accounts', 'balance')) {
        db!.exec('ALTER TABLE broker_accounts ADD COLUMN balance TEXT');
        db!.exec('ALTER TABLE broker_accounts ADD COLUMN balance_fetched_at DATETIME');
      }
      if (!hasColumn('families', 'min_balance')) {
        db!.exec('ALTER TABLE families ADD COLUMN min_balance INTEGER DEFAULT 0');
      }
    });

    // ── v2: secondary tables (added in 2025-2026) ──────────────────────────
    // These are idempotent CREATE TABLE IF NOT EXISTS — safe to re-run.
    runStep(2, () => {
      db!.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        doc_type TEXT NOT NULL,
        original_name TEXT,
        mime_type TEXT,
        file_size INTEGER,
        file_uuid TEXT NOT NULL UNIQUE,
        sha256 TEXT,
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_docs_member
      ON documents(member_id);

      CREATE TABLE IF NOT EXISTS broker_portfolio_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        broker_account_id INTEGER NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
        member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        broker_code TEXT NOT NULL,
        report_kind TEXT NOT NULL,
        as_of_date TEXT,
        original_file_name TEXT,
        stored_file_path TEXT NOT NULL,
        downloaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_broker_reports_account
      ON broker_portfolio_reports(broker_account_id, downloaded_at DESC);

      CREATE TABLE IF NOT EXISTS broker_portfolio_report_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_id INTEGER NOT NULL REFERENCES broker_portfolio_reports(id) ON DELETE CASCADE,
        sheet_name TEXT NOT NULL,
        asset_scope TEXT NOT NULL,
        client_id TEXT,
        statement_title TEXT,
        as_of_date TEXT,
        invested_value REAL,
        present_value REAL,
        unrealized_pnl REAL,
        unrealized_pnl_pct REAL
      );
      CREATE INDEX IF NOT EXISTS idx_broker_report_summaries_report
      ON broker_portfolio_report_summaries(report_id);

      CREATE TABLE IF NOT EXISTS broker_portfolio_holdings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_id INTEGER NOT NULL REFERENCES broker_portfolio_reports(id) ON DELETE CASCADE,
        sheet_name TEXT NOT NULL,
        asset_scope TEXT NOT NULL,
        is_combined_view INTEGER DEFAULT 0,
        row_order INTEGER DEFAULT 0,
        symbol TEXT NOT NULL,
        isin TEXT,
        sector TEXT,
        instrument_type TEXT,
        quantity_available REAL,
        quantity_discrepant REAL,
        quantity_long_term REAL,
        quantity_pledged_margin REAL,
        quantity_pledged_loan REAL,
        average_price REAL,
        previous_closing_price REAL,
        unrealized_pnl REAL,
        unrealized_pnl_pct REAL
      );
      CREATE INDEX IF NOT EXISTS idx_broker_portfolio_holdings_report
      ON broker_portfolio_holdings(report_id, sheet_name, row_order);

      CREATE TABLE IF NOT EXISTS ipo_bid_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
        broker_account_id INTEGER REFERENCES broker_accounts(id) ON DELETE SET NULL,
        bank_code TEXT NOT NULL,
        broker_code TEXT,
        ipo_name TEXT NOT NULL,
        bid_type TEXT NOT NULL DEFAULT 'CUTOFF',
        quantity INTEGER NOT NULL,
        lot_size INTEGER,
        entered_price REAL,
        effective_price REAL NOT NULL,
        blocked_amount REAL NOT NULL,
        demat_account_last4 TEXT,
        pan_last4 TEXT,
        ready_to_submit INTEGER DEFAULT 0,
        page_url TEXT,
        prepare_warnings_json TEXT,
        bank_reference TEXT,
        status TEXT NOT NULL DEFAULT 'DRAFT',
        prepared_at DATETIME,
        submitted_at DATETIME,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_ipo_bid_runs_member
      ON ipo_bid_runs(member_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS ipo_master_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL DEFAULT 'BSE',
        issue_name TEXT NOT NULL UNIQUE,
        symbol TEXT,
        exchange_platform TEXT,
        issue_type TEXT,
        status TEXT,
        open_date TEXT,
        close_date TEXT,
        price_min REAL,
        price_max REAL,
        lot_size INTEGER,
        minimum_bid_quantity INTEGER,
        face_value REAL,
        detail_url TEXT,
        raw_json TEXT,
        fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_ipo_master_cache_status
      ON ipo_master_cache(status, open_date, close_date);

      CREATE TABLE IF NOT EXISTS mobile_recharge_tracking (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        mobile_number TEXT NOT NULL,
        recharge_date TEXT,
        validity_days INTEGER,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    });

    // ── v3: mobile_recharge_tracking augmentations ─────────────────────────
    // Adds mobile_model and display_order columns and backfills display_order.
    runStep(3, () => {
      if (!hasColumn('mobile_recharge_tracking', 'mobile_model')) {
        db!.exec('ALTER TABLE mobile_recharge_tracking ADD COLUMN mobile_model TEXT');
      }
      if (!hasColumn('mobile_recharge_tracking', 'display_order')) {
        db!.exec('ALTER TABLE mobile_recharge_tracking ADD COLUMN display_order INTEGER DEFAULT 0');
        db!.exec('UPDATE mobile_recharge_tracking SET display_order = id');
      }
    });

    if (startVersion < CURRENT_SCHEMA_VERSION) {
      console.log(`[DB] Schema is now at v${CURRENT_SCHEMA_VERSION}.`);
    }
  }

  if (newDb) {
    // Schema is inlined as a TS string (src/main/db/schema.ts) so it ships
    // inside the bundled main process — no on-disk schema.sql required at
    // runtime. Keep schema.sql in sync as the human-readable source.
    db.exec(SCHEMA_SQL);
  }

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function rekeyDb(rawKey: Buffer): void {
  if (!db) throw new Error('DB_NOT_OPEN');
  const keyHex = rawKey.toString('hex');
  db.pragma(`rekey = "x'${keyHex}'"`);
  db.prepare('SELECT count(*) FROM sqlite_master').get();
}

export function getDb(): Database.Database {
  if (!db) throw new Error('DB_NOT_OPEN');
  return db;
}
