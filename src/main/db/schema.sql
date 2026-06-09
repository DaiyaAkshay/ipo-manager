-- IPO Manager database schema
-- Runs inside SQLCipher (entire DB file is encrypted with master password)
-- Sensitive fields are ALSO encrypted at the field level with a key in OS keychain

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS families (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  family_name TEXT NOT NULL UNIQUE,
  display_order INTEGER DEFAULT 0,
  notes TEXT,
  min_balance INTEGER DEFAULT 0,   -- minimum savings balance the family should maintain (₹)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  member_type TEXT DEFAULT 'INDIVIDUAL',  -- 'INDIVIDUAL' or 'HUF'
  dob TEXT,                                -- stored as ISO date string
  mobile TEXT,
  email TEXT,
  -- Sensitive fields stored as encrypted BLOBs (AES-256-GCM)
  pan_enc BLOB,
  aadhaar_enc BLOB,
  email_password_enc BLOB,                 -- email account password (for IPO confirmations, OTP fallback)
  -- Display helpers (last 4 chars only, plaintext for fast list rendering)
  pan_last4 TEXT,
  aadhaar_last4 TEXT,
  display_order INTEGER DEFAULT 0,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_members_family ON members(family_id);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  bank_code TEXT NOT NULL,                -- 'AU', 'YES', 'SBI', 'KOTAK', 'ICICI', 'BOB', 'PNB', 'HDFC', 'AXIS'
  account_number_enc BLOB,
  ifsc TEXT,
  customer_id_enc BLOB,
  user_id_enc BLOB,
  password_enc BLOB,
  -- Optional extras (encrypted)
  debit_card_enc BLOB,
  debit_card_pin_enc BLOB,
  debit_card_cvv_enc BLOB,
  debit_card_valid_thru TEXT,
  digilocker_pin_enc BLOB,
  -- Display helpers
  account_last4 TEXT,
  -- Last fetched balance (plaintext — not sensitive, shown in UI)
  balance TEXT,
  balance_fetched_at DATETIME,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_bank_member ON bank_accounts(member_id);

CREATE TABLE IF NOT EXISTS broker_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  broker_code TEXT NOT NULL,              -- 'ZERODHA', 'DHAN', 'ANGEL', 'MIRAE'
  client_id_enc BLOB,
  account_number_enc BLOB,
  user_id_enc BLOB,
  password_enc BLOB,
  totp_secret_enc BLOB,                   -- if user enables TOTP later
  -- Per-broker contact (sometimes different from member's main email)
  broker_mobile TEXT,
  broker_email TEXT,
  -- Last fetched funds balance (plaintext — not sensitive, shown in UI)
  balance TEXT,
  balance_fetched_at DATETIME,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_broker_member ON broker_accounts(member_id);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,                 -- 'AADHAAR', 'PAN', 'CHEQUE', 'OTHER'
  original_name TEXT,
  mime_type TEXT,
  file_size INTEGER,
  -- File is stored encrypted on disk at data/documents/{file_uuid}.enc
  file_uuid TEXT NOT NULL UNIQUE,
  sha256 TEXT,                            -- of plaintext, for tamper detection
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_docs_member ON documents(member_id);

CREATE TABLE IF NOT EXISTS holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  quantity INTEGER,
  notes TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

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
CREATE INDEX IF NOT EXISTS idx_broker_reports_account ON broker_portfolio_reports(broker_account_id, downloaded_at DESC);

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

CREATE TABLE IF NOT EXISTS ipo_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  ipo_name TEXT NOT NULL,
  applied_via_bank_id INTEGER REFERENCES bank_accounts(id),
  applied_date TEXT,
  amount INTEGER,
  status TEXT DEFAULT 'APPLIED',          -- APPLIED / ALLOTTED / NOT_ALLOTTED / REFUNDED
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

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

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts DATETIME DEFAULT CURRENT_TIMESTAMP,
  member_id INTEGER,
  action TEXT NOT NULL,                   -- LOGIN_BANK / LOGIN_BROKER / VIEW_DOC / etc.
  target TEXT,                            -- AU / ZERODHA / etc.
  status TEXT,                            -- SUCCESS / FAILED / CANCELLED
  details TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_member ON audit_log(member_id);

INSERT OR IGNORE INTO schema_version (version) VALUES (1);
