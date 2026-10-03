/**
 * Cross-PC sync policy — the rules that decide whether a PC takes another
 * PC's snapshot, pushes its own, or stops and asks. These are pure functions,
 * so unlike engine.test.ts they run under plain Node.
 */

import { describe, expect, it } from 'vitest';
import {
  ABANDONED_PARTIAL_MS,
  decideSync,
  isDescendantOf,
  isDirty,
  MAX_LINEAGE,
  monotonicSnapshotTime,
  nextAncestors,
  pickHead,
  selectSnapshotsToKeep,
  type HeadCandidate,
} from '../../src/main/backup/syncPolicy';

// Snapshot ids are ISO timestamps with ':' → '-'.
const id = (iso: string) => iso.replace(/:/g, '-');
const S1 = id('2026-09-20T10:00:00.000Z');
const S2 = id('2026-09-21T10:00:00.000Z');
const S3 = id('2026-09-22T10:00:00.000Z');
const S4 = id('2026-09-23T10:00:00.000Z');
const ready = (headId: string, manifest: object) => ({ kind: 'ready' as const, id: headId, manifest });

describe('pickHead', () => {
  it('returns the newest complete snapshot', () => {
    const head = pickHead([
      { id: S2, complete: true, manifest: { ancestors: [S1] }, ageMs: 1000 },
      { id: S1, complete: true, manifest: { ancestors: [] }, ageMs: 2000 },
    ]);
    expect(head).toEqual({ kind: 'ready', id: S2, manifest: { ancestors: [S1] } });
  });

  it('reports a recent incomplete snapshot as pending instead of falling back to an older one', () => {
    const head = pickHead([
      { id: S2, complete: false, ageMs: 60_000 },
      { id: S1, complete: true, manifest: {}, ageMs: 86_400_000 },
    ]);
    expect(head).toEqual({ kind: 'pending', id: S2 });
  });

  it('skips a partial snapshot old enough to have been abandoned by a crashed writer', () => {
    const head = pickHead([
      { id: S2, complete: false, ageMs: ABANDONED_PARTIAL_MS + 1 },
      { id: S1, complete: true, manifest: {}, ageMs: ABANDONED_PARTIAL_MS + 2 },
    ]);
    expect(head).toMatchObject({ kind: 'ready', id: S1 });
  });

  it('is lazy — stops at the first decision', () => {
    let inspected = 0;
    function* candidates(): Generator<HeadCandidate> {
      inspected++; yield { id: S3, complete: true, manifest: {}, ageMs: 0 };
      inspected++; yield { id: S2, complete: true, manifest: {}, ageMs: 0 };
    }
    pickHead(candidates());
    expect(inspected).toBe(1);
  });

  it('returns none for an empty folder', () => {
    expect(pickHead([])).toEqual({ kind: 'none' });
  });
});

describe('isDescendantOf', () => {
  it('treats snapshots from pre-lineage builds as linear (legacy behaviour)', () => {
    expect(isDescendantOf(S3, {}, S2)).toBe(true);
  });

  it('accepts a head whose history contains our base', () => {
    expect(isDescendantOf(S3, { parentSnapshotId: S2, ancestors: [S2, S1] }, S1)).toBe(true);
  });

  it('accepts a head that explicitly supersedes our base (conflict resolved on the other PC)', () => {
    expect(isDescendantOf(S4, { parentSnapshotId: S2, ancestors: [S2, S1], supersedes: [S3] }, S3)).toBe(true);
  });

  it('flags a divergent sibling: head built on an older snapshot, missing our newer one', () => {
    // A pushed S2 from S1; B, never having seen S2, pushed S3 from S1.
    expect(isDescendantOf(S3, { parentSnapshotId: S1, ancestors: [S1] }, S2)).toBe(false);
  });

  it('accepts a base older than everything the head records (upgrade from a pre-lineage build)', () => {
    // First snapshot written after upgrading only knows its immediate base S3.
    expect(isDescendantOf(S4, { parentSnapshotId: S3, ancestors: [S3] }, S1)).toBe(true);
  });

  it('accepts anything when this PC has never synced', () => {
    expect(isDescendantOf(S2, { parentSnapshotId: S1, ancestors: [S1] }, null)).toBe(true);
  });
});

describe('isDirty', () => {
  it('compares against the last synced fingerprint', () => {
    expect(isDirty('a', 'a', true)).toBe(false);
    expect(isDirty('b', 'a', false)).toBe(true);
  });
  it('uses the caller-chosen default when there is no fingerprint yet', () => {
    expect(isDirty('a', null, true)).toBe(true);
    expect(isDirty('a', null, false)).toBe(false);
  });
});

describe('decideSync', () => {
  it('is up to date when the head is our base', () => {
    expect(decideSync({ lastSnapshotId: S2 }, ready(S2, { ancestors: [S1] }), true))
      .toEqual({ kind: 'up-to-date', dirty: true });
  });

  it('fast-forwards when the other PC built on our data and we have no local changes', () => {
    expect(decideSync({ lastSnapshotId: S1 }, ready(S2, { parentSnapshotId: S1, ancestors: [S1] }), false))
      .toEqual({ kind: 'fast-forward', remoteSnapshotId: S2 });
  });

  it('refuses to overwrite unsynced local changes — the old behaviour silently lost them', () => {
    expect(decideSync({ lastSnapshotId: S1 }, ready(S2, { parentSnapshotId: S1, ancestors: [S1] }), true))
      .toEqual({ kind: 'conflict', remoteSnapshotId: S2, reason: 'local-unsynced-changes' });
  });

  it('refuses to take a divergent head even when clean', () => {
    expect(decideSync({ lastSnapshotId: S2 }, ready(S3, { parentSnapshotId: S1, ancestors: [S1] }), false))
      .toEqual({ kind: 'conflict', remoteSnapshotId: S3, reason: 'diverged' });
  });

  it('waits for a snapshot that is still arriving', () => {
    expect(decideSync({ lastSnapshotId: S1 }, { kind: 'pending', id: S2 }, false))
      .toEqual({ kind: 'pending', remoteSnapshotId: S2 });
  });

  it('pushes into an empty folder', () => {
    expect(decideSync({ lastSnapshotId: null }, { kind: 'none' }, true)).toEqual({ kind: 'up-to-date', dirty: true });
  });
});

describe('two-PC scenarios', () => {
  it('sequential use stays in sync without prompts', () => {
    // A pushes S1. B (never synced, empty vault) pulls it, edits, pushes S2 built on S1.
    expect(decideSync({ lastSnapshotId: null }, ready(S1, { ancestors: [] }), false).kind).toBe('fast-forward');
    const s2 = { parentSnapshotId: S1, ancestors: nextAncestors([S1]) };
    // A, clean, sees S2 and takes it.
    expect(decideSync({ lastSnapshotId: S1 }, ready(S2, s2), false).kind).toBe('fast-forward');
    // A pushes S3 on top of S2; B, clean, takes it.
    const s3 = { parentSnapshotId: S2, ancestors: nextAncestors([S2, ...s2.ancestors]) };
    expect(decideSync({ lastSnapshotId: S2 }, ready(S3, s3), false).kind).toBe('fast-forward');
  });

  it('a PC that missed several snapshots still fast-forwards (not a false conflict)', () => {
    const s4 = { parentSnapshotId: S3, ancestors: [S3, S2, S1] };
    expect(decideSync({ lastSnapshotId: S1 }, ready(S4, s4), false).kind).toBe('fast-forward');
  });

  it('keep-local resolution lets the other PC fast-forward without a second prompt', () => {
    // B pushed S2 (from S1). A, dirty from S1, chose "keep this PC's data" → S3 supersedes S2.
    const s3 = { parentSnapshotId: S1, ancestors: nextAncestors([S1], [S2, S1]), supersedes: [S2] };
    expect(decideSync({ lastSnapshotId: S2 }, ready(S3, s3), false).kind).toBe('fast-forward');
  });

  it('upgrade transition: first lineage-bearing snapshot does not strand older PCs', () => {
    // Other PC upgraded; its first push only records its immediate base (S3).
    const s4 = { parentSnapshotId: S3, ancestors: [S3] };
    // This PC's base is an older 0.3.6-era snapshot (S1) → take the newer data.
    expect(decideSync({ lastSnapshotId: S1 }, ready(S4, s4), false).kind).toBe('fast-forward');
  });
});

describe('monotonicSnapshotTime', () => {
  it('uses the current time normally', () => {
    expect(monotonicSnapshotTime(2000, 1000)).toBe(2000);
    expect(monotonicSnapshotTime(2000, null)).toBe(2000);
  });
  it('never sorts before the head, even when this PC\'s clock runs behind', () => {
    expect(monotonicSnapshotTime(1000, 5000)).toBe(5001);
    expect(monotonicSnapshotTime(5000, 5000)).toBe(5001);
  });
});

describe('nextAncestors', () => {
  it('dedupes and keeps order (our base first)', () => {
    expect(nextAncestors([S2, S1], [S3, S1])).toEqual([S2, S1, S3]);
  });
  it('caps the history length', () => {
    const many = Array.from({ length: MAX_LINEAGE + 50 }, (_, i) => `id-${i}`);
    expect(nextAncestors(many)).toHaveLength(MAX_LINEAGE);
  });
});

describe('selectSnapshotsToKeep', () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const now = Date.UTC(2026, 8, 26, 12, 0, 0);
  const snap = (ageMs: number) => ({ id: id(new Date(now - ageMs).toISOString()), ts: now - ageMs });

  it('keeps everything from the last two hours', () => {
    const snaps = [snap(5 * 60_000), snap(30 * 60_000), snap(90 * 60_000)];
    expect(selectSnapshotsToKeep(snaps, now).size).toBe(3);
  });

  it('thins older snapshots to one per hour, then one per day', () => {
    const snaps = [
      snap(3 * HOUR + 10 * 60_000), snap(3 * HOUR + 20 * 60_000),     // same hour → 1
      snap(2 * DAY + HOUR), snap(2 * DAY + 2 * HOUR),                 // same day → 1
    ];
    const keep = selectSnapshotsToKeep(snaps, now);
    expect(keep.has(snaps[0].id)).toBe(true);
    expect(keep.has(snaps[1].id)).toBe(false);
    expect(keep.has(snaps[2].id)).toBe(true);
    expect(keep.has(snaps[3].id)).toBe(false);
  });

  it('drops snapshots older than six months but always keeps the newest', () => {
    const ancient = snap(400 * DAY);
    expect(selectSnapshotsToKeep([ancient], now).has(ancient.id)).toBe(true);        // it's the head
    const newer = snap(10 * DAY);
    const keep = selectSnapshotsToKeep([ancient, newer], now);
    expect(keep.has(newer.id)).toBe(true);
    expect(keep.has(ancient.id)).toBe(false);
  });
});

 it('retains the lexically newest head when UUID snapshots share a timestamp', () => {
  const now = Date.UTC(2026, 9, 3), ts = now - 200 * 86_400_000;
  const older = '2026-03-17T00-00-00.000Z_00000000-0000-4000-8000-000000000000';
  const head = '2026-03-17T00-00-00.000Z_ffffffff-ffff-4fff-8fff-ffffffffffff';
  expect(selectSnapshotsToKeep([{ id: older, ts }, { id: head, ts }], now)).toEqual(new Set([head]));
 });
