/**
 * Carries app settings that live outside the vault (today: the Gmail OAuth
 * client + sign-in) between PCs, next to the snapshots, so setting up a new PC
 * doesn't mean pasting the Google JSON and signing in again.
 *
 *   <backup-root>/settings/gmail-<ms>.enc
 *
 * Each file is AES-256-GCM-encrypted with the vault's FIELD key — the same on
 * every PC of this vault and unchanged by a master-password change — and holds
 * { v, atMs, host, gmail: payload | null } (null = removed on that PC). Every
 * change is a NEW file (never overwritten, so an R2 bucket lock is no
 * obstacle); the newest timestamp wins. Settings are not part of snapshot
 * lineage, so a Gmail sign-in on one PC never causes a sync conflict.
 *
 * The decision logic (decideSettingsSync) is pure and unit-tested; the I/O
 * wrapper (syncGmailSettings) takes its Gmail accessors as arguments so this
 * module has no dependency on Electron, keytar or googleapis.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { latestSettingsFile, writeSettingsFile } from './replicator';

/** Per-PC memory of the last settings version it has seen or published. */
export interface SettingsSyncState {
  /** Fingerprint of the local setup when last synced (null = none). */
  fp: string | null;
  /** Timestamp of the version that fingerprint came from. */
  atMs: number;
}

export type SettingsDecision =
  | { kind: 'none'; state: SettingsSyncState }
  | { kind: 'publish'; state: SettingsSyncState }   // write local as a new version
  | { kind: 'apply'; state: SettingsSyncState };    // adopt the remote version locally

/**
 * @param state   this PC's sync memory (undefined = never synced settings here)
 * @param localFp fingerprint of the current local setup (null = none)
 * @param remote  newest version in the backup root (fp null = "removed")
 */
export function decideSettingsSync(
  state: SettingsSyncState | undefined,
  localFp: string | null,
  remote: { atMs: number; fp: string | null } | null,
  nowMs: number,
): SettingsDecision {
  if (!state) {
    // First time on this PC. A new PC takes what the other PCs use; a PC that
    // already has its own setup keeps it and only publishes if nothing exists.
    if (remote && remote.fp && !localFp) return { kind: 'apply', state: { fp: remote.fp, atMs: remote.atMs } };
    if (localFp && !remote) return { kind: 'publish', state: { fp: localFp, atMs: nowMs } };
    return { kind: 'none', state: { fp: localFp, atMs: remote?.atMs ?? 0 } };
  }
  if (localFp !== state.fp) {
    // Changed here since the last sync (signed in again, new JSON, removed).
    return { kind: 'publish', state: { fp: localFp, atMs: nowMs } };
  }
  if (remote && remote.atMs > state.atMs) {
    if (remote.fp !== localFp) return { kind: 'apply', state: { fp: remote.fp, atMs: remote.atMs } };
    return { kind: 'none', state: { fp: localFp, atMs: remote.atMs } };
  }
  return { kind: 'none', state };
}

export function fingerprint(payload: unknown): string | null {
  if (payload === null || payload === undefined) return null;
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function encrypt(key: Buffer, plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}

function decrypt(key: Buffer, blob: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

interface SettingsFile<T> { v: 1; atMs: number; host: string; gmail: T | null }

/** Decrypt the newest version of `name`, or null (none, or not this vault's key). */
export function readLatestSettings<T>(root: string, name: string, fieldKey: Buffer): { atMs: number; payload: T | null } | null {
  const latest = latestSettingsFile(root, name);
  if (!latest) return null;
  try {
    const parsed = JSON.parse(decrypt(fieldKey, readFileSync(latest.path)).toString('utf8')) as SettingsFile<T>;
    return { atMs: latest.atMs, payload: parsed.gmail ?? null };
  } catch {
    return null;
  }
}

export interface GmailAccess<T> {
  read: () => Promise<T | null>;
  apply: (payload: T | null) => Promise<void>;
}

function readState(path: string): Record<string, SettingsSyncState> {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}; } catch { return {}; }
}

function writeState(path: string, state: Record<string, SettingsSyncState>): void {
  const tmp = `${path}.part`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, path);
}

/**
 * One pass: publish this PC's Gmail setup if it changed, or adopt a newer one
 * from another PC. Returns what happened (for logging / UI).
 */
export async function syncGmailSettings<T>(
  root: string, statePath: string, fieldKey: Buffer, gmail: GmailAccess<T>, nowMs: number = Date.now(),
): Promise<'none' | 'published' | 'applied'> {
  const all = readState(statePath);
  const local = await gmail.read();
  const remote = readLatestSettings<T>(root, 'gmail', fieldKey);
  const decision = decideSettingsSync(
    all.gmail, fingerprint(local), remote ? { atMs: remote.atMs, fp: fingerprint(remote.payload) } : null, nowMs,
  );
  if (decision.kind === 'publish') {
    const body: SettingsFile<T> = { v: 1, atMs: nowMs, host: hostname(), gmail: local };
    const written = writeSettingsFile(root, 'gmail', encrypt(fieldKey, Buffer.from(JSON.stringify(body))), nowMs);
    decision.state.atMs = written.atMs;
  } else if (decision.kind === 'apply') {
    await gmail.apply(remote!.payload);
    // Re-read: the fingerprint must match what the Gmail module now reports.
    decision.state.fp = fingerprint(await gmail.read());
  }
  all.gmail = decision.state;
  writeState(statePath, all);
  return decision.kind === 'publish' ? 'published' : decision.kind === 'apply' ? 'applied' : 'none';
}
