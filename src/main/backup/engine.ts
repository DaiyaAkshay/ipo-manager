/**
 * Encrypted incremental backup engine.
 *
 * ── Design ──────────────────────────────────────────────────────────────────
 *
 *   <backup-root>/
 *   ├── meta.json                          (plaintext: format version, vault id)
 *   ├── blobs/
 *   │   └── <file_uuid>.enc                (document files — already encrypted
 *   │                                       with the keytar field key; copied
 *   │                                       once, referenced by many snapshots)
 *   └── snapshots/
 *       └── 2026-05-19T02-30-00.000Z/
 *           ├── vault.db                   (SQLCipher snapshot — encrypted
 *           │                               with the master-derived key)
 *           ├── field-key.bin              (field key, AES-256-GCM-encrypted
 *           │                               with the master key — lets you
 *           │                               restore on another machine)
 *           └── manifest.json              (list of file_uuids in this snap +
 *                                           timestamps/sizes)
 *
 * ── Incremental ─────────────────────────────────────────────────────────────
 * Documents (PDFs/JPEGs) are stored ONCE in /blobs/ keyed by file_uuid. Every
 * snapshot's manifest references the uuids it needs. Garbage-collect blobs
 * that no snapshot references.
 *
 * ── Multi-machine sync ──────────────────────────────────────────────────────
 * The backup root is just a folder. Point it inside OneDrive / Google Drive /
 * Dropbox and a second machine can restore from the same folder.
 */

import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
  rmSync, statSync, writeFileSync, unlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { getDataDir, getDbPath, getDb, closeDb, openDb } from '../db/connection';
import { getEncryptedDocumentPath } from '../documents/storage';
import { deriveMasterKeyFromMeta, type VaultMeta } from '../crypto/master';
import keytar from 'keytar';

const FIELD_KEYTAR_SERVICE = 'ipo-manager';
const FIELD_KEYTAR_ACCOUNT = 'field-encryption-key-v1';
const BACKUP_CONFIG_FILENAME = 'backup.config.json';
const BACKUP_STATE_FILENAME = 'backup.state.json';
const META_FILENAME = 'meta.json';
const FORMAT_VERSION = 1;

export interface BackupConfig {
  enabled: boolean;
  folder: string | null;          // user-chosen backup root
  vaultId: string;                // random id, lets restore validate it's the right vault
}

export interface BackupState {
  lastBackupAt: string | null;     // ISO timestamp of the last successful snapshot
  lastBackupError: string | null;  // last error message (if any)
  lastSnapshotId: string | null;   // folder name of the most recent snapshot
  inProgress: boolean;             // true while a backup is actively running
}

export interface SnapshotInfo {
  id: string;                      // folder name (also the ISO timestamp)
  timestamp: string;               // ISO
  dbBytes: number;
  documentCount: number;
  totalBlobBytes: number;          // sum of all blob sizes referenced
  band: 'last-24h' | 'last-7d' | 'last-30d' | 'last-6mo' | 'older';
}

interface SnapshotManifest {
  version: number;
  timestamp: string;
  dbBytes: number;
  documents: Array<{
    file_uuid: string;
    original_name: string;
    sha256: string;
    file_size: number;
  }>;
}

// ── Config / state ──────────────────────────────────────────────────────────

function getConfigPath(): string {
  return join(getDataDir(), BACKUP_CONFIG_FILENAME);
}

function getStatePath(): string {
  return join(getDataDir(), BACKUP_STATE_FILENAME);
}

export function getBackupConfig(): BackupConfig {
  try {
    if (existsSync(getConfigPath())) {
      const parsed = JSON.parse(readFileSync(getConfigPath(), 'utf8'));
      return {
        enabled: !!parsed.enabled,
        folder: typeof parsed.folder === 'string' ? parsed.folder : null,
        vaultId: typeof parsed.vaultId === 'string' && parsed.vaultId.length > 0
          ? parsed.vaultId
          : randomUUID(),
      };
    }
  } catch {
    // fallthrough — write a fresh config
  }
  const fresh: BackupConfig = { enabled: false, folder: null, vaultId: randomUUID() };
  writeFileSync(getConfigPath(), JSON.stringify(fresh, null, 2), 'utf8');
  return fresh;
}

export function setBackupConfig(patch: Partial<BackupConfig>): BackupConfig {
  const current = getBackupConfig();
  const next: BackupConfig = {
    ...current,
    ...patch,
    vaultId: current.vaultId, // never change vault id once minted
  };
  writeFileSync(getConfigPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function getBackupState(): BackupState {
  try {
    if (existsSync(getStatePath())) {
      const parsed = JSON.parse(readFileSync(getStatePath(), 'utf8'));
      return {
        lastBackupAt: parsed.lastBackupAt ?? null,
        lastBackupError: parsed.lastBackupError ?? null,
        lastSnapshotId: parsed.lastSnapshotId ?? null,
        inProgress: false, // never persist inProgress (could be stale across crashes)
      };
    }
  } catch { /* */ }
  return { lastBackupAt: null, lastBackupError: null, lastSnapshotId: null, inProgress: false };
}

let _inProgress = false;

function writeState(state: BackupState): void {
  writeFileSync(getStatePath(), JSON.stringify(state, null, 2), 'utf8');
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getRootMetaPath(root: string): string {
  return join(root, META_FILENAME);
}

function getBlobsDir(root: string): string {
  return join(root, 'blobs');
}

function getSnapshotsDir(root: string): string {
  return join(root, 'snapshots');
}

function newSnapshotId(): string {
  // ISO with colons replaced (Windows file system can't have colons)
  return new Date().toISOString().replace(/:/g, '-');
}

function parseSnapshotIdTimestamp(id: string): Date | null {
  // Reverse the colon escape
  const iso = id.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

function bandForAge(ageMs: number): SnapshotInfo['band'] {
  const h = ageMs / 3_600_000;
  if (h < 24) return 'last-24h';
  if (h < 24 * 7) return 'last-7d';
  if (h < 24 * 30) return 'last-30d';
  if (h < 24 * 180) return 'last-6mo';
  return 'older';
}

function aesEncryptBuffer(key: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // layout: [iv(12) | tag(16) | ciphertext]
  return Buffer.concat([iv, tag, enc]);
}

function aesDecryptBuffer(key: Buffer, blob: Buffer): Buffer {
  if (blob.length < 12 + 16) throw new Error('Backup blob too short to decrypt.');
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ciphertext = blob.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

async function readFieldKey(): Promise<Buffer | null> {
  const hex = await keytar.getPassword(FIELD_KEYTAR_SERVICE, FIELD_KEYTAR_ACCOUNT);
  if (!hex) return null;
  return Buffer.from(hex, 'hex');
}

async function writeFieldKey(key: Buffer): Promise<void> {
  await keytar.setPassword(FIELD_KEYTAR_SERVICE, FIELD_KEYTAR_ACCOUNT, key.toString('hex'));
}

// ── Root initialization ─────────────────────────────────────────────────────

function ensureBackupRoot(root: string, vaultId: string): void {
  ensureDir(root);
  ensureDir(getBlobsDir(root));
  ensureDir(getSnapshotsDir(root));
  const metaPath = getRootMetaPath(root);
  if (!existsSync(metaPath)) {
    writeFileSync(metaPath, JSON.stringify({
      version: FORMAT_VERSION,
      vaultId,
      createdAt: new Date().toISOString(),
    }, null, 2), 'utf8');
  }
}

// ── Snapshot creation ───────────────────────────────────────────────────────

export interface CreateSnapshotResult {
  ok: boolean;
  snapshotId?: string;
  error?: string;
  durationMs?: number;
  documentsCopied?: number;
  documentsReused?: number;
  dbBytes?: number;
}

export async function createSnapshot(masterKey: Buffer): Promise<CreateSnapshotResult> {
  if (_inProgress) {
    return { ok: false, error: 'A backup is already in progress.' };
  }

  const config = getBackupConfig();
  if (!config.enabled || !config.folder) {
    return { ok: false, error: 'Backup is not configured (folder not chosen).' };
  }

  _inProgress = true;
  const startTs = Date.now();
  const snapshotId = newSnapshotId();
  let snapshotDir = '';

  try {
    ensureBackupRoot(config.folder, config.vaultId);
    snapshotDir = join(getSnapshotsDir(config.folder), snapshotId);
    ensureDir(snapshotDir);

    // 1) DB snapshot via VACUUM INTO — consistent without closing.
    //    SQLCipher carries the encryption key into the output file, so the
    //    backup file is openable with the same master password.
    const db = getDb();
    db.pragma('wal_checkpoint(TRUNCATE)');
    const snapshotDbPath = join(snapshotDir, 'vault.db');
    if (existsSync(snapshotDbPath)) unlinkSync(snapshotDbPath);
    db.prepare(`VACUUM INTO ?`).run(snapshotDbPath);
    const dbBytes = statSync(snapshotDbPath).size;

    // 2) vault.meta.json — copy as-is. Contains the Argon2 salt + params
    //    that the master password was hashed with. Without this, a second
    //    machine can't re-derive the same master key (its own meta has a
    //    different random salt), so field-key.bin decryption would fail.
    const liveMetaPath = join(getDataDir(), 'vault.meta.json');
    if (existsSync(liveMetaPath)) {
      copyFileSync(liveMetaPath, join(snapshotDir, 'vault.meta.json'));
    }

    // 3) Field key — AES-256-GCM with master key — small file alongside the DB.
    const fieldKey = await readFieldKey();
    if (fieldKey) {
      const encryptedFieldKey = aesEncryptBuffer(masterKey, fieldKey);
      writeFileSync(join(snapshotDir, 'field-key.bin'), encryptedFieldKey);
    }

    // 3) Documents — copy any .enc file referenced by the DB into the shared
    //    blobs/ folder if not already present (incremental).
    const docs = db.prepare(`
      SELECT file_uuid, original_name, sha256, file_size FROM documents
    `).all() as Array<{ file_uuid: string; original_name: string; sha256: string; file_size: number }>;
    const blobsDir = getBlobsDir(config.folder);
    let copied = 0;
    let reused = 0;
    for (const doc of docs) {
      const src = getEncryptedDocumentPath(doc.file_uuid);
      const dst = join(blobsDir, `${doc.file_uuid}.enc`);
      if (!existsSync(src)) {
        // Document file is missing on disk — skip, don't fail the whole backup.
        continue;
      }
      if (existsSync(dst)) {
        reused += 1;
      } else {
        copyFileSync(src, dst);
        copied += 1;
      }
    }

    // 4) Manifest — tells restore which uuids belong to this snapshot.
    const manifest: SnapshotManifest = {
      version: FORMAT_VERSION,
      timestamp: new Date().toISOString(),
      dbBytes,
      documents: docs.map(d => ({
        file_uuid: d.file_uuid,
        original_name: d.original_name,
        sha256: d.sha256,
        file_size: d.file_size,
      })),
    };
    writeFileSync(join(snapshotDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    // 5) Retention sweep.
    try { pruneOldSnapshots(config.folder); } catch (e) { /* non-fatal */ }
    try { garbageCollectBlobs(config.folder); } catch (e) { /* non-fatal */ }

    const durationMs = Date.now() - startTs;
    writeState({
      lastBackupAt: new Date().toISOString(),
      lastBackupError: null,
      lastSnapshotId: snapshotId,
      inProgress: false,
    });
    return { ok: true, snapshotId, durationMs, documentsCopied: copied, documentsReused: reused, dbBytes };
  } catch (e: any) {
    const message = e?.message || String(e);
    // Best-effort cleanup of half-written snapshot dir
    try { if (snapshotDir && existsSync(snapshotDir)) rmSync(snapshotDir, { recursive: true, force: true }); } catch { /* */ }
    writeState({
      lastBackupAt: getBackupState().lastBackupAt,
      lastBackupError: message,
      lastSnapshotId: getBackupState().lastSnapshotId,
      inProgress: false,
    });
    return { ok: false, error: message };
  } finally {
    _inProgress = false;
  }
}

// ── Snapshot listing ────────────────────────────────────────────────────────

export function listSnapshots(): SnapshotInfo[] {
  const config = getBackupConfig();
  if (!config.folder || !existsSync(getSnapshotsDir(config.folder))) return [];

  const dirs = readdirSync(getSnapshotsDir(config.folder), { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);

  const now = Date.now();
  const out: SnapshotInfo[] = [];
  for (const id of dirs) {
    const ts = parseSnapshotIdTimestamp(id);
    if (!ts) continue;
    const manifestPath = join(getSnapshotsDir(config.folder), id, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    let manifest: SnapshotManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch { continue; }

    const totalBlobBytes = manifest.documents.reduce((acc, d) => acc + (d.file_size || 0), 0);
    out.push({
      id,
      timestamp: manifest.timestamp,
      dbBytes: manifest.dbBytes,
      documentCount: manifest.documents.length,
      totalBlobBytes,
      band: bandForAge(now - ts.getTime()),
    });
  }

  // Newest first
  return out.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

// ── Retention ───────────────────────────────────────────────────────────────

/**
 * Retention policy (after each backup):
 *   - Keep ALL snapshots in last 24h
 *   - Keep ONE per day in last 7 days
 *   - Keep ONE per week in last 30 days
 *   - Keep ONE per month in last 6 months
 *   - Delete anything older than 6 months
 */
function pruneOldSnapshots(root: string): void {
  const snapsDir = getSnapshotsDir(root);
  if (!existsSync(snapsDir)) return;

  const all = readdirSync(snapsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => ({ id: e.name, ts: parseSnapshotIdTimestamp(e.name)?.getTime() ?? 0 }))
    .filter(x => x.ts > 0)
    .sort((a, b) => b.ts - a.ts);  // newest first

  const now = Date.now();
  const dayMs = 86_400_000;
  const keepers = new Set<string>();

  const dayBuckets = new Map<string, string>();   // 'YYYY-MM-DD' → snapshot id
  const weekBuckets = new Map<string, string>();  // 'YYYY-WW' → snapshot id
  const monthBuckets = new Map<string, string>(); // 'YYYY-MM' → snapshot id

  for (const snap of all) {
    const ageMs = now - snap.ts;
    if (ageMs < 24 * 60 * 60 * 1000) {
      keepers.add(snap.id);
      continue;
    }
    const date = new Date(snap.ts);
    if (ageMs < 7 * dayMs) {
      const key = date.toISOString().slice(0, 10);
      if (!dayBuckets.has(key)) {
        dayBuckets.set(key, snap.id);
        keepers.add(snap.id);
      }
    } else if (ageMs < 30 * dayMs) {
      const year = date.getUTCFullYear();
      const week = Math.floor((date.getTime() - new Date(Date.UTC(year, 0, 1)).getTime()) / (7 * dayMs));
      const key = `${year}-W${week}`;
      if (!weekBuckets.has(key)) {
        weekBuckets.set(key, snap.id);
        keepers.add(snap.id);
      }
    } else if (ageMs < 180 * dayMs) {
      const key = date.toISOString().slice(0, 7);
      if (!monthBuckets.has(key)) {
        monthBuckets.set(key, snap.id);
        keepers.add(snap.id);
      }
    }
    // Older than 180d → not added to keepers → deleted below
  }

  for (const snap of all) {
    if (keepers.has(snap.id)) continue;
    try { rmSync(join(snapsDir, snap.id), { recursive: true, force: true }); } catch { /* */ }
  }
}

function garbageCollectBlobs(root: string): void {
  const referenced = new Set<string>();
  for (const info of listSnapshots()) {
    const manifestPath = join(getSnapshotsDir(root), info.id, 'manifest.json');
    try {
      const m: SnapshotManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      for (const d of m.documents) referenced.add(d.file_uuid);
    } catch { /* */ }
  }

  const blobsDir = getBlobsDir(root);
  if (!existsSync(blobsDir)) return;
  const files = readdirSync(blobsDir);
  for (const file of files) {
    if (!file.endsWith('.enc')) continue;
    const uuid = file.replace(/\.enc$/, '');
    if (!referenced.has(uuid)) {
      try { unlinkSync(join(blobsDir, file)); } catch { /* */ }
    }
  }
}

// ── Restore ─────────────────────────────────────────────────────────────────

export interface RestoreResult {
  ok: boolean;
  error?: string;
  documentsRestored?: number;
  dbBytes?: number;
}

/**
 * Restore a specific snapshot using the master PASSWORD (not the key).
 *
 * Why password and not key: the snapshot may have been created on a machine
 * with a different Argon2 salt. We read the snapshot's vault.meta.json,
 * derive the matching master key from password+salt, then proceed.
 *
 * Steps performed here:
 *   - Read snapshot's vault.meta.json → derive the snapshot-era master key
 *   - Decrypt snapshot/field-key.bin and write the field key to keytar
 *   - Copy snapshot/vault.db over <dataDir>/vault.db (with .pre-restore sidecar)
 *   - Copy snapshot/vault.meta.json over <dataDir>/vault.meta.json
 *   - Copy each referenced blob into <dataDir>/documents/<file_uuid>.enc
 *   - Re-open the DB with the snapshot-era master key
 */
export async function restoreSnapshot(
  snapshotId: string,
  masterPassword: string,
  options?: { sourceFolder?: string }   // optional override (e.g. restoring from another machine's folder)
): Promise<RestoreResult> {
  const config = getBackupConfig();
  const root = options?.sourceFolder || config.folder;
  if (!root) return { ok: false, error: 'No backup folder configured.' };
  if (!masterPassword) return { ok: false, error: 'Master password is required to restore.' };

  const snapshotDir = join(getSnapshotsDir(root), snapshotId);
  if (!existsSync(snapshotDir)) return { ok: false, error: 'Snapshot not found.' };

  const snapshotDbPath = join(snapshotDir, 'vault.db');
  const manifestPath = join(snapshotDir, 'manifest.json');
  const fieldKeyPath = join(snapshotDir, 'field-key.bin');
  const snapshotMetaPath = join(snapshotDir, 'vault.meta.json');
  if (!existsSync(snapshotDbPath) || !existsSync(manifestPath)) {
    return { ok: false, error: 'Snapshot is corrupt (missing vault.db or manifest.json).' };
  }

  let manifest: SnapshotManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e: any) {
    return { ok: false, error: `Manifest parse failed: ${e.message || e}` };
  }

  // Read the snapshot's vault.meta.json so we derive the SAME master key the
  // snapshot was encrypted with. Without this, a second machine's local salt
  // would produce a different key and field-key.bin decryption would fail.
  let snapshotMeta: VaultMeta | null = null;
  if (existsSync(snapshotMetaPath)) {
    try {
      snapshotMeta = JSON.parse(readFileSync(snapshotMetaPath, 'utf8')) as VaultMeta;
    } catch (e: any) {
      return { ok: false, error: `Snapshot vault.meta.json parse failed: ${e.message || e}` };
    }
  } else {
    return {
      ok: false,
      error: 'This snapshot was created with an older build that did not include vault.meta.json. ' +
        'Take a fresh backup on the source machine first, then restore.'
    };
  }

  // Derive the snapshot-era master key from the password + snapshot's salt.
  let snapshotMasterKey: Buffer;
  try {
    snapshotMasterKey = await deriveMasterKeyFromMeta(masterPassword, snapshotMeta);
  } catch (e: any) {
    return { ok: false, error: `Key derivation failed: ${e?.message || e}` };
  }

  try {
    // 1) Decrypt the field key BEFORE touching anything on disk — that way if
    //    the password is wrong we abort cleanly without corrupting state.
    let fieldKey: Buffer | null = null;
    if (existsSync(fieldKeyPath)) {
      const encryptedFieldKey = readFileSync(fieldKeyPath);
      try {
        fieldKey = aesDecryptBuffer(snapshotMasterKey, encryptedFieldKey);
      } catch (e: any) {
        return {
          ok: false,
          error: 'Master password does not match this snapshot. ' +
            'If you set up the vault on this machine with a different password, ' +
            'use the same password the snapshot was created with.'
        };
      }
    }

    // 2) Restore the DB. Move the existing DB to a .pre-restore-<ts> sidecar
    //    so the user can roll back manually if something goes wrong.
    const targetDbPath = getDbPath();
    closeDb();
    if (existsSync(targetDbPath)) {
      const stamp = new Date().toISOString().replace(/:/g, '-');
      const sidecar = `${targetDbPath}.pre-restore-${stamp}`;
      try { renameSync(targetDbPath, sidecar); } catch { /* */ }
    }
    copyFileSync(snapshotDbPath, targetDbPath);
    const dbBytes = statSync(targetDbPath).size;

    // 3) Restore the meta file (so future unlocks on this machine derive the
    //    same key as the snapshot was encrypted with).
    const liveMetaPath = join(getDataDir(), 'vault.meta.json');
    if (existsSync(liveMetaPath)) {
      const stamp = new Date().toISOString().replace(/:/g, '-');
      try { renameSync(liveMetaPath, `${liveMetaPath}.pre-restore-${stamp}`); } catch { /* */ }
    }
    copyFileSync(snapshotMetaPath, liveMetaPath);

    // 4) Write the field key into OS keychain.
    if (fieldKey) await writeFieldKey(fieldKey);

    // 5) Restore documents from blobs/ → <dataDir>/documents/
    const dataDocsDir = ensureDir(join(getDataDir(), 'documents'));
    const blobsDir = getBlobsDir(root);
    let restored = 0;
    for (const doc of manifest.documents) {
      const src = join(blobsDir, `${doc.file_uuid}.enc`);
      if (!existsSync(src)) continue;
      const dst = join(dataDocsDir, `${doc.file_uuid}.enc`);
      ensureDir(dirname(dst));
      copyFileSync(src, dst);
      restored += 1;
    }

    // 6) Re-open the DB with the snapshot-era master key.
    openDb(snapshotMasterKey);

    return { ok: true, documentsRestored: restored, dbBytes };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** Convenience: pick the latest snapshot id from a folder (own folder by default). */
export function latestSnapshotId(sourceFolder?: string): string | null {
  const root = sourceFolder || getBackupConfig().folder;
  if (!root) return null;
  const snapsDir = getSnapshotsDir(root);
  if (!existsSync(snapsDir)) return null;
  const ids = readdirSync(snapsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort((a, b) => b.localeCompare(a));
  return ids[0] || null;
}

// ── Auto-sync on unlock ──────────────────────────────────────────────────────
// Called immediately after vault:unlock. If the configured backup folder
// contains a snapshot NEWER than this machine's last backup, silently restore
// it so both machines stay in sync via a shared cloud folder.

export interface AutoSyncResult {
  synced: boolean;
  newMasterKey?: Buffer;   // updated key if the snapshot had a different Argon2 salt
  snapshotTimestamp?: string;
  error?: string;
}

export async function autoSyncFromBackup(masterPassword: string): Promise<AutoSyncResult> {
  const config = getBackupConfig();
  if (!config.enabled || !config.folder) return { synced: false };
  if (_inProgress) return { synced: false };
  if (!existsSync(config.folder)) return { synced: false };

  const latest = latestSnapshotId(config.folder);
  if (!latest) return { synced: false };

  const snapsDir = getSnapshotsDir(config.folder);
  const manifestPath = join(snapsDir, latest, 'manifest.json');
  if (!existsSync(manifestPath)) return { synced: false };

  let manifest: SnapshotManifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch { return { synced: false }; }

  const snapshotTime = new Date(manifest.timestamp).getTime();
  const state = getBackupState();
  const localLastBackup = state.lastBackupAt ? new Date(state.lastBackupAt).getTime() : 0;

  // Nothing to do — our local data is already as new as the latest snapshot.
  if (snapshotTime <= localLastBackup) return { synced: false };

  // Read the snapshot's vault.meta.json to derive the correct master key.
  const snapshotMetaPath = join(snapsDir, latest, 'vault.meta.json');
  if (!existsSync(snapshotMetaPath)) return { synced: false, error: 'Snapshot missing vault.meta.json' };

  let snapshotMeta: VaultMeta;
  try { snapshotMeta = JSON.parse(readFileSync(snapshotMetaPath, 'utf8')) as VaultMeta; }
  catch { return { synced: false }; }

  // Derive the snapshot-era key so we can return it to the caller (ipc.ts keeps
  // currentMasterKey in memory; after restore the DB uses this key).
  let snapshotMasterKey: Buffer;
  try { snapshotMasterKey = await deriveMasterKeyFromMeta(masterPassword, snapshotMeta); }
  catch (e: any) { return { synced: false, error: `Key derivation: ${e?.message || e}` }; }

  const result = await restoreSnapshot(latest, masterPassword);
  if (!result.ok) return { synced: false, error: result.error };

  // Update local state to match the restored snapshot so the next unlock won't
  // try to restore the same snapshot again.
  writeState({
    lastBackupAt: manifest.timestamp,
    lastBackupError: null,
    lastSnapshotId: latest,
    inProgress: false,
  });

  return { synced: true, newMasterKey: snapshotMasterKey, snapshotTimestamp: manifest.timestamp };
}

// ── Reporter used by the IPC layer ──────────────────────────────────────────

export function getCurrentInProgress(): boolean {
  return _inProgress;
}
