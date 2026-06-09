import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getUserDownloadsDir(): string {
  if (process.env.IPO_REPORTS_DIR) return ensureDir(process.env.IPO_REPORTS_DIR);

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    const downloadsDir = app?.getPath?.('downloads');
    if (downloadsDir) return ensureDir(downloadsDir);
  } catch {
    // Fall back to the conventional Windows/macOS/Linux Downloads folder.
  }

  return ensureDir(join(homedir(), 'Downloads'));
}

export function getBrokerReportsBaseDir(): string {
  return getUserDownloadsDir();
}

export function getBrokerReportDir(_brokerCode: string, _memberId: number): string {
  return getBrokerReportsBaseDir();
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim();
}
