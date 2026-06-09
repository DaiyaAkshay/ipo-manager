let lastActivity = Date.now();
let activeAutomationCount = 0;

export const AUTOLOCK_MS = 30 * 60 * 1000;

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

export function shouldAutolock(now = Date.now()): boolean {
  if (activeAutomationCount > 0) return false;
  return now - lastActivity > AUTOLOCK_MS;
}
