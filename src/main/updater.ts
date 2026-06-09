/**
 * Auto-update plumbing using electron-updater.
 *
 * Flow:
 *   - On app start, we wait for the first browser window to finish loading its
 *     renderer (did-finish-load) and then wait 1 more second for React to
 *     hydrate. Only then do we fire the first update check. This guarantees
 *     the renderer is always subscribed to `updater:status` before any events
 *     broadcast.
 *   - The last known status is cached in `lastStatus`. The renderer calls
 *     `updater:getStatus` on mount so it catches up with anything that fired
 *     before its subscription was set up (e.g. if update was already
 *     downloaded by the time the vault is unlocked and the component mounts).
 *   - On network error, we retry once after 30 seconds (handles the case
 *     where the network isn't fully up when the app launches).
 *
 * Notes:
 *   - Public GitHub repo means no token needed — anonymous fetch works.
 *   - Update events are forwarded to ALL BrowserWindows via webContents.send.
 *   - Failures are non-fatal — we log and move on; the user can keep working.
 *   - Disabled in dev mode (electron-vite serve sets ELECTRON_RENDERER_URL).
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';

let initialized = false;
let updateDownloaded = false;

// ── Status cache ─────────────────────────────────────────────────────────────
// Keeps the last known update status so the renderer can call
// `updater:getStatus` on mount and immediately sync state, regardless of
// whether it was alive when the events originally broadcast.
let lastStatus: Record<string, any> = { kind: 'idle' };

function broadcast(channel: string, payload?: any): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try { win.webContents.send(channel, payload); } catch { /* */ }
    }
  }
}

/** Update the cache and broadcast to all windows. */
function setStatus(payload: Record<string, any>): void {
  lastStatus = payload;
  broadcast('updater:status', payload);
}

export function initAutoUpdater(): void {
  if (initialized) return;
  initialized = true;

  // Skip in dev — electron-vite sets this env var when running `npm run dev`.
  if (process.env.ELECTRON_RENDERER_URL) {
    console.log('[Updater] Skipping auto-update in dev mode.');
    return;
  }

  // Log everything for debugging.
  autoUpdater.logger = {
    info:  (m: string) => console.log('[Updater]', m),
    warn:  (m: string) => console.warn('[Updater]', m),
    error: (m: string) => console.error('[Updater]', m),
    debug: (m: string) => console.log('[Updater]', m),
  } as any;

  // Download automatically; install only on user confirmation (via IPC below).
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  // ── Event handlers ────────────────────────────────────────────────────────

  autoUpdater.on('checking-for-update', () => {
    setStatus({ kind: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    setStatus({ kind: 'available', version: info.version });
  });

  autoUpdater.on('update-not-available', (info) => {
    setStatus({ kind: 'up-to-date', version: info.version });
  });

  autoUpdater.on('download-progress', (p) => {
    setStatus({
      kind: 'downloading',
      percent: Math.round(p.percent),
      bytesPerSecond: p.bytesPerSecond,
      transferred: p.transferred,
      total: p.total,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true;
    setStatus({ kind: 'downloaded', version: info.version });
  });

  autoUpdater.on('error', (err) => {
    setStatus({ kind: 'error', message: err?.message || String(err) });
    // Retry once after 30 seconds — handles the case where the network
    // isn't fully up yet when the app first launches.
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(e => {
        console.warn('[Updater] Retry check failed:', e?.message || e);
      });
    }, 30_000);
  });

  // ── IPC handlers ──────────────────────────────────────────────────────────

  // Renderer calls this on mount to immediately get the current status and
  // skip the race with the broadcast-based event system.
  ipcMain.handle('updater:getStatus', () => lastStatus);

  // Renderer triggers install when user clicks "Restart and install".
  ipcMain.handle('updater:installNow', () => {
    if (!updateDownloaded) return { ok: false, error: 'No update is ready to install yet.' };
    // quitAndInstall closes all windows and replaces the executable, then
    // relaunches. The before-quit handler runs first, so the final backup
    // flush still happens before update.
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { ok: true };
  });

  ipcMain.handle('updater:checkNow', async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return { ok: true, version: result?.updateInfo?.version || null };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle('updater:currentVersion', () => app.getVersion());

  // ── Initial check timing ──────────────────────────────────────────────────
  // We fire the first update check ONLY after the first browser window has
  // finished loading AND React has had 1 second to hydrate. This guarantees
  // the renderer is subscribed to `updater:status` before any events fire.
  //
  // Previously we used setTimeout(3000) from app-start, which raced with
  // renderer load time on slow machines and caused events to fire into the
  // void.
  let firstCheckScheduled = false;

  const scheduleFirstCheck = (): void => {
    if (firstCheckScheduled) return;
    firstCheckScheduled = true;
    // 1-second buffer after did-finish-load for React to hydrate + subscribe.
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(e => {
        console.warn('[Updater] Initial check failed:', e?.message || e);
      });
    }, 1_000);
  };

  // Primary trigger: first window finishes loading.
  app.on('browser-window-created', (_, win) => {
    win.webContents.once('did-finish-load', scheduleFirstCheck);
  });

  // Fallback: if somehow no did-finish-load fires within 15 seconds, check
  // anyway so we don't silently skip updates on unusual launch paths.
  setTimeout(() => {
    if (!firstCheckScheduled) {
      console.warn('[Updater] Fallback check (did-finish-load never fired)');
      firstCheckScheduled = true;
      autoUpdater.checkForUpdates().catch(e => {
        console.warn('[Updater] Fallback check failed:', e?.message || e);
      });
    }
  }, 15_000);
}
