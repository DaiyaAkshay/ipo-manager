/**
 * Vault cipher format guard.
 *
 * The vault is SQLite3MultipleCiphers ChaCha20-Poly1305 (cipher='chacha20'),
 * not SQLCipher. The Android viewer (ipo-manager-android) opens vault.db with
 * exactly this format, so a silent switch (e.g. a library default change)
 * would lock it out. These tests pin the format from both sides.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Same skip as tests/backup/engine.test.ts: the native module is built for
// Electron's Node ABI and can't load under plain `vitest run`.
let canLoadSqlite = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3-multiple-ciphers');
  const probe = new Database(':memory:');
  probe.close();
  canLoadSqlite = true;
} catch { /* skip below */ }

const describeIfDb = canLoadSqlite ? describe : describe.skip;

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ipo-cipher-'));
  process.env.IPO_DATA_DIR = dataDir;
});

afterEach(() => {
  if (dataDir && existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
  delete process.env.IPO_DATA_DIR;
});

/** Open `path` read-only with the given pre-key pragmas; true if the key works. */
function opensWith(path: string, keyHex: string, preKey: string[]): boolean {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3-multiple-ciphers');
  const db = new Database(path, { readonly: true });
  try {
    for (const p of preKey) db.pragma(p);
    db.pragma(`key = "x'${keyHex}'"`);
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

describeIfDb('db/connection cipher format', () => {
  it('creates a vault that opens as chacha20 and not as sqlcipher', async () => {
    const { openDb, closeDb, getDbPath } = await import('../../src/main/db/connection');
    const key = randomBytes(32);
    const db = openDb(key);
    expect(db.pragma('cipher', { simple: true })).toBe('chacha20');
    closeDb();

    const keyHex = key.toString('hex');
    expect(opensWith(getDbPath(), keyHex, ["cipher='chacha20'"])).toBe(true);
    expect(opensWith(getDbPath(), keyHex, ["cipher='sqlcipher'", 'legacy=4'])).toBe(false);
    expect(opensWith(getDbPath(), keyHex, ["cipher='sqlcipher'"])).toBe(false);
  });

  it('still opens a vault made with the old pragmas (no pin, cipher_compatibility = 4)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3-multiple-ciphers');
    const path = join(dataDir, 'old.db');
    const keyHex = randomBytes(32).toString('hex');

    const old = new Database(path);
    old.pragma(`key = "x'${keyHex}'"`);
    old.pragma('cipher_compatibility = 4');
    old.exec('CREATE TABLE legacy_probe (x INTEGER)');
    old.close();

    // The pre-key pragmas openDb() and validateSnapshotDb() now use.
    expect(opensWith(path, keyHex, ["cipher='chacha20'"])).toBe(true);
  });
});
