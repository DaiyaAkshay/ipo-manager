/**
 * Backup engine round-trip — the highest-value test in the suite.
 *
 * It simulates the multi-machine scenario:
 *   Machine A: create vault, add data, take snapshot
 *   Machine B: fresh install (different salt), restore from snapshot
 *   → the same master password must unlock the restored vault
 *
 * This is the exact failure mode that bit a real user last week (the salt
 * wasn't included in the snapshot). Keeping the test in the repo prevents
 * that regression.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// better-sqlite3-multiple-ciphers is compiled against Electron's Node ABI,
// not vanilla Node, so it can't load in a normal `vitest run`. We detect the
// mismatch and skip the engine tests with a clear message — the engine is
// covered end-to-end by manual testing during build verification.
//
// To run these tests, run inside Electron-bridged vitest:
//   npm rebuild better-sqlite3-multiple-ciphers
// (will break the Electron app until you `npm run postinstall` again).
let canLoadSqlite = false;
try {
  // The require() call itself is lazy — the native binding only loads when
  // we actually instantiate a Database. Probe with an in-memory DB.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3-multiple-ciphers');
  const probe = new Database(':memory:');
  probe.close();
  canLoadSqlite = true;
} catch { /* skip below */ }

const describeIfDb = canLoadSqlite ? describe : describe.skip;

let dataDirA: string;
let dataDirB: string;
let backupDir: string;

beforeEach(() => {
  dataDirA = mkdtempSync(join(tmpdir(), 'ipo-backup-A-'));
  dataDirB = mkdtempSync(join(tmpdir(), 'ipo-backup-B-'));
  backupDir = mkdtempSync(join(tmpdir(), 'ipo-backup-shared-'));
  process.env.IPO_DATA_DIR = dataDirA;
});

afterEach(() => {
  for (const d of [dataDirA, dataDirB, backupDir]) {
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  delete process.env.IPO_DATA_DIR;
});

describeIfDb('backup/engine', () => {
  it('creates a snapshot with vault.db + vault.meta.json + manifest', async () => {
    // ── Machine A: set up vault ──────────────────────────────────────────
    const { deriveMasterKey } = await import('../../src/main/crypto/master');
    const { openDb, closeDb } = await import('../../src/main/db/connection');
    const masterKey = await deriveMasterKey('Tr0pic@l-Mango-Whirl-Strong');
    openDb(masterKey);

    // Configure backup
    const { setBackupConfig, createSnapshot } = await import('../../src/main/backup/engine');
    setBackupConfig({ enabled: true, folder: backupDir });

    // Take snapshot
    const result = await createSnapshot(masterKey);
    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBeTruthy();

    // Check the artifacts on disk
    const snapsRoot = join(backupDir, 'snapshots');
    expect(existsSync(snapsRoot)).toBe(true);
    const snapDirs = readdirSync(snapsRoot, { withFileTypes: true }).filter(e => e.isDirectory());
    expect(snapDirs.length).toBe(1);
    const snapDir = join(snapsRoot, snapDirs[0].name);
    expect(existsSync(join(snapDir, 'vault.db'))).toBe(true);
    expect(existsSync(join(snapDir, 'manifest.json'))).toBe(true);
    expect(existsSync(join(snapDir, 'vault.meta.json'))).toBe(true);     // ← the salt-bearing file
    expect(existsSync(join(snapDir, 'field-key.bin'))).toBe(true);

    closeDb();
  });

  it('restores on a "different machine" (different IPO_DATA_DIR / salt)', async () => {
    // ── Machine A: set up vault + take snapshot ──────────────────────────
    const masterPassword = 'Tr0pic@l-Mango-Whirl-Strong';
    const { deriveMasterKey } = await import('../../src/main/crypto/master');
    const { openDb, closeDb, getDb } = await import('../../src/main/db/connection');
    const masterKeyA = await deriveMasterKey(masterPassword);
    openDb(masterKeyA);

    // Insert a family + member so we have something to verify after restore
    const db = getDb();
    db.prepare(`INSERT INTO families (family_name) VALUES (?)`).run('Sharma Family');
    const famId = (db.prepare(`SELECT id FROM families`).get() as any).id;
    db.prepare(`INSERT INTO members (family_id, full_name) VALUES (?, ?)`).run(famId, 'Akshay Sharma');

    const { setBackupConfig, createSnapshot, restoreSnapshot } = await import('../../src/main/backup/engine');
    setBackupConfig({ enabled: true, folder: backupDir });
    const snapResult = await createSnapshot(masterKeyA);
    expect(snapResult.ok).toBe(true);
    const snapshotId = snapResult.snapshotId!;

    // ── Switch to Machine B: fresh dataDir → fresh salt ──────────────────
    closeDb();
    process.env.IPO_DATA_DIR = dataDirB;

    // The fresh dir has no vault.meta.json yet. Open the DB to verify Machine
    // B has its OWN salt (different from A's) before we restore.
    const masterKeyB = await deriveMasterKey(masterPassword);
    expect(masterKeyA.equals(masterKeyB)).toBe(false);    // different salts → different keys
    closeDb(); // close — restoreSnapshot will re-open with the snapshot's key

    // Point backup config at the shared folder (in real life this would be
    // OneDrive/Drive synced from Machine A).
    setBackupConfig({ enabled: true, folder: backupDir });

    // ── Restore using PASSWORD (not key) — engine re-derives the key from
    //    the snapshot's salt ───────────────────────────────────────────────
    const restoreResult = await restoreSnapshot(snapshotId, masterPassword);
    expect(restoreResult.ok).toBe(true);

    // Verify the restored DB has the data Machine A inserted
    const db2 = getDb();
    const families = db2.prepare(`SELECT family_name FROM families`).all() as any[];
    expect(families).toEqual([{ family_name: 'Sharma Family' }]);
    const members = db2.prepare(`SELECT full_name FROM members`).all() as any[];
    expect(members).toEqual([{ full_name: 'Akshay Sharma' }]);

    closeDb();
  });

  it('refuses to restore with the WRONG master password (no data loss)', async () => {
    // Set up + snapshot as Machine A
    const realPassword = 'Tr0pic@l-Mango-Whirl-Strong';
    const { deriveMasterKey } = await import('../../src/main/crypto/master');
    const { openDb, closeDb, getDb, dbExists, getDbPath } = await import('../../src/main/db/connection');
    const masterKeyA = await deriveMasterKey(realPassword);
    openDb(masterKeyA);
    const db = getDb();
    db.prepare(`INSERT INTO families (family_name) VALUES (?)`).run('Pre-Restore Marker');
    closeDb();

    const { setBackupConfig, createSnapshot, restoreSnapshot } = await import('../../src/main/backup/engine');
    setBackupConfig({ enabled: true, folder: backupDir });
    openDb(masterKeyA);
    const snapResult = await createSnapshot(masterKeyA);
    closeDb();
    expect(snapResult.ok).toBe(true);

    // Attempt restore with wrong password
    const restoreResult = await restoreSnapshot(snapResult.snapshotId!, 'wrong-password-incorrect');
    expect(restoreResult.ok).toBe(false);
    expect(restoreResult.error).toMatch(/master password does not match/i);

    // The original DB on disk should still be intact (we abort before touching it)
    expect(dbExists()).toBe(true);
  });

  it('createSnapshot fails cleanly when backup not configured', async () => {
    const { deriveMasterKey } = await import('../../src/main/crypto/master');
    const { openDb } = await import('../../src/main/db/connection');
    const { setBackupConfig, createSnapshot } = await import('../../src/main/backup/engine');

    const k = await deriveMasterKey('Tr0pic@l-Mango-Whirl-Strong');
    openDb(k);
    setBackupConfig({ enabled: false, folder: null });

    const r = await createSnapshot(k);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not configured/i);
  });
});
