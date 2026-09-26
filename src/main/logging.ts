import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from './db/connection';

// Cap the automation log so it can't grow without bound. When it crosses the
// cap we rotate it to a single `.1` backup (overwriting any previous backup),
// so at most ~2× MAX_LOG_BYTES of log ever sits on disk.
const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2 MB

function ensureLogDir(): string {
  const dir = join(getDataDir(), 'logs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function getAutomationLogPath(): string {
  return join(ensureLogDir(), 'automation.log');
}

function rotateIfNeeded(logPath: string): void {
  try {
    if (!existsSync(logPath)) return;
    if (statSync(logPath).size < MAX_LOG_BYTES) return;
    const backup = `${logPath}.1`;
    try { rmSync(backup, { force: true }); } catch { /* */ }
    renameSync(logPath, backup);
  } catch {
    // Rotation is best-effort — never let it break logging.
  }
}

export function appendAutomationLog(scope: string, message: string): void {
  const line = `[${new Date().toISOString()}] [${scope}] ${message}\n`;
  try {
    const logPath = getAutomationLogPath();
    rotateIfNeeded(logPath);
    appendFileSync(logPath, line, 'utf8');
  } catch {
    // Logging must never break automation.
  }
}

/**
 * Mask things that shouldn't sit in a plaintext log: URL query strings (login
 * redirects can carry request tokens), long digit runs (mobile / account /
 * card numbers — last 4 kept) and the local part of email addresses.
 */
export function redactLogText(text: string): string {
  return text
    .replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g, '$1?…')
    .replace(/\b\d{8,}\b/g, digits => `••••${digits.slice(-4)}`)
    .replace(/\b([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, '$1***@$2');
}

let consoleMirrorInstalled = false;

/**
 * Persist main-process diagnostics. Most bank/broker adapters only use
 * console.*, which is lost in the installed app — so a failed SBI or Zerodha
 * login left no trace to debug. Mirror tagged console lines ("[Zerodha] …",
 * "[Sync] …", "[Gmail] …") into automation.log, redacted. Adapters never log
 * passwords/OTPs (only lengths), and redactLogText masks the rest.
 */
export function installConsoleMirror(): void {
  if (consoleMirrorInstalled) return;
  consoleMirrorInstalled = true;
  const TAGGED = /^\[[A-Za-z][\w .&/-]{0,40}\]/;
  const render = (args: unknown[]) => args.map(a => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        const text = render(args);
        if (TAGGED.test(text)) appendAutomationLog(level.toUpperCase(), redactLogText(text).slice(0, 2000));
      } catch { /* logging must never break the caller */ }
    };
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

/**
 * Wipe automation artifacts that may carry session-identifying content — the
 * CAPTCHA crops and login-page screenshots written by writeAutomationArtifact,
 * plus the rotated log backups. The login-page screenshots can show the typed
 * username, so leaving them unencrypted beside the locked vault defeats the
 * point of encryption-at-rest. Called on vault lock / reset / manual purge,
 * alongside purgeBrowserProfiles. Best-effort: never throws.
 */
export function purgeAutomationArtifacts(): { artifactsDeleted: number } {
  let artifactsDeleted = 0;
  try {
    const dir = join(getDataDir(), 'logs');
    if (!existsSync(dir)) return { artifactsDeleted };
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      // Delete screenshot artifacts and the rotated log backup. Keep the live
      // automation.log (it no longer contains secrets after redaction) so a
      // failure that just occurred is still inspectable this session.
      if (lower.endsWith('.png') || lower === 'automation.log.1') {
        try {
          rmSync(join(dir, entry.name), { force: true });
          artifactsDeleted += 1;
        } catch { /* leave it for next time */ }
      }
    }
  } catch {
    // Best-effort cleanup.
  }
  return { artifactsDeleted };
}
