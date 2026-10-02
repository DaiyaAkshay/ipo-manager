import type { Page } from 'playwright';

/**
 * Helpers for the steps the user does by hand in the bank's Chrome window:
 * typing the CAPTCHA, and typing the OTP when it can't be read from Gmail.
 *
 * The app never solves CAPTCHAs and never shows its own OTP popup. Adapters
 * fill what they can, show a small banner in the bank page, and poll the page
 * until the user has finished the step, then carry on with their post-login
 * work (balance fetch etc.).
 *
 * Keep this module free of Electron imports so it stays unit-testable.
 */

/**
 * Error message prefix thrown by the `fetchOtp` callback when there is no
 * automatic OTP source (mobile-OTP banks, Gmail not connected / signed out).
 * Adapters treat it as "the user will type the OTP in the browser".
 */
export const MANUAL_OTP_ERROR = 'OTP_MANUAL';

export function isManualOtpError(error: unknown): boolean {
  const message = (error as any)?.message ?? String(error ?? '');
  return typeof message === 'string' && message.startsWith(MANUAL_OTP_ERROR);
}

const HINT_ID = '__ipo_manager_manual_hint__';

/**
 * Show (or replace) a non-blocking banner at the top of the bank page.
 * It ignores pointer events so it never blocks the page underneath.
 * Best-effort: a navigation or CSP error is swallowed.
 */
export async function showPageHint(page: Page, title: string, message: string): Promise<void> {
  if (page.isClosed()) return;
  await page.evaluate(({ id, title, message }) => {
    const existing = document.getElementById(id);
    if (existing && existing.getAttribute('data-msg') === `${title}|${message}`) return;
    existing?.remove();
    if (!document.body) return;
    const div = document.createElement('div');
    div.id = id;
    div.setAttribute('data-msg', `${title}|${message}`);
    div.style.cssText = [
      'position:fixed', 'top:10px', 'left:50%', 'transform:translateX(-50%)',
      'max-width:min(640px,92vw)', 'background:#1d4ed8', 'color:#fff',
      'padding:10px 18px', 'border-radius:10px', 'z-index:2147483647',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'font-size:13px', 'line-height:1.4', 'box-shadow:0 6px 20px rgba(0,0,0,0.35)',
      'pointer-events:none',
    ].join(';');
    const strong = document.createElement('div');
    strong.style.cssText = 'font-weight:700;font-size:14px';
    strong.textContent = title;
    const body = document.createElement('div');
    body.style.cssText = 'opacity:0.95;margin-top:2px';
    body.textContent = message;
    div.appendChild(strong);
    div.appendChild(body);
    document.body.appendChild(div);
  }, { id: HINT_ID, title, message }).catch(() => {});
}

export async function clearPageHint(page: Page): Promise<void> {
  if (page.isClosed()) return;
  await page.evaluate((id) => { document.getElementById(id)?.remove(); }, HINT_ID).catch(() => {});
}

export interface OtpOrManualOptions {
  /** Log prefix, e.g. "AU Bank". */
  label: string;
  /**
   * True once the page has moved past the OTP step (OTP field gone, or the
   * logged-in dashboard is showing). Must not throw.
   */
  isOtpStepDone: () => Promise<boolean>;
  /** Overall wait for the user to type the OTP in the browser. Default 5 min. */
  timeoutMs?: number;
  /** Poll interval. Default 1 s. */
  pollMs?: number;
  /** Banner text shown while waiting for the user. */
  hintMessage?: string;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Get the OTP automatically (Gmail / TOTP via `fetchOtp`) while watching the
 * page in case the user types it in the browser themselves.
 *
 * Returns the OTP when `fetchOtp` produced one before the page moved on — the
 * caller fills it. Returns null when the user completed the OTP step in the
 * browser, or when the wait timed out; either way the caller should continue
 * with its post-login steps (they have their own waits).
 *
 * `isOtpStepDone` must report true on two consecutive polls, so a field that
 * blinks out during a re-render isn't mistaken for a submitted OTP.
 */
export async function getOtpOrWaitForManualEntry(
  page: Page,
  fetchOtp: () => Promise<string>,
  opts: OtpOrManualOptions,
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const pollMs = opts.pollMs ?? 1_000;
  const hintMessage = opts.hintMessage
    ?? 'Type the OTP in this window and submit it. The app continues automatically.';

  type AutoResult = { otp: string } | { error: unknown };
  let auto: AutoResult | null = null;
  fetchOtp().then(
    (otp) => { auto = { otp }; },
    (error) => { auto = { error }; },
  );

  const deadline = Date.now() + timeoutMs;
  let doneStreak = 0;
  let reportedFailure = false;

  try {
    while (Date.now() < deadline) {
      if (page.isClosed()) return null;

      const settled = auto as AutoResult | null;
      if (settled && 'otp' in settled && settled.otp) return settled.otp;
      if (settled && !reportedFailure) {
        reportedFailure = true;
        const err = 'error' in settled ? settled.error : null;
        if (isManualOtpError(err)) {
          console.log(`[${opts.label}] No automatic OTP source — waiting for the OTP to be typed in the browser.`);
        } else {
          console.warn(`[${opts.label}] Automatic OTP fetch failed (${(err as any)?.message ?? err}) — waiting for the OTP to be typed in the browser.`);
        }
        await showPageHint(page, 'Enter the OTP here', hintMessage);
      } else if (reportedFailure) {
        // A navigation drops the banner; put it back (no-op if still there).
        await showPageHint(page, 'Enter the OTP here', hintMessage);
      }

      if (await opts.isOtpStepDone().catch(() => false)) {
        doneStreak += 1;
        if (doneStreak >= 2) {
          console.log(`[${opts.label}] OTP step completed in the browser.`);
          return null;
        }
      } else {
        doneStreak = 0;
      }

      await sleep(pollMs);
    }
    console.warn(`[${opts.label}] OTP step not completed within ${Math.round(timeoutMs / 1000)}s.`);
    return null;
  } finally {
    await clearPageHint(page);
  }
}

/**
 * Poll until `isDone` reports true (e.g. the CAPTCHA/login form has been
 * submitted by the user). Returns false on timeout or a closed page.
 */
export async function waitForManualStep(
  page: Page,
  isDone: () => Promise<boolean>,
  timeoutMs: number,
  pollMs = 800,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) return false;
    if (await isDone().catch(() => false)) return true;
    await sleep(pollMs);
  }
  return false;
}
