/**
 * Cross-PC sync policy — pure functions only (no filesystem, SQLite, keychain
 * or Electron), so the decisions that decide whether data gets overwritten are
 * unit-testable under plain Node. The engine (engine.ts) gathers the facts
 * (local DB hash, the folder's newest snapshot, this PC's sync state) and asks
 * this module what to do.
 *
 * ── Model ───────────────────────────────────────────────────────────────────
 * Every snapshot records the history it was built on (`ancestors`, newest
 * first). A PC's "base" is the snapshot it last pushed or pulled. Given the
 * folder's newest snapshot (the head):
 *
 *   head == base                          → up to date (push local changes)
 *   head built on base, no local changes  → fast-forward (take the head)
 *   local changes, or head NOT built on base → conflict: one side's changes
 *                                             would be lost, so ask the user
 *
 * Pushes only happen when head == base, and new snapshot ids always sort after
 * the head they were built on, so a PC whose clock runs behind can't produce a
 * "newer" snapshot that sorts as older.
 */

export interface SnapshotLineage {
  /** Snapshot this one was built on (the writer's base). */
  parentSnapshotId?: string | null;
  /** Newest-first history this snapshot descends from (capped). */
  ancestors?: string[];
  /** Snapshots this one deliberately replaces (conflict resolved as "keep this PC's data"). */
  supersedes?: string[];
  sourceHost?: string;
  timestamp?: string;
}

export interface HeadCandidate {
  id: string;
  /** All files present and consistent with the manifest (not mid-cloud-sync). */
  complete: boolean;
  manifest?: SnapshotLineage;
  /** now − the time encoded in the snapshot id. */
  ageMs: number;
}

export type Head =
  | { kind: 'none' }
  | { kind: 'pending'; id: string }
  | { kind: 'ready'; id: string; manifest: SnapshotLineage };

/** A partial snapshot older than this is treated as abandoned (writer crashed). */
export const ABANDONED_PARTIAL_MS = 30 * 60 * 1000;
/** Max ids kept in a snapshot's `ancestors`. */
export const MAX_LINEAGE = 200;

/**
 * Pick the folder's head from candidates sorted newest-first (lazily — stops
 * at the first decision). A recent incomplete snapshot means another PC's
 * upload hasn't fully arrived yet: report it as pending rather than skipping to
 * an older one (which would sync the wrong data) or restoring a torn file.
 */
export function pickHead(candidates: Iterable<HeadCandidate>): Head {
  for (const c of candidates) {
    if (c.complete && c.manifest) return { kind: 'ready', id: c.id, manifest: c.manifest };
    if (c.ageMs < ABANDONED_PARTIAL_MS) return { kind: 'pending', id: c.id };
    // Old partial snapshot — its writer crashed mid-way. Skip it.
  }
  return { kind: 'none' };
}

/**
 * Was the head built on top of (or deliberately replacing) our base?
 * Snapshot ids are ISO-like timestamps, so they compare chronologically.
 */
export function isDescendantOf(headId: string, head: SnapshotLineage, baseId: string | null): boolean {
  if (!baseId) return true;                  // never synced: nothing of ours in the folder to lose
  if (headId === baseId) return true;
  const hasLineage = head.parentSnapshotId !== undefined || head.ancestors !== undefined;
  if (!hasLineage) return true;              // written by a pre-lineage build: legacy behaviour
  if (head.parentSnapshotId === baseId) return true;
  const ancestors = head.ancestors ?? [];
  if (ancestors.includes(baseId)) return true;
  if (head.supersedes?.includes(baseId)) return true;
  // Our base is older than everything the head's history records (a capped
  // list, or history that started on a pre-lineage build during an upgrade):
  // it predates any fork the head could have taken, so it's not a divergent
  // branch. A divergent sibling is always NEWER than the fork point.
  const oldestKnown = [head.parentSnapshotId, ...ancestors].filter((x): x is string => !!x).sort()[0];
  return !!oldestKnown && baseId < oldestKnown;
}

/**
 * Has the local vault changed since it was last pushed or pulled?
 * `dirtyWhenUnknown` covers state with no fingerprint yet (written by a build
 * that didn't track hashes, or a PC that has never synced) — see the engine's
 * pullDirty/pushDirty for how each direction resolves it.
 */
export function isDirty(localHash: string | null, lastSyncedDbHash: string | null, dirtyWhenUnknown: boolean): boolean {
  if (!lastSyncedDbHash) return dirtyWhenUnknown;
  return localHash !== lastSyncedDbHash;
}

export interface SyncStateView {
  lastSnapshotId: string | null;
}

export type ConflictReason = 'local-unsynced-changes' | 'diverged';

export type SyncDecision =
  | { kind: 'up-to-date'; dirty: boolean }
  | { kind: 'pending'; remoteSnapshotId: string }
  | { kind: 'fast-forward'; remoteSnapshotId: string }
  | { kind: 'conflict'; remoteSnapshotId: string; reason: ConflictReason };

/**
 * @param dirty  whether this PC holds local changes the folder doesn't have.
 */
export function decideSync(state: SyncStateView, head: Head, dirty: boolean): SyncDecision {
  if (head.kind === 'none' || head.id === state.lastSnapshotId) return { kind: 'up-to-date', dirty };
  if (head.kind === 'pending') return { kind: 'pending', remoteSnapshotId: head.id };
  if (!dirty && isDescendantOf(head.id, head.manifest, state.lastSnapshotId)) {
    return { kind: 'fast-forward', remoteSnapshotId: head.id };
  }
  return { kind: 'conflict', remoteSnapshotId: head.id, reason: dirty ? 'local-unsynced-changes' : 'diverged' };
}

/** History for a new snapshot built on `lineage` (our base first). */
export function nextAncestors(lineage: string[], supersededLineage: string[] = []): string[] {
  const out: string[] = [];
  for (const id of [...lineage, ...supersededLineage]) {
    if (!out.includes(id)) out.push(id);
    if (out.length >= MAX_LINEAGE) break;
  }
  return out;
}

/**
 * Snapshot id for a new push: the current time, but never earlier than the
 * head it was built on — so a PC whose clock runs behind still produces an id
 * that sorts as newest. Ids are ISO timestamps with ':' → '-' (Windows paths).
 */
export function monotonicSnapshotTime(nowMs: number, headTimeMs: number | null): number {
  return headTimeMs !== null && headTimeMs >= nowMs ? headTimeMs + 1 : nowMs;
}

/**
 * Retention: which snapshots to keep (ids sorted any order, with their times).
 *   - everything from the last 2 hours
 *   - one per hour for the last 24 hours
 *   - one per day for the last 7 days
 *   - one per week for the last 30 days
 *   - one per month for the last 6 months
 *   - always the newest snapshot (the sync head), whatever its age
 * Within a bucket the newest snapshot wins.
 */
export function selectSnapshotsToKeep(snaps: Array<{ id: string; ts: number }>, nowMs: number): Set<string> {
  const hour = 3_600_000;
  const day = 24 * hour;
  const keep = new Set<string>();
  const buckets = new Set<string>();
  const sorted = [...snaps].filter(s => s.ts > 0).sort((a, b) => b.ts - a.ts || b.id.localeCompare(a.id));
  if (sorted[0]) keep.add(sorted[0].id);

  for (const s of sorted) {
    const age = nowMs - s.ts;
    const d = new Date(s.ts);
    let bucket: string | null;
    if (age < 2 * hour) {
      keep.add(s.id);
      continue;
    } else if (age < day) {
      bucket = `h:${d.toISOString().slice(0, 13)}`;
    } else if (age < 7 * day) {
      bucket = `d:${d.toISOString().slice(0, 10)}`;
    } else if (age < 30 * day) {
      bucket = `w:${Math.floor(s.ts / (7 * day))}`;
    } else if (age < 180 * day) {
      bucket = `m:${d.toISOString().slice(0, 7)}`;
    } else {
      bucket = null; // older than 6 months → delete
    }
    if (bucket && !buckets.has(bucket)) {
      buckets.add(bucket);
      keep.add(s.id);
    }
  }
  return keep;
}
