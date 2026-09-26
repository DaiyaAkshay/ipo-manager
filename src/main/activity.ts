let lastActivity = Date.now();
let activeAutomationCount = 0;

export const AUTOLOCK_MS = 30 * 60 * 1000;
/**
 * While a bank/broker window is open the user may be working in it (it's a
 * separate Chromium window the inactivity timer can't see), so auto-lock —
 * which closes those windows — waits up to this long instead.
 */
export const AUTOLOCK_WITH_BROWSER_OPEN_MS = 2 * 60 * 60 * 1000;

export function markActivity(): void {
  lastActivity = Date.now();
}

export function beginAutomation(): void {
  activeAutomationCount += 1;
  markActivity();
}

export function endAutomation(): void {
  activeAutomationCount = Math.max(0, activeAutomationCount - 1);
  markActivity();
}

export function shouldAutolock(now = Date.now(), browserWindowOpen = false): boolean {
  if (activeAutomationCount > 0) return false;
  return now - lastActivity > (browserWindowOpen ? AUTOLOCK_WITH_BROWSER_OPEN_MS : AUTOLOCK_MS);
}

/** Read-only snapshot of the in-flight automation counter. */
export function activeAutomations(): number {
  return activeAutomationCount;
}
