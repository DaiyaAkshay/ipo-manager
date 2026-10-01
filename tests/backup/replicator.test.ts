/**
 * R2 replicator — two PCs sharing one bucket, simulated with temp folders and
 * an in-memory object store. Covers the rules that decide what gets deleted.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  replicate, copyBackupTree, emptyReplicationState, ORPHAN_BLOB_GRACE_MS, type ReplicationState,
} from '../../src/main/backup/replicator';
import { normalizePrefix, parseListObjectsV2, testObjectStore, validateR2Settings, type ObjectStore, type StoredObject } from '../../src/main/backup/objectStore';

class MemoryStore implements ObjectStore {
  objects = new Map<string, { body: Buffer; lastModified: number }>();
  log: string[] = [];
  refuseDeletes = false;
  /** Bucket lock: refuse overwrites and deletes. */
  locked = false;
  now = Date.now();
  async list(prefix: string): Promise<StoredObject[]> {
    return [...this.objects].filter(([k]) => k.startsWith(prefix))
      .map(([key, o]) => ({ key, size: o.body.length, lastModified: o.lastModified }));
  }
  async get(key: string): Promise<Buffer> {
    const o = this.objects.get(key);
    if (!o) throw new Error(`404 ${key}`);
    return Buffer.from(o.body);
  }
  async put(key: string, body: Buffer): Promise<void> {
    if (this.locked && this.objects.has(key)) throw new Error('403 ObjectLockedByBucketPolicy');
    this.log.push(`put ${key}`);
    this.objects.set(key, { body: Buffer.from(body), lastModified: this.now });
  }
  async delete(key: string): Promise<void> {
    if (this.refuseDeletes || this.locked) throw new Error('403 ObjectLocked');
    this.log.push(`delete ${key}`);
    this.objects.delete(key);
  }
}

const P = 'ipo-manager';
let dirs: string[] = [];
function tmp(name: string): string {
  const d = mkdtempSync(join(tmpdir(), `ipo-r2-${name}-`));
  dirs.push(d);
  return d;
}

/** Write a complete snapshot the way the engine does (manifest last). */
function writeSnapshot(root: string, id: string, docs: string[] = [], db = `db-${id}`): void {
  const dir = join(root, 'snapshots', id);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, 'blobs'), { recursive: true });
  for (const uuid of docs) {
    const blob = join(root, 'blobs', `${uuid}.enc`);
    if (!existsSync(blob)) writeFileSync(blob, `blob-${uuid}`);
  }
  writeFileSync(join(dir, 'vault.db'), db);
  writeFileSync(join(dir, 'vault.meta.json'), '{"saltHex":"00"}');
  writeFileSync(join(dir, 'field-key.bin'), 'fk');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    version: 1, timestamp: id, dbBytes: db.length,
    documents: docs.map(u => ({ file_uuid: u, original_name: 'x.pdf', sha256: '', file_size: 1 })),
  }));
}

const snaps = (root: string) => existsSync(join(root, 'snapshots')) ? readdirSync(join(root, 'snapshots')).sort() : [];
const S1 = '2026-09-01T10-00-00.000Z';
const S2 = '2026-09-01T11-00-00.000Z';
const S3 = '2026-09-01T12-00-00.000Z';

let store: MemoryStore;
let pcA: string;
let pcB: string;
let stA: ReplicationState;
let stB: ReplicationState;

async function passA(now = store.now) { const r = await replicate(pcA, store, P, stA, now); stA = r.state; return r; }
async function passB(now = store.now) { const r = await replicate(pcB, store, P, stB, now); stB = r.state; return r; }

beforeEach(() => {
  store = new MemoryStore();
  pcA = tmp('A');
  pcB = tmp('B');
  stA = emptyReplicationState();
  stB = emptyReplicationState();
});

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('backup/replicator', () => {
  it('uploads blobs first and the manifest last', async () => {
    writeSnapshot(pcA, S1, ['doc-1']);
    const r = await passA();
    expect(r.uploadedSnapshots).toEqual([S1]);
    const puts = store.log.filter(l => l.startsWith('put'));
    expect(puts[0]).toBe(`put ${P}/blobs/doc-1.enc`);
    expect(puts.at(-1)).toBe(`put ${P}/snapshots/${S1}/manifest.json`);
    expect(stA.synced).toEqual([S1]);
  });

  it('second PC downloads complete snapshots with their documents', async () => {
    writeSnapshot(pcA, S1, ['doc-1']);
    await passA();
    const r = await passB();
    expect(r.downloadedSnapshots).toEqual([S1]);
    expect(readFileSync(join(pcB, 'snapshots', S1, 'vault.db'), 'utf8')).toBe(`db-${S1}`);
    expect(existsSync(join(pcB, 'blobs', 'doc-1.enc'))).toBe(true);
    expect(stB.synced).toEqual([S1]);
    // Nothing to do on a second pass.
    store.log = [];
    await passB();
    expect(store.log).toEqual([]);
  });

  it('mirrors another PC\'s in-progress upload as an empty (pending) folder', async () => {
    await store.put(`${P}/snapshots/${S2}/vault.db`, Buffer.from('half'));
    await passB();
    expect(snaps(pcB)).toEqual([S2]);
    expect(readdirSync(join(pcB, 'snapshots', S2))).toEqual([]);
    // Upload finishes → next pass downloads it.
    await store.put(`${P}/snapshots/${S2}/vault.meta.json`, Buffer.from('{}'));
    await store.put(`${P}/snapshots/${S2}/manifest.json`, Buffer.from(JSON.stringify({ documents: [] })));
    const r = await passB();
    expect(r.downloadedSnapshots).toEqual([S2]);
  });

  it('ignores and finally cleans up an abandoned partial upload', async () => {
    await store.put(`${P}/snapshots/${S2}/vault.db`, Buffer.from('half'));
    await passB(store.now + 60 * 60 * 1000);
    expect(snaps(pcB)).toEqual([]);
    await passB(store.now + 25 * 3_600_000);
    expect([...store.objects.keys()].some(k => k.includes(S2))).toBe(false);
  });

  it('propagates a local prune to the bucket and on to the other PC', async () => {
    writeSnapshot(pcA, S1);
    writeSnapshot(pcA, S2);
    await passA();
    await passB();
    expect(snaps(pcB)).toEqual([S1, S2]);

    rmSync(join(pcA, 'snapshots', S1), { recursive: true }); // engine retention on PC A
    const r = await passA();
    expect(r.deletedRemote).toEqual([S1]);
    const rb = await passB();
    expect(rb.deletedLocal).toEqual([S1]);
    expect(snaps(pcB)).toEqual([S2]);
  });

  it('never re-downloads a pruned snapshot while a bucket lock refuses the delete', async () => {
    writeSnapshot(pcA, S1);
    writeSnapshot(pcA, S2);
    await passA();
    store.refuseDeletes = true;
    rmSync(join(pcA, 'snapshots', S1), { recursive: true });
    const r = await passA();
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(Object.keys(stA.tombstones)).toEqual([S1]);
    await passA();
    expect(snaps(pcA)).toEqual([S2]);
    // Lock expires → the retry (after the back-off) deletes it.
    store.refuseDeletes = false;
    const later = await passA(store.now + 7 * 3_600_000);
    expect(later.deletedRemote).toEqual([S1]);
    expect(stA.tombstones).toEqual({});
  });

  it('resumes an interrupted upload under a bucket lock without overwriting', async () => {
    writeSnapshot(pcA, S1, ['doc-1']);
    store.locked = true;
    // A crashed earlier pass got vault.db and the blob up, but not the rest.
    await store.put(`${P}/blobs/doc-1.enc`, Buffer.from('blob-doc-1'));
    await store.put(`${P}/snapshots/${S1}/vault.db`, Buffer.from(`db-${S1}`));
    const r = await passA();
    expect(r.uploadedSnapshots).toEqual([S1]);
    expect(store.objects.has(`${P}/snapshots/${S1}/manifest.json`)).toBe(true);
    expect(stA.synced).toEqual([S1]);
  });

  it('connection test passes repeatedly under a bucket lock', async () => {
    store.locked = true;
    expect((await testObjectStore(store, P)).ok).toBe(true);
    await new Promise(res => setTimeout(res, 2));
    expect((await testObjectStore(store, P)).ok).toBe(true);
  });

  it('does not delete local snapshots when the bucket looks empty', async () => {
    writeSnapshot(pcB, S1);
    await passB();
    store.objects.clear(); // wiped bucket / wrong prefix
    const r = await passB();
    expect(r.deletedLocal).toEqual([]);
    expect(snaps(pcB)).toEqual([S1]);
    expect(r.uploadedSnapshots).toEqual([S1]); // and it re-seeds the bucket
  });

  it('deletes an unreferenced remote document only after the grace period', async () => {
    writeSnapshot(pcA, S1, ['old-doc']);
    await passA();
    writeSnapshot(pcA, S2, []);
    rmSync(join(pcA, 'snapshots', S1), { recursive: true });
    await passA();
    expect(store.objects.has(`${P}/blobs/old-doc.enc`)).toBe(true);
    await passA(store.now + ORPHAN_BLOB_GRACE_MS + 1000);
    expect(store.objects.has(`${P}/blobs/old-doc.enc`)).toBe(false);
  });

  it('keeps a document that becomes referenced again during the grace period', async () => {
    writeSnapshot(pcA, S1, ['doc']);
    await passA();
    writeSnapshot(pcA, S2, []);
    rmSync(join(pcA, 'snapshots', S1), { recursive: true });
    await passA();
    writeSnapshot(pcA, S3, ['doc']);
    await passA(store.now + ORPHAN_BLOB_GRACE_MS + 1000);
    expect(store.objects.has(`${P}/blobs/doc.enc`)).toBe(true);
    expect(stA.orphanBlobsSince).toEqual({});
  });
});

describe('backup/replicator copyBackupTree', () => {
  it('seeds and mirrors, pruning only when the source has snapshots', () => {
    const src = tmp('src');
    const dst = tmp('dst');
    writeSnapshot(src, S1, ['d1']);
    writeSnapshot(src, S2, ['d2']);
    expect(copyBackupTree(src, dst, { prune: true }).copiedSnapshots).toBe(2);
    rmSync(join(src, 'snapshots', S1), { recursive: true });
    rmSync(join(src, 'blobs', 'd1.enc'));
    copyBackupTree(src, dst, { prune: true });
    expect(snaps(dst)).toEqual([S2]);
    expect(readdirSync(join(dst, 'blobs'))).toEqual(['d2.enc']);
    // Empty source → mirror untouched.
    rmSync(join(src, 'snapshots'), { recursive: true });
    copyBackupTree(src, dst, { prune: true });
    expect(snaps(dst)).toEqual([S2]);
  });
});

describe('backup/objectStore', () => {
  it('parses ListObjectsV2 pages', () => {
    const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated>
      <Contents><Key>ipo-manager/a&amp;b.enc</Key><Size>12</Size><LastModified>2026-09-01T10:00:00.000Z</LastModified></Contents>
      <Contents><Key>ipo-manager/meta.json</Key><Size>3</Size><LastModified>bad</LastModified></Contents>
      <NextContinuationToken>tok/123=</NextContinuationToken></ListBucketResult>`;
    const page = parseListObjectsV2(xml);
    expect(page.objects).toEqual([
      { key: 'ipo-manager/a&b.enc', size: 12, lastModified: Date.parse('2026-09-01T10:00:00.000Z') },
      { key: 'ipo-manager/meta.json', size: 3, lastModified: 0 },
    ]);
    expect(page.nextToken).toBe('tok/123=');
    expect(parseListObjectsV2('<IsTruncated>false</IsTruncated>').nextToken).toBeNull();
  });

  it('validates settings and the bucket folder', () => {
    expect(validateR2Settings({ accountId: 'nope' })).toMatch(/Account ID/);
    expect(validateR2Settings({
      accountId: 'a'.repeat(32), bucket: 'ipo-backups', accessKeyId: 'k'.repeat(32), secretAccessKey: 's'.repeat(64),
    })).toBeNull();
    expect(normalizePrefix('')).toBe('ipo-manager');
    expect(normalizePrefix('/office/ipo/')).toBe('office/ipo');
    expect(() => normalizePrefix('a/../b')).toThrow();
  });

  it('connection test reports a bucket lock as a note, not a failure', async () => {
    const s = new MemoryStore();
    s.refuseDeletes = true;
    const r = await testObjectStore(s, P);
    expect(r.ok).toBe(true);
    expect('note' in r && r.note).toMatch(/bucket lock/);
  });
});
