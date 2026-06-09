import { Page } from 'playwright';
import { LoginAdapter, LoginCredentials } from './browser';

const LOGIN_URL = 'https://web.fyers.in/';

export const fyersAdapter: LoginAdapter = {
  code: 'FYERS',
  displayName: 'Fyers',
  otpMode: 'manual',

  async login(page: Page, creds: LoginCredentials): Promise<void> {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(2000);

    try {
      const userField = page.locator('input[type="text"], input[name*="user" i], input[id*="user" i], input[name*="client" i]').first();
      if (await userField.isVisible().catch(() => false)) {
        await userField.fill(creds.username);
      }
    } catch {}

    try {
      const passField = page.locator('input[type="password"], input[name*="pass" i], input[id*="pass" i], input[name*="pin" i]').first();
      if (await passField.isVisible().catch(() => false)) {
        await passField.fill(creds.password);
      }
    } catch {}

    console.log('[Fyers] Credentials filled where possible. Complete any OTP/CAPTCHA manually.');
    console.log('[Fyers] Browser remains open for IPO application.');
  },
};
