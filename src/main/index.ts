import { app, BrowserWindow, Menu, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { markActivity, shouldAutolock } from './activity';
import { closeDb } from './db/connection';
import { clearVaultSessionSecrets, flushBackupOnExit, registerIpcHandlers } from './ipc';
import { purgeBrowserProfiles } from './automation/browser';
import { initAutoUpdater } from './updater';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0d0e12',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.setMenu(null);

  // ── Navigation hardening ──────────────────────────────────────────────────
  // The renderer is a local SPA that never legitimately opens child windows or
  // top-navigates away from its own bundle (external links go through the
  // https-only shell:openExternal IPC). Deny window.open and block any
  // top-level navigation to a different URL, so a compromised renderer can't
  // load an attacker page that would inherit the privileged preload bridge.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL();
    if (current && url !== current) event.preventDefault();
  });

  mainWindow.on('ready-to-show', () => mainWindow?.show());

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  // Auto-lock on inactivity
  mainWindow.webContents.on('before-input-event', () => { markActivity(); });
  setInterval(async () => {
    if (shouldAutolock()) {
      // Flush any pending changes to the backup folder before locking — so
      // even a short session ending in auto-lock leaves a snapshot for the
      // other PC to pick up.
      await flushBackupOnExit();
      closeDb();
      clearVaultSessionSecrets();
      // Wipe Playwright profiles (session cookies for banks/brokers) so an
      // attacker with disk access can't replay the auto-locked user's logins.
      void purgeBrowserProfiles().catch(() => {});
      mainWindow?.webContents.send('vault:locked');
    }
  }, 30_000);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerIpcHandlers(ipcMain);
  initAutoUpdater();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Don't close the DB or clear secrets here — before-quit (below) needs
  // currentMasterKey to run a final backup. The OS will fire before-quit
  // next and the cleanup happens there.
  if (process.platform !== 'darwin') app.quit();
});

// Final backup flush before exit. We preventDefault, run the backup
// asynchronously, then call app.quit() again — by which point didFlush is
// true and we fall through to the normal cleanup + exit path.
let didFlushOnExit = false;
app.on('before-quit', async (event) => {
  if (!didFlushOnExit) {
    event.preventDefault();
    try { await flushBackupOnExit(); } catch { /* never block exit */ }
    didFlushOnExit = true;
    app.quit();
    return;
  }
  closeDb();
  clearVaultSessionSecrets();
});
