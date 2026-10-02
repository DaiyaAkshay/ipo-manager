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
 *           ├── vault.db                   (SQLite3MC ChaCha20-Poly1305 snapshot
 *           │                               — encrypted with the master-derived key)
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
 * Dropbox and every PC using it stays in sync:
 *   - PULL on unlock and every ~30s while unlocked: if another PC pushed a
 *     snapshot built on this PC's data, take it (fast-forward).
 *   - PUSH ~90s after local changes settle, and on lock/quit — but only when
 *     the folder's newest snapshot is the one this PC is based on.
 *   - Otherwise (both PCs changed data, or histories diverged) nothing is
 *     overwritten: the conflict is recorded and the user chooses which copy
 *     wins. Decision logic lives in syncPolicy.ts (pure, unit-tested).
 * Each manifest records the source PC, app version and snapshot lineage.
 */

import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
  rmSync, statSync, writeFileSync, unlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { hostname } from 'node:os';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3-multiple-ciphers';
import { getDataDir, getDbPath, getDb, closeDb, openDb } from '../db/connection';
import { getEncryptedDocumentPath } from '../documents/storage';
import { deriveMasterKeyFromMeta, getVaultMeta, type VaultMeta } from '../crypto/master';
import { clearKeyCache as clearFieldKeyCache } from '../crypto/field';
import {
  decideSync, isDirty, monotonicSnapshotTime, nextAncestors, pickHead, selectSnapshotsToKeep,
  MAX_LINEAGE, type ConflictReason, type Head, type HeadCandidate, type SyncDecision,
} from './syncPolicy';
import { copyBackupTree, emptyReplicationState, replicate, type ReplicationState } from './replicator';
import { R2Store, normalizePrefix, testObjectStore } from './objectStore';
import keytar from 'keytar';

const FIELD_KEYTAR_SERVICE = 'ipo-manager';
const FIELD_KEYTAR_ACCOUNT = 'field-encryption-key-v1';
const BACKUP_CONFIG_FILENAME = 'backup.config.json';
const BACKUP_STATE_FILENAME = 'backup.state.json';
const META_FILENAME = 'meta.json';
const FORMAT_VERSION = 1;

export type BackupTarget = 'folder' | 'r2';

/** Non-secret R2 settings. The secret access key lives in the OS keychain. */
export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  /** Folder inside the bucket, e.g. "ipo-manager". */
  prefix: string;
}

export interface BackupConfig {
  enabled: boolean;
  /** Where snapshots go: a synced folder (Google Drive etc.) or Cloudflare R2. */
  target: BackupTarget;
  folder: string | null;          // user-chosen backup root (target 'folder')
  r2: R2Config | null;            // target 'r2'
  /** Optional extra copy (USB disk, NAS, cloud folder), refreshed after each upload. */
  mirrorFolder: string | null;
  vaultId: string;                // random id, lets restore validate it's the right vault
}

export interface SyncConflict {
  detectedAt: string;
  reason: ConflictReason;
  remoteSnapshotId: string;
  remoteHost: string | null;
  remoteTimestamp: string | null;
  localBaseSnapshotId: string | null;
}

export interface BackupState {
  lastBackupAt: string | null;     // ISO timestamp of the last successful push (snapshot)
  lastBackupError: string | null;  // last push error message (if any)
  lastSnapshotId: string | null;   // this PC's base: the snapshot it last pushed or pulled
  inProgress: boolean;             // true while a backup is actively running
  /** sha256 of the local vault.db right after the last push/pull — detects unsynced local edits. */
  lastSyncedDbHash: string | null;
  /** [lastSnapshotId, ...its ancestors], newest first — written into the next snapshot's manifest. */
  lineage: string[];
  lastPullAt: string | null;
  lastPullSourceHost: string | null;
  /** Last sync problem to show the user (null when healthy). */
  lastSyncError: string | null;
  /** Set when both sides changed; nothing is pushed or pulled until the user chooses. */
  conflict: SyncConflict | null;
  /** Last problem refreshing the extra-copy folder (null when fine or not set). */
  lastMirrorError: string | null;
}

export interface SnapshotInfo {
  id: string;                      // folder name (also the ISO timestamp)
  timestamp: string;               // ISO
  dbBytes: number;
  documentCount: number;
  totalBlobBytes: number;          // sum of all blob sizes referenced
  band: 'last-24h' | 'last-7d' | 'last-30d' | 'last-6mo' | 'older';
  sourceHost: string | null;       // PC that wrote it (null for snapshots from older builds)
  appVersion: string | null;
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
  // Added in 0.3.7 — optional so snapshots from older builds still parse.
  sourceHost?: string;
  appVersion?: string;
  dbSha256?: string;
  parentSnapshotId?: string | null;
  ancestors?: string[];
  supersedes?: string[];
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
      const r2 = parsed.r2 && typeof parsed.r2 === 'object'
        && typeof parsed.r2.accountId === 'string' && typeof parsed.r2.bucket === 'string'
        && typeof parsed.r2.accessKeyId === 'string'
        ? { accountId: parsed.r2.accountId, bucket: parsed.r2.bucket, accessKeyId: parsed.r2.accessKeyId, prefix: safePrefix(parsed.r2.prefix) }
        : null;
      return {
        enabled: !!parsed.enabled,
        target: parsed.target === 'r2' && r2 ? 'r2' : 'folder',
        folder: typeof parsed.folder === 'string' ? parsed.folder : null,
        r2,
        mirrorFolder: typeof parsed.mirrorFolder === 'string' && parsed.mirrorFolder ? parsed.mirrorFolder : null,
        vaultId: typeof parsed.vaultId === 'string' && parsed.vaultId.length > 0
          ? parsed.vaultId
          : randomUUID(),
      };
    }
  } catch {
    // fallthrough — write a fresh config
  }
  const fresh: BackupConfig = { enabled: false, target: 'folder', folder: null, r2: null, mirrorFolder: null, vaultId: randomUUID() };
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
  if (next.target === 'r2' && !next.r2) next.target = 'folder';
  writeFileSync(getConfigPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function safePrefix(prefix: unknown): string {
  try { return normalizePrefix(typeof prefix === 'string' ? prefix : null); } catch { return 'ipo-manager'; }
}

/** Has the user chosen where backups go? */
export function isBackupConfigured(config: BackupConfig = getBackupConfig()): boolean {
  return config.target === 'r2' ? !!config.r2 : !!config.folder;
}

/**
 * The folder the engine reads and writes snapshots in. For R2 that is a local
 * cache the replicator keeps in step with the bucket — which also leaves a
 * full local backup history on this PC.
 */
export function getActiveRoot(config: BackupConfig = getBackupConfig()): string | null {
  if (config.target === 'r2') return config.r2 ? join(getDataDir(), R2_CACHE_DIRNAME) : null;
  return config.folder;
}

// ── Cloudflare R2 ───────────────────────────────────────────────────────────

const R2_SECRET_KEYTAR_ACCOUNT = 'r2-secret-access-key-v1';
const R2_CACHE_DIRNAME = 'r2-cache';
const R2_STATE_FILENAME = 'r2.state.json';
/** The extra copy goes in its own subfolder so it can never mix with a folder another PC syncs from. */
export const MIRROR_SUBFOLDER = 'IPO Manager backup copy';

export async function setR2Secret(secret: string): Promise<void> {
  await keytar.setPassword(FIELD_KEYTAR_SERVICE, R2_SECRET_KEYTAR_ACCOUNT, secret.trim());
}

export async function hasR2Secret(): Promise<boolean> {
  return !!(await keytar.getPassword(FIELD_KEYTAR_SERVICE, R2_SECRET_KEYTAR_ACCOUNT).catch(() => null));
}

async function openR2Store(r2: R2Config, secretOverride?: string): Promise<R2Store> {
  const secretAccessKey = secretOverride || await keytar.getPassword(FIELD_KEYTAR_SERVICE, R2_SECRET_KEYTAR_ACCOUNT);
  if (!secretAccessKey) throw new Error('The R2 secret key is missing from this PC\'s keychain — enter it again in Backup & Sync.');
  return new R2Store({ ...r2, secretAccessKey });
}

/** Check credentials before saving them (list, write, read back, delete). */
export async function testR2(r2: R2Config, secret: string | undefined) {
  try {
    return await testObjectStore(await openR2Store(r2, secret), r2.prefix);
  } catch (e: any) {
    return { ok: false as const, error: e?.message || String(e) };
  }
}

interface R2Status extends ReplicationState {
  lastOkAt: string | null;
  lastError: string | null;
  lastWarning: string | null;
  /** Bucket + prefix the state belongs to — a different bucket starts fresh. */
  target: string | null;
}

function r2TargetId(r2: R2Config): string {
  return `${r2.accountId}/${r2.bucket}/${r2.prefix}`;
}

function getR2Status(): R2Status {
  const blank: R2Status = { ...emptyReplicationState(), lastOkAt: null, lastError: null, lastWarning: null, target: null };
  try {
    const p = join(getDataDir(), R2_STATE_FILENAME);
    if (!existsSync(p)) return blank;
    const s = JSON.parse(readFileSync(p, 'utf8'));
    return {
      synced: Array.isArray(s.synced) ? s.synced.filter((x: unknown) => typeof x === 'string') : [],
      tombstones: s.tombstones && typeof s.tombstones === 'object' ? s.tombstones : {},
      orphanBlobsSince: s.orphanBlobsSince && typeof s.orphanBlobsSince === 'object' ? s.orphanBlobsSince : {},
      lastOkAt: s.lastOkAt ?? null,
      lastError: s.lastError ?? null,
      lastWarning: s.lastWarning ?? null,
      target: s.target ?? null,
    };
  } catch {
    return blank;
  }
}

function saveR2Status(next: R2Status): void {
  writeFileSync(join(getDataDir(), R2_STATE_FILENAME), JSON.stringify(next, null, 2), 'utf8');
}

/**
 * Bring the R2 cache and the bucket in step. Callers hold _inProgress (or
 * are about to check it), so this never runs alongside a snapshot or restore.
 */
async function replicateR2(config: BackupConfig): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!config.r2) return { ok: false, error: 'Cloudflare R2 is not configured.' };
  const root = getActiveRoot(config)!;
  const prev = getR2Status();
  const target = r2TargetId(config.r2);
  const base: ReplicationState = prev.target === target ? prev : emptyReplicationState();
  try {
    const store = await openR2Store(config.r2);
    const report = await replicate(root, store, config.r2.prefix, base);
    saveR2Status({
      ...report.state,
      lastOkAt: new Date().toISOString(),
      lastError: null,
      lastWarning: report.warnings[0] ?? null,
      target,
    });
    if (report.uploadedSnapshots.length || report.downloadedSnapshots.length) {
      console.log(`[Sync] R2: uploaded ${report.uploadedSnapshots.length}, downloaded ${report.downloadedSnapshots.length} snapshot(s)`);
    }
    return { ok: true };
  } catch (e: any) {
    const error = e?.name === 'TimeoutError' ? 'the connection timed out' : (e?.message || String(e));
    saveR2Status({ ...prev, lastError: error });
    return { ok: false, error };
  }
}

/** Refresh the optional extra-copy folder. Never fails the backup. */
function refreshMirror(config: BackupConfig): void {
  const root = getActiveRoot(config);
  if (!config.mirrorFolder || !root) return;
  const state = getBackupState();
  try {
    if (!existsSync(config.mirrorFolder)) throw new Error(`folder not found: ${config.mirrorFolder} (drive unplugged?)`);
    copyBackupTree(root, join(config.mirrorFolder, MIRROR_SUBFOLDER), { prune: true });
    if (state.lastMirrorError) updateState({ lastMirrorError: null });
  } catch (e: any) {
    updateState({ lastMirrorError: `Extra copy not updated: ${e?.message || e}` });
  }
}

/**
 * Switch this PC to R2. With `seedFrom`, copy an existing backup folder's
 * history (e.g. the Google Drive folder) into the R2 cache first, so the
 * bucket starts with it and the sync lineage carries on unbroken.
 */
export async function enableR2(r2: R2Config, opts: { seedFrom?: string | null }): Promise<{ ok: true; seeded: number } | { ok: false; error: string }> {
  if (_inProgress) return { ok: false, error: 'A backup is running — try again in a moment.' };
  _inProgress = true;
  try {
    const config = setBackupConfig({ target: 'r2', r2, enabled: true });
    let seeded = 0;
    if (opts.seedFrom && existsSync(join(opts.seedFrom, 'snapshots'))) {
      seeded = copyBackupTree(opts.seedFrom, getActiveRoot(config)!, { prune: false }).copiedSnapshots;
    }
    const rep = await replicateR2(config);
    return rep.ok ? { ok: true, seeded } : { ok: false, error: `Saved, but the first upload failed: ${rep.error}` };
  } finally {
    _inProgress = false;
  }
}

function emptyState(): BackupState {
  return {
    lastBackupAt: null, lastBackupError: null, lastSnapshotId: null, inProgress: false,
    lastSyncedDbHash: null, lineage: [], lastPullAt: null, lastPullSourceHost: null,
    lastSyncError: null, conflict: null, lastMirrorError: null,
  };
}

export function getBackupState(): BackupState {
  try {
    if (existsSync(getStatePath())) {
      const parsed = JSON.parse(readFileSync(getStatePath(), 'utf8'));
      return {
        ...emptyState(),
        lastBackupAt: parsed.lastBackupAt ?? null,
        lastBackupError: parsed.lastBackupError ?? null,
        lastSnapshotId: parsed.lastSnapshotId ?? null,
        inProgress: false, // never persist inProgress (could be stale across crashes)
        lastSyncedDbHash: typeof parsed.lastSyncedDbHash === 'string' ? parsed.lastSyncedDbHash : null,
        lineage: Array.isArray(parsed.lineage) ? parsed.lineage.filter((x: unknown) => typeof x === 'string') : [],
        lastPullAt: parsed.lastPullAt ?? null,
        lastPullSourceHost: parsed.lastPullSourceHost ?? null,
        lastSyncError: parsed.lastSyncError ?? null,
        conflict: parsed.conflict && typeof parsed.conflict.remoteSnapshotId === 'string' ? parsed.conflict : null,
        lastMirrorError: parsed.lastMirrorError ?? null,
      };
    }
  } catch { /* */ }
  return emptyState();
}

let _inProgress = false;

/** Merge a patch into the persisted state (never clobbers fields it doesn't name). */
function updateState(patch: Partial<BackupState>): BackupState {
  const next: BackupState = { ...getBackupState(), ...patch, inProgress: false };
  writeFileSync(getStatePath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// ── Fingerprints ────────────────────────────────────────────────────────────

function sha256File(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * sha256 of the live vault.db file. SQLite3MC writes committed changes straight
 * into the file (no WAL), so this changes exactly when data changes — the
 * basis for "does this PC have edits the other PC hasn't seen?".
 */
export function getLocalDbHash(): string | null {
  return existsSync(getDbPath()) ? sha256File(getDbPath()) : null;
}

function appVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    return app?.getVersion?.() || 'unknown';
  } catch {
    return 'unknown';
  }
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

function newSnapshotId(atMs: number = Date.now()): string {
  // ISO with colons replaced (Windows file system can't have colons)
  return new Date(atMs).toISOString().replace(/:/g, '-');
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

export interface CreateSnapshotOptions {
  /** Snapshots this push deliberately replaces (a conflict resolved as "keep this PC's data"). */
  supersedes?: string[];
}

function readManifestAncestors(root: string, snapshotId: string): string[] {
  try {
    const m = JSON.parse(readFileSync(join(getSnapshotsDir(root), snapshotId, 'manifest.json'), 'utf8'));
    return Array.isArray(m?.ancestors) ? m.ancestors.filter((x: unknown) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export async function createSnapshot(masterKey: Buffer, opts: CreateSnapshotOptions = {}): Promise<CreateSnapshotResult> {
  if (_inProgress) {
    return { ok: false, error: 'A backup is already in progress.' };
  }

  const config = getBackupConfig();
  const root = getActiveRoot(config);
  if (!config.enabled || !root) {
    return { ok: false, error: 'Backup is not configured (folder not chosen).' };
  }

  _inProgress = true;
  const startTs = Date.now();
  const state = getBackupState();
  let snapshotId = '';
  let snapshotDir = '';

  try {
    ensureBackupRoot(root, config.vaultId);
    // Never sort before the head we're building on, even if this PC's clock
    // runs behind the PC that wrote it.
    const headId = latestSnapshotId(root);
    const headTime = headId ? (parseSnapshotIdTimestamp(headId)?.getTime() ?? null) : null;
    snapshotId = newSnapshotId(monotonicSnapshotTime(startTs, headTime));
    snapshotDir = join(getSnapshotsDir(root), snapshotId);
    ensureDir(snapshotDir);

    // 1) DB snapshot via VACUUM INTO — consistent without closing.
    //    SQLite3MC carries the cipher (chacha20) and key into the output file,
    //    so the backup file is openable with the same master password.
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
    const blobsDir = getBlobsDir(root);
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

    // 4) Lineage — the history this snapshot was built on (our base first),
    //    plus the history of anything it deliberately replaces. Other PCs use
    //    this to tell "built on my data" (safe to take) from "diverged" (ask).
    const supersedes = (opts.supersedes || []).filter(Boolean);
    const supersededLineage: string[] = [];
    for (const id of supersedes) supersededLineage.push(id, ...readManifestAncestors(root, id));
    const baseLineage = state.lineage.length
      ? state.lineage
      : (state.lastSnapshotId ? [state.lastSnapshotId] : []);
    const ancestors = nextAncestors(baseLineage, supersededLineage);

    // 5) Manifest — written LAST, so a reader that sees a manifest knows the
    //    other files were already written (dbSha256 catches a cloud client
    //    that delivers them out of order).
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
      sourceHost: hostname(),
      appVersion: appVersion(),
      dbSha256: sha256File(snapshotDbPath) || undefined,
      parentSnapshotId: state.lastSnapshotId,
      ancestors,
      ...(supersedes.length ? { supersedes } : {}),
    };
    writeFileSync(join(snapshotDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    // 6) Retention sweep.
    try { pruneOldSnapshots(root); } catch (e) { /* non-fatal */ }
    try { garbageCollectBlobs(root); } catch (e) { /* non-fatal */ }

    // 7) Off-PC copies. The snapshot is already safe in the local root; if
    //    the upload fails it is retried on the next sync pass.
    let uploadError: string | null = null;
    if (config.target === 'r2') {
      const rep = await replicateR2(config);
      if (!rep.ok) uploadError = `Saved on this PC; upload to Cloudflare R2 will retry (${rep.error}).`;
    }
    refreshMirror(config);

    const durationMs = Date.now() - startTs;
    updateState({
      lastBackupAt: new Date().toISOString(),
      lastBackupError: null,
      lastSnapshotId: snapshotId,
      lastSyncedDbHash: getLocalDbHash(),
      lineage: [snapshotId, ...ancestors].slice(0, MAX_LINEAGE),
      lastSyncError: uploadError,
      conflict: null,
    });
    return { ok: true, snapshotId, durationMs, documentsCopied: copied, documentsReused: reused, dbBytes };
  } catch (e: any) {
    const message = e?.message || String(e);
    // Best-effort cleanup of half-written snapshot dir
    try { if (snapshotDir && existsSync(snapshotDir)) rmSync(snapshotDir, { recursive: true, force: true }); } catch { /* */ }
    updateState({ lastBackupError: message });
    return { ok: false, error: message };
  } finally {
    _inProgress = false;
  }
}

// ── Snapshot listing ────────────────────────────────────────────────────────

export function listSnapshots(sourceFolder?: string): SnapshotInfo[] {
  // Read from the given folder if provided (e.g. previewing another machine's
  // backup before adopting it), else the configured local folder. Taking the
  // folder as an argument avoids mutating the persistent backup config just to
  // peek at a foreign folder — a swap that could race with an auto-backup.
  const folder = sourceFolder || getActiveRoot();
  if (!folder || !existsSync(getSnapshotsDir(folder))) return [];

  const dirs = readdirSync(getSnapshotsDir(folder), { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);

  const now = Date.now();
  const out: SnapshotInfo[] = [];
  for (const id of dirs) {
    const ts = parseSnapshotIdTimestamp(id);
    if (!ts) continue;
    const manifestPath = join(getSnapshotsDir(folder), id, 'manifest.json');
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
      sourceHost: typeof manifest.sourceHost === 'string' ? manifest.sourceHost : null,
      appVersion: typeof manifest.appVersion === 'string' ? manifest.appVersion : null,
    });
  }

  // Newest first
  return out.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

// ── Retention ───────────────────────────────────────────────────────────────

/**
 * Retention (after each push) — see selectSnapshotsToKeep in syncPolicy.ts:
 * everything from the last 2h, then hourly / daily / weekly / monthly buckets,
 * nothing older than 6 months, and always the newest snapshot. Snapshots are
 * now only written when data actually changed, so the recent tier stays small.
 */
function pruneOldSnapshots(root: string): void {
  const snapsDir = getSnapshotsDir(root);
  if (!existsSync(snapsDir)) return;

  const all = readdirSync(snapsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => ({ id: e.name, ts: parseSnapshotIdTimestamp(e.name)?.getTime() ?? 0 }))
    .filter(x => x.ts > 0);

  const keepers = selectSnapshotsToKeep(all, Date.now());
  for (const snap of all) {
    if (keepers.has(snap.id)) continue;
    try { rmSync(join(snapsDir, snap.id), { recursive: true, force: true }); } catch { /* */ }
  }
}

function garbageCollectBlobs(root: string): void {
  const referenced = new Set<string>();
  for (const info of listSnapshots(root)) {
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

export interface RestoreFailure {
  ok: false;
  error: string;
}

export type RestoreResult = RestoreFailure | RestoreSuccess;

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
/**
 * Open a snapshot's vault.db read-only with its derived key and confirm it is
 * intact BEFORE we let it overwrite the live vault. An interrupted cloud sync
 * (OneDrive/Dropbox) can leave a truncated or torn DB file; restoring that over
 * a good live vault would be silent data loss. Returns ok only if the key works
 * AND PRAGMA integrity passes AND the expected schema is present.
 */
function validateSnapshotDb(dbPath: string, rawKey: Buffer): { ok: true } | { ok: false; error: string } {
  let probe: Database.Database | null = null;
  try {
    probe = new Database(dbPath, { readonly: true });
    // Same pragmas as openDb(): pin chacha20 before keying (see db/connection.ts).
    probe.pragma("cipher='chacha20'");
    probe.pragma(`key = "x'${rawKey.toString('hex')}'"`);
    // Wrong key throws here; a truncated/corrupt file fails quick_check.
    const result = probe.pragma('quick_check', { simple: true }) as string;
    if (result !== 'ok') {
      return { ok: false, error: `Snapshot failed integrity check (${result}). The backup file may be corrupt or a cloud sync was interrupted.` };
    }
    // Sanity-check that this is actually our schema, not just any readable DB.
    probe.prepare('SELECT 1 FROM members LIMIT 1').get();
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `Snapshot database could not be verified: ${e?.message || e}` };
  } finally {
    try { probe?.close(); } catch { /* */ }
  }
}

/**
 * Keep only the most recent few `.pre-restore-*` sidecars per base file. Each
 * restore (including the automatic auto-sync-on-unlock) leaves a full encrypted
 * DB copy behind; without pruning these grow without bound on a two-machine
 * cloud-sync setup. We keep the latest KEEP so a recent restore is still
 * recoverable, and delete the rest.
 */
function pruneOldPreRestoreSidecars(dataDir: string, keep = 3): void {
  try {
    const entries = readdirSync(dataDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.includes('.pre-restore-'))
      .map(e => e.name);
    // Group by the base file (e.g. "vault.db", "vault.meta.json").
    const groups = new Map<string, string[]>();
    for (const name of entries) {
      const base = name.slice(0, name.indexOf('.pre-restore-'));
      const list = groups.get(base) || [];
      list.push(name);
      groups.set(base, list);
    }
    for (const list of groups.values()) {
      // Timestamp is embedded in the name, so a lexical sort is chronological.
      list.sort((a, b) => b.localeCompare(a));
      for (const stale of list.slice(keep)) {
        try { unlinkSync(join(dataDir, stale)); } catch { /* */ }
      }
    }
  } catch { /* best-effort */ }
}

export interface RestoreOptions {
  /** Restore from a different backup root (e.g. another machine's folder). */
  sourceFolder?: string;
  /**
   * Key of the CURRENTLY open live vault. Lets us (a) skip the expensive
   * Argon2 derivation when the snapshot uses the same salt as the live vault —
   * the normal case once PCs share a vault — and (b) re-open the live vault if
   * the swap can't go ahead, so a failed restore never leaves the app running
   * on a closed database.
   */
  liveKey?: Buffer;
}

export interface RestoreSuccess {
  ok: true;
  error?: undefined;
  documentsRestored: number;
  dbBytes: number;
  /** Key the restored vault is now open with (adopt it as the session key). */
  masterKey: Buffer;
  sourceHost: string | null;
  snapshotTimestamp: string;
  ancestors: string[];
}

function sameKdf(a: VaultMeta, b: VaultMeta): boolean {
  return a.saltHex === b.saltHex
    && a.argonOpts?.type === b.argonOpts?.type
    && a.argonOpts?.memoryCost === b.argonOpts?.memoryCost
    && a.argonOpts?.timeCost === b.argonOpts?.timeCost
    && a.argonOpts?.parallelism === b.argonOpts?.parallelism;
}

const STILL_SYNCING_ERROR =
  'This backup is still being copied by your cloud drive (the file is incomplete). ' +
  'It will be picked up automatically once it has fully arrived.';

export async function restoreSnapshot(
  snapshotId: string,
  masterPassword: string,
  options: RestoreOptions = {}
): Promise<RestoreResult> {
  if (_inProgress) {
    return { ok: false, error: 'A backup or sync is already running. Try again in a moment.' };
  }
  _inProgress = true;
  try {
    return await restoreSnapshotInner(snapshotId, masterPassword, options);
  } finally {
    _inProgress = false;
  }
}

async function restoreSnapshotInner(
  snapshotId: string,
  masterPassword: string,
  options: RestoreOptions
): Promise<RestoreResult> {
  const config = getBackupConfig();
  const root = options.sourceFolder || getActiveRoot(config);
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

  // A cloud client can deliver manifest.json before vault.db has fully
  // downloaded. Refuse a torn file instead of restoring it.
  const snapshotDbSize = statSync(snapshotDbPath).size;
  if (typeof manifest.dbBytes === 'number' && manifest.dbBytes !== snapshotDbSize) {
    return { ok: false, error: STILL_SYNCING_ERROR };
  }
  if (manifest.dbSha256 && sha256File(snapshotDbPath) !== manifest.dbSha256) {
    return { ok: false, error: STILL_SYNCING_ERROR };
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

  // Same salt + params as the live vault → same key; skip a 256 MB Argon2 run.
  let snapshotMasterKey: Buffer;
  const liveMeta = getVaultMeta();
  if (options.liveKey && liveMeta && sameKdf(liveMeta, snapshotMeta)) {
    snapshotMasterKey = Buffer.from(options.liveKey);
  } else {
    try {
      snapshotMasterKey = await deriveMasterKeyFromMeta(masterPassword, snapshotMeta);
    } catch (e: any) {
      return { ok: false, error: `Key derivation failed: ${e?.message || e}` };
    }
  }

  // 1) Decrypt the field key BEFORE touching anything on disk — that way if
  //    the password is wrong we abort cleanly without corrupting state.
  let fieldKey: Buffer | null = null;
  if (existsSync(fieldKeyPath)) {
    try {
      fieldKey = aesDecryptBuffer(snapshotMasterKey, readFileSync(fieldKeyPath));
    } catch {
      return {
        ok: false,
        error: 'Master password does not match this snapshot. ' +
          'If you set up the vault on this machine with a different password, ' +
          'use the same password the snapshot was created with.'
      };
    }
  }

  // 2) Validate the snapshot DB BEFORE we touch the live vault. This runs
  //    while the live DB is still open and untouched, so a corrupt/truncated
  //    snapshot aborts the restore with zero data loss.
  const dbValidation = validateSnapshotDb(snapshotDbPath, snapshotMasterKey);
  if (!dbValidation.ok) return dbValidation;

  // 3) Documents first. Blobs are content-addressed by a random uuid and never
  //    rewritten, so copying them while the live vault is still open is safe,
  //    and a file already present with the same size is skipped.
  let documentsRestored = 0;
  try {
    const dataDocsDir = ensureDir(join(getDataDir(), 'documents'));
    const blobsDir = getBlobsDir(root);
    for (const doc of manifest.documents) {
      const src = join(blobsDir, `${doc.file_uuid}.enc`);
      if (!existsSync(src)) continue;
      const dst = join(dataDocsDir, `${doc.file_uuid}.enc`);
      if (!existsSync(dst) || statSync(dst).size !== statSync(src).size) {
        ensureDir(dirname(dst));
        copyFileSync(src, dst);
      }
      documentsRestored += 1;
    }
  } catch (e: any) {
    return { ok: false, error: `Could not copy documents from the backup: ${e?.message || e}` };
  }

  // 4) Swap the DB + meta. Everything from closeDb() to openDb() is
  //    synchronous — no await — so no IPC handler can run against a closed
  //    database mid-swap. The current vault is moved to a .pre-restore-<ts>
  //    sidecar; if we can't preserve it, or anything fails, we roll back and
  //    re-open the live vault rather than leave the app on a closed DB.
  const targetDbPath = getDbPath();
  const liveMetaPath = join(getDataDir(), 'vault.meta.json');
  const stamp = new Date().toISOString().replace(/:/g, '-');
  const dbSidecar = `${targetDbPath}.pre-restore-${stamp}`;
  const metaSidecar = `${liveMetaPath}.pre-restore-${stamp}`;
  const reopenLive = () => {
    if (options.liveKey) { try { openDb(options.liveKey); } catch { /* */ } }
  };

  closeDb();
  const hadLiveDb = existsSync(targetDbPath);
  if (hadLiveDb) {
    try {
      renameSync(targetDbPath, dbSidecar);
    } catch (e: any) {
      reopenLive();
      return {
        ok: false,
        error: `Could not back up the current vault before restoring (${e?.message || e}). ` +
          'Restore aborted — your existing data is unchanged. Close any program that may be ' +
          'holding the database open and try again.',
      };
    }
  }
  const hadLiveMeta = existsSync(liveMetaPath);
  try {
    copyFileSync(snapshotDbPath, targetDbPath);
    if (hadLiveMeta) renameSync(liveMetaPath, metaSidecar);
    copyFileSync(snapshotMetaPath, liveMetaPath);
    openDb(snapshotMasterKey);
  } catch (e: any) {
    // Roll back to exactly what we had.
    try { closeDb(); } catch { /* */ }
    try { rmSync(targetDbPath, { force: true }); } catch { /* */ }
    if (hadLiveDb) { try { renameSync(dbSidecar, targetDbPath); } catch { /* */ } }
    if (hadLiveMeta && existsSync(metaSidecar)) {
      try { rmSync(liveMetaPath, { force: true }); renameSync(metaSidecar, liveMetaPath); } catch { /* */ }
    }
    reopenLive();
    return { ok: false, error: `Restore failed and was rolled back: ${e?.message || e}` };
  }
  const dbBytes = statSync(targetDbPath).size;
  pruneOldPreRestoreSidecars(getDataDir());

  // 5) Field key → OS keychain, only if it actually differs (first restore onto
  //    a new PC). Drop the in-memory copy in field.ts too, or encrypted fields
  //    in the restored vault would be decrypted with the old key.
  if (fieldKey) {
    const current = await readFieldKey().catch(() => null);
    if (!current || !current.equals(fieldKey)) {
      await writeFieldKey(fieldKey);
      clearFieldKeyCache();
    }
  }

  return {
    ok: true,
    documentsRestored,
    dbBytes,
    masterKey: snapshotMasterKey,
    sourceHost: typeof manifest.sourceHost === 'string' ? manifest.sourceHost : null,
    snapshotTimestamp: manifest.timestamp,
    ancestors: Array.isArray(manifest.ancestors) ? manifest.ancestors : [],
  };
}

/** Convenience: pick the latest snapshot id from a folder (own folder by default). */
export function latestSnapshotId(sourceFolder?: string): string | null {
  const root = sourceFolder || getActiveRoot();
  if (!root) return null;
  const snapsDir = getSnapshotsDir(root);
  if (!existsSync(snapsDir)) return null;
  const ids = readdirSync(snapsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort((a, b) => b.localeCompare(a));
  return ids[0] || null;
}

// ── Cross-PC sync ────────────────────────────────────────────────────────────
// Decisions come from syncPolicy.ts; this section gathers the facts from disk
// and carries them out. Nothing here ever overwrites local changes that the
// other PC hasn't seen, or pushes over a snapshot this PC hasn't pulled.

/** Completed inspections, keyed by snapshot id (a finished snapshot never changes). */
const inspectCache = new Map<string, { key: string; candidate: HeadCandidate }>();

/** Is this snapshot folder complete and consistent, or still arriving via the cloud client? */
function inspectSnapshot(root: string, id: string, nowMs: number): HeadCandidate {
  const ageMs = Math.max(0, nowMs - (parseSnapshotIdTimestamp(id)?.getTime() ?? 0));
  const dir = join(getSnapshotsDir(root), id);
  const dbPath = join(dir, 'vault.db');
  const manifestPath = join(dir, 'manifest.json');
  try {
    if (!existsSync(dbPath) || !existsSync(manifestPath) || !existsSync(join(dir, 'vault.meta.json'))) {
      return { id, complete: false, ageMs };
    }
    const dbStat = statSync(dbPath);
    const manifestStat = statSync(manifestPath);
    const key = `${dbStat.size}:${dbStat.mtimeMs}:${manifestStat.size}:${manifestStat.mtimeMs}`;
    const cached = inspectCache.get(id);
    if (cached && cached.key === key) return { ...cached.candidate, ageMs };

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as SnapshotManifest;
    let complete = typeof manifest.dbBytes !== 'number' || manifest.dbBytes === dbStat.size;
    if (complete && manifest.dbSha256) complete = sha256File(dbPath) === manifest.dbSha256;
    if (!complete) return { id, complete: false, ageMs };
    const candidate: HeadCandidate = { id, complete: true, manifest, ageMs };
    inspectCache.set(id, { key, candidate });
    return candidate;
  } catch {
    return { id, complete: false, ageMs };
  }
}

function* snapshotCandidates(root: string, nowMs: number): Generator<HeadCandidate> {
  const snapsDir = getSnapshotsDir(root);
  if (!existsSync(snapsDir)) return;
  const ids = readdirSync(snapsDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !!parseSnapshotIdTimestamp(e.name))
    .map(e => e.name)
    .sort((a, b) => b.localeCompare(a));
  for (const id of ids) yield inspectSnapshot(root, id, nowMs);
}

function findHead(root: string): Head {
  return pickHead(snapshotCandidates(root, Date.now()));
}

function localVaultIsEmpty(): boolean {
  try {
    const row = getDb().prepare(
      'SELECT (SELECT count(*) FROM families) + (SELECT count(*) FROM members) AS n'
    ).get() as { n: number } | undefined;
    return !row || Number(row.n) === 0;
  } catch {
    return false; // DB not open — assume it has data (the safe side: ask, don't overwrite)
  }
}

/**
 * Local changes the folder hasn't seen — for deciding whether a newer remote
 * snapshot can simply be taken. With no fingerprint yet: a PC that synced
 * before (state from an older build) takes newer data, as it always did; a PC
 * that has NEVER synced but already holds data must not be silently
 * overwritten by the folder's copy, so that becomes a choice for the user.
 */
function pullDirty(state: BackupState, localHash: string | null): boolean {
  if (state.lastSyncedDbHash) return localHash !== state.lastSyncedDbHash;
  if (state.lastSnapshotId) return false;
  return !localVaultIsEmpty();
}

/** Local changes worth pushing. No fingerprint yet → push (what older builds did). */
function pushDirty(state: BackupState, localHash: string | null): boolean {
  return isDirty(localHash, state.lastSyncedDbHash, true);
}

const PENDING_MESSAGE =
  'A newer backup from another PC is still arriving through your cloud drive. ' +
  'It will be applied automatically once it has fully synced.';

const PASSWORD_CHANGED_MESSAGE =
  'The master password was changed on another PC, so its newer backup can\'t be opened with this ' +
  'session\'s password. Lock (Ctrl+L) and unlock with the NEW password to continue syncing.';

type RootCheck = { root: string } | { skip: 'disabled' } | { skip: 'missing'; message: string };

const r2UnreachableMessage = (error: string) =>
  `Cloudflare R2 could not be reached (${error}). Your data is safe on this PC; sync resumes automatically.`;

/** Root check without network access (for status display). */
function localSyncRoot(): RootCheck {
  const config = getBackupConfig();
  const root = getActiveRoot(config);
  if (!config.enabled || !root) return { skip: 'disabled' };
  if (config.target === 'r2') {
    const err = getR2Status().lastError;
    return err ? { skip: 'missing', message: r2UnreachableMessage(err) } : { root };
  }
  if (!existsSync(root)) {
    return {
      skip: 'missing',
      message: `Backup folder not found: ${root}. Is Google Drive (or your cloud drive) running and signed in?`,
    };
  }
  return { root };
}

/**
 * The configured backup root if sync can run now, else why not. For R2 this
 * first brings the local cache up to date with the bucket — unless a
 * snapshot/restore is running, in which case the caller backs off anyway.
 */
async function syncRoot(): Promise<RootCheck> {
  const config = getBackupConfig();
  const root = getActiveRoot(config);
  if (!config.enabled || !root) return { skip: 'disabled' };
  if (config.target !== 'r2') return localSyncRoot();
  if (_inProgress) return { root };
  _inProgress = true;
  try {
    const rep = await replicateR2(config);
    if (!rep.ok) return { skip: 'missing', message: r2UnreachableMessage(rep.error) };
  } finally {
    _inProgress = false;
  }
  return { root };
}

export interface SyncOutcome {
  action: 'none' | 'pulled' | 'pushed' | 'conflict' | 'pending' | 'error' | 'disabled';
  /** After a pull: the key the vault is now open with. */
  newMasterKey?: Buffer;
  sourceHost?: string | null;
  snapshotTimestamp?: string;
  conflict?: SyncConflict;
  /** True when this call newly detected the conflict (vs one already known). */
  conflictIsNew?: boolean;
  error?: string;
}

function recordConflict(decision: Extract<SyncDecision, { kind: 'conflict' }>, head: Head): SyncOutcome {
  const state = getBackupState();
  const manifest = head.kind === 'ready' ? head.manifest : undefined;
  const same = state.conflict?.remoteSnapshotId === decision.remoteSnapshotId;
  const conflict: SyncConflict = same && state.conflict
    ? { ...state.conflict, reason: decision.reason }
    : {
      detectedAt: new Date().toISOString(),
      reason: decision.reason,
      remoteSnapshotId: decision.remoteSnapshotId,
      remoteHost: manifest?.sourceHost ?? null,
      remoteTimestamp: manifest?.timestamp ?? null,
      localBaseSnapshotId: state.lastSnapshotId,
    };
  updateState({ conflict, lastSyncError: null });
  return { action: 'conflict', conflict, conflictIsNew: !same };
}

async function applyFastForward(
  remoteSnapshotId: string,
  masterPassword: string,
  liveKey: Buffer
): Promise<SyncOutcome> {
  const r = await restoreSnapshot(remoteSnapshotId, masterPassword, { liveKey });
  if (!r.ok) {
    const stillSyncing = r.error === STILL_SYNCING_ERROR;
    const passwordChanged = r.error.startsWith('Master password does not match');
    updateState({
      lastSyncError: stillSyncing
        ? PENDING_MESSAGE
        : passwordChanged
          ? PASSWORD_CHANGED_MESSAGE
          : `Could not apply the newer backup: ${r.error}`,
    });
    return { action: stillSyncing ? 'pending' : 'error', error: passwordChanged ? PASSWORD_CHANGED_MESSAGE : r.error };
  }
  updateState({
    lastSnapshotId: remoteSnapshotId,
    lastSyncedDbHash: getLocalDbHash(),
    lineage: [remoteSnapshotId, ...r.ancestors].slice(0, MAX_LINEAGE),
    lastPullAt: new Date().toISOString(),
    lastPullSourceHost: r.sourceHost,
    lastSyncError: null,
    conflict: null,
  });
  return {
    action: 'pulled',
    newMasterKey: r.masterKey,
    sourceHost: r.sourceHost,
    snapshotTimestamp: r.snapshotTimestamp,
  };
}

/**
 * Pull on unlock. `preOpenLocalHash` is the vault.db hash taken BEFORE the DB
 * was opened, so a schema migration run by openDb() isn't mistaken for a user
 * edit (which would raise a false conflict).
 */
export async function syncOnUnlock(opts: {
  masterPassword: string;
  liveKey: Buffer;
  preOpenLocalHash: string | null;
}): Promise<SyncOutcome> {
  const ready = await syncRoot();
  if ('skip' in ready) {
    if (ready.skip === 'missing') updateState({ lastSyncError: ready.message });
    return { action: ready.skip === 'missing' ? 'error' : 'disabled', error: 'message' in ready ? ready.message : undefined };
  }
  if (_inProgress) return { action: 'none' };

  const state = getBackupState();
  const head = findHead(ready.root);
  const decision = decideSync(state, head, pullDirty(state, opts.preOpenLocalHash));

  // State written by a build that didn't track hashes (this PC has synced
  // before): adopt the vault as it was at the last close as the synced baseline.
  if (!state.lastSyncedDbHash && state.lastSnapshotId && decision.kind === 'up-to-date') {
    updateState({ lastSyncedDbHash: opts.preOpenLocalHash });
  }

  switch (decision.kind) {
    case 'fast-forward':
      return applyFastForward(decision.remoteSnapshotId, opts.masterPassword, opts.liveKey);
    case 'conflict':
      return recordConflict(decision, head);
    case 'pending':
      updateState({ lastSyncError: PENDING_MESSAGE });
      return { action: 'pending' };
    default:
      updateState({ lastSyncError: null, conflict: null });
      return { action: 'none' };
  }
}

/**
 * Unlock fallback for a master password changed on another PC: the typed
 * password can't open this PC's (older-key) vault, but it may open the newer
 * snapshot that PC pushed. Only tried when the folder holds a snapshot this PC
 * hasn't pulled. restoreSnapshot checks the password against the snapshot's
 * field key before touching anything, so a mistyped password changes nothing.
 */
export async function tryUnlockFromNewerBackup(masterPassword: string): Promise<SyncOutcome | null> {
  const ready = await syncRoot();
  if ('skip' in ready) return null;
  const state = getBackupState();
  const head = findHead(ready.root);
  if (head.kind !== 'ready' || head.id === state.lastSnapshotId) return null;
  const r = await restoreSnapshot(head.id, masterPassword, {});
  if (!r.ok) return null;
  updateState({
    lastSnapshotId: head.id,
    lastSyncedDbHash: getLocalDbHash(),
    lineage: [head.id, ...r.ancestors].slice(0, MAX_LINEAGE),
    lastPullAt: new Date().toISOString(),
    lastPullSourceHost: r.sourceHost,
    lastSyncError: null,
    conflict: null,
  });
  return { action: 'pulled', newMasterKey: r.masterKey, sourceHost: r.sourceHost, snapshotTimestamp: r.snapshotTimestamp };
}

// Push debounce: push once the local DB hash has been stable for PUSH_SETTLE_MS,
// so a burst of edits (or a bulk balance refresh) becomes one snapshot.
export const PUSH_SETTLE_MS = 90_000;
let observedHash: string | null = null;
let observedSince = 0;

/**
 * One pass of the while-unlocked sync loop (ipc.ts runs it every ~30s).
 * `canPull`/`canPush` are false while a bank/broker automation is running, so
 * the DB is never swapped mid-login and balance writes land in one push.
 */
export async function syncTick(opts: {
  masterPassword: string;
  liveKey: Buffer;
  canPull: boolean;
  canPush: boolean;
}): Promise<SyncOutcome> {
  const ready = await syncRoot();
  if ('skip' in ready) {
    if (ready.skip === 'missing' && getBackupState().lastSyncError !== ready.message) {
      updateState({ lastSyncError: ready.message });
    }
    return { action: ready.skip === 'missing' ? 'error' : 'disabled' };
  }
  if (_inProgress) return { action: 'none' };

  const state = getBackupState();
  const localHash = getLocalDbHash();
  const head = findHead(ready.root);
  const decision = decideSync(state, head, pullDirty(state, localHash));

  switch (decision.kind) {
    case 'fast-forward':
      if (!opts.canPull) return { action: 'none' };
      return applyFastForward(decision.remoteSnapshotId, opts.masterPassword, opts.liveKey);
    case 'conflict':
      return recordConflict(decision, head);
    case 'pending':
      if (state.lastSyncError !== PENDING_MESSAGE) updateState({ lastSyncError: PENDING_MESSAGE });
      return { action: 'pending' };
    case 'up-to-date': {
      if (state.conflict || state.lastSyncError) updateState({ conflict: null, lastSyncError: null });
      if (!pushDirty(state, localHash)) {
        observedHash = localHash;
        return { action: 'none' };
      }
      if (localHash !== observedHash) {
        observedHash = localHash;
        observedSince = Date.now();
        return { action: 'none' };
      }
      if (!opts.canPush || Date.now() - observedSince < PUSH_SETTLE_MS) return { action: 'none' };
      const res = await createSnapshot(opts.liveKey);
      return res.ok ? { action: 'pushed' } : { action: 'error', error: res.error };
    }
  }
}

/**
 * Push on lock / quit / auto-lock — only if there are local changes AND the
 * folder's newest snapshot is still the one this PC is based on. If another PC
 * pushed in the meantime, don't overwrite it: keep the local changes on disk
 * and record a conflict for the user to resolve at the next unlock.
 */
export async function pushBeforeClose(masterKey: Buffer): Promise<SyncOutcome> {
  const ready = await syncRoot();
  if ('skip' in ready) return { action: ready.skip === 'missing' ? 'error' : 'disabled' };
  if (_inProgress) return { action: 'none' };

  const state = getBackupState();
  if (state.conflict) return { action: 'conflict', conflict: state.conflict };
  const head = findHead(ready.root);
  const dirty = pushDirty(state, getLocalDbHash());
  const decision = decideSync(state, head, dirty);
  switch (decision.kind) {
    case 'up-to-date': {
      if (!dirty) return { action: 'none' };
      const res = await createSnapshot(masterKey);
      return res.ok ? { action: 'pushed' } : { action: 'error', error: res.error };
    }
    case 'fast-forward':
      return { action: 'none' }; // nothing local to push; the pull happens at next unlock
    case 'pending':
      updateState({ lastSyncError: PENDING_MESSAGE });
      return { action: 'pending' };
    case 'conflict':
      return recordConflict(decision, head);
  }
}

/**
 * Settle a recorded conflict.
 *   keep-local: push this PC's data as a snapshot that explicitly supersedes
 *               the other PC's, so every PC fast-forwards to it.
 *   use-remote: take the other PC's newest snapshot; this PC's unsynced changes
 *               stay recoverable in the vault.db.pre-restore-* sidecar.
 */
export async function resolveSyncConflict(
  choice: 'keep-local' | 'use-remote',
  opts: { masterPassword: string; liveKey: Buffer }
): Promise<SyncOutcome> {
  const ready = await syncRoot();
  if ('skip' in ready) {
    return { action: 'error', error: 'message' in ready ? ready.message : 'Backup is not configured.' };
  }
  const state = getBackupState();
  if (!state.conflict) return { action: 'none' };
  const head = findHead(ready.root);
  const remoteId = head.kind === 'ready' ? head.id : state.conflict.remoteSnapshotId;

  if (choice === 'keep-local') {
    const res = await createSnapshot(opts.liveKey, { supersedes: [remoteId] });
    return res.ok ? { action: 'pushed' } : { action: 'error', error: res.error };
  }
  if (head.kind === 'pending') return { action: 'pending', error: STILL_SYNCING_ERROR };
  return applyFastForward(remoteId, opts.masterPassword, opts.liveKey);
}

/**
 * "Backup now". Follows the same rules as automatic sync: if another PC pushed
 * newer data, take it first (when this PC has nothing unsynced) instead of
 * creating a divergent snapshot; refuse while a conflict is unresolved.
 */
export async function backupNow(opts: { masterPassword: string; liveKey: Buffer }): Promise<
  CreateSnapshotResult & { pulledFrom?: string | null; newMasterKey?: Buffer }
> {
  const ready = await syncRoot();
  if ('skip' in ready) {
    return { ok: false, error: 'message' in ready ? ready.message : 'Backup is not configured (folder not chosen).' };
  }
  const state = getBackupState();
  if (state.conflict) {
    return { ok: false, error: 'Resolve the sync conflict first — both PCs have changes the other has not seen.' };
  }
  const head = findHead(ready.root);
  const localHash = getLocalDbHash();
  const decision = decideSync(state, head, pullDirty(state, localHash));
  if (decision.kind === 'pending') return { ok: false, error: PENDING_MESSAGE };
  if (decision.kind === 'conflict') {
    const outcome = recordConflict(decision, head);
    return { ok: false, error: `Sync conflict with ${outcome.conflict?.remoteHost || 'another PC'} — choose which copy to keep.` };
  }
  if (decision.kind === 'fast-forward') {
    const pulled = await applyFastForward(decision.remoteSnapshotId, opts.masterPassword, opts.liveKey);
    if (pulled.action !== 'pulled') return { ok: false, error: pulled.error || 'Could not apply the newer backup.' };
    return { ok: true, snapshotId: decision.remoteSnapshotId, pulledFrom: pulled.sourceHost ?? null, newMasterKey: pulled.newMasterKey };
  }
  return createSnapshot(opts.liveKey);
}

/**
 * After a manual restore (Backup → Restore…), make the restored data the new
 * head for every PC — otherwise the next sync pass would fast-forward straight
 * back to the folder's newest snapshot and silently undo the restore.
 */
export async function publishRestoredVault(masterKey: Buffer, restoredSnapshotId: string, ancestors: string[]): Promise<CreateSnapshotResult> {
  const ready = await syncRoot();
  if ('skip' in ready) return { ok: false, error: 'Backup is not configured.' };
  const head = findHead(ready.root);
  updateState({
    lastSnapshotId: restoredSnapshotId,
    lineage: [restoredSnapshotId, ...ancestors].slice(0, MAX_LINEAGE),
    conflict: null,
  });
  const supersedes = head.kind === 'ready' && head.id !== restoredSnapshotId ? [head.id] : [];
  return createSnapshot(masterKey, { supersedes });
}

export interface SyncStatus {
  thisHost: string;
  /** Local edits not yet pushed (only meaningful while unlocked). */
  dirty: boolean;
  folderMissing: boolean;
  head: { id: string; sourceHost: string | null; timestamp: string | null } | null;
  /** Newest remote snapshot that is still arriving through the cloud client. */
  pendingRemoteId: string | null;
  target: BackupTarget;
  /** R2 only: last failed bucket round-trip, and the last good one. */
  remoteError: string | null;
  remoteOkAt: string | null;
  /** R2 only: non-fatal note, e.g. a delete refused by a bucket lock. */
  remoteWarning: string | null;
}

export function getSyncStatus(): SyncStatus {
  const state = getBackupState();
  const config = getBackupConfig();
  const r2 = config.target === 'r2' ? getR2Status() : null;
  const status: SyncStatus = {
    thisHost: hostname(), dirty: false, folderMissing: false, head: null, pendingRemoteId: null,
    target: config.target,
    remoteError: r2?.lastError ?? null,
    remoteOkAt: r2?.lastOkAt ?? null,
    remoteWarning: r2?.lastWarning ?? null,
  };
  const ready = localSyncRoot();
  if ('skip' in ready && config.target !== 'r2') return { ...status, folderMissing: ready.skip === 'missing' };
  const root = 'root' in ready ? ready.root : getActiveRoot(config);
  if (!root) return status;
  const head = findHead(root);
  return {
    ...status,
    dirty: !!state.lastSyncedDbHash && isDirty(getLocalDbHash(), state.lastSyncedDbHash, false),
    head: head.kind === 'ready'
      ? { id: head.id, sourceHost: head.manifest.sourceHost ?? null, timestamp: head.manifest.timestamp ?? null }
      : null,
    pendingRemoteId: head.kind === 'pending' ? head.id : null,
  };
}

// ── Reporter used by the IPC layer ──────────────────────────────────────────

export function getCurrentInProgress(): boolean {
  return _inProgress;
}
