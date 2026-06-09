/**
 * Auto-update plumbing using electron-updater.
 *
 * Flow:
 *   - On app start (after window ready), we check GitHub Releases for a
 *     newer `latest.yml` than the running app's version.
 *   - If newer → download in background → on completion, notify renderer.
 *   - User sees a toast/banner; clicking "Restart now" calls back to install.
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

function broadcast(channel: string, payload?: any): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try { win.webContents.send(channel, payload); } catch { /* */ }
    }
  }
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
    info: (m: string) => console.log('[Updater]', m),
    warn: (m: string) => console.warn('[Updater]', m),
    error: (m: string) => console.error('[Updater]', m),
    debug: (m: string) => console.log('[Updater]', m),
  } as any;

  // Download automatically; install only on user confirmation (via IPC below).
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => {
    broadcast('updater:status', { kind: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    broadcast('updater:status', { kind: 'available', version: info.version });
  });

  autoUpdater.on('update-not-available', (info) => {
    broadcast('updater:status', { kind: 'up-to-date', version: info.version });
  });

  autoUpdater.on('download-progress', (p) => {
    broadcast('updater:status', {
      kind: 'downloading',
      percent: Math.round(p.percent),
      bytesPerSecond: p.bytesPerSecond,
      transferred: p.transferred,
      total: p.total,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true;
    broadcast('updater:status', { kind: 'downloaded', version: info.version });
  });

  autoUpdater.on('error', (err) => {
    broadcast('updater:status', { kind: 'error', message: err?.message || String(err) });
  });

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

  // Initial check ~3 seconds after startup so the app is responsive first.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(e => {
      console.warn('[Updater] Initial check failed:', e?.message || e);
    });
  }, 3_000);
}
