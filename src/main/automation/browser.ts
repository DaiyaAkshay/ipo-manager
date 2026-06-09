/**
 * Playwright-based browser launcher.
 *
 * Always runs headed (visible) — never headless. This is intentional:
 *   - You can see what the bot is doing
 *   - You can intervene if a CAPTCHA, security question, or unexpected
 *     screen appears
 *   - Banks are less likely to flag a visible browser as automation
 *
 * Each login uses a separate persistent context so cookies/sessions for
 * different relatives don't collide.
 */

import { chromium, BrowserContext, Download, Page } from 'playwright';
import { basename, dirname, extname, join } from 'node:path';
import { mkdirSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

const sessionCache = new Map<string, BrowserContext>();
const contextDownloadDirs = new WeakMap<BrowserContext, string>();
const downloadRevealContexts = new WeakSet<BrowserContext>();
const downloadRevealPages = new WeakSet<Page>();
const recentlyRevealedDownloads = new Set<string>();
const downloadFolderMonitors = new Map<string, { timer: ReturnType<typeof setInterval>; scanning: boolean }>();
const downloadMonitorSeenFiles = new Map<string, number>();
const PLAYWRIGHT_ACCEPT_DOWNLOADS_MESSAGE = 'Pass { acceptDownloads: true } when you are creating your browser context.';
const REVEALABLE_DOWNLOAD_EXTENSIONS = new Set(['.xlsx', '.xls', '.xlsm', '.csv', '.pdf', '.jpg', '.jpeg']);

interface BrowserWindowBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim();
}

function getMostRecentOpenPage(context: BrowserContext): Page | null {
  const pages = context.pages().filter(page => !page.isClosed());
  return pages.length > 0 ? pages[pages.length - 1] : null;
}

function getBrowserProfilesBase(): string {
  if (process.env.IPO_DATA_DIR) return join(process.env.IPO_DATA_DIR, '..', 'browser-profiles');
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    return join(app.getPath('userData'), 'browser-profiles');
  } catch {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'ipo-manager', 'browser-profiles');
  }
}

function getSystemDownloadsDir(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    const downloadsDir = app?.getPath?.('downloads');
    if (downloadsDir) return ensureDir(downloadsDir);
  } catch {
    // Fall back to the conventional Downloads folder.
  }
  return ensureDir(join(homedir(), 'Downloads'));
}

function getBrowserDownloadDir(_profileKey: string): string {
  return getSystemDownloadsDir();
}

function getPreferredBrowserExecutablePath(): string | null {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const candidates = [
      // System-wide Chrome
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      // Per-user Chrome (very common — installs without admin rights)
      join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      // System-wide Edge
      join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      // Per-user Edge
      join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      // Chromium / Brave fallbacks
      join(programFiles, 'Chromium', 'Application', 'chrome.exe'),
      join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      join(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ];
    return candidates.find(candidate => existsSync(candidate)) || null;
  }

  if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
    return candidates.find(candidate => existsSync(candidate)) || null;
  }

  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/microsoft-edge',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
  return candidates.find(candidate => existsSync(candidate)) || null;
}

function ensureBrowserProfilePreferences(profileDir: string, downloadDir: string): void {
  const defaultDir = ensureDir(join(profileDir, 'Default'));
  const preferencesPath = join(defaultDir, 'Preferences');
  let preferences: Record<string, any> = {};

  if (existsSync(preferencesPath)) {
    try {
      preferences = JSON.parse(readFileSync(preferencesPath, 'utf8'));
    } catch (error) {
      console.warn('[Browser] Could not parse existing Preferences file, rewriting a minimal one:', error);
    }
  }

  const safeBrowsing = typeof preferences.safebrowsing === 'object' && preferences.safebrowsing
    ? preferences.safebrowsing
    : {};
  preferences.safebrowsing = {
    ...safeBrowsing,
    enabled: false,
    enhanced: false,
  };

  const downloadPrefs = typeof preferences.download === 'object' && preferences.download
    ? preferences.download
    : {};
  preferences.download = {
    ...downloadPrefs,
    default_directory: downloadDir,
    directory_upgrade: true,
    prompt_for_download: false,
  };

  writeFileSync(preferencesPath, JSON.stringify(preferences));
}

function getPreferredBrowserWindowBounds(): BrowserWindowBounds {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { screen } = require('electron') as typeof import('electron');
    const workArea = screen?.getPrimaryDisplay?.().workArea;
    if (workArea) {
      const padding = 12;
      const width = workArea.width > (padding * 2) ? workArea.width - (padding * 2) : workArea.width;
      const height = workArea.height > (padding * 2) ? workArea.height - (padding * 2) : workArea.height;
      return {
        left: workArea.x + padding,
        top: workArea.y + padding,
        width,
        height,
      };
    }
  } catch {
    // Fall back to a conservative desktop window size.
  }

  return {
    left: 24,
    top: 24,
    width: 1360,
    height: 860,
  };
}

async function setBrowserDownloadBehavior(page: Page, downloadDir: string): Promise<void> {
  try {
    const client = await page.context().newCDPSession(page);
    const params: Record<string, string | boolean> = {
      behavior: 'allow',
      downloadPath: downloadDir,
      eventsEnabled: true,
    };
    const contextAny = page.context() as any;
    const browserContextId = contextAny?._browserContextId;
    if (browserContextId) params.browserContextId = browserContextId;
    await client.send('Browser.setDownloadBehavior', params);
  } catch (error) {
    console.warn('[Browser] Could not override Chromium download behavior:', error);
  }
}

async function fitBrowserWindowToDesktop(page: Page): Promise<void> {
  try {
    const client = await page.context().newCDPSession(page);
    const { windowId } = await client.send('Browser.getWindowForTarget');
    const bounds = getPreferredBrowserWindowBounds();
    await client.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'normal' },
    }).catch(() => {});
    await client.send('Browser.setWindowBounds', {
      windowId,
      bounds: {
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      },
    });
  } catch (error) {
    console.warn('[Browser] Could not fit Chromium window to the desktop:', error);
  }
}

function revealFileInFolder(filePath: string): void {
  const revealKey = pathKey(filePath);
  if (recentlyRevealedDownloads.has(revealKey)) return;
  recentlyRevealedDownloads.add(revealKey);
  downloadMonitorSeenFiles.set(revealKey, Date.now());
  setTimeout(() => recentlyRevealedDownloads.delete(revealKey), 30_000);

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { shell } = require('electron') as typeof import('electron');
    shell.showItemInFolder(filePath);
    return;
  } catch (error) {
    console.warn('[Browser] Could not reveal download with Electron shell:', error);
  }

  if (process.platform === 'win32') {
    try {
      const child = spawn('explorer.exe', [`/select,${filePath}`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref();
      return;
    } catch (error) {
      console.warn('[Browser] Could not reveal download with explorer.exe:', error);
    }
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { shell } = require('electron') as typeof import('electron');
    shell.openPath(dirname(filePath)).catch(error => {
      if (error) console.warn('[Browser] Could not open download folder:', error);
    });
    return;
  } catch {
    // Fall through to logging the path.
  }

  console.log('[Browser] Download saved at:', filePath);
}

function pathKey(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

function isRevealableDownloadPath(filePath: string): boolean {
  const lowerPath = filePath.toLowerCase();
  if (
    lowerPath.endsWith('.crdownload') ||
    lowerPath.endsWith('.tmp') ||
    lowerPath.endsWith('.download')
  ) {
    return false;
  }
  const extension = extname(lowerPath);
  return !extension || REVEALABLE_DOWNLOAD_EXTENSIONS.has(extension);
}

function collectRevealableDownloadFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isFile()) {
      if (isRevealableDownloadPath(entryPath)) files.push(entryPath);
    }
  }
  return files;
}

function markExistingDownloadsSeen(downloadDir: string): void {
  for (const filePath of collectRevealableDownloadFiles(downloadDir)) {
    try {
      const stats = statSync(filePath);
      if (stats.isFile()) downloadMonitorSeenFiles.set(pathKey(filePath), stats.mtimeMs);
    } catch {
      // The file may have been moved while the folder was being scanned.
    }
  }
}

function stopDownloadFolderMonitor(downloadDir: string): void {
  const monitorKey = pathKey(downloadDir);
  const monitor = downloadFolderMonitors.get(monitorKey);
  if (!monitor) return;

  clearInterval(monitor.timer);
  downloadFolderMonitors.delete(monitorKey);
}

function startDownloadFolderMonitor(downloadDir: string, profileKey: string): void {
  const monitorKey = pathKey(downloadDir);
  if (downloadFolderMonitors.has(monitorKey)) return;

  markExistingDownloadsSeen(downloadDir);

  async function scan(): Promise<void> {
    const monitor = downloadFolderMonitors.get(monitorKey);
    if (!monitor || monitor.scanning) return;
    monitor.scanning = true;

    try {
      for (const filePath of collectRevealableDownloadFiles(downloadDir)) {
        let stats;
        try {
          stats = statSync(filePath);
        } catch {
          continue;
        }
        if (!stats.isFile()) continue;

        const seenKey = pathKey(filePath);
        if (downloadMonitorSeenFiles.get(seenKey) === stats.mtimeMs) continue;

        if (recentlyRevealedDownloads.has(seenKey)) {
          downloadMonitorSeenFiles.set(seenKey, stats.mtimeMs);
          continue;
        }

        if (!(await waitForStableDownloadFile(filePath, 5_000))) continue;

        let stableStats;
        try {
          stableStats = statSync(filePath);
        } catch {
          continue;
        }
        if (!stableStats.isFile() || !isRevealableDownloadPath(filePath)) continue;

        downloadMonitorSeenFiles.set(seenKey, stableStats.mtimeMs);
        console.log(`[Browser] Download folder monitor opening containing folder (${profileKey}): ${filePath}`);
        revealFileInFolder(filePath);
      }
    } finally {
      const monitorAfterScan = downloadFolderMonitors.get(monitorKey);
      if (monitorAfterScan) monitorAfterScan.scanning = false;
    }
  }

  const timer = setInterval(() => {
    scan().catch(error => {
      console.warn('[Browser] Download folder monitor scan failed:', error);
    });
  }, 1_500);

  downloadFolderMonitors.set(monitorKey, { timer, scanning: false });
  console.log(`[Browser] Watching download folder for ${profileKey}: ${downloadDir}`);
  scan().catch(error => {
    console.warn('[Browser] Download folder monitor scan failed:', error);
  });
}

function attachDownloadAutoReveal(page: Page): void {
  if (downloadRevealPages.has(page)) return;
  downloadRevealPages.add(page);

  page.on('download', async download => {
    const startedAt = Date.now();
    try {
      const saved = await resolveBrowserDownload(page, download, startedAt, 30_000);
      console.log('[Browser] Download finished, opening containing folder:', saved.filePath);
      revealFileInFolder(saved.filePath);
    } catch (error) {
      console.warn('[Browser] Could not auto-open download folder:', error);
    }
  });
}

function attachContextDownloadAutoReveal(context: BrowserContext, downloadDir: string): void {
  contextDownloadDirs.set(context, downloadDir);
  for (const page of context.pages().filter(page => !page.isClosed())) {
    attachDownloadAutoReveal(page);
  }

  if (downloadRevealContexts.has(context)) return;
  downloadRevealContexts.add(context);
  context.on('page', page => {
    attachDownloadAutoReveal(page);
    setBrowserDownloadBehavior(page, downloadDir).catch(() => {});
    fitBrowserWindowToDesktop(page).catch(() => {});
  });
}

interface LaunchOpts {
  /** Per-member, per-bank id used to namespace the browser profile. */
  profileKey: string;
}

export async function launchSession(opts: LaunchOpts): Promise<{ context: BrowserContext; page: Page }> {
  const downloadDir = getBrowserDownloadDir(opts.profileKey);
  const windowBounds = getPreferredBrowserWindowBounds();
  const cached = sessionCache.get(opts.profileKey);
  if (cached) {
    try {
      const page = getMostRecentOpenPage(cached) || await cached.newPage();
      startDownloadFolderMonitor(downloadDir, opts.profileKey);
      attachContextDownloadAutoReveal(cached, downloadDir);
      await setBrowserDownloadBehavior(page, downloadDir);
      await fitBrowserWindowToDesktop(page);
      await page.bringToFront().catch(() => {});
      console.log(`[Browser] Reusing existing session for ${opts.profileKey}`);
      return { context: cached, page };
    } catch {
      sessionCache.delete(opts.profileKey);
    }
  }

  const profileDir = join(getBrowserProfilesBase(), opts.profileKey);
  if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true });
  ensureBrowserProfilePreferences(profileDir, downloadDir);
  const executablePath = getPreferredBrowserExecutablePath();

  if (executablePath) {
    console.log(`[Browser] Using installed browser: ${executablePath}`);
  } else {
    console.log('[Browser] No installed Chrome/Edge found; falling back to Playwright bundled Chromium.');
  }

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath: executablePath || undefined,
      headless: false,
      viewport: null,
      acceptDownloads: true,
      downloadsPath: downloadDir,
      timeout: 45_000,
      // Match a normal Chrome to reduce automation fingerprint
      args: [
        '--disable-blink-features=AutomationControlled',
        '--safebrowsing-disable-download-protection',
        '--no-first-run',
        '--no-default-browser-check',
        `--window-position=${windowBounds.left},${windowBounds.top}`,
        `--window-size=${windowBounds.width},${windowBounds.height}`,
      ]
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Browser] Launch failed for ${opts.profileKey}:`, message);

    const looksLikeMissingBrowser = /Executable doesn't exist|Failed to launch|browser revision|not found|spawn .* ENOENT/i.test(message);
    if (looksLikeMissingBrowser && !executablePath) {
      throw new Error(
        `Could not launch a browser. Install Google Chrome (or Microsoft Edge) on this machine, then try again. ` +
        `IPO Manager looks for chrome.exe / msedge.exe in Program Files and %LOCALAPPDATA%. ` +
        `(Underlying error: ${message})`
      );
    }
    throw new Error(`Could not open browser for ${opts.profileKey}. Close old IPO Manager Chrome windows and try again. ${message}`);
  }
  console.log(`[Browser] Launched ${executablePath ? basename(executablePath) : 'bundled Chromium'} for ${opts.profileKey}`);
  startDownloadFolderMonitor(downloadDir, opts.profileKey);
  attachContextDownloadAutoReveal(context, downloadDir);
  sessionCache.set(opts.profileKey, context);
  context.on('close', () => {
    if (sessionCache.get(opts.profileKey) === context) {
      sessionCache.delete(opts.profileKey);
    }
    stopDownloadFolderMonitor(downloadDir);
  });

  const page = getMostRecentOpenPage(context) || await context.newPage();
  await setBrowserDownloadBehavior(page, downloadDir);
  await fitBrowserWindowToDesktop(page);
  await page.bringToFront().catch(() => {});
  return { context, page };
}

export async function closeAllBrowserSessions(): Promise<number> {
  const contexts = Array.from(sessionCache.values());
  sessionCache.clear();
  await Promise.all(contexts.map(context => context.close().catch(() => {})));
  return contexts.length;
}

/**
 * Wipe ALL Playwright browser profiles on disk — closes any open contexts
 * first, then deletes the profile directories. After this, every bank /
 * broker login will require fresh credentials again.
 *
 * Called by:
 *   - vault:lock         (every time the vault locks, including auto-lock)
 *   - vault:reset        (factory reset)
 *   - automation:clearBrowserSessions (manual user purge)
 */
export async function purgeBrowserProfiles(): Promise<{ contextsClosed: number; profilesDeleted: number }> {
  const contextsClosed = await closeAllBrowserSessions();
  const base = getBrowserProfilesBase();
  let profilesDeleted = 0;
  try {
    if (existsSync(base)) {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const target = join(base, entry.name);
        try {
          rmSync(target, { recursive: true, force: true });
          profilesDeleted += 1;
        } catch (e) {
          // Profile dir may be locked if chromium is still releasing handles.
          // Try once more after a short wait, then give up — we'll get it on
          // the next lock.
          await new Promise(resolve => setTimeout(resolve, 250));
          try {
            rmSync(target, { recursive: true, force: true });
            profilesDeleted += 1;
          } catch { /* leave it for next time */ }
        }
      }
    }
  } catch { /* */ }
  return { contextsClosed, profilesDeleted };
}

export interface LoginCredentials {
  username: string;
  password: string;
  customerId?: string;
  totpSecret?: string;
}

export interface DownloadedBrokerReport {
  reportKind: string;
  asOfDate: string | null;
  fileName: string;
  filePath: string;
}

function isRenamedDuplicate(fileName: string, suggestedName: string): boolean {
  const expectedExt = extname(suggestedName).toLowerCase();
  const actualExt = extname(fileName).toLowerCase();
  if (expectedExt && actualExt !== expectedExt) return false;

  const expectedBase = basename(suggestedName, expectedExt).toLowerCase();
  const actualBase = basename(fileName, actualExt).toLowerCase();
  return actualBase === expectedBase || (actualBase.startsWith(`${expectedBase} (`) && actualBase.endsWith(')'));
}

async function waitForStableDownloadFile(filePath: string, timeoutMs: number): Promise<boolean> {
  let lastSize = -1;
  let stableSince = 0;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!existsSync(filePath)) {
      lastSize = -1;
      stableSince = 0;
      await new Promise(resolve => setTimeout(resolve, 200));
      continue;
    }

    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size <= 0) {
      lastSize = -1;
      stableSince = 0;
      await new Promise(resolve => setTimeout(resolve, 200));
      continue;
    }

    if (stats.size === lastSize && Date.now() - stats.mtimeMs >= 300) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= 900) return true;
    } else {
      lastSize = stats.size;
      stableSince = 0;
    }

    await new Promise(resolve => setTimeout(resolve, 200));
  }

  return false;
}

export async function resolveBrowserDownload(
  page: Page,
  download: Download,
  startedAt: number,
  timeoutMs = 15_000,
): Promise<{ filePath: string; fileName: string }> {
  const failure = await download.failure();
  if (failure && failure !== PLAYWRIGHT_ACCEPT_DOWNLOADS_MESSAGE) {
    throw new Error(`Download failed: ${failure}`);
  }

  const suggestedName = download.suggestedFilename() || 'download';
  const downloadDir = contextDownloadDirs.get(page.context());
  if (!downloadDir) {
    const fallbackPath = await download.path();
    if (!fallbackPath) throw new Error('Downloaded file path not available');
    return { filePath: fallbackPath, fileName: basename(fallbackPath) };
  }

  const cutoffTime = startedAt - 2_000;
  const deadline = Date.now() + timeoutMs;
  const exactPath = join(downloadDir, suggestedName);

  while (Date.now() < deadline) {
    if (existsSync(exactPath)) {
      const stats = statSync(exactPath);
      if (stats.isFile() && stats.mtimeMs >= cutoffTime) {
        const remaining = Math.max(1_000, Math.min(4_000, deadline - Date.now()));
        if (await waitForStableDownloadFile(exactPath, remaining)) {
          return { filePath: exactPath, fileName: basename(exactPath) };
        }
      }
    }

    const matches = readdirSync(downloadDir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => join(downloadDir, entry.name))
      .filter(filePath => !filePath.toLowerCase().endsWith('.crdownload'))
      .map(filePath => ({ filePath, name: basename(filePath), stats: statSync(filePath) }))
      .filter(entry => entry.stats.mtimeMs >= cutoffTime)
      .filter(entry => isRenamedDuplicate(entry.name, suggestedName))
      .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);

    if (matches.length) {
      const remaining = Math.max(1_000, Math.min(4_000, deadline - Date.now()));
      if (await waitForStableDownloadFile(matches[0].filePath, remaining)) {
        return { filePath: matches[0].filePath, fileName: matches[0].name };
      }
    }

    await new Promise(resolve => setTimeout(resolve, 250));
  }

  const fallbackPath = await download.path().catch(() => null);
  if (fallbackPath) return { filePath: fallbackPath, fileName: basename(fallbackPath) };
  throw new Error(`Could not resolve downloaded file for ${suggestedName}`);
}

export interface IpoBidDraft {
  issueName: string;
  brokerCode?: string | null;
  dematAccount?: string | null;
  debitAccountLast4?: string | null;
  investorCategory?: string | null;
  pan: string;
  quantity: number;
  lotSize?: number | null;
  bidType: 'CUTOFF' | 'LIMIT';
  enteredPrice?: number | null;
  effectivePrice: number;
  blockedAmount: number;
  /** Bank login credentials — passed through so the AU adapter can re-auth
   *  on the IPO subdomain (iposmart.au.bank.in) if it shows its own login. */
  username?: string;
  password?: string;
}

export interface PreparedIpoBidResult {
  pageUrl: string;
  readyToSubmit: boolean;
  blockedAmount: number;
  warnings: string[];
  detectedIssueName?: string | null;
  detectedDemat?: string | null;
  detectedAmount?: string | null;
}

export interface SubmittedIpoBidResult {
  pageUrl: string;
  bankReference: string | null;
  confirmationText?: string | null;
  warnings: string[];
}

export interface LoginAdapter {
  code: string;
  displayName: string;
  /**
   * 'email'  — OTP is fetched automatically from Gmail (default).
   * 'manual' — OTP is sent to the user's mobile; the app shows an input
   *            dialog so the user can type it in.
   * 'totp'   — Code is generated locally from the stored TOTP secret.
   */
  otpMode?: 'email' | 'manual' | 'totp';
  login(page: Page, creds: LoginCredentials, fetchOtp: () => Promise<string>): Promise<void>;
  /**
   * Optional: called immediately after a successful login to scrape the
   * available balance from whatever page the bank has landed on.
   * Returns a formatted string like "₹1,23,456.78" or null if not found.
   */
  fetchBalance?(page: Page): Promise<string | null>;
  downloadPortfolioReport?(
    page: Page,
    creds: LoginCredentials,
    fetchOtp: () => Promise<string>
  ): Promise<DownloadedBrokerReport | null>;
  prepareIpoBid?(page: Page, draft: IpoBidDraft): Promise<PreparedIpoBidResult>;
  submitPreparedIpoBid?(page: Page, draft: IpoBidDraft): Promise<SubmittedIpoBidResult>;
}
