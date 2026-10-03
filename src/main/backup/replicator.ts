/**
 * Keeps a local backup root in step with an object store (Cloudflare R2), and
 * copies a backup root into a plain mirror folder (USB disk, NAS, a cloud
 * folder). Pure fs + ObjectStore — no Electron, keytar or SQLite — so it runs
 * under plain Node in tests.
 *
 * ── Why a local cache instead of talking to R2 from the engine ─────────────
 * The engine's sync rules (lineage, dirty hash, conflicts, retention) work on
 * a folder and are already proven. With R2 the engine keeps using a folder —
 * <dataDir>/r2-cache — and this module does what the Google Drive client used
 * to do, minus the parts that broke: no separate app to be signed out of or
 * paused, and R2 is strongly consistent, so there are no half-synced files.
 *
 *   bucket/<prefix>/meta.json
 *   bucket/<prefix>/blobs/<file_uuid>.enc
 *   bucket/<prefix>/snapshots/<id>/{vault.db,vault.meta.json,field-key.bin,manifest.json}
 *
 * Rules that keep it safe:
 *   - manifest.json is uploaded / written LAST. A snapshot without one is
 *     incomplete; the engine reports it as "another PC is uploading".
 *   - A snapshot's blobs are transferred BEFORE its manifest, so a complete
 *     snapshot always has its documents.
 *   - Deletes only follow a snapshot both sides were known to have (`synced`),
 *     and nothing local is deleted when the bucket looks empty.
 *   - A snapshot this PC pruned is remembered (`tombstones`) so it is never
 *     downloaded again, even while an R2 bucket lock refuses the delete.
 *   - A remote blob is deleted only after nothing has referenced it for a day.
 */

import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
  rmSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ObjectStore, StoredObject } from './objectStore';

export const MANIFEST = 'manifest.json';
const META = 'meta.json';
const SNAPSHOT_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(\.\d{3})?Z(?:_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/;
const BLOB_RE = /^[A-Za-z0-9-]+\.enc$/;
const SNAPSHOT_FILE_RE = /^[A-Za-z0-9._-]+$/;
/** A remote snapshot with no manifest this old is an abandoned upload. */
export const ABANDONED_UPLOAD_MS = 30 * 60 * 1000;
/** ...and is cleaned out of the bucket after this long. */
const PARTIAL_CLEANUP_MS = 24 * 3_600_000;
/** An unreferenced remote blob is deleted after it has been unreferenced this long. */
export const ORPHAN_BLOB_GRACE_MS = 24 * 3_600_000;
/** How often to retry a delete the bucket refused (e.g. bucket lock). */
const TOMBSTONE_RETRY_MS = 6 * 3_600_000;
/** Snapshot downloads per pass, newest first — keeps each pass short so user actions never wait long. */
export const DEFAULT_MAX_DOWNLOADS = 3;
/** Encrypted settings bundles (e.g. Gmail): settings/<name>-<13-digit ms>.enc, never overwritten. */
export const SETTINGS_RE = /^([a-z0-9-]+)-(\d{13})\.enc$/;
/** Settings versions kept per name. */
const SETTINGS_KEEP = 3;

export interface ReplicationState {
  /** Snapshot ids both sides had, as of the last pass. */
  synced: string[];
  /** Manifest identity verified against the remote listing (legacy ID collision guard). */
  verifiedManifests?: Record<string, string>;
  /** Snapshots this PC pruned → last time a remote delete was attempted. */
  tombstones: Record<string, number>;
  /** Remote blob → when it was first seen unreferenced. */
  orphanBlobsSince: Record<string, number>;
  /** Object key → last delete attempt, so a bucket lock never causes a retry storm. */
  deleteAttempts: Record<string, number>;
}

export function emptyReplicationState(): ReplicationState {
  return { synced: [], tombstones: {}, orphanBlobsSince: {}, deleteAttempts: {} };
}

export interface ReplicateOptions {
  /** Max snapshots to download this pass (newest first). Default DEFAULT_MAX_DOWNLOADS. */
  maxDownloads?: number;
  /**
   * Unlock mode: only fetch what's needed to see the newest snapshot — no
   * uploads, no deletes, no clean-up. The next normal pass does the rest.
   */
  light?: boolean;
}

export interface ReplicationReport {
  state: ReplicationState;
  uploadedSnapshots: string[];
  downloadedSnapshots: string[];
  deletedRemote: string[];
  deletedLocal: string[];
  uploadedBlobs: number;
  downloadedBlobs: number;
  /** Non-fatal problems (e.g. a delete refused by a bucket lock). */
  warnings: string[];
  /** Older remote snapshots still to fetch (they come in later passes). */
  moreToDownload: boolean;
}

// ── Local helpers ───────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Write via a temp file + rename so a crash never leaves a torn file under the real name. */
function writeAtomic(path: string, body: Buffer): void {
  const tmp = `${path}.part`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

interface LocalSnapshot { id: string; complete: boolean; files: string[] }

function localSnapshots(root: string): Map<string, LocalSnapshot> {
  const out = new Map<string, LocalSnapshot>();
  const dir = join(root, 'snapshots');
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || !SNAPSHOT_ID_RE.test(e.name)) continue;
    const files = readdirSync(join(dir, e.name)).filter(f => SNAPSHOT_FILE_RE.test(f) && !f.endsWith('.part'));
    out.set(e.name, { id: e.name, complete: files.includes(MANIFEST), files });
  }
  return out;
}

function readManifestDocs(path: string): string[] {
  try {
    const m = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(m?.documents)
      ? m.documents.map((d: any) => d?.file_uuid).filter((u: unknown): u is string => typeof u === 'string' && /^[A-Za-z0-9-]+$/.test(u))
      : [];
  } catch {
    return [];
  }
}

function localManifestPath(root: string, id: string): string {
  return join(root, 'snapshots', id, MANIFEST);
}

/** Manifests of remote snapshots not (yet) downloaded — for blob GC and the restore list. */
export function remoteManifestDir(root: string): string {
  return join(root, 'remote-manifests');
}

function settingsDir(root: string): string {
  return join(root, 'settings');
}

// ── Remote listing ──────────────────────────────────────────────────────────

interface RemoteView {
  snapshots: Map<string, Map<string, StoredObject>>;
  blobs: Map<string, StoredObject>;
  meta: StoredObject | null;
  settings: Map<string, StoredObject>;
}

function groupRemote(objects: StoredObject[], prefix: string): RemoteView {
  const view: RemoteView = { snapshots: new Map(), blobs: new Map(), meta: null, settings: new Map() };
  const base = `${prefix}/`;
  for (const o of objects) {
    if (!o.key.startsWith(base)) continue;
    const rel = o.key.slice(base.length);
    if (rel === META) { view.meta = o; continue; }
    const parts = rel.split('/');
    if (parts.length === 2 && parts[0] === 'settings' && SETTINGS_RE.test(parts[1])) {
      view.settings.set(parts[1], o);
    } else if (parts.length === 2 && parts[0] === 'blobs' && BLOB_RE.test(parts[1])) {
      view.blobs.set(parts[1].replace(/\.enc$/, ''), o);
    } else if (parts.length === 3 && parts[0] === 'snapshots' && SNAPSHOT_ID_RE.test(parts[1]) && SNAPSHOT_FILE_RE.test(parts[2])) {
      const files = view.snapshots.get(parts[1]) || new Map<string, StoredObject>();
      files.set(parts[2], o);
      view.snapshots.set(parts[1], files);
    }
  }
  return view;
}

// ── Replication ─────────────────────────────────────────────────────────────

/**
 * One pass: bring `root` and the bucket to the same set of snapshots.
 * Throws only when the bucket can't be listed or a transfer fails; the state
 * it returns must be persisted by the caller (and only on success).
 */
export async function replicate(
  root: string,
  store: ObjectStore,
  prefix: string,
  prev: ReplicationState,
  nowMs: number = Date.now(),
  opts: ReplicateOptions = {},
): Promise<ReplicationReport> {
  ensureDir(join(root, 'snapshots'));
  ensureDir(join(root, 'blobs'));
  const light = !!opts.light;
  const maxDownloads = Math.max(1, opts.maxDownloads ?? DEFAULT_MAX_DOWNLOADS);
  const report: ReplicationReport = {
    state: {
      synced: [], tombstones: { ...prev.tombstones }, orphanBlobsSince: { ...prev.orphanBlobsSince },
      deleteAttempts: { ...(prev.deleteAttempts || {}) },
      verifiedManifests: {},
    },
    uploadedSnapshots: [], downloadedSnapshots: [], deletedRemote: [], deletedLocal: [],
    uploadedBlobs: 0, downloadedBlobs: 0, warnings: [], moreToDownload: false,
  };
  const tombstones = report.state.tombstones;
  const attempts = report.state.deleteAttempts;
  /** Throttled delete: at most one attempt per key per TOMBSTONE_RETRY_MS. */
  const tryDelete = async (key: string, what: string): Promise<boolean> => {
    if (nowMs - (attempts[key] ?? 0) < TOMBSTONE_RETRY_MS) return false;
    attempts[key] = nowMs;
    try {
      await store.delete(key);
      delete attempts[key];
      return true;
    } catch (e: any) {
      report.warnings.push(`Could not delete ${what} from the bucket (a bucket lock keeps it until it expires): ${e?.message || e}`);
      return false;
    }
  };
  const synced = new Set(prev.synced);

  const remote = groupRemote(await store.list(`${prefix}/`), prefix);
  const remoteComplete = () => new Set([...remote.snapshots].filter(([, f]) => f.has(MANIFEST)).map(([id]) => id));
  let local = localSnapshots(root);
  // Older builds used timestamp-only IDs. Never silently adopt a different
  // snapshot under the same ID, even when both files happen to have equal size.
  for (const [id, snap] of local) {
    const object = remote.snapshots.get(id)?.get(MANIFEST);
    if (!snap.complete || !object) continue;
    const manifest = readFileSync(localManifestPath(root, id));
    const fingerprint = `${createHash('sha256').update(manifest).digest('hex')}:${object.lastModified}:${object.size}`;
    if (prev.verifiedManifests?.[id] !== fingerprint) {
      if (!manifest.equals(await store.get(object.key))) {
        throw new Error(`Snapshot ID collision (${id}): local and cloud contents differ. Both copies have been preserved; sync stopped.`);
      }
    }
    report.state.verifiedManifests![id] = fingerprint;
  }

  const snapKey = (id: string, file: string) => `${prefix}/snapshots/${id}/${file}`;
  const blobKey = (uuid: string) => `${prefix}/blobs/${uuid}.enc`;
  const localBlob = (uuid: string) => join(root, 'blobs', `${uuid}.enc`);

  const deleteRemoteSnapshot = async (id: string): Promise<boolean> => {
    const files = remote.snapshots.get(id);
    if (!files) return true;
    // Manifest first, so a half-finished delete reads as "incomplete", never as a torn snapshot.
    const order = [...files.keys()].sort((a, b) => (a === MANIFEST ? -1 : b === MANIFEST ? 1 : 0));
    for (const f of order) {
      try {
        await store.delete(snapKey(id, f));
        files.delete(f);
      } catch (e: any) {
        report.warnings.push(`Could not delete ${id} from the bucket: ${e?.message || e}`);
        return false;
      }
    }
    remote.snapshots.delete(id);
    return true;
  };

  // 1) Snapshots this PC pruned (known on both sides, now gone locally), plus
  //    earlier prunes whose delete the bucket refused.
  if (!light) for (const id of synced) {
    if (!local.has(id) && remote.snapshots.has(id)) tombstones[id] = 0;
  }
  for (const [id, lastTry] of Object.entries(tombstones)) {
    if (!remote.snapshots.has(id)) { delete tombstones[id]; continue; }
    if (light) continue;
    if (nowMs - lastTry < TOMBSTONE_RETRY_MS) continue;
    tombstones[id] = nowMs;
    if (await deleteRemoteSnapshot(id)) {
      delete tombstones[id];
      report.deletedRemote.push(id);
    }
  }

  // 2) Snapshots another PC pruned (known on both sides, now gone remotely).
  //    Never act on an empty-looking bucket — that's a wrong prefix or a
  //    wiped bucket, not a prune (retention always keeps the newest).
  const remoteNow = remoteComplete();
  if (remoteNow.size > 0 && !light) {
    for (const id of synced) {
      if (remote.snapshots.has(id) || !local.get(id)?.complete) continue;
      try { rmSync(join(root, 'snapshots', id), { recursive: true, force: true }); report.deletedLocal.push(id); } catch { /* */ }
    }
    local = localSnapshots(root);
  }

  // 3) Download complete remote snapshots this PC doesn't have, NEWEST first
  //    and a few per pass (the newest is what sync needs; history follows):
  //    blobs, then the snapshot files, then the manifest.
  const wanted = [...remoteComplete()].sort().reverse()
    .filter(id => !local.get(id)?.complete && !(id in tombstones));
  for (const id of wanted.slice(0, maxDownloads)) {
    report.downloadedBlobs += await downloadSnapshot(root, store, prefix, id, remote.snapshots.get(id)!, remote.blobs);
    report.downloadedSnapshots.push(id);
  }
  report.moreToDownload = wanted.length > maxDownloads;

  // 4) Another PC's upload in progress: mirror it as an empty folder so the
  //    engine reports "pending" instead of building on an older snapshot.
  //    Abandoned partial uploads are ignored, and eventually cleaned up.
  const uploading = new Set<string>();
  for (const [id, files] of [...remote.snapshots]) {
    if (files.has(MANIFEST)) continue;
    const newest = Math.max(...[...files.values()].map(o => o.lastModified));
    const age = nowMs - newest;
    if (age < ABANDONED_UPLOAD_MS) {
      uploading.add(id);
      ensureDir(join(root, 'snapshots', id));
    } else if (age > PARTIAL_CLEANUP_MS && !local.get(id)?.complete && !light) {
      for (const f of [...files.keys()]) {
        if (await tryDelete(snapKey(id, f), `an abandoned upload (${id})`)) files.delete(f);
      }
      if (files.size === 0) remote.snapshots.delete(id);
    }
  }
  local = localSnapshots(root);
  for (const snap of local.values()) {
    // Only empty folders are ours to remove (a marker whose upload finished or
    // was abandoned) — never a folder the engine is writing into.
    if (!snap.complete && snap.files.length === 0 && !uploading.has(snap.id)) {
      try { rmdirSync(join(root, 'snapshots', snap.id)); } catch { /* not empty / gone */ }
    }
  }

  // 5) Upload complete local snapshots the bucket doesn't have.
  local = localSnapshots(root);
  const remoteDone = remoteComplete();
  for (const snap of [...local.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (light || !snap.complete || remoteDone.has(snap.id)) continue;
    for (const uuid of readManifestDocs(localManifestPath(root, snap.id))) {
      const src = localBlob(uuid);
      if (!existsSync(src)) {
        if (remote.blobs.has(uuid)) continue;
        throw new Error(`Backup document ${uuid} is missing; the snapshot was not published.`);
      }
      const size = statSync(src).size;
      if (remote.blobs.get(uuid)?.size === size) continue;
      await store.put(blobKey(uuid), readFileSync(src));
      remote.blobs.set(uuid, { key: blobKey(uuid), size, lastModified: nowMs });
      report.uploadedBlobs += 1;
    }
    // Resume an interrupted upload: an object already there with the same size
    // was written by this snapshot (PUTs are all-or-nothing). Skipping it also
    // matters under a bucket lock, which refuses overwrites.
    const files = new Map<string, StoredObject>(remote.snapshots.get(snap.id) || []);
    for (const file of snap.files.filter(f => f !== MANIFEST)) {
      const body = readFileSync(join(root, 'snapshots', snap.id, file));
      if (files.get(file)?.size === body.length) continue;
      await store.put(snapKey(snap.id, file), body);
      files.set(file, { key: snapKey(snap.id, file), size: body.length, lastModified: nowMs });
    }
    const manifest = readFileSync(localManifestPath(root, snap.id));
    await store.put(snapKey(snap.id, MANIFEST), manifest);
    files.set(MANIFEST, { key: snapKey(snap.id, MANIFEST), size: manifest.length, lastModified: nowMs });
    remote.snapshots.set(snap.id, files);
    report.uploadedSnapshots.push(snap.id);
  }

  // 6) Root meta.json, either direction.
  const localMeta = join(root, META);
  if (!remote.meta && existsSync(localMeta) && !light) await store.put(`${prefix}/${META}`, readFileSync(localMeta));
  else if (remote.meta && !existsSync(localMeta)) writeAtomic(localMeta, await store.get(`${prefix}/${META}`));

  // 7) Settings bundles (encrypted elsewhere; opaque here). Each version is a
  //    new key, so a bucket lock never refuses them: fetch what's missing,
  //    upload ours, keep the newest few of each name.
  await syncSettings(root, store, prefix, remote.settings, light, tryDelete);

  // 8) Remote blobs that NO remote snapshot references — including snapshots
  //    this PC never downloaded, or pruned while a bucket lock still keeps
  //    them — are deleted after a grace period.
  if (!light) {
    local = localSnapshots(root);
    const completeLocal = [...local.values()].filter(s => s.complete);
    const remoteIds = remoteComplete();
    const manDir = remoteManifestDir(root);
    ensureDir(manDir);
    const referenced = new Set<string>();
    let allKnown = completeLocal.length > 0;
    for (const s of completeLocal) for (const u of readManifestDocs(localManifestPath(root, s.id))) referenced.add(u);
    for (const id of remoteIds) {
      if (local.get(id)?.complete) continue;
      const cached = join(manDir, `${id}.json`);
      if (!existsSync(cached)) {
        try { writeAtomic(cached, await store.get(snapKey(id, MANIFEST))); } catch { allKnown = false; continue; }
      }
      for (const u of readManifestDocs(cached)) referenced.add(u);
    }
    for (const f of readdirSync(manDir)) {
      const id = f.replace(/\.json$/, '');
      if (!remoteIds.has(id) || local.get(id)?.complete) { try { unlinkSync(join(manDir, f)); } catch { /* */ } }
    }
    const orphans = report.state.orphanBlobsSince;
    for (const uuid of Object.keys(orphans)) if (referenced.has(uuid) || !remote.blobs.has(uuid)) delete orphans[uuid];
    // Only when every remote manifest could be read — otherwise we can't know what's unreferenced.
    if (allKnown) {
      for (const uuid of remote.blobs.keys()) {
        if (referenced.has(uuid)) continue;
        orphans[uuid] ??= nowMs;
        if (nowMs - orphans[uuid] < ORPHAN_BLOB_GRACE_MS) continue;
        if (await tryDelete(blobKey(uuid), 'an unused document')) delete orphans[uuid];
      }
    }
  }

  // Both sides now have these.
  const finalRemote = remoteComplete();
  report.state.synced = [...localSnapshots(root).values()]
    .filter(s => s.complete && finalRemote.has(s.id))
    .map(s => s.id)
    .sort();
  return report;
}

/** Fetch one complete remote snapshot into `root` (blobs, files, manifest last). Returns blobs downloaded. */
async function downloadSnapshot(
  root: string, store: ObjectStore, prefix: string, id: string,
  files: Map<string, StoredObject>, blobs: Map<string, StoredObject>,
): Promise<number> {
  const dir = join(root, 'snapshots', id);
  ensureDir(dir);
  const tmpManifest = join(dir, `${MANIFEST}.part`);
  writeFileSync(tmpManifest, await store.get(`${prefix}/snapshots/${id}/${MANIFEST}`));
  let n = 0;
  for (const uuid of readManifestDocs(tmpManifest)) {
    const dst = join(root, 'blobs', `${uuid}.enc`);
    const obj = blobs.get(uuid);
    if (!obj) throw new Error(`Backup document ${uuid} is missing from the bucket.`);
    if (existsSync(dst) && statSync(dst).size === obj.size) continue;
    const body = await store.get(`${prefix}/blobs/${uuid}.enc`);
    if (body.length !== obj.size) throw new Error(`Download of document ${uuid} was incomplete.`);
    writeAtomic(dst, body);
    n += 1;
  }
  for (const [file, obj] of files) {
    if (file === MANIFEST) continue;
    const body = await store.get(`${prefix}/snapshots/${id}/${file}`);
    if (body.length !== obj.size) throw new Error(`Download of ${id}/${file} was incomplete.`);
    writeAtomic(join(dir, file), body);
  }
  renameSync(tmpManifest, join(dir, MANIFEST));
  return n;
}

/**
 * Download one specific remote snapshot (e.g. an older one picked in the
 * Restore dialog that this PC never fetched). No-op if it's already local.
 */
export async function fetchRemoteSnapshot(root: string, store: ObjectStore, prefix: string, id: string): Promise<void> {
  if (!SNAPSHOT_ID_RE.test(id)) throw new Error('Bad snapshot id.');
  if (existsSync(localManifestPath(root, id))) return;
  const remote = groupRemote(await store.list(`${prefix}/`), prefix);
  const files = remote.snapshots.get(id);
  if (!files?.has(MANIFEST)) throw new Error('That backup is no longer in the bucket.');
  ensureDir(join(root, 'blobs'));
  await downloadSnapshot(root, store, prefix, id, files, remote.blobs);
}

/** Newest local settings file for `name` (e.g. "gmail"), or null. */
export function latestSettingsFile(root: string, name: string): { path: string; atMs: number } | null {
  const dir = settingsDir(root);
  if (!existsSync(dir)) return null;
  let best: { path: string; atMs: number } | null = null;
  for (const f of readdirSync(dir)) {
    const m = f.match(SETTINGS_RE);
    if (!m || m[1] !== name) continue;
    const atMs = Number(m[2]);
    if (!best || atMs > best.atMs) best = { path: join(dir, f), atMs };
  }
  return best;
}

/** Write a new settings version (never overwrites; a newer timestamp always wins). */
export function writeSettingsFile(root: string, name: string, body: Buffer, atMs: number = Date.now()): { path: string; atMs: number } {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Bad settings name.');
  const dir = settingsDir(root);
  ensureDir(dir);
  const latest = latestSettingsFile(root, name);
  const stamp = Math.max(atMs, (latest?.atMs ?? 0) + 1);
  const path = join(dir, `${name}-${String(stamp).padStart(13, '0')}.enc`);
  writeAtomic(path, body);
  return { path, atMs: stamp };
}

async function syncSettings(
  root: string, store: ObjectStore, prefix: string, remote: Map<string, StoredObject>, light: boolean,
  tryDelete: (key: string, what: string) => Promise<boolean>,
): Promise<void> {
  const dir = settingsDir(root);
  ensureDir(dir);
  const localFiles = new Set(readdirSync(dir).filter(f => SETTINGS_RE.test(f)));
  const newestPerName = (files: Iterable<string>) => {
    const m = new Map<string, string>();
    for (const f of files) { const n = f.match(SETTINGS_RE)![1]; if (!m.has(n) || f > m.get(n)!) m.set(n, f); }
    return m;
  };
  // Only the newest remote version of each name matters; older ones are history.
  const localNewest = newestPerName(localFiles);
  for (const [name, f] of newestPerName(remote.keys())) {
    if (!localFiles.has(f) && (!localNewest.has(name) || f > localNewest.get(name)!)) {
      writeAtomic(join(dir, f), await store.get(`${prefix}/settings/${f}`));
      localFiles.add(f);
    }
  }
  if (light) return;
  for (const f of localFiles) {
    if (!remote.has(f)) await store.put(`${prefix}/settings/${f}`, readFileSync(join(dir, f)));
  }
  // Keep the newest SETTINGS_KEEP versions of each name, locally and (throttled) remotely.
  const byName = new Map<string, string[]>();
  for (const f of new Set([...localFiles, ...remote.keys()])) {
    const name = f.match(SETTINGS_RE)![1];
    byName.set(name, [...(byName.get(name) || []), f]);
  }
  for (const list of byName.values()) {
    for (const f of list.sort().reverse().slice(SETTINGS_KEEP)) {
      try { if (existsSync(join(dir, f))) unlinkSync(join(dir, f)); } catch { /* */ }
      if (remote.has(f)) await tryDelete(`${prefix}/settings/${f}`, 'an old settings version');
    }
  }
}

// ── Mirror folder ───────────────────────────────────────────────────────────

/**
 * Copy a backup root's snapshots + blobs into `dest`, manifest last. With
 * `prune`, also remove what the source no longer has — but never when the
 * source holds no complete snapshot (an empty source is a fault, not a prune).
 * Used for the optional extra-copy folder and to seed the R2 cache from an
 * existing Google Drive backup folder.
 */
export function copyBackupTree(src: string, dest: string, opts: { prune: boolean }): { copiedSnapshots: number } {
  ensureDir(join(dest, 'snapshots'));
  ensureDir(join(dest, 'blobs'));
  if (existsSync(join(src, META)) && !existsSync(join(dest, META))) copyFileSync(join(src, META), join(dest, META));

  const from = localSnapshots(src);
  const to = localSnapshots(dest);
  const srcBlobs = existsSync(join(src, 'blobs')) ? readdirSync(join(src, 'blobs')).filter(f => BLOB_RE.test(f)) : [];
  for (const f of srcBlobs) {
    const s = join(src, 'blobs', f);
    const d = join(dest, 'blobs', f);
    if (!existsSync(d) || statSync(d).size !== statSync(s).size) copyFileSync(s, d);
  }

  let copiedSnapshots = 0;
  for (const snap of from.values()) {
    if (!snap.complete || to.get(snap.id)?.complete) continue;
    const sDir = join(src, 'snapshots', snap.id);
    const dDir = join(dest, 'snapshots', snap.id);
    ensureDir(dDir);
    for (const f of snap.files.filter(f => f !== MANIFEST)) copyFileSync(join(sDir, f), join(dDir, f));
    copyFileSync(join(sDir, MANIFEST), join(dDir, MANIFEST));
    copiedSnapshots += 1;
  }

  const srcComplete = [...from.values()].filter(s => s.complete);
  if (opts.prune && srcComplete.length > 0) {
    for (const id of to.keys()) {
      if (!from.get(id)?.complete) rmSync(join(dest, 'snapshots', id), { recursive: true, force: true });
    }
    const keepBlobs = new Set(srcBlobs);
    for (const f of readdirSync(join(dest, 'blobs'))) {
      if (BLOB_RE.test(f) && !keepBlobs.has(f)) { try { unlinkSync(join(dest, 'blobs', f)); } catch { /* */ } }
    }
  }
  return { copiedSnapshots };
}
