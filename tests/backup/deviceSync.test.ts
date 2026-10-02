/** Cross-device balance audit using encrypted vaults and a synthetic R2 store. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import keytar from 'keytar';
import type { ObjectStore, StoredObject } from '../../src/main/backup/objectStore';

class SharedStore implements ObjectStore {
  objects = new Map<string, Buffer>();
  online = true;
  check() { if (!this.online) throw new Error('Synthetic network offline'); }
  async list(prefix: string): Promise<StoredObject[]> {
    this.check();
    return [...this.objects].filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, size: value.length, lastModified: Date.now() }));
  }
  async get(key: string) {
    this.check();
    const value = this.objects.get(key);
    if (!value) throw new Error(`Missing synthetic object ${key}`);
    return Buffer.from(value);
  }
  async put(key: string, body: Buffer) { this.check(); this.objects.set(key, Buffer.from(body)); }
  async delete(key: string) { this.check(); this.objects.delete(key); }
}
const shared = new SharedStore();

// Replace only the network transport. Exercise the production engine, R2
// replication, encrypted database snapshots, lineage and conflict resolution.
vi.mock('../../src/main/backup/objectStore', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/main/backup/objectStore')>();
  return { ...original, R2Store: class {
    list(prefix: string) { return shared.list(prefix); }
    get(key: string) { return shared.get(key); }
    put(key: string, body: Buffer) { return shared.put(key, body); }
    delete(key: string) { return shared.delete(key); }
  } };
});

let canLoadSqlite = false;
try {
  const Database = require('better-sqlite3-multiple-ciphers');
  const db = new Database(':memory:');
  db.close();
  canLoadSqlite = true;
} catch { /* Run with npm run test:native for Electron's SQLite ABI. */ }

const password = 'Synthetic-Device-Sync-2026!';
type Device = { dir: string; key: Buffer };
let engine: typeof import('../../src/main/backup/engine');
let connection: typeof import('../../src/main/db/connection');
let crypto: typeof import('../../src/main/crypto/master');
let dirs: string[];
let now: number;

async function activate(device: Device) {
  connection.closeDb();
  process.env.IPO_DATA_DIR = device.dir;
  connection.openDb(device.key);
}

async function newDevice(): Promise<Device> {
  connection.closeDb();
  const dir = mkdtempSync(join(tmpdir(), 'ipo-device-sync-'));
  dirs.push(dir);
  process.env.IPO_DATA_DIR = dir;
  const key = await crypto.deriveMasterKey(password);
  connection.openDb(key);
  engine.setBackupConfig({ enabled: true, target: 'r2', r2: {
    accountId: '0'.repeat(32), bucket: 'synthetic-audit', accessKeyId: 'synthetic-access-key', prefix: 'ipo-manager',
  } });
  return { dir, key };
}

async function unlock(device: Device) {
  await activate(device);
  const outcome = await engine.syncOnUnlock({ masterPassword: password, liveKey: device.key,
    preOpenLocalHash: engine.getLocalDbHash() });
  if (outcome.newMasterKey) device.key = outcome.newMasterKey;
  return outcome;
}

async function tick(device: Device, idle = true) {
  await activate(device);
  const outcome = await engine.syncTick({ masterPassword: password, liveKey: device.key, canPull: idle, canPush: idle });
  if (outcome.newMasterKey) device.key = outcome.newMasterKey;
  return outcome;
}

async function seed() {
  const a = await newDevice();
  const db = connection.getDb();
  db.prepare('INSERT INTO families (family_name) VALUES (?)').run('Synthetic Family');
  db.prepare('INSERT INTO members (family_id, full_name) VALUES (1, ?)').run('Synthetic Member');
  for (const code of ['AU', 'HDFC']) {
    db.prepare('INSERT INTO bank_accounts (member_id, bank_code, balance) VALUES (1, ?, ?)').run(code, '₹100.00');
  }
  expect((await engine.createSnapshot(a.key)).ok).toBe(true);
  const b = await newDevice();
  expect((await unlock(b)).action).toBe('pulled');
  return { a, b };
}

function fetchBalance(id: number, balance: string) {
  // The same persistence operation used by runLogin and in-browser refresh.
  connection.getDb().prepare('UPDATE bank_accounts SET balance = ?, balance_fetched_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(balance, id);
}
function balances() {
  return connection.getDb().prepare('SELECT id, balance, balance_fetched_at FROM bank_accounts ORDER BY id').all() as
    Array<{ id: number; balance: string; balance_fetched_at: string | null }>;
}

(canLoadSqlite ? describe : describe.skip)('cross-device bank balance sync', () => {
  beforeAll(async () => {
    connection = await import('../../src/main/db/connection');
    crypto = await import('../../src/main/crypto/master');
    engine = await import('../../src/main/backup/engine');
  }, 60_000);
  beforeEach(async () => {
    dirs = [];
    shared.objects.clear(); shared.online = true;
    now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    engine.setSyncSuspended(false);
    const field = await import('../../src/main/crypto/field');
    field.clearKeyCache();
    await field.getOrCreateFieldKey();
    await keytar.setPassword('ipo-manager', 'r2-secret-access-key-v1', 'synthetic-secret-access-key');
  });
  afterEach(() => {
    connection.closeDb();
    vi.restoreAllMocks();
    delete process.env.IPO_DATA_DIR;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('uploads after settling and delivers the value and fetch time to two clean devices', async () => {
    const { a, b } = await seed();
    const c = await newDevice();
    expect((await unlock(c)).action).toBe('pulled');
    await activate(a);
    fetchBalance(1, '₹12500.00');
    const expected = balances();
    expect((await tick(a)).action).toBe('none');
    now += 60_000;
    expect((await tick(a)).action).toBe('none');
    now += 30_000;
    expect((await tick(a)).action).toBe('pushed');
    expect((await tick(b)).action).toBe('pulled');
    expect(balances()).toEqual(expected);
    expect((await tick(c)).action).toBe('pulled');
    expect(balances()).toEqual(expected);
  });

  it('does not merge different bank balances fetched concurrently on different devices', async () => {
    const { a, b } = await seed();
    await activate(a); fetchBalance(1, '₹11000.00');
    await activate(b); fetchBalance(2, '₹22000.00');
    await activate(a);
    expect((await engine.backupNow({ masterPassword: password, liveKey: a.key })).ok).toBe(true);
    expect((await tick(b)).action).toBe('conflict');
    expect(balances().map(row => row.balance)).toEqual(['₹100.00', '₹22000.00']);
    expect((await engine.resolveSyncConflict('keep-local', { masterPassword: password, liveKey: b.key })).action).toBe('pushed');
    expect((await tick(a)).action).toBe('pulled');
    // Choosing PC B's whole vault replaces A's independent AU refresh.
    expect(balances().map(row => row.balance)).toEqual(['₹100.00', '₹22000.00']);
  });

  it('reproduces an undetected collision when two stale caches allocate the same snapshot id', async () => {
    const { a, b } = await seed();
    await activate(a); fetchBalance(1, '₹66000.00');
    await activate(b); fetchBalance(2, '₹77000.00');
    // Both devices are behind the time of their shared base snapshot. Each
    // allocates base + 1 ms, as can happen with clock skew and overlapping
    // publish preflights. PC B's cache still has the base when A publishes.
    now -= 60_000;
    await activate(a);
    const aPush = await engine.createSnapshot(a.key);
    expect(aPush.ok).toBe(true);
    await activate(b);
    const bPush = await engine.createSnapshot(b.key);
    expect(bPush.ok).toBe(true);
    expect(bPush.snapshotId).toBe(aPush.snapshotId);
    // Existing ids are trusted without comparing content. B appears clean,
    // but its balance update was never uploaded and no conflict is raised.
    expect((await tick(b)).action).toBe('none');
    expect(balances().map(row => row.balance)).toEqual(['₹100.00', '₹77000.00']);
    const c = await newDevice();
    expect((await unlock(c)).action).toBe('pulled');
    expect(balances().map(row => row.balance)).toEqual(['₹66000.00', '₹100.00']);
  });

  it('defers incoming balances while an automation is active, then applies them', async () => {
    const { a, b } = await seed();
    await activate(a); fetchBalance(1, '₹33000.00');
    expect((await engine.backupNow({ masterPassword: password, liveKey: a.key })).ok).toBe(true);
    expect((await tick(b, false)).action).toBe('none');
    expect(balances()[0].balance).toBe('₹100.00');
    expect((await tick(b)).action).toBe('pulled');
    expect(balances()[0].balance).toBe('₹33000.00');
  });

  it('reproduces manual sync replacing a database still held by a bank automation', async () => {
    const { a, b } = await seed();
    await activate(a); fetchBalance(1, '₹88000.00');
    expect((await engine.backupNow({ masterPassword: password, liveKey: a.key })).ok).toBe(true);
    await activate(b);
    const dbHeldByLogin = connection.getDb();
    const activity = await import('../../src/main/activity');
    activity.beginAutomation();
    try {
      expect(activity.activeAutomations()).toBe(1);
      // backup:runNow invokes this directly without checking activeAutomations.
      const result = await engine.backupNow({ masterPassword: password, liveKey: b.key });
      expect(result.ok).toBe(true);
      if (result.newMasterKey) b.key = result.newMasterKey;
      expect(balances()[0].balance).toBe('₹88000.00');
      expect(dbHeldByLogin.open).toBe(false);
      expect(() => dbHeldByLogin.prepare('UPDATE bank_accounts SET balance = ? WHERE id = 2'))
        .toThrow(/not open|closed/i);
    } finally {
      activity.endAutomation();
    }
  });

  it('keeps an offline device unchanged and catches up after reconnection', async () => {
    const { a, b } = await seed();
    await activate(a); fetchBalance(1, '₹44000.00');
    expect((await engine.backupNow({ masterPassword: password, liveKey: a.key })).ok).toBe(true);
    shared.online = false;
    expect((await tick(b)).action).toBe('error');
    expect(balances()[0].balance).toBe('₹100.00');
    shared.online = true;
    expect((await tick(b)).action).toBe('pulled');
    expect(balances()[0].balance).toBe('₹44000.00');
  });

  it('catches up on unlock and flushes a source change on close without the settle delay', async () => {
    const { a, b } = await seed();
    await activate(a); fetchBalance(1, '₹55000.00');
    expect((await engine.pushBeforeClose(a.key)).action).toBe('pushed');
    await activate(b);
    engine.setSyncSuspended(true);
    expect((await tick(b)).action).toBe('none');
    expect(balances()[0].balance).toBe('₹100.00');
    expect((await unlock(b)).action).toBe('pulled');
    expect(balances()[0].balance).toBe('₹55000.00');
  });
});
