import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from './db/connection';

function ensureLogDir(): string {
  const dir = join(getDataDir(), 'logs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function getAutomationLogPath(): string {
  return join(ensureLogDir(), 'automation.log');
}

export function appendAutomationLog(scope: string, message: string): void {
  const line = `[${new Date().toISOString()}] [${scope}] ${message}\n`;
  try {
    appendFileSync(getAutomationLogPath(), line, 'utf8');
  } catch {
    // Logging must never break automation.
  }
}

export function writeAutomationArtifact(fileName: string, bytes: Buffer): string | null {
  try {
    const path = join(ensureLogDir(), fileName);
    writeFileSync(path, bytes);
    return path;
  } catch {
    return null;
  }
}
