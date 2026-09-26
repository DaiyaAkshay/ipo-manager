import { Page } from 'playwright';
import { gotoFirstReachable, LoginAdapter, LoginCredentials } from './browser';

// web.fyers.in stopped resolving (verified 2026-09-26). trade.fyers.in redirects
// to login.fyers.in, which offers "Mobile number" (#mobile-code, tel) or
// "Client ID" (#fy_client_id) via the loginType radios, then Continue → OTP/PIN.
const LOGIN_URLS = ['https://trade.fyers.in/', 'https://login.fyers.in/'];

export const fyersAdapter: LoginAdapter = {
  code: 'FYERS',
  displayName: 'Fyers',
  otpMode: 'manual',

  async login(page: Page, creds: LoginCredentials): Promise<void> {
    await gotoFirstReachable(page, LOGIN_URLS, { label: 'Fyers' });
    await page.waitForTimeout(2000);

    // A 10-digit number is a mobile login; anything else is a Fyers client ID.
    const id = (creds.customerId || creds.username || '').trim();
    const isMobile = /^\d{10}$/.test(id);

    try {
      await page.locator(isMobile ? '#mobile_rb' : '#clientId_rb').first().check({ timeout: 3_000 }).catch(async () => {
        await page.locator(isMobile ? 'button:has-text("Login with mobile number")' : 'button:has-text("Login with client ID")')
          .first().click({ timeout: 3_000 }).catch(() => {});
      });
      const field = page.locator(isMobile
        ? '#mobile-code, input[type="tel"]'
        : '#fy_client_id, input[name*="client" i], input[id*="client" i]').first();
      if (await field.isVisible().catch(() => false)) {
        await field.fill(id);
        console.log(`[Fyers] ✓ ${isMobile ? 'Mobile number' : 'Client ID'} filled`);
        await page.locator('button:has-text("Continue")').first().click({ timeout: 3_000 }).catch(() => {});
      } else {
        console.warn('[Fyers] Login field not found — the page may have changed. Continue manually.');
      }
    } catch {}

    // Older/alternate flows show a password/PIN field on the same page.
    try {
      const passField = page.locator('input[type="password"], input[name*="pin" i], input[id*="pin" i]').first();
      if (creds.password && await passField.isVisible().catch(() => false)) {
        await passField.fill(creds.password);
      }
    } catch {}

    console.log('[Fyers] Credentials filled where possible. Complete the OTP/PIN step manually.');
    console.log('[Fyers] Browser remains open for IPO application.');
  },
};
