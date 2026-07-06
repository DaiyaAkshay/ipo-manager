import { Page } from 'playwright';
import { LoginAdapter, LoginCredentials } from './browser';

// Upstox web trading terminal. Visiting it unauthenticated redirects to the
// Upstox login flow (mobile number → OTP → PIN/DOB, 2-factor). IPO applications
// are placed from within the logged-in terminal.
const LOGIN_URL = 'https://pro.upstox.com/';

export const upstoxAdapter: LoginAdapter = {
  code: 'UPSTOX',
  displayName: 'Upstox',
  // Upstox sends a one-time password to the client's registered mobile at
  // login (2-factor). We can't read that from Gmail, so the app prompts the
  // user to type it in — same as the other broker terminals.
  otpMode: 'manual',

  async login(page: Page, creds: LoginCredentials): Promise<void> {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(2_000);

    // ── Mobile number / User ID ───────────────────────────────────────────────
    // Upstox logs in with the registered mobile number (or client id). Fill the
    // first visible, non-password field; best-effort, never throw if the markup
    // differs from what we expect.
    try {
      const userField = page.locator(
        'input[type="tel"], input[name*="mobile" i], input[id*="mobile" i], ' +
        'input[name*="phone" i], input[id*="phone" i], ' +
        'input[name*="user" i], input[id*="user" i], ' +
        'input[name*="client" i], input[id*="client" i], ' +
        'input[placeholder*="mobile" i], input[placeholder*="phone" i], input[placeholder*="user" i], ' +
        'input[type="text"]'
      ).first();
      if (await userField.isVisible().catch(() => false)) {
        await userField.fill(creds.username);
        console.log('[Upstox] Filled mobile number / user id.');
      }
    } catch { /* markup may differ — user completes manually */ }

    // ── Password / PIN ────────────────────────────────────────────────────────
    // Upstox's flow often shows the PIN/password only after the OTP step, so
    // this fills it if a field is already present; otherwise the user does it.
    try {
      const passField = page.locator(
        'input[type="password"], input[name*="pass" i], input[id*="pass" i], ' +
        'input[name*="pin" i], input[id*="pin" i]'
      ).first();
      if (await passField.isVisible().catch(() => false)) {
        await passField.fill(creds.password);
        console.log('[Upstox] Filled password / PIN.');
      }
    } catch { /* user completes manually */ }

    console.log('[Upstox] Credentials filled where possible. Complete OTP/PIN and login manually.');
    console.log('[Upstox] Browser remains open for the IPO application.');
  },
};
