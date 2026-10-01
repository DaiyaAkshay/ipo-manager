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
import type { ObjectStore, StoredObject } from './objectStore';

export const MANIFEST = 'manifest.json';
const META = 'meta.json';
const SNAPSHOT_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(\.\d{3})?Z$/;
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

export interface ReplicationState {
  /** Snapshot ids both sides had, as of the last pass. */
  synced: string[];
  /** Snapshots this PC pruned → last time a remote delete was attempted. */
  tombstones: Record<string, number>;
  /** Remote blob → when it was first seen unreferenced. */
  orphanBlobsSince: Record<string, number>;
}

export function emptyReplicationState(): ReplicationState {
  return { synced: [], tombstones: {}, orphanBlobsSince: {} };
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

// ── Remote listing ──────────────────────────────────────────────────────────

interface RemoteView {
  snapshots: Map<string, Map<string, StoredObject>>;
  blobs: Map<string, StoredObject>;
  meta: StoredObject | null;
}

function groupRemote(objects: StoredObject[], prefix: string): RemoteView {
  const view: RemoteView = { snapshots: new Map(), blobs: new Map(), meta: null };
  const base = `${prefix}/`;
  for (const o of objects) {
    if (!o.key.startsWith(base)) continue;
    const rel = o.key.slice(base.length);
    if (rel === META) { view.meta = o; continue; }
    const parts = rel.split('/');
    if (parts.length === 2 && parts[0] === 'blobs' && BLOB_RE.test(parts[1])) {
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
): Promise<ReplicationReport> {
  ensureDir(join(root, 'snapshots'));
  ensureDir(join(root, 'blobs'));
  const report: ReplicationReport = {
    state: { synced: [], tombstones: { ...prev.tombstones }, orphanBlobsSince: { ...prev.orphanBlobsSince } },
    uploadedSnapshots: [], downloadedSnapshots: [], deletedRemote: [], deletedLocal: [],
    uploadedBlobs: 0, downloadedBlobs: 0, warnings: [],
  };
  const tombstones = report.state.tombstones;
  const synced = new Set(prev.synced);

  const remote = groupRemote(await store.list(`${prefix}/`), prefix);
  const remoteComplete = () => new Set([...remote.snapshots].filter(([, f]) => f.has(MANIFEST)).map(([id]) => id));
  let local = localSnapshots(root);

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
  for (const id of synced) {
    if (!local.has(id) && remote.snapshots.has(id)) tombstones[id] = 0;
  }
  for (const [id, lastTry] of Object.entries(tombstones)) {
    if (!remote.snapshots.has(id)) { delete tombstones[id]; continue; }
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
  if (remoteNow.size > 0) {
    for (const id of synced) {
      if (remote.snapshots.has(id) || !local.get(id)?.complete) continue;
      try { rmSync(join(root, 'snapshots', id), { recursive: true, force: true }); report.deletedLocal.push(id); } catch { /* */ }
    }
    local = localSnapshots(root);
  }

  // 3) Download complete remote snapshots this PC doesn't have: blobs, then
  //    the snapshot files, then the manifest.
  for (const id of [...remoteComplete()].sort()) {
    if (local.get(id)?.complete || id in tombstones) continue;
    const files = remote.snapshots.get(id)!;
    const dir = join(root, 'snapshots', id);
    ensureDir(dir);
    const manifestBody = await store.get(snapKey(id, MANIFEST));
    const tmpManifest = join(dir, `${MANIFEST}.part`);
    writeFileSync(tmpManifest, manifestBody);
    for (const uuid of readManifestDocs(tmpManifest)) {
      const dst = localBlob(uuid);
      const obj = remote.blobs.get(uuid);
      if (!obj || (existsSync(dst) && statSync(dst).size === obj.size)) continue;
      writeAtomic(dst, await store.get(blobKey(uuid)));
      report.downloadedBlobs += 1;
    }
    for (const [file, obj] of files) {
      if (file === MANIFEST) continue;
      const body = await store.get(snapKey(id, file));
      if (body.length !== obj.size) throw new Error(`Download of ${id}/${file} was incomplete.`);
      writeAtomic(join(dir, file), body);
    }
    renameSync(tmpManifest, join(dir, MANIFEST));
    report.downloadedSnapshots.push(id);
  }

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
    } else if (age > PARTIAL_CLEANUP_MS && !local.get(id)?.complete) {
      await deleteRemoteSnapshot(id);
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
    if (!snap.complete || remoteDone.has(snap.id)) continue;
    for (const uuid of readManifestDocs(localManifestPath(root, snap.id))) {
      const src = localBlob(uuid);
      if (!existsSync(src)) continue;
      const size = statSync(src).size;
      if (remote.blobs.get(uuid)?.size === size) continue;
      await store.put(blobKey(uuid), readFileSync(src));
      remote.blobs.set(uuid, { key: blobKey(uuid), size, lastModified: nowMs });
      report.uploadedBlobs += 1;
    }
    const files = new Map<string, StoredObject>();
    for (const file of snap.files.filter(f => f !== MANIFEST)) {
      const body = readFileSync(join(root, 'snapshots', snap.id, file));
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
  if (!remote.meta && existsSync(localMeta)) await store.put(`${prefix}/${META}`, readFileSync(localMeta));
  else if (remote.meta && !existsSync(localMeta)) writeAtomic(localMeta, await store.get(`${prefix}/${META}`));

  // 7) Remote blobs no complete snapshot references — deleted after a grace
  //    period, so a blob another PC is about to reference again survives.
  local = localSnapshots(root);
  const completeLocal = [...local.values()].filter(s => s.complete);
  if (completeLocal.length > 0) {
    const referenced = new Set<string>();
    for (const s of completeLocal) for (const u of readManifestDocs(localManifestPath(root, s.id))) referenced.add(u);
    const orphans = report.state.orphanBlobsSince;
    for (const uuid of Object.keys(orphans)) if (referenced.has(uuid) || !remote.blobs.has(uuid)) delete orphans[uuid];
    for (const uuid of remote.blobs.keys()) {
      if (referenced.has(uuid)) continue;
      orphans[uuid] ??= nowMs;
      if (nowMs - orphans[uuid] < ORPHAN_BLOB_GRACE_MS) continue;
      try {
        await store.delete(blobKey(uuid));
        delete orphans[uuid];
      } catch (e: any) {
        report.warnings.push(`Could not delete an unused document from the bucket: ${e?.message || e}`);
        break;
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
