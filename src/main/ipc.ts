import type { IpcMain } from 'electron';
import { dialog, app, BrowserWindow, shell } from 'electron';
import { copyFileSync, existsSync, statSync, rmSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dbExists, openDb, getDb, rekeyDb, closeDb, getDataDir } from './db/connection';
import { vaultInitialized, deriveMasterKey, passwordStrengthIssues } from './crypto/master';
import { encryptField, decryptField, lastN, clearKeyCache as clearFieldKeyCache } from './crypto/field';
import { beginAutomation, endAutomation, activeAutomations } from './activity';
import { getBankAdapter, getBrokerAdapter, getOtpPreset } from './automation/registry';
import {
  waitForOtp,
  getGmailConnectionStatus,
  connectGmail,
  isGmailAuthError,
  saveGmailCredentialsJson,
  clearGmailCredentialsConfig,
} from './email/gmail';
import {
  clearCaptchaApiKey,
  getCaptchaAiStatus,
  setCaptchaAiProvider,
  saveCaptchaApiKey,
  type CaptchaApiKeyProvider,
  type CaptchaAiProvider,
} from './ai/captcha';
import { getBrokerReportDir, sanitizeFileName } from './reports/storage';
import {
  applyMemberDocumentDrafts,
  downloadMemberDocumentToDownloads,
  getMemberDocumentSummaryMap,
  MEMBER_DOCUMENT_TYPES,
  removeAllMemberDocuments,
  type MemberDocumentType,
} from './documents/storage';
import type { IpoBidDraft } from './automation/browser';
import { launchSession, closeAllBrowserSessions, purgeBrowserProfiles } from './automation/browser';
import { importExcel } from './importer/excel';
import { exportExcel } from './exporter/excel';
import { parseAngelPortfolioReport } from './reports/angelWorkbook';
import { parseDhanPortfolioReport } from './reports/dhanWorkbook';
import { parseZerodhaPortfolioReport } from './reports/zerodhaWorkbook';
import { listCachedIpoIssues, refreshIpoCatalog } from './ipo/catalog';
import {
  getBackupConfig as backupGetConfig,
  setBackupConfig as backupSetConfig,
  getBackupState as backupGetState,
  getCurrentInProgress as backupInProgress,
  listSnapshots as backupListSnapshots,
  restoreSnapshot as backupRestoreSnapshot,
  latestSnapshotId as backupLatestSnapshotId,
  backupNow,
  enableR2,
  getActiveRoot as backupActiveRoot,
  hasR2Secret,
  setR2Secret,
  testR2,
  type R2Config,
  getLocalDbHash,
  getSyncStatus,
  publishRestoredVault,
  pushBeforeClose,
  resolveSyncConflict,
  setSyncSuspended,
  syncOnUnlock,
  syncTick,
  tryUnlockFromNewerBackup,
  type SyncOutcome,
} from './backup/engine';
import { normalizePrefix, validateR2Settings } from './backup/objectStore';

// Store the master password as a Buffer so we can zero the bytes on lock,
// preventing the string from lingering in V8's heap (JS strings are immutable
// and can't be overwritten; a Buffer can). All callers use getMasterPassword()
// which returns a temporary string copy — minimise the lifetime of that copy.
let currentMasterPasswordBuf: Buffer | null = null;
let currentMasterKey: Buffer | null = null;

function getMasterPassword(): string | null {
  return currentMasterPasswordBuf ? currentMasterPasswordBuf.toString('utf8') : null;
}

// ── Unlock rate-limiter ────────────────────────────────────────────────────
// Exponential back-off after consecutive wrong-password attempts so brute-force
// over IPC (e.g. via a malicious Electron renderer exploit) is expensive.
// Resets fully on a successful unlock.
let failedUnlockAttempts = 0;
let unlockCooldownUntil = 0;

export function clearVaultSessionSecrets(): void {
  // Zero the master key and password buffers before nulling the references so
  // the bytes don't linger in V8's heap even if the GC delays.
  if (currentMasterKey) currentMasterKey.fill(0);
  if (currentMasterPasswordBuf) { currentMasterPasswordBuf.fill(0); currentMasterPasswordBuf = null; }
  currentMasterKey = null;
  // Wipe the field-encryption key cached in field.ts. Without this, any IPC
  // handler that calls decryptField after lock would re-fetch from the OS
  // keychain successfully. With this, a future decrypt call needs the keychain
  // service to still be authorised — which means the OS lock state controls
  // access, not just our in-memory flag.
  clearFieldKeyCache();
  stopSyncLoop();
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try { if (!win.isDestroyed()) win.webContents.send(channel, payload); } catch { /* */ }
  }
}

/**
 * Tell the renderer what a sync pass did: a pull means the vault was replaced
 * underneath it (reload everything); a new conflict needs the user's choice;
 * anything else just refreshes the backup pill.
 */
function reportSyncOutcome(outcome: SyncOutcome, reason: string): void {
  // A pass that finished after the vault locked must not re-arm the session key.
  if (outcome.newMasterKey && currentMasterKey) currentMasterKey = Buffer.from(outcome.newMasterKey);
  if (outcome.action === 'pulled') {
    console.log(`[Sync] (${reason}) pulled snapshot from ${outcome.sourceHost || 'another PC'}`);
    broadcast('vault:autoSynced', {
      snapshotTimestamp: outcome.snapshotTimestamp,
      sourceHost: outcome.sourceHost ?? null,
    });
  } else if (outcome.action === 'conflict' && outcome.conflictIsNew) {
    console.warn(`[Sync] (${reason}) conflict with ${outcome.conflict?.remoteHost || 'another PC'}: ${outcome.conflict?.reason}`);
    broadcast('backup:syncConflict', outcome.conflict);
  } else if (outcome.action === 'error' && outcome.error) {
    console.warn(`[Sync] (${reason}) ${outcome.error}`);
  }
  if (outcome.action !== 'none' && outcome.action !== 'disabled') broadcast('backup:statusChanged', {});
}

/**
 * Push local changes before the vault closes (lock, auto-lock, quit, Windows
 * shutdown). Only pushes when data actually changed and no other PC pushed in
 * the meantime — see pushBeforeClose. Never throws: backup must not block exit.
 */
export async function flushBackupOnExit(): Promise<void> {
  if (!currentMasterKey) return;
  // Stop the loop, tell a pass that is still running not to pull, and let it
  // finish — so nothing re-opens the vault after the caller closes it.
  setSyncSuspended(true);
  stopSyncLoop();
  await waitForSyncIdle(30_000);
  if (!currentMasterKey) return;
  try {
    const outcome = await pushBeforeClose(currentMasterKey);
    if (outcome.action === 'pushed') console.log('[Sync] (on-close) pushed local changes');
    else if (outcome.action === 'conflict') console.warn('[Sync] (on-close) not pushed: another PC saved newer data — resolve at next unlock');
    else if (outcome.error) console.warn(`[Sync] (on-close) ${outcome.error}`);
  } catch (e: any) {
    console.warn(`[Sync] (on-close) threw: ${e?.message || e}`);
  }
}

// ── Sync loop ────────────────────────────────────────────────────────────────
// While unlocked: every SYNC_TICK_MS, pull a newer snapshot from another PC
// (when nothing here is unsynced) and push local changes once they settle.
// Replaces the old "once 10s after unlock, then every 6h" backup timer, which
// left the other PC without this PC's changes for hours.
const SYNC_TICK_MS = 30_000;
let syncLoopTimer: ReturnType<typeof setInterval> | null = null;
let syncTickRunning = false;

async function runSyncTick(reason: string): Promise<void> {
  if (syncTickRunning || !currentMasterKey) return;
  const password = getMasterPassword();
  if (!password) return;
  syncTickRunning = true;
  try {
    // Never swap the DB under an in-flight login or push mid-run: balance
    // writes from a bulk refresh land in one snapshot after it finishes.
    const idle = activeAutomations() === 0;
    // A copy: locking zeroes currentMasterKey, and a pass may still be using its key.
    const outcome = await syncTick({ masterPassword: password, liveKey: Buffer.from(currentMasterKey), canPull: idle, canPush: idle });
    reportSyncOutcome(outcome, reason);
  } catch (e: any) {
    console.warn(`[Sync] (${reason}) tick failed: ${e?.message || e}`);
  } finally {
    syncTickRunning = false;
  }
}

async function waitForSyncIdle(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((syncTickRunning || backupInProgress()) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

/**
 * Run a user-initiated backup action without colliding with the 30 s sync
 * loop: pause it, let a running pass finish, run, resume. Before this, such
 * clicks failed with "a backup is already running".
 */
async function withSyncPaused<T>(fn: () => Promise<T>): Promise<T> {
  const wasRunning = !!syncLoopTimer;
  stopSyncLoop();
  await waitForSyncIdle(60_000);
  try {
    return await fn();
  } finally {
    if (wasRunning && currentMasterKey) startSyncLoop();
  }
}

function startSyncLoop(): void {
  setSyncSuspended(false);
  stopSyncLoop();
  syncLoopTimer = setInterval(() => { void runSyncTick('periodic'); }, SYNC_TICK_MS);
}

function stopSyncLoop(): void {
  if (syncLoopTimer) {
    clearInterval(syncLoopTimer);
    syncLoopTimer = null;
  }
}

function documentTypeLabel(docType: MemberDocumentType): string {
  switch (docType) {
    case 'PAN': return 'PAN';
    case 'AADHAAR': return 'Aadhaar';
    case 'BIRTH_CERTIFICATE': return 'Birth Certificate';
    case 'CHEQUE': return 'Cheque';
    default: return docType;
  }
}

async function openFolderContainingFile(filePath: string): Promise<string | null> {
  // Prefer Electron's built-in: it opens the file manager at the file's folder
  // and selects the file, handling spaces/quoting correctly on every platform.
  //
  // We used to spawn `explorer.exe /select,<path>` ourselves, but Node's spawn
  // auto-quotes the whole argument to `"/select,C:\...\pan (1).pdf"`. When the
  // filename contains a space (which it does on every repeat download —
  // "pan (1).pdf", "pan (2).pdf", …), explorer can't parse that form and
  // silently falls back to opening the default Documents/This-PC folder instead
  // of Downloads. showItemInFolder avoids the whole problem.
  try {
    shell.showItemInFolder(filePath);
    return null;
  } catch (error: any) {
    console.warn('[Open Folder] showItemInFolder failed:', error?.message || error);
  }

  // Fallback: at least open the containing folder (without selecting the file).
  const folderOpenError = await shell.openPath(dirname(filePath));
  return folderOpenError || null;
}

export function registerIpcHandlers(ipc: IpcMain): void {

  ipc.handle('vault:status', () => ({
    initialized: vaultInitialized() && dbExists()
  }));

  ipc.handle('vault:unlock', async (_, password: string) => {
    // ── Rate-limit check ──────────────────────────────────────────────────
    const now = Date.now();
    if (unlockCooldownUntil > now) {
      const secs = Math.ceil((unlockCooldownUntil - now) / 1000);
      return {
        ok: false,
        error: `Too many failed attempts. Please wait ${secs} second${secs === 1 ? '' : 's'} before trying again.`,
        cooldownSeconds: secs,
      };
    }

    if (!vaultInitialized() && !dbExists()) {
      const issues = passwordStrengthIssues(password);
      if (issues.length) return { ok: false, issues };
    }
    try {
      const key = await deriveMasterKey(password);
      // Fingerprint the vault BEFORE opening it: openDb() may run a schema
      // migration, which must not be mistaken for an unsynced user edit.
      const preOpenLocalHash = getLocalDbHash();
      openDb(key);
      // Store password as a Buffer so the bytes can be zeroed on lock.
      if (currentMasterPasswordBuf) currentMasterPasswordBuf.fill(0);
      currentMasterPasswordBuf = Buffer.from(password, 'utf8');
      currentMasterKey = Buffer.from(key);

      // Successful unlock — reset rate-limiter.
      failedUnlockAttempts = 0;
      unlockCooldownUntil = 0;

      // Pull: take another PC's newer snapshot if it was built on this PC's
      // data; if both sides changed, record a conflict for the user instead of
      // silently overwriting either copy.
      let outcome: SyncOutcome = { action: 'none' };
      try {
        outcome = await syncOnUnlock({ masterPassword: password, liveKey: currentMasterKey, preOpenLocalHash });
        if (outcome.newMasterKey) currentMasterKey = Buffer.from(outcome.newMasterKey);
      } catch (e: any) {
        console.warn('[Sync] unlock pull failed:', e?.message || e);
      }

      startSyncLoop();

      if (outcome.action !== 'none' && outcome.action !== 'disabled') {
        // Notify the renderer after it has had a moment to mount. A conflict
        // found at unlock is always news to this session.
        setTimeout(() => reportSyncOutcome({ ...outcome, newMasterKey: undefined, conflictIsNew: true }, 'unlock'), 1500);
      }

      return { ok: true };
    } catch (e: any) {
      if ((e as Error).message === 'INVALID_MASTER_PASSWORD') {
        // The master password may have been changed on another PC: this PC's
        // vault still uses the old key, but the newer synced snapshot opens
        // with the new one. Load it instead of reporting a wrong password.
        try {
          const pulled = await tryUnlockFromNewerBackup(password);
          if (pulled?.newMasterKey) {
            if (currentMasterPasswordBuf) currentMasterPasswordBuf.fill(0);
            currentMasterPasswordBuf = Buffer.from(password, 'utf8');
            currentMasterKey = Buffer.from(pulled.newMasterKey);
            failedUnlockAttempts = 0;
            unlockCooldownUntil = 0;
            startSyncLoop();
            setTimeout(() => reportSyncOutcome({ ...pulled, newMasterKey: undefined }, 'unlock:new-password'), 1500);
            return { ok: true, passwordChangedElsewhere: true };
          }
        } catch (err: any) {
          console.warn('[Sync] new-password unlock fallback failed:', err?.message || err);
        }
        // Wrong password — bump the failure counter and apply back-off.
        failedUnlockAttempts++;
        if (failedUnlockAttempts >= 3) {
          // 2s, 4s, 8s, 16s … capped at 5 minutes.
          const delaySecs = Math.min(2 * Math.pow(2, failedUnlockAttempts - 3), 300);
          unlockCooldownUntil = Date.now() + delaySecs * 1000;
          return {
            ok: false,
            error: `Incorrect password (attempt ${failedUnlockAttempts}). Wait ${delaySecs}s before trying again.`,
            cooldownSeconds: delaySecs,
          };
        }
        return { ok: false, error: 'Incorrect master password.' };
      }
      return { ok: false, error: (e as Error).message || String(e) };
    }
  });

  // Manually lock the vault — same effect as auto-lock after 30 min idle.
  // Closes the encrypted DB, wipes in-memory secrets, purges Playwright
  // browser profiles (cached bank/broker session cookies), notifies renderer.
  //
  // Refuses to lock if an automation is in flight. Locking mid-Playwright would
  // null currentMasterKey while a SQL write (balance update / bid log) is
  // still running, throwing DB_NOT_OPEN and potentially leaving the bank/
  // broker session in an inconsistent state. The renderer should show the
  // returned reason to the user.
  ipc.handle('vault:lock', async () => {
    if (activeAutomations() > 0) {
      return {
        ok: false,
        error: `Cannot lock — ${activeAutomations()} automation(s) still running. ` +
          'Wait for the current browser session to finish, or use ' +
          '"Stop" on the activity panel first.',
        reason: 'AUTOMATION_IN_FLIGHT',
      };
    }
    try {
      await flushBackupOnExit();
      try { closeDb(); } catch { /* */ }
      clearVaultSessionSecrets();
      // Purge cached cookies so an attacker with disk access can't replay
      // bank/broker logins from this session.
      try { await purgeBrowserProfiles(); } catch { /* */ }
      BrowserWindow.getAllWindows().forEach(w => {
        try { w.webContents.send('vault:locked'); } catch { /* */ }
      });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // Manual "Clear browser sessions" — same as the lock-time purge, but
  // doesn't lock the vault. Lets the user force a clean login pass.
  ipc.handle('automation:clearBrowserSessions', async () => {
    try {
      const result = await purgeBrowserProfiles();
      return { ok: true, ...result };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipc.handle('vault:changePassword', async (_, payload: { currentPassword: string; newPassword: string }) => {
    const currentPassword = payload?.currentPassword || '';
    const newPassword = payload?.newPassword || '';
    if (!currentPassword || !newPassword) {
      return { ok: false, error: 'Current and new master passwords are required.' };
    }
    if (currentPassword === newPassword) {
      return { ok: false, error: 'New password must be different from the current password.' };
    }
    const issues = passwordStrengthIssues(newPassword);
    if (issues.length) return { ok: false, issues };

    try {
      const oldKey = await deriveMasterKey(currentPassword);
      if (!currentMasterKey || !oldKey.equals(currentMasterKey)) {
        return { ok: false, error: 'Current master password is incorrect.' };
      }

      const newKey = await deriveMasterKey(newPassword);
      rekeyDb(newKey);
      if (currentMasterPasswordBuf) currentMasterPasswordBuf.fill(0);
      currentMasterPasswordBuf = Buffer.from(newPassword, 'utf8');
      currentMasterKey = Buffer.from(newKey);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  // Factory-reset the vault: wipes EVERYTHING on disk (vault DB, documents,
  // logs, config) and clears the OS keychain entries (field key, gmail token,
  // anthropic API key). The user-chosen backup folder is NOT touched — that
  // lives outside our data dir and represents the user's only recovery path.
  //
  // The renderer is responsible for confirming with the user before calling
  // this. Once called, the next vault:status will report initialized=false
  // and the app will boot into first-time-setup.
  ipc.handle('vault:reset', async (_, payload: { confirmation: string; password?: string }) => {
    if (payload?.confirmation !== 'RESET') {
      return { ok: false, error: 'Confirmation phrase missing — type RESET to confirm.' };
    }

    // Require the current master password before destroying data. This stops
    // a hijacked renderer (XSS in a loaded external page, malicious extension,
    // or any non-UI IPC caller) from wiping the vault by just sending the
    // string "RESET". Only callers who know the password can wipe.
    //
    // Edge case: if the vault is locked (no currentMasterKey), we still allow
    // reset with the correct password — the user might be locked out and want
    // to start over. We re-derive the key and compare against the SQLCipher
    // header by attempting an open.
    if (vaultInitialized() && dbExists()) {
      const password = payload?.password || '';
      if (!password) {
        return { ok: false, error: 'Current master password is required to reset the vault.' };
      }
      try {
        const probeKey = await deriveMasterKey(password);
        if (currentMasterKey) {
          // Vault is unlocked — direct buffer compare.
          if (!probeKey.equals(currentMasterKey)) {
            return { ok: false, error: 'Master password is incorrect.' };
          }
        } else {
          // Vault is locked — verify by attempting to open the DB. openDb()
          // throws INVALID_MASTER_PASSWORD on wrong key. We close again
          // immediately if it succeeds.
          try {
            openDb(probeKey);
            closeDb();
          } catch {
            return { ok: false, error: 'Master password is incorrect.' };
          }
        }
      } catch (e: any) {
        return { ok: false, error: e?.message || 'Password verification failed.' };
      }
    }

    try {
      // 1) Close the DB so files are not locked.
      try { closeDb(); } catch { /* */ }

      // 2) Remove the entire data directory contents (but keep the dir itself).
      const dataDir = getDataDir();
      if (existsSync(dataDir)) {
        for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
          const target = `${dataDir}\\${entry.name}`;
          try {
            if (entry.isDirectory()) {
              rmSync(target, { recursive: true, force: true });
            } else {
              unlinkSync(target);
            }
          } catch { /* skip individual failures */ }
        }
      }

      // 3) Wipe the Playwright browser profiles (cached bank/broker session
      //    cookies). Otherwise the new "fresh" install could still auto-login
      //    to the old user's banks.
      try {
        const userData = app.getPath('userData');
        const profilesDir = `${userData}\\browser-profiles`;
        if (existsSync(profilesDir)) rmSync(profilesDir, { recursive: true, force: true });
      } catch { /* */ }

      // 4) Clear OS keychain entries.
      try {
        const keytar = require('keytar');
        await keytar.deletePassword('ipo-manager', 'field-encryption-key-v1').catch(() => {});
        await keytar.deletePassword('ipo-manager', 'gmail-refresh-token-v1').catch(() => {});
        await keytar.deletePassword('ipo-manager', 'anthropic-api-key-v1').catch(() => {});
      } catch { /* */ }

      // 5) Clear in-memory session secrets and tell the renderer to lock.
      clearVaultSessionSecrets();
      BrowserWindow.getAllWindows().forEach(w => {
        try { w.webContents.send('vault:locked'); } catch { /* */ }
      });

      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipc.handle('gmail:status', async (_, opts?: { force?: boolean }) =>
    getGmailConnectionStatus({ force: !!opts?.force }));

  ipc.handle('gmail:connect', async () => {
    try {
      const status = await connectGmail();
      return { ok: true, status };
    } catch (e: any) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipc.handle('gmail:setCredentials', async (_, rawJson: string) => {
    try {
      const status = await saveGmailCredentialsJson(rawJson);
      return { ok: true, status };
    } catch (e: any) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipc.handle('gmail:clearCredentials', async () => {
    try {
      const status = await clearGmailCredentialsConfig();
      return { ok: true, status };
    } catch (e: any) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  // ── Families ────────────────────────────────────────────────────────────

  ipc.handle('families:list', () => {
    const db = getDb();
    return db.prepare(`
      SELECT f.id, f.family_name, f.notes, f.display_order, f.min_balance,
             COUNT(m.id) AS member_count
      FROM families f
      LEFT JOIN members m ON m.family_id = f.id
      GROUP BY f.id
      ORDER BY f.display_order, f.family_name
    `).all();
  });

  ipc.handle('families:create', (_, { family_name, min_balance }: { family_name: string; min_balance?: number }) => {
    const db = getDb();
    const maxOrder = (db.prepare('SELECT MAX(display_order) as m FROM families').get() as any)?.m ?? 0;
    const result = db.prepare(
      'INSERT INTO families (family_name, display_order, min_balance) VALUES (?, ?, ?)'
    ).run(family_name.trim(), maxOrder + 1, min_balance ?? 0);
    return { ok: true, id: result.lastInsertRowid };
  });

  ipc.handle('families:update', (_, { id, family_name, notes, min_balance }: { id: number; family_name: string; notes?: string; min_balance?: number }) => {
    const db = getDb();
    db.prepare('UPDATE families SET family_name = ?, notes = ?, min_balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(family_name.trim(), notes ?? null, min_balance ?? 0, id);
    return { ok: true };
  });

  ipc.handle('families:delete', (_, { id }: { id: number }) => {
    const db = getDb();
    db.prepare('DELETE FROM families WHERE id = ?').run(id);
    return { ok: true };
  });

  ipc.handle('families:reorder', (_, { ids }: { ids: number[] }) => {
    const db = getDb();
    const stmt = db.prepare('UPDATE families SET display_order = ? WHERE id = ?');
    db.transaction(() => { ids.forEach((id, i) => stmt.run(i, id)); })();
    return { ok: true };
  });

  // ── Members ─────────────────────────────────────────────────────────────

  ipc.handle('members:byFamily', async (_, familyId: number) => {
    const db = getDb();
    // Only fetch last-4 suffixes here — do NOT decrypt full PAN/Aadhaar in the
    // list view. Full values are loaded on-demand via member:fullDetail when the
    // user opens the detail modal. This avoids decrypting credentials for every
    // member just to paint the family list.
    const members = db.prepare(`
      SELECT id, full_name, member_type, dob, mobile, email,
             pan_last4, aadhaar_last4, display_order
      FROM members WHERE family_id = ?
      ORDER BY display_order, full_name
    `).all(familyId) as any[];
    const banksStmt = db.prepare(`SELECT id, bank_code, account_last4, balance, balance_fetched_at,
      CASE WHEN password_enc IS NOT NULL AND password_enc != '' THEN 1 ELSE 0 END AS has_password
      FROM bank_accounts WHERE member_id = ?`);
    const brokersStmt = db.prepare(`SELECT ba.id, ba.broker_code, ba.balance, ba.balance_fetched_at,
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM broker_portfolio_report_summaries s
          WHERE s.report_id = (
            SELECT r.id
            FROM broker_portfolio_reports r
            WHERE r.broker_account_id = ba.id AND r.member_id = ba.member_id
            ORDER BY r.downloaded_at DESC, r.id DESC
            LIMIT 1
          )
          AND s.asset_scope = 'COMBINED'
          AND s.present_value IS NOT NULL
        ) THEN (
          SELECT s.present_value
          FROM broker_portfolio_report_summaries s
          WHERE s.report_id = (
            SELECT r.id
            FROM broker_portfolio_reports r
            WHERE r.broker_account_id = ba.id AND r.member_id = ba.member_id
            ORDER BY r.downloaded_at DESC, r.id DESC
            LIMIT 1
          )
          AND s.asset_scope = 'COMBINED'
          AND s.present_value IS NOT NULL
          ORDER BY s.id
          LIMIT 1
        )
        ELSE (
          SELECT SUM(s.present_value)
          FROM broker_portfolio_report_summaries s
          WHERE s.report_id = (
            SELECT r.id
            FROM broker_portfolio_reports r
            WHERE r.broker_account_id = ba.id AND r.member_id = ba.member_id
            ORDER BY r.downloaded_at DESC, r.id DESC
            LIMIT 1
          )
          AND s.present_value IS NOT NULL
        )
      END AS portfolio_value,
      (
        SELECT r.downloaded_at
        FROM broker_portfolio_reports r
        WHERE r.broker_account_id = ba.id AND r.member_id = ba.member_id
        ORDER BY r.downloaded_at DESC, r.id DESC
        LIMIT 1
      ) AS portfolio_fetched_at,
      CASE WHEN password_enc IS NOT NULL AND password_enc != '' THEN 1 ELSE 0 END AS has_password
      FROM broker_accounts ba WHERE ba.member_id = ?`);
    return members.map(m => ({
      ...m,
      pan: null,      // populated on-demand via member:fullDetail
      aadhaar: null,  // populated on-demand via member:fullDetail
      documents: getMemberDocumentSummaryMap(db, m.id),
      banks: banksStmt.all(m.id),
      brokers: brokersStmt.all(m.id),
    }));
  });

  ipc.handle('member:fullDetail', async (_, memberId: number) => {
    const db = getDb();
    const m = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId) as any;
    if (!m) return null;
    const banks = db.prepare('SELECT * FROM bank_accounts WHERE member_id = ?').all(memberId) as any[];
    const brokers = db.prepare('SELECT * FROM broker_accounts WHERE member_id = ?').all(memberId) as any[];
    return {
      id: m.id, family_id: m.family_id, full_name: m.full_name,
      member_type: m.member_type, dob: m.dob, mobile: m.mobile, email: m.email, notes: m.notes,
      pan: await decryptField(m.pan_enc),
      aadhaar: await decryptField(m.aadhaar_enc),
      email_password: await decryptField(m.email_password_enc).catch(() => ''),
      documents: getMemberDocumentSummaryMap(db, memberId),
      banks: await Promise.all(banks.map(async b => ({
        bank_code: b.bank_code, ifsc: b.ifsc, account_last4: b.account_last4,
        user_id: await decryptField(b.user_id_enc),
        password: await decryptField(b.password_enc),
        account_number: await decryptField(b.account_number_enc),
        customer_id: await decryptField(b.customer_id_enc),
      }))),
      brokers: await Promise.all(brokers.map(async b => ({
        broker_code: b.broker_code, broker_mobile: b.broker_mobile, broker_email: b.broker_email,
        user_id: await decryptField(b.user_id_enc),
        password: await decryptField(b.password_enc),
        client_id: await decryptField(b.client_id_enc).catch(() => '')
          || await decryptField(b.account_number_enc).catch(() => ''),
        totp_secret: await decryptField(b.totp_secret_enc).catch(() => ''),
      }))),
    };
  });

  ipc.handle('members:create', async (_, payload: any) => {
    const db = getDb();
    const { family_id, full_name, member_type, dob, mobile, email, email_password,
            pan, aadhaar, documents = {}, banks = [], brokers = [] } = payload;
    const maxOrder = (db.prepare('SELECT MAX(display_order) as m FROM members WHERE family_id = ?').get(family_id) as any)?.m ?? 0;
    const result = db.prepare(`
      INSERT INTO members (family_id, full_name, member_type, dob, mobile, email,
        pan_enc, aadhaar_enc, email_password_enc, pan_last4, aadhaar_last4, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(family_id, full_name.trim(), member_type, dob || null, mobile || null, email || null,
        await encryptField(pan), await encryptField(aadhaar),
        await encryptField(email_password || ''),
        lastN(pan), lastN(aadhaar), maxOrder + 1);
    const memberId = result.lastInsertRowid as number;
    await applyMemberDocumentDrafts(db, memberId, documents);
    await saveBankAccounts(db, memberId, banks, false);
    await saveBrokerAccounts(db, memberId, brokers, false);
    return { ok: true, id: memberId };
  });

  ipc.handle('members:update', async (_, payload: any) => {
    const db = getDb();
    const { id, full_name, member_type, dob, mobile, email, email_password,
            pan, aadhaar, documents = {}, banks = [], brokers = [] } = payload;
    db.prepare(`UPDATE members SET
      full_name = ?, member_type = ?, dob = ?, mobile = ?, email = ?,
      pan_enc = ?, aadhaar_enc = ?, email_password_enc = ?,
      pan_last4 = ?, aadhaar_last4 = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(full_name.trim(), member_type, dob || null, mobile || null, email || null,
        await encryptField(pan), await encryptField(aadhaar),
        await encryptField(email_password || ''),
        lastN(pan), lastN(aadhaar), id);
    await applyMemberDocumentDrafts(db, id, documents);
    await saveBankAccounts(db, id, banks, true);
    await saveBrokerAccounts(db, id, brokers, true);
    return { ok: true };
  });

  ipc.handle('members:delete', (_, { id }: { id: number }) => {
    const db = getDb();
    removeAllMemberDocuments(db, id);
    db.prepare('DELETE FROM members WHERE id = ?').run(id);
    return { ok: true };
  });

  ipc.handle('members:reorder', (_, { family_id, ids }: { family_id: number; ids: number[] }) => {
    const db = getDb();
    const stmt = db.prepare('UPDATE members SET display_order = ? WHERE id = ? AND family_id = ?');
    db.transaction(() => { ids.forEach((id, i) => stmt.run(i, id, family_id)); })();
    return { ok: true };
  });

  // ── Mobile Recharge Tracking (standalone table, no link to members) ─────────
  ipc.handle('recharge:list', () => {
    const db = getDb();
    return db.prepare('SELECT * FROM mobile_recharge_tracking ORDER BY display_order, id').all();
  });

  ipc.handle('recharge:reorder', (_, { ids }: { ids: number[] }) => {
    const db = getDb();
    const stmt = db.prepare('UPDATE mobile_recharge_tracking SET display_order = ? WHERE id = ?');
    db.transaction(() => { ids.forEach((id, i) => stmt.run(i, id)); })();
    return { ok: true };
  });

  ipc.handle('recharge:create', (_, payload: { name: string; mobile_number: string; mobile_model?: string; recharge_date?: string; validity_days?: number; notes?: string }) => {
    const db = getDb();
    const { name, mobile_number, mobile_model, recharge_date, validity_days, notes } = payload;
    const result = db.prepare(`
      INSERT INTO mobile_recharge_tracking (name, mobile_number, mobile_model, recharge_date, validity_days, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name.trim(), mobile_number.trim(), mobile_model || null, recharge_date || null, validity_days ?? null, notes || null);
    return { ok: true, id: result.lastInsertRowid };
  });

  ipc.handle('recharge:update', (_, payload: { id: number; name: string; mobile_number: string; mobile_model?: string; recharge_date?: string; validity_days?: number; notes?: string }) => {
    const db = getDb();
    const { id, name, mobile_number, mobile_model, recharge_date, validity_days, notes } = payload;
    db.prepare(`
      UPDATE mobile_recharge_tracking SET
        name = ?, mobile_number = ?, mobile_model = ?, recharge_date = ?, validity_days = ?, notes = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(name.trim(), mobile_number.trim(), mobile_model || null, recharge_date || null, validity_days ?? null, notes || null, id);
    return { ok: true };
  });

  ipc.handle('recharge:delete', (_, { id }: { id: number }) => {
    const db = getDb();
    db.prepare('DELETE FROM mobile_recharge_tracking WHERE id = ?').run(id);
    return { ok: true };
  });

  // ── Zerodha TOTP ──────────────────────────────────────────────────────────
  ipc.handle('totp:listZerodhaMembers', async () => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT ba.id AS broker_account_id, ba.member_id, m.full_name AS member_name,
             ba.totp_secret_enc
      FROM broker_accounts ba
      JOIN members m ON m.id = ba.member_id
      WHERE ba.broker_code = 'ZERODHA'
        AND ba.totp_secret_enc IS NOT NULL AND ba.totp_secret_enc != ''
      ORDER BY m.full_name COLLATE NOCASE
    `).all() as any[];
    const result = [];
    for (const r of rows) {
      try {
        const secret = await decryptField(r.totp_secret_enc);
        if (secret) result.push({ brokerAccountId: r.broker_account_id, memberId: r.member_id, memberName: r.member_name });
      } catch { /* skip accounts with bad keys */ }
    }
    return result;
  });

  ipc.handle('totp:generate', async (_, { brokerAccountId }: { brokerAccountId: number }) => {
    try {
      const { TOTP } = await import('totp-generator');
      const db = getDb();
      const row = db.prepare('SELECT totp_secret_enc FROM broker_accounts WHERE id = ?').get(brokerAccountId) as any;
      if (!row?.totp_secret_enc) return { ok: false, error: 'No TOTP secret' };
      const secret = await decryptField(row.totp_secret_enc);
      if (!secret) return { ok: false, error: 'Could not decrypt TOTP secret' };
      const { otp } = await TOTP.generate(secret);
      const nowSec = Math.floor(Date.now() / 1000);
      const secondsRemaining = 30 - (nowSec % 30);
      return { ok: true, otp, secondsRemaining };
    } catch (e: any) {
      // Malformed (non-base32) secret, or the vault locked — report, don't reject.
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipc.handle('documents:pick', async (_, payload: { docType: MemberDocumentType }) => {
    const docType = payload?.docType;
    if (!docType || !MEMBER_DOCUMENT_TYPES.includes(docType)) {
      return { ok: false, error: 'Invalid document type' };
    }
    const label = documentTypeLabel(docType);
    const result = await dialog.showOpenDialog({
      title: `Select ${label} file`,
      filters: [{ name: 'PDF or JPEG', extensions: ['pdf', 'jpg', 'jpeg'] }],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
    const selectedPath = result.filePaths[0];
    const fileName = selectedPath.split(/[\\/]/).pop() || `${docType.toLowerCase()}.pdf`;
    const ext = fileName.toLowerCase().split('.').pop() || '';
    const mimeType = ext === 'pdf' ? 'application/pdf' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : '';
    if (!mimeType) return { ok: false, error: 'Only PDF and JPEG files are supported' };
    try {
      const { size } = statSync(selectedPath);
      return {
        ok: true,
        file: {
          selectedPath,
          originalName: fileName,
          mimeType,
          fileSize: size,
        }
      };
    } catch (e: any) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipc.handle('captchaAi:status', async () => getCaptchaAiStatus());

  // CAPTCHA usage / cost guardrails ──────────────────────────────────────────
  ipc.handle('captchaAi:getUsage', async () => {
    const { getCaptchaUsage } = await import('./ai/usage');
    return { ok: true, usage: getCaptchaUsage() };
  });

  ipc.handle('captchaAi:setConsent', async (_, consented: boolean) => {
    const { setCaptchaConsent } = await import('./ai/usage');
    return { ok: true, usage: setCaptchaConsent(!!consented) };
  });

  ipc.handle('captchaAi:setCap', async (_, cap: number) => {
    const { setCaptchaCap } = await import('./ai/usage');
    return { ok: true, usage: setCaptchaCap(Number(cap) || 0) };
  });

  ipc.handle('captchaAi:resetTodayCounter', async () => {
    const { resetCaptchaTodayCounter } = await import('./ai/usage');
    return { ok: true, usage: resetCaptchaTodayCounter() };
  });

  ipc.handle('captchaAi:setProvider', async (_, provider: CaptchaAiProvider) => {
    try {
      const status = await setCaptchaAiProvider(provider);
      return { ok: true, status };
    } catch (e: any) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipc.handle('captchaAi:setKey', async (_, provider: CaptchaApiKeyProvider, apiKey: string) => {
    try {
      const status = await saveCaptchaApiKey(provider, apiKey);
      return { ok: true, status };
    } catch (e: any) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipc.handle('captchaAi:clearKey', async (_, provider: CaptchaApiKeyProvider) => {
    try {
      const status = await clearCaptchaApiKey(provider);
      return { ok: true, status };
    } catch (e: any) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipc.handle('documents:download', async (_, payload: { memberId: number; docType: MemberDocumentType }) => {
    const db = getDb();
    const { memberId, docType } = payload || {};
    if (!memberId || !docType || !MEMBER_DOCUMENT_TYPES.includes(docType)) {
      return { ok: false, error: 'Invalid document download request' };
    }

    const member = db.prepare('SELECT id, full_name FROM members WHERE id = ?').get(memberId) as { id: number; full_name: string } | undefined;
    if (!member) return { ok: false, error: 'Member not found' };

    const auditInsert = db.prepare('INSERT INTO audit_log (member_id, action, target, status, details) VALUES (?, ?, ?, ?, ?)');
    try {
      const saved = await downloadMemberDocumentToDownloads(db, memberId, docType, member.full_name);
      const folderOpenError = await openFolderContainingFile(saved.filePath);
      auditInsert.run(
        memberId,
        'DOWNLOAD_DOC',
        docType,
        'SUCCESS',
        folderOpenError ? `${saved.filePath} | folder open failed: ${folderOpenError}` : saved.filePath
      );
      return { ok: true, ...saved, folderOpened: !folderOpenError, folderOpenError: folderOpenError || null };
    } catch (e: any) {
      auditInsert.run(memberId, 'DOWNLOAD_DOC', docType, 'FAILED', e.message || String(e));
      return { ok: false, error: e.message || String(e) };
    }
  });

  // ── Manual OTP dialog (for banks that send OTP to mobile only) ──────────

  ipc.handle('otp:provide', (_, otp: string) => {
    clearOtpTimeout();
    if (pendingOtpResolve) {
      pendingOtpResolve(otp.trim());
      pendingOtpResolve = null;
      pendingOtpReject  = null;
    }
    return { ok: true };
  });

  ipc.handle('otp:cancel', () => {
    clearOtpTimeout();
    if (pendingOtpReject) {
      pendingOtpReject(new Error('OTP_CANCELLED'));
      pendingOtpResolve = null;
      pendingOtpReject  = null;
    }
    return { ok: true };
  });

  // ── Import / Login ───────────────────────────────────────────────────────

  ipc.handle('import:pickAndRun', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select Demat_Sheet.xlsx',
      filters: [{ name: 'Excel', extensions: ['xlsx', 'xlsm'] }],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
    try {
      const summary = await importExcel(result.filePaths[0]);
      return { ok: true, ...summary };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  });

  ipc.handle('export:pickAndRun', async () => {
    const masterPwd = getMasterPassword();
    if (!masterPwd) {
      return { ok: false, error: 'Unlock the vault again before exporting.' };
    }
    const date = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog({
      title: 'Export IPO Manager Data',
      defaultPath: `IPO Manager Export ${date}.xlsx`,
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
    try {
      const summary = await exportExcel(result.filePath, masterPwd);
      return { ok: true, filePath: result.filePath, ...summary };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  });

  ipc.handle('automation:cancelCurrent', async () => {
    clearOtpTimeout();
    if (pendingOtpReject) {
      pendingOtpReject(new Error('USER_CANCELLED'));
      pendingOtpResolve = null;
      pendingOtpReject = null;
      const win = BrowserWindow.getAllWindows()[0];
      if (win) win.webContents.send('otp:dismiss', {});
    }

    const closedContexts = await closeAllBrowserSessions();
    return { ok: true, closedContexts };
  });

  ipc.handle('login:bank', async (_, payload: { memberId: number; bankId: number; closeAfterFetch?: boolean }) => {
    return runLogin('BANK', payload.memberId, payload.bankId, {
      fetchBalance: true,
      closeAfterFetch: payload.closeAfterFetch ?? false,
    });
  });

  ipc.handle('login:broker', async (_, payload: { memberId: number; brokerId: number; fetchBalance?: boolean; closeAfterFetch?: boolean }) => {
    return runLogin('BROKER', payload.memberId, payload.brokerId, {
      fetchBalance: payload.fetchBalance ?? false,
      closeAfterFetch: payload.closeAfterFetch ?? false,
    });
  });

  ipc.handle('broker:downloadPortfolio', async (_, payload: { memberId: number; brokerId: number }) => {
    return downloadBrokerPortfolioReport(payload.memberId, payload.brokerId);
  });

  ipc.handle('broker:getLatestPortfolio', async (_, payload: { memberId: number; brokerId: number }) => {
    return getLatestBrokerPortfolioReport(payload.memberId, payload.brokerId);
  });

  ipc.handle('broker:openLatestPortfolioFolder', async (_, payload: { memberId: number; brokerId: number }) => {
    return openLatestBrokerPortfolioFolder(payload.memberId, payload.brokerId);
  });

  ipc.handle('ipo:getMemberDraftOptions', async (_, payload: { memberId: number }) => {
    return getMemberAuBidDraftOptions(payload.memberId);
  });

  ipc.handle('ipo:prepareAuBid', async (_, payload: {
    memberId: number;
    bankId: number;
    brokerId?: number | null;
    issueName: string;
    quantity: number;
    lotSize?: number | null;
    bidType: 'CUTOFF' | 'LIMIT';
    bidPrice: number;
  }) => {
    return prepareAuIpoBid(payload);
  });

  ipc.handle('ipo:confirmAuBid', async (_, payload: { bidRunId: number }) => {
    return confirmAuIpoBid(payload.bidRunId);
  });

  ipc.handle('ipo:listMemberBids', async (_, payload: { memberId: number }) => {
    return listMemberIpoBids(payload.memberId);
  });

  ipc.handle('ipo:listCatalog', async () => {
    const cached = listCachedIpoIssues();
    if (cached.length) return { ok: true, issues: cached, stale: false };
    return refreshIpoCatalog();
  });

  ipc.handle('ipo:refreshCatalog', async () => {
    return refreshIpoCatalog();
  });

  // ── Backup IPC ──────────────────────────────────────────────────────────────
  ipc.handle('backup:getConfig', async () => backupGetConfig());

  ipc.handle('backup:setConfig', async (_, patch: {
    enabled?: boolean; folder?: string | null; mirrorFolder?: string | null; target?: 'folder';
  }) => {
    try {
      // Only whitelisted fields; switching TO R2 goes through backup:enableR2,
      // which tests the credentials first.
      const clean: Parameters<typeof backupSetConfig>[0] = {};
      if (typeof patch?.enabled === 'boolean') clean.enabled = patch.enabled;
      if (patch?.folder === null || typeof patch?.folder === 'string') clean.folder = patch.folder;
      if (patch?.mirrorFolder === null || typeof patch?.mirrorFolder === 'string') clean.mirrorFolder = patch.mirrorFolder || null;
      if (patch?.target === 'folder') clean.target = 'folder';
      const next = backupSetConfig(clean);
      return { ok: true, config: next };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipc.handle('backup:pickFolder', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose backup folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
    return { ok: true, folder: result.filePaths[0] };
  });

  // R2 settings arrive from the renderer; the secret is only ever written to
  // the OS keychain, and only after a successful round-trip to the bucket.
  type R2Payload = { accountId?: string; bucket?: string; accessKeyId?: string; secret?: string; prefix?: string };
  const readR2Payload = async (p: R2Payload): Promise<{ r2: R2Config; secret?: string } | { error: string }> => {
    try {
      const r2: R2Config = {
        accountId: String(p?.accountId || '').trim().toLowerCase(),
        bucket: String(p?.bucket || '').trim(),
        accessKeyId: String(p?.accessKeyId || '').trim(),
        prefix: normalizePrefix(p?.prefix),
      };
      const secret = typeof p?.secret === 'string' && p.secret.trim() ? p.secret.trim() : undefined;
      if (!secret && !(await hasR2Secret())) return { error: 'Enter the Secret Access Key.' };
      const problem = validateR2Settings({ ...r2, secretAccessKey: secret || 'x'.repeat(32) });
      return problem ? { error: problem } : { r2, secret };
    } catch (e: any) {
      return { error: e?.message || String(e) };
    }
  };

  ipc.handle('backup:testR2', async (_, payload: R2Payload) => {
    const parsed = await readR2Payload(payload);
    if ('error' in parsed) return { ok: false, error: parsed.error };
    return testR2(parsed.r2, parsed.secret);
  });

  ipc.handle('backup:enableR2', async (_, payload: R2Payload & { seedFromFolder?: boolean }) => {
    const parsed = await readR2Payload(payload);
    if ('error' in parsed) return { ok: false, error: parsed.error };
    if (activeAutomations() > 0) {
      return { ok: false, error: 'Wait for the running bank/broker login to finish, then try again.' };
    }
    const test = await testR2(parsed.r2, parsed.secret);
    if (!test.ok) return test;
    if (parsed.secret) await setR2Secret(parsed.secret);
    const current = backupGetConfig();
    const seedFrom = payload?.seedFromFolder && current.target === 'folder' ? current.folder : null;
    const result = await enableR2(parsed.r2, { seedFrom });
    broadcast('backup:statusChanged', {});
    return result.ok ? { ...result, note: test.note } : result;
  });

  ipc.handle('backup:status', async () => {
    const state = backupGetState();
    return {
      hasR2Secret: await hasR2Secret(),
      config: backupGetConfig(),
      state: { ...state, inProgress: backupInProgress() },
      sync: getSyncStatus(),
    };
  });

  ipc.handle('backup:runNow', async () => {
    const password = getMasterPassword();
    if (!currentMasterKey || !password) return { ok: false, error: 'Vault is locked.' };
    const liveKey = currentMasterKey;
    const result = await withSyncPaused(() => backupNow({ masterPassword: password, liveKey }));
    if (result.newMasterKey) {
      currentMasterKey = Buffer.from(result.newMasterKey);
      broadcast('vault:autoSynced', { snapshotTimestamp: new Date().toISOString(), sourceHost: result.pulledFrom ?? null });
    }
    broadcast('backup:statusChanged', {});
    const { newMasterKey: _omit, ...rest } = result;
    return rest;
  });

  ipc.handle('backup:resolveConflict', async (_, choice: 'keep-local' | 'use-remote') => {
    const password = getMasterPassword();
    if (!currentMasterKey || !password) return { ok: false, error: 'Vault is locked.' };
    if (choice !== 'keep-local' && choice !== 'use-remote') return { ok: false, error: 'Invalid choice.' };
    if (activeAutomations() > 0) {
      return { ok: false, error: 'Wait for the running bank/broker login to finish, then try again.' };
    }
    const liveKey = currentMasterKey;
    const outcome = await withSyncPaused(() => resolveSyncConflict(choice, { masterPassword: password, liveKey }));
    reportSyncOutcome(outcome, `resolve:${choice}`);
    if (outcome.action === 'pushed' || outcome.action === 'pulled') return { ok: true, action: outcome.action };
    return { ok: false, error: outcome.error || 'The conflict could not be resolved yet.' };
  });

  ipc.handle('backup:listSnapshots', async () => {
    // In R2 mode this includes backups that are only in the bucket (fetched on restore).
    return { ok: true, snapshots: backupListSnapshots(), target: backupGetConfig().target };
  });

  ipc.handle('backup:listSnapshotsFromFolder', async (_, folder: string) => {
    // Used when restoring from another machine's backup folder before
    // committing it as the local backup config.
    if (!folder || typeof folder !== 'string') return { ok: false, error: 'No folder provided.' };
    // Read the foreign folder directly — no global-config swap, so this can't
    // race with an auto-backup or leave the wrong folder persisted on error.
    const snapshots = backupListSnapshots(folder);
    return { ok: true, snapshots };
  });

  ipc.handle('backup:restore', async (_, payload: { snapshotId: string; sourceFolder?: string }) => {
    const masterPwdForRestore = getMasterPassword();
    if (!masterPwdForRestore) return { ok: false, error: 'Vault is locked.' };
    if (!payload?.snapshotId) return { ok: false, error: 'No snapshot id provided.' };
    if (activeAutomations() > 0) {
      return { ok: false, error: 'Wait for the running bank/broker login to finish, then restore.' };
    }
    let published = true;
    let publishError: string | undefined;
    const result = await withSyncPaused(async () => {
      const r = await backupRestoreSnapshot(payload.snapshotId, masterPwdForRestore, {
        sourceFolder: payload.sourceFolder,
        liveKey: currentMasterKey ?? undefined,
      });
      if (!r.ok) return r;
      // The restored snapshot may use a different salt → the vault is now open
      // with the key restoreSnapshot derived. Adopt it for the session.
      currentMasterKey = Buffer.from(r.masterKey);
      // Make the restored data the new head for every synced PC; otherwise the
      // next sync pass would fast-forward straight back and undo the restore.
      // A copy from another folder becomes the new data everywhere too.
      const pub = await publishRestoredVault(currentMasterKey, payload.snapshotId, r.ancestors);
      published = pub.ok;
      publishError = pub.error || pub.uploadError;
      if (!pub.ok || pub.uploadError) console.warn('[Sync] restored vault not published yet:', publishError);
      return r;
    });
    if (!result.ok) return result;
    broadcast('backup:statusChanged', {});
    return {
      ok: true,
      documentsRestored: result.documentsRestored,
      dbBytes: result.dbBytes,
      published: published && !publishError,
      publishError,
    };
  });

  ipc.handle('backup:latestSnapshotId', async (_, sourceFolder?: string) => {
    return { ok: true, snapshotId: backupLatestSnapshotId(sourceFolder) };
  });

  ipc.handle('shell:openExternal', async (_, url: string) => {
    try {
      if (typeof url !== 'string' || !url.startsWith('https://')) {
        return { ok: false, error: 'Invalid URL' };
      }
      await shell.openExternal(url);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e.message || String(e) };
    }
  });
}

// ── Manual OTP state ─────────────────────────────────────────────────────────

let pendingOtpResolve: ((otp: string) => void) | null = null;
let pendingOtpReject:  ((err: Error)  => void) | null = null;
// Store the timeout handle so we can cancel it when the OTP is provided,
// cancelled, or superseded by a new request. Without this, the old timer fires
// 3 minutes after a superseded request and incorrectly rejects the new request
// (because pendingOtpReject still points at the new Promise's reject function).
let otpTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

function clearOtpTimeout(): void {
  if (otpTimeoutHandle) {
    clearTimeout(otpTimeoutHandle);
    otpTimeoutHandle = null;
  }
}

/**
 * Sends an 'otp:needed' event to the renderer window, which shows an input
 * dialog. Resolves when the user submits the OTP, rejects on cancel/timeout.
 */
function requestOtpFromUser(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Cancel any previous pending request AND its timer.
    clearOtpTimeout();
    if (pendingOtpReject) pendingOtpReject(new Error('OTP_SUPERSEDED'));

    pendingOtpResolve = resolve;
    pendingOtpReject  = reject;

    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.webContents.send('otp:needed', { label });

    // Auto-cancel after 3 minutes. Store handle so it can be cleared.
    otpTimeoutHandle = setTimeout(() => {
      otpTimeoutHandle = null;
      if (pendingOtpReject) {
        pendingOtpReject(new Error('OTP_TIMEOUT'));
        pendingOtpResolve = null;
        pendingOtpReject  = null;
        const w = BrowserWindow.getAllWindows()[0];
        if (w) w.webContents.send('otp:dismiss', {});
      }
    }, 3 * 60 * 1000);
  });
}

/**
 * Email-OTP fetch shared by every login path. Reads the OTP from Gmail; if
 * Gmail can't be used (not signed in, access expired/revoked, not set up) it
 * falls straight back to the in-app OTP dialog — instead of the old behaviour
 * of opening a Google sign-in tab mid-login and hanging while the bank's OTP
 * expired — and tells the renderer to refresh the Gmail status pill.
 */
async function fetchEmailOtp(code: string, displayName: string, startTime: Date): Promise<string> {
  const otpPreset = getOtpPreset(code);
  if (!otpPreset) throw new Error(`No OTP preset for ${code}`);
  try {
    return await waitForOtp({ query: otpPreset.query, otpRegex: otpPreset.otpRegex, receivedAfter: startTime, timeoutMs: 90_000 });
  } catch (e: any) {
    if (!isGmailAuthError(e)) throw e;
    BrowserWindow.getAllWindows().forEach(w => {
      try { if (!w.isDestroyed()) w.webContents.send('gmail:statusChanged', { reason: e.code }); } catch { /* */ }
    });
    return requestOtpFromUser(
      e.code === 'GMAIL_NOT_CONFIGURED'
        ? `Gmail isn't set up, so the ${displayName} OTP can't be read automatically. Enter it here (or type it in the bank window):`
        : `Gmail needs you to sign in again, so the ${displayName} OTP can't be read automatically. Enter it here (or type it in the bank window):`
    );
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function saveBankAccounts(db: any, memberId: number, banks: any[], replaceExisting: boolean) {
  if (replaceExisting) {
    const keepCodes = banks
      .map((b: any) => String(b.bank_code || '').trim())
      .filter((code: string) => !!code);
    if (keepCodes.length) {
      const placeholders = keepCodes.map(() => '?').join(', ');
      db.prepare(
        `DELETE FROM bank_accounts WHERE member_id = ? AND bank_code NOT IN (${placeholders})`
      ).run(memberId, ...keepCodes);
    } else {
      db.prepare('DELETE FROM bank_accounts WHERE member_id = ?').run(memberId);
    }
  }

  for (const bank of banks) {
    if (!bank.user_id && !bank.password) continue;
    const existing = db.prepare('SELECT id FROM bank_accounts WHERE member_id = ? AND bank_code = ?')
      .get(memberId, bank.bank_code) as any;
    const enc = {
      user_id: await encryptField(bank.user_id),
      password: await encryptField(bank.password),
      account_number: await encryptField(bank.account_number),
      customer_id: await encryptField(bank.customer_id),
    };
    if (existing) {
      db.prepare(`UPDATE bank_accounts SET
        user_id_enc=?, password_enc=?, account_number_enc=?, customer_id_enc=?,
        ifsc=?, account_last4=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
      `).run(enc.user_id, enc.password, enc.account_number, enc.customer_id,
          bank.ifsc || null, lastN(bank.account_number), existing.id);
    } else {
      db.prepare(`INSERT INTO bank_accounts
        (member_id, bank_code, user_id_enc, password_enc, account_number_enc, customer_id_enc, ifsc, account_last4)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(memberId, bank.bank_code, enc.user_id, enc.password,
          enc.account_number, enc.customer_id, bank.ifsc || null, lastN(bank.account_number));
    }
  }
}

async function saveBrokerAccounts(db: any, memberId: number, brokers: any[], replaceExisting: boolean) {
  if (replaceExisting) {
    const keepCodes = brokers
      .map((b: any) => String(b.broker_code || '').trim())
      .filter((code: string) => !!code);
    if (keepCodes.length) {
      const placeholders = keepCodes.map(() => '?').join(', ');
      db.prepare(
        `DELETE FROM broker_accounts WHERE member_id = ? AND broker_code NOT IN (${placeholders})`
      ).run(memberId, ...keepCodes);
    } else {
      db.prepare('DELETE FROM broker_accounts WHERE member_id = ?').run(memberId);
    }
  }

  for (const broker of brokers) {
    if (!broker.user_id && !broker.password) continue;
    const existing = db.prepare('SELECT id FROM broker_accounts WHERE member_id = ? AND broker_code = ?')
      .get(memberId, broker.broker_code) as any;
    const enc = {
      user_id: await encryptField(broker.user_id),
      password: await encryptField(broker.password),
      client_id: await encryptField(broker.client_id),
      account_number: await encryptField(broker.client_id),
      totp_secret: await encryptField(broker.totp_secret),
    };
    if (existing) {
      db.prepare(`UPDATE broker_accounts SET
        user_id_enc=?, password_enc=?, client_id_enc=?, account_number_enc=?, totp_secret_enc=?,
        broker_mobile=?, broker_email=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
      `).run(enc.user_id, enc.password, enc.client_id, enc.account_number, enc.totp_secret,
          broker.broker_mobile || null, broker.broker_email || null, existing.id);
    } else {
      db.prepare(`INSERT INTO broker_accounts
        (member_id, broker_code, user_id_enc, password_enc, client_id_enc, account_number_enc, totp_secret_enc, broker_mobile, broker_email)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(memberId, broker.broker_code, enc.user_id, enc.password, enc.client_id, enc.account_number, enc.totp_secret,
          broker.broker_mobile || null, broker.broker_email || null);
    }
  }
}

async function runLogin(
  kind: 'BANK' | 'BROKER',
  memberId: number,
  accountId: number,
  options?: { fetchBalance?: boolean; closeAfterFetch?: boolean }
) {
  const db = getDb();
  const tableName = kind === 'BANK' ? 'bank_accounts' : 'broker_accounts';
  const codeCol = kind === 'BANK' ? 'bank_code' : 'broker_code';
  const account = db.prepare(`SELECT * FROM ${tableName} WHERE id = ? AND member_id = ?`)
    .get(accountId, memberId) as any;
  if (!account) return { ok: false, error: 'Account not found' };
  const code = account[codeCol];
  const adapter = kind === 'BANK' ? getBankAdapter(code) : getBrokerAdapter(code);
  if (!adapter) return { ok: false, error: `No adapter for ${code}` };
  const username   = await decryptField(account.user_id_enc);
  const password   = await decryptField(account.password_enc);
  if (!username || !password) return { ok: false, error: 'Missing credentials' };
  // customer_id / client_id — optional field, used by some adapters (e.g. Kotak CRN)
  const customerId = kind === 'BANK'
    ? await decryptField(account.customer_id_enc).catch(() => null)
    : await decryptField(account.client_id_enc).catch(() => null);
  const totpSecret = kind === 'BROKER'
    ? await decryptField(account.totp_secret_enc).catch(() => null)
    : null;
  const shouldFetchBalance = options?.fetchBalance ?? true;
  const shouldCloseAfterFetch = !!options?.closeAfterFetch;
  const startTime = new Date();
  const fetchOtp = async () => {
    if (adapter.otpMode === 'totp') {
      if (!totpSecret) throw new Error('TOTP secret not set for this account');
      const { TOTP } = await import('totp-generator');
      return (await TOTP.generate(totpSecret)).otp;
    }
    if (adapter.otpMode === 'manual') {
      return requestOtpFromUser(`Enter the OTP sent to your mobile for ${adapter.displayName}`);
    }
    return fetchEmailOtp(code, adapter.displayName, startTime);
  };
  const auditInsert = db.prepare('INSERT INTO audit_log (member_id, action, target, status, details) VALUES (?, ?, ?, ?, ?)');
  beginAutomation();
  let contextToClose: import('playwright').BrowserContext | null = null;
  try {
    const { context, page } = await launchSession({ profileKey: `${kind}-${code}-${memberId}` });
    contextToClose = context;
    await adapter.login(page, { username, password, customerId: customerId ?? undefined, totpSecret: totpSecret ?? undefined }, fetchOtp);

    // ── Fetch balance after login ───────────────────────────────────────────
    let balance: string | null = null;
    let balanceFetchedAt: string | null = null;
    let balanceFetchError: string | null = null;

    if (shouldFetchBalance && adapter.fetchBalance) {
      try {
        balance = await adapter.fetchBalance(page);
      } catch (err: any) {
        balanceFetchError = err?.message || String(err);
        balance = null;
      }
      const tbl = kind === 'BANK' ? 'bank_accounts' : 'broker_accounts';
      if (balance) {
        // Successful scrape — write both the new value and timestamp.
        // `balance_fetched_at` only moves on a real read, so the "age" shown in
        // the UI always reflects when the displayed number was actually fetched.
        balanceFetchedAt = new Date().toISOString();
        db.prepare(
          `UPDATE ${tbl} SET balance = ?, balance_fetched_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).run(balance, accountId);
      }
      // else: login worked but scraping returned nothing — leave the old balance
      // AND its timestamp untouched, so the age doesn't falsely reset on a value
      // that wasn't actually refreshed.
    }

    // If the browser stays open (e.g. AU Bank IPO flow), give the user an
    // in-page button to re-fetch the balance on demand — useful right after
    // they transfer funds out to another account and the number goes stale.
    if (shouldFetchBalance && !shouldCloseAfterFetch && adapter.fetchBalance && adapter.injectBalanceRefreshButton) {
      const tbl = kind === 'BANK' ? 'bank_accounts' : 'broker_accounts';
      await adapter.injectBalanceRefreshButton(page, async () => {
        const fresh = await adapter.fetchBalance!(page);
        // Only persist + broadcast on a real read. A failed re-fetch leaves the
        // stored balance and its timestamp untouched, so the "age" never resets
        // onto a value that wasn't actually refreshed.
        if (fresh) {
          const liveDb = getDb();
          liveDb.prepare(
            `UPDATE ${tbl} SET balance = ?, balance_fetched_at = CURRENT_TIMESTAMP WHERE id = ?`
          ).run(fresh, accountId);
          const freshAt = new Date().toISOString();
          BrowserWindow.getAllWindows().forEach(w => {
            try {
              w.webContents.send('account:balanceUpdated', {
                kind, accountId, memberId, balance: fresh, balanceFetchedAt: freshAt,
              });
            } catch { /* renderer may be gone */ }
          });
        }
        return fresh;
      }).catch((err: any) => {
        console.warn('[login] Could not inject balance refresh button:', err?.message || err);
      });
    }

    const auditDetails = balance
      ? `balance:${balance}`
      : shouldFetchBalance
        ? `login-ok-no-balance${balanceFetchError ? `:${balanceFetchError}` : ''}`
        : 'login-only';
    auditInsert.run(memberId, `LOGIN_${kind}`, code, 'SUCCESS', auditDetails);
    return { ok: true, balance, balanceFetchedAt };
  } catch (e: any) {
    auditInsert.run(memberId, `LOGIN_${kind}`, code, 'FAILED', e.message);
    return { ok: false, error: e.message };
  } finally {
    // Honour an explicit close request even when no balance was fetched (a
    // "verify credentials, then close" call used to leave the window open).
    if (contextToClose && shouldCloseAfterFetch) {
      await contextToClose.close().catch(() => {});
    }
    endAutomation();
  }
}

async function downloadBrokerPortfolioReport(memberId: number, brokerId: number) {
  const db = getDb();
  const account = db.prepare(`
    SELECT * FROM broker_accounts WHERE id = ? AND member_id = ?
  `).get(brokerId, memberId) as any;
  if (!account) return { ok: false, error: 'Broker account not found' };

  const code = account.broker_code;
  const adapter = getBrokerAdapter(code);
  if (!adapter?.downloadPortfolioReport) {
    return { ok: false, error: `Portfolio download is not available for ${code}` };
  }

  const username = await decryptField(account.user_id_enc);
  const password = await decryptField(account.password_enc);
  if (!username || !password) return { ok: false, error: 'Missing credentials' };

  const customerId = await decryptField(account.client_id_enc).catch(() => null);
  const totpSecret = await decryptField(account.totp_secret_enc).catch(() => null);
  const startTime = new Date();
  const fetchOtp = async () => {
    if (adapter.otpMode === 'totp') {
      if (!totpSecret) throw new Error('TOTP secret not set for this account');
      const { TOTP } = await import('totp-generator');
      return (await TOTP.generate(totpSecret)).otp;
    }
    if (adapter.otpMode === 'manual') {
      return requestOtpFromUser(`Enter the OTP sent to your mobile for ${adapter.displayName}`);
    }
    return fetchEmailOtp(code, adapter.displayName, startTime);
  };

  const auditInsert = db.prepare('INSERT INTO audit_log (member_id, action, target, status, details) VALUES (?, ?, ?, ?, ?)');
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const isRetriableFileError = (error: any) => {
    const code = error?.code;
    return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOENT';
  };
  const copyFileWithRetry = async (sourcePath: string, destinationPath: string) => {
    let lastError: any = null;
    for (let attempt = 1; attempt <= 40; attempt += 1) {
      try {
        copyFileSync(sourcePath, destinationPath);
        return;
      } catch (error: any) {
        lastError = error;
        if (!isRetriableFileError(error) || attempt === 40) break;
        await sleep(250);
      }
    }
    throw lastError;
  };

  beginAutomation();
  try {
    const { page } = await launchSession({ profileKey: `BROKER-${code}-${memberId}` });
    const report = await adapter.downloadPortfolioReport(
      page,
      { username, password, customerId: customerId ?? undefined, totpSecret: totpSecret ?? undefined },
      fetchOtp
    );

    if (!report) throw new Error('Portfolio report download returned no file');

    const reportDir = getBrokerReportDir(code, memberId);
    const safeFileName = sanitizeFileName(report.fileName || `${code.toLowerCase()}-portfolio.xlsx`);
    const datedPrefix = report.asOfDate ? `${report.asOfDate}_` : '';
    let targetPath = join(reportDir, `${datedPrefix}${safeFileName}`);
    if (existsSync(targetPath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      targetPath = join(reportDir, `${datedPrefix}${stamp}_${safeFileName}`);
    }

    await copyFileWithRetry(report.filePath, targetPath);
    const folderOpenError = await openFolderContainingFile(targetPath);

    const reportInsert = db.prepare(`
      INSERT INTO broker_portfolio_reports
      (broker_account_id, member_id, broker_code, report_kind, as_of_date, original_file_name, stored_file_path)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const reportResult = reportInsert.run(
      brokerId,
      memberId,
      code,
      report.reportKind,
      report.asOfDate,
      report.fileName,
      targetPath
    );

    const reportId = Number(reportResult.lastInsertRowid);
    let parsedSummaryCount = 0;
    let parsedHoldingCount = 0;

    const parsed = code === 'ZERODHA'
      ? parseZerodhaPortfolioReport(targetPath)
      : code === 'DHAN'
        ? parseDhanPortfolioReport(targetPath)
        : code === 'ANGEL'
          ? parseAngelPortfolioReport(targetPath)
        : null;

    if (parsed) {
      parsedSummaryCount = storeParsedBrokerPortfolioReport(db, reportId, parsed);
      parsedHoldingCount = parsed.holdings.length;
    }

    auditInsert.run(
      memberId,
      'DOWNLOAD_BROKER_PORTFOLIO',
      code,
      'SUCCESS',
      `${targetPath} | parsed summaries:${parsedSummaryCount} holdings:${parsedHoldingCount}`
        + (folderOpenError ? ` | folder open failed: ${folderOpenError}` : '')
    );
    return {
      ok: true,
      reportId,
      brokerCode: code,
      reportKind: report.reportKind,
      asOfDate: report.asOfDate,
      fileName: report.fileName,
      filePath: targetPath,
      folderOpened: !folderOpenError,
      folderOpenError: folderOpenError || null,
      parsedSummaryCount,
      parsedHoldingCount,
    };
  } catch (e: any) {
    auditInsert.run(memberId, 'DOWNLOAD_BROKER_PORTFOLIO', code, 'FAILED', e.message);
    return { ok: false, error: e.message || String(e) };
  } finally {
    endAutomation();
  }
}

async function getLatestBrokerPortfolioReport(memberId: number, brokerId: number) {
  const db = getDb();
  const account = db.prepare(`
    SELECT id, broker_code FROM broker_accounts WHERE id = ? AND member_id = ?
  `).get(brokerId, memberId) as any;
  if (!account) return { ok: false, error: 'Broker account not found' };

  const report = db.prepare(`
    SELECT *
    FROM broker_portfolio_reports
    WHERE broker_account_id = ? AND member_id = ?
    ORDER BY downloaded_at DESC, id DESC
    LIMIT 1
  `).get(brokerId, memberId) as any;
  if (!report) return { ok: false, error: 'No downloaded portfolio report found yet' };

  const summaries = db.prepare(`
    SELECT sheet_name, asset_scope, client_id, statement_title, as_of_date,
           invested_value, present_value, unrealized_pnl, unrealized_pnl_pct
    FROM broker_portfolio_report_summaries
    WHERE report_id = ?
    ORDER BY id
  `).all(report.id);

  const holdings = db.prepare(`
    SELECT sheet_name, asset_scope, is_combined_view, row_order, symbol, isin, sector, instrument_type,
           quantity_available, quantity_discrepant, quantity_long_term, quantity_pledged_margin, quantity_pledged_loan,
           average_price, previous_closing_price, unrealized_pnl, unrealized_pnl_pct
    FROM broker_portfolio_holdings
    WHERE report_id = ?
    ORDER BY sheet_name, row_order, id
  `).all(report.id);

  return {
    ok: true,
    report: {
      reportId: report.id,
      brokerCode: account.broker_code,
      reportKind: report.report_kind,
      asOfDate: report.as_of_date,
      fileName: report.original_file_name,
      filePath: report.stored_file_path,
      downloadedAt: report.downloaded_at,
      summaries,
      holdings,
    }
  };
}

async function openLatestBrokerPortfolioFolder(memberId: number, brokerId: number) {
  const db = getDb();
  const account = db.prepare(`
    SELECT id, broker_code FROM broker_accounts WHERE id = ? AND member_id = ?
  `).get(brokerId, memberId) as any;
  if (!account) return { ok: false, error: 'Broker account not found' };

  const report = db.prepare(`
    SELECT stored_file_path, original_file_name
    FROM broker_portfolio_reports
    WHERE broker_account_id = ? AND member_id = ?
    ORDER BY downloaded_at DESC, id DESC
    LIMIT 1
  `).get(brokerId, memberId) as any;
  if (!report?.stored_file_path) {
    return { ok: false, error: `No saved ${account.broker_code} report found yet. Use Save & Open first.` };
  }
  if (!existsSync(report.stored_file_path)) {
    return { ok: false, error: `Saved report file is missing: ${report.stored_file_path}` };
  }

  const folderOpenError = await openFolderContainingFile(report.stored_file_path);
  if (folderOpenError) return { ok: false, error: folderOpenError, filePath: report.stored_file_path };
  return {
    ok: true,
    brokerCode: account.broker_code,
    fileName: report.original_file_name,
    filePath: report.stored_file_path,
  };
}

async function getMemberAuBidDraftOptions(memberId: number) {
  const db = getDb();
  const member = db.prepare(`
    SELECT id, full_name, pan_last4
    FROM members
    WHERE id = ?
  `).get(memberId) as any;
  if (!member) return { ok: false, error: 'Member not found' };

  const banks = db.prepare(`
    SELECT id, bank_code
    FROM bank_accounts
    WHERE member_id = ? AND bank_code = 'AU'
      AND user_id_enc IS NOT NULL AND password_enc IS NOT NULL
    ORDER BY id
  `).all(memberId) as any[];

  return {
    ok: true,
    member: {
      id: member.id,
      fullName: member.full_name,
      panLast4: member.pan_last4,
    },
    banks,
    history: listMemberIpoBids(memberId).history,
  };
}

async function buildOtpFetcher(_kind: 'BANK' | 'BROKER', code: string, adapter: any, totpSecret: string | null, startTime: Date) {
  return async () => {
    if (adapter.otpMode === 'totp') {
      if (!totpSecret) throw new Error('TOTP secret not set for this account');
      const { TOTP } = await import('totp-generator');
      return (await TOTP.generate(totpSecret)).otp;
    }
    if (adapter.otpMode === 'manual') {
      return requestOtpFromUser(`Enter the OTP sent to your mobile for ${adapter.displayName}`);
    }
    return fetchEmailOtp(code, adapter.displayName, startTime);
  };
}

async function prepareAuIpoBid(payload: {
  memberId: number;
  bankId: number;
  brokerId?: number | null;
  issueName: string;
  quantity: number;
  lotSize?: number | null;
  bidType: 'CUTOFF' | 'LIMIT';
  bidPrice: number;
}) {
  const db = getDb();
  const issueName = payload.issueName.trim();
  const quantity = Math.max(0, Math.floor(payload.quantity || 0));
  const effectivePrice = Number(payload.bidPrice || 0);
  const lotSize = payload.lotSize ? Math.max(0, Math.floor(payload.lotSize)) : null;

  if (!issueName) return { ok: false, error: 'IPO issue name is required' };
  if (!quantity) return { ok: false, error: 'Quantity must be greater than zero' };
  if (!(effectivePrice > 0)) return { ok: false, error: 'Price must be greater than zero' };
  if (lotSize && quantity % lotSize !== 0) {
    return { ok: false, error: `Quantity must be a multiple of lot size ${lotSize}` };
  }

  const member = db.prepare(`
    SELECT id, full_name, member_type, pan_enc, pan_last4
    FROM members
    WHERE id = ?
  `).get(payload.memberId) as any;
  if (!member) return { ok: false, error: 'Member not found' };

  const bank = db.prepare(`
    SELECT * FROM bank_accounts
    WHERE id = ? AND member_id = ?
  `).get(payload.bankId, payload.memberId) as any;
  if (!bank) return { ok: false, error: 'AU bank account not found' };
  if (bank.bank_code !== 'AU') return { ok: false, error: 'Selected bank account is not AU Bank' };

  const username = await decryptField(bank.user_id_enc).catch(() => null);
  const password = await decryptField(bank.password_enc).catch(() => null);
  const customerId = await decryptField(bank.customer_id_enc).catch(() => null);
  const pan = await decryptField(member.pan_enc).catch(() => null);
  if (!username || !password) return { ok: false, error: 'Missing AU credentials' };
  if (!pan) return { ok: false, error: `PAN is missing for ${member.full_name}` };

  const adapter = getBankAdapter('AU');
  if (!adapter?.prepareIpoBid) return { ok: false, error: 'AU IPO preparation is not available yet' };

  const draft: IpoBidDraft = {
    issueName,
    brokerCode: null,
    dematAccount: null,
    debitAccountLast4: bank.account_last4 || null,
    investorCategory: Number((quantity * effectivePrice).toFixed(2)) > 200000
      ? 'Individual Investors, NRI, HUF - HNI applications above 2 Lakhs'
      : 'Individual Investors, NRI, HUF - Retail applications up to 2 Lakhs',
    pan,
    quantity,
    lotSize,
    bidType: payload.bidType,
    enteredPrice: payload.bidType === 'LIMIT' ? effectivePrice : null,
    effectivePrice,
    blockedAmount: Number((quantity * effectivePrice).toFixed(2)),
    // Pass creds so the AU adapter can re-auth on the IPO subdomain if needed
    username,
    password,
  };

  const auditInsert = db.prepare('INSERT INTO audit_log (member_id, action, target, status, details) VALUES (?, ?, ?, ?, ?)');
  beginAutomation();
  try {
    const startTime = new Date();
    const fetchOtp = await buildOtpFetcher('BANK', 'AU', adapter, null, startTime);
    const { page } = await launchSession({ profileKey: `BANK-AU-${payload.memberId}` });
    await adapter.login(page, {
      username,
      password,
      customerId: customerId ?? undefined,
    }, fetchOtp);

    const prepared = await adapter.prepareIpoBid(page, draft);

    // ── Window-close auto-advance ─────────────────────────────────────────
    // After the bid form is prepared the IPO browser window stays open for
    // the user to review/submit manually. When they close that Chromium
    // window (whether the bid was placed or not), the renderer should
    // automatically open the next queued member's bid window.
    try {
      // The IPO page may be the main page or a popup opened by openAuIpoArea.
      const allPages = page.context().pages();
      const ipoPage = allPages.find(
        p => !p.isClosed() && p.url().includes('iposmart.au.bank.in')
      ) ?? (page.url().includes('iposmart.au.bank.in') ? page : null);
      const watchPage = ipoPage ?? page;
      const memberIdForEvent = payload.memberId;
      watchPage.once('close', () => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('ipo:ipoWindowClosed', { memberId: memberIdForEvent });
          }
        }
      });
    } catch { /* non-fatal — auto-advance just won't fire */ }

    const insert = db.prepare(`
      INSERT INTO ipo_bid_runs
      (member_id, bank_account_id, broker_account_id, bank_code, broker_code, ipo_name,
       bid_type, quantity, lot_size, entered_price, effective_price, blocked_amount,
       demat_account_last4, pan_last4, ready_to_submit, page_url, prepare_warnings_json,
       status, prepared_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PREPARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    const result = insert.run(
      payload.memberId,
      payload.bankId,
      null,
      'AU',
      null,
      issueName,
      payload.bidType,
      quantity,
      lotSize,
      draft.enteredPrice,
      draft.effectivePrice,
      draft.blockedAmount,
      null,
      member.pan_last4,
      prepared.readyToSubmit ? 1 : 0,
      prepared.pageUrl,
      JSON.stringify(prepared.warnings)
    );

    const bidRunId = Number(result.lastInsertRowid);
    auditInsert.run(
      payload.memberId,
      'AU_IPO_PREPARE',
      issueName,
      'SUCCESS',
      `bank:${bank.id} qty:${quantity} amount:${draft.blockedAmount}`
    );

    return {
      ok: true,
      bidRun: {
        id: bidRunId,
        memberId: payload.memberId,
        memberName: member.full_name,
        bankId: payload.bankId,
        bankCode: 'AU',
        brokerId: 0,
        brokerCode: 'AU-SAVED',
        issueName,
        bidType: payload.bidType,
        quantity,
        lotSize,
        enteredPrice: draft.enteredPrice,
        effectivePrice: draft.effectivePrice,
        blockedAmount: draft.blockedAmount,
        dematAccountLast4: null,
        panLast4: member.pan_last4,
        readyToSubmit: prepared.readyToSubmit,
        warnings: prepared.warnings,
        pageUrl: prepared.pageUrl,
        detectedIssueName: prepared.detectedIssueName ?? null,
        detectedDemat: prepared.detectedDemat ?? null,
        detectedAmount: prepared.detectedAmount ?? null,
        preparedAt: new Date().toISOString(),
      }
    };
  } catch (e: any) {
    auditInsert.run(payload.memberId, 'AU_IPO_PREPARE', issueName, 'FAILED', e?.message || String(e));
    return { ok: false, error: e?.message || String(e) };
  } finally {
    endAutomation();
  }
}

async function confirmAuIpoBid(bidRunId: number) {
  const db = getDb();
  const bid = db.prepare(`
    SELECT *
    FROM ipo_bid_runs
    WHERE id = ?
  `).get(bidRunId) as any;
  if (!bid) return { ok: false, error: 'IPO bid run not found' };
  if (bid.bank_code !== 'AU') return { ok: false, error: 'Only AU IPO bids are supported here' };
  // Refuse to re-submit a bid that was already placed (or is mid-flight). Without
  // this, a double-click or a replayed IPC would drive a SECOND real-money
  // application — the success path never cleared ready_to_submit, so the row
  // stayed armed. The atomic claim below is the real race guard; these checks
  // just return friendlier messages on the common (non-racing) path.
  if (bid.status === 'SUBMITTED') {
    return { ok: false, error: 'This bid has already been submitted — refusing to submit it again.' };
  }
  if (bid.status === 'IN_PROGRESS') {
    return { ok: false, error: 'This bid is already being submitted. Wait for the current attempt to finish.' };
  }
  if (!bid.ready_to_submit) return { ok: false, error: 'This AU bid is not marked ready to submit yet' };

  const member = db.prepare(`
    SELECT id, full_name, pan_enc
    FROM members
    WHERE id = ?
  `).get(bid.member_id) as any;
  const bank = db.prepare(`
    SELECT *
    FROM bank_accounts
    WHERE id = ? AND member_id = ?
  `).get(bid.bank_account_id, bid.member_id) as any;
  if (!member || !bank) {
    return { ok: false, error: 'Member or bank details are no longer available' };
  }

  const username = await decryptField(bank.user_id_enc).catch(() => null);
  const password = await decryptField(bank.password_enc).catch(() => null);
  const customerId = await decryptField(bank.customer_id_enc).catch(() => null);
  const pan = await decryptField(member.pan_enc).catch(() => null);
  if (!username || !password) return { ok: false, error: 'Missing AU credentials' };
  if (!pan) return { ok: false, error: `PAN is missing for ${member.full_name}` };

  const adapter = getBankAdapter('AU');
  if (!adapter?.submitPreparedIpoBid) return { ok: false, error: 'AU IPO submission is not available yet' };

  const draft: IpoBidDraft = {
    issueName: bid.ipo_name,
    brokerCode: bid.broker_code,
    dematAccount: null,
    debitAccountLast4: bank.account_last4 || null,
    investorCategory: bid.blocked_amount > 200000
      ? 'Individual Investors, NRI, HUF - HNI applications above 2 Lakhs'
      : 'Individual Investors, NRI, HUF - Retail applications up to 2 Lakhs',
    pan,
    quantity: bid.quantity,
    lotSize: bid.lot_size,
    bidType: bid.bid_type,
    enteredPrice: bid.entered_price,
    effectivePrice: bid.effective_price,
    blockedAmount: bid.blocked_amount,
  };

  // Race-safe claim: atomically flip a still-submittable row to IN_PROGRESS.
  // Only one concurrent caller can win the UPDATE (changes === 1); a duplicate
  // call (double-click, retried IPC) sees changes === 0 and is refused. We claim
  // AFTER all read-only validation above so an early error can't leave a row
  // stuck IN_PROGRESS. PREPARED → first attempt; FAILED → user-initiated retry.
  const claim = db.prepare(`
    UPDATE ipo_bid_runs
    SET status = 'IN_PROGRESS', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND ready_to_submit = 1 AND status IN ('PREPARED', 'FAILED')
  `).run(bidRunId);
  if (claim.changes === 0) {
    return { ok: false, error: 'This bid is no longer in a submittable state (already submitted or in progress).' };
  }

  const auditInsert = db.prepare('INSERT INTO audit_log (member_id, action, target, status, details) VALUES (?, ?, ?, ?, ?)');
  beginAutomation();
  try {
    const startTime = new Date();
    const fetchOtp = await buildOtpFetcher('BANK', 'AU', adapter, null, startTime);
    const { page } = await launchSession({ profileKey: `BANK-AU-${bid.member_id}` });
    await adapter.login(page, {
      username,
      password,
      customerId: customerId ?? undefined,
    }, fetchOtp);

    const submitted = await adapter.submitPreparedIpoBid(page, draft);
    db.prepare(`
      UPDATE ipo_bid_runs
      SET status = 'SUBMITTED',
          ready_to_submit = 0,
          bank_reference = ?,
          page_url = ?,
          prepare_warnings_json = ?,
          submitted_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP,
          error_message = NULL
      WHERE id = ?
    `).run(
      submitted.bankReference,
      submitted.pageUrl,
      JSON.stringify(submitted.warnings),
      bidRunId
    );

    auditInsert.run(
      bid.member_id,
      'AU_IPO_SUBMIT',
      bid.ipo_name,
      'SUCCESS',
      submitted.bankReference || submitted.confirmationText || 'submitted'
    );

    return {
      ok: true,
      bidRunId,
      bankReference: submitted.bankReference,
      confirmationText: submitted.confirmationText ?? null,
      warnings: submitted.warnings,
      pageUrl: submitted.pageUrl,
    };
  } catch (e: any) {
    db.prepare(`
      UPDATE ipo_bid_runs
      SET status = 'FAILED',
          error_message = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(e?.message || String(e), bidRunId);
    auditInsert.run(bid.member_id, 'AU_IPO_SUBMIT', bid.ipo_name, 'FAILED', e?.message || String(e));
    return { ok: false, error: e?.message || String(e) };
  } finally {
    endAutomation();
  }
}

function listMemberIpoBids(memberId: number) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, bank_code, broker_code, ipo_name, bid_type, quantity, lot_size,
           entered_price, effective_price, blocked_amount, demat_account_last4,
           pan_last4, ready_to_submit, status, bank_reference, page_url,
           prepare_warnings_json, prepared_at, submitted_at, error_message,
           created_at, updated_at
    FROM ipo_bid_runs
    WHERE member_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 12
  `).all(memberId) as any[];

  return {
    ok: true,
    history: rows.map((row) => ({
      id: row.id,
      bankCode: row.bank_code,
      brokerCode: row.broker_code,
      issueName: row.ipo_name,
      bidType: row.bid_type,
      quantity: row.quantity,
      lotSize: row.lot_size,
      enteredPrice: row.entered_price,
      effectivePrice: row.effective_price,
      blockedAmount: row.blocked_amount,
      dematAccountLast4: row.demat_account_last4,
      panLast4: row.pan_last4,
      readyToSubmit: !!row.ready_to_submit,
      status: row.status,
      bankReference: row.bank_reference,
      pageUrl: row.page_url,
      warnings: row.prepare_warnings_json ? JSON.parse(row.prepare_warnings_json) : [],
      preparedAt: row.prepared_at,
      submittedAt: row.submitted_at,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  };
}

function storeParsedBrokerPortfolioReport(db: any, reportId: number, parsed: {
  summaries: Array<{
    sheetName: string;
    assetScope: 'EQUITY' | 'MUTUAL_FUNDS' | 'COMBINED';
    clientId: string | null;
    statementTitle: string | null;
    asOfDate: string | null;
    investedValue: number | null;
    presentValue: number | null;
    unrealizedPnl: number | null;
    unrealizedPnlPct: number | null;
  }>;
  holdings: Array<{
    sheetName: string;
    assetScope: 'EQUITY' | 'MUTUAL_FUNDS' | 'COMBINED';
    isCombinedView: boolean;
    rowOrder: number;
    symbol: string;
    isin: string | null;
    sector: string | null;
    instrumentType: string | null;
    quantityAvailable: number | null;
    quantityDiscrepant: number | null;
    quantityLongTerm: number | null;
    quantityPledgedMargin: number | null;
    quantityPledgedLoan: number | null;
    averagePrice: number | null;
    previousClosingPrice: number | null;
    unrealizedPnl: number | null;
    unrealizedPnlPct: number | null;
  }>;
}) {
  const insertSummary = db.prepare(`
    INSERT INTO broker_portfolio_report_summaries
    (report_id, sheet_name, asset_scope, client_id, statement_title, as_of_date, invested_value, present_value, unrealized_pnl, unrealized_pnl_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertHolding = db.prepare(`
    INSERT INTO broker_portfolio_holdings
    (report_id, sheet_name, asset_scope, is_combined_view, row_order, symbol, isin, sector, instrument_type,
     quantity_available, quantity_discrepant, quantity_long_term, quantity_pledged_margin, quantity_pledged_loan,
     average_price, previous_closing_price, unrealized_pnl, unrealized_pnl_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const summary of parsed.summaries) {
      insertSummary.run(
        reportId,
        summary.sheetName,
        summary.assetScope,
        summary.clientId,
        summary.statementTitle,
        summary.asOfDate,
        summary.investedValue,
        summary.presentValue,
        summary.unrealizedPnl,
        summary.unrealizedPnlPct
      );
    }

    for (const holding of parsed.holdings) {
      insertHolding.run(
        reportId,
        holding.sheetName,
        holding.assetScope,
        holding.isCombinedView ? 1 : 0,
        holding.rowOrder,
        holding.symbol,
        holding.isin,
        holding.sector,
        holding.instrumentType,
        holding.quantityAvailable,
        holding.quantityDiscrepant,
        holding.quantityLongTerm,
        holding.quantityPledgedMargin,
        holding.quantityPledgedLoan,
        holding.averagePrice,
        holding.previousClosingPrice,
        holding.unrealizedPnl,
        holding.unrealizedPnlPct
      );
    }
  });

  tx();
  return parsed.summaries.length;
}
