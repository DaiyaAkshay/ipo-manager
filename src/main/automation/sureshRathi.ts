import { Page } from 'playwright';
import { LoginAdapter, LoginCredentials } from './browser';

// Suresh Rathi Securities uses the Meon white-label ASBA/IPO portal for online
// IPO applications. This is the IPO-specific login (not the mSauda trading
// terminal), which is what matters for this app. If the user actually applies
// through a different Suresh Rathi portal, only this URL needs to change.
const LOGIN_URL = 'https://ipo.meon.co.in/sureshrathi';

export const sureshRathiAdapter: LoginAdapter = {
  code: 'SURESH',
  displayName: 'Suresh Rathi Securities',
  // Meon IPO portals send a one-time password to the client's registered
  // mobile/email at login — we can't read that from Gmail reliably, so the app
  // prompts the user to type it in (same as the other broker terminals).
  otpMode: 'manual',

  async login(page: Page, creds: LoginCredentials): Promise<void> {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(2_000);

    // ── Username / Client code / PAN ──────────────────────────────────────────
    // Meon logins label the first field variously as Client Code, User ID or
    // PAN. Fill the first visible, non-password text field with the stored
    // username; best-effort, never throw if the markup differs.
    try {
      const userField = page.locator(
        'input[name*="user" i], input[id*="user" i], ' +
        'input[name*="client" i], input[id*="client" i], ' +
        'input[name*="pan" i], input[id*="pan" i], ' +
        'input[placeholder*="client" i], input[placeholder*="user" i], input[placeholder*="pan" i], ' +
        'input[type="text"]'
      ).first();
      if (await userField.isVisible().catch(() => false)) {
        await userField.fill(creds.username);
        console.log('[Suresh Rathi] Filled username / client code.');
      }
    } catch { /* markup may differ — user completes manually */ }

    // ── Password ──────────────────────────────────────────────────────────────
    try {
      const passField = page.locator(
        'input[type="password"], input[name*="pass" i], input[id*="pass" i]'
      ).first();
      if (await passField.isVisible().catch(() => false)) {
        await passField.fill(creds.password);
        console.log('[Suresh Rathi] Filled password.');
      }
    } catch { /* user completes manually */ }

    console.log('[Suresh Rathi] Credentials filled where possible. Complete OTP/CAPTCHA and login manually.');
    console.log('[Suresh Rathi] Browser remains open for the IPO application.');
  },
};
