/**
 * YES Bank NetBanking login adapter.
 *
 * Login URL  : https://netbanking.yesbank.in/
 * Step 1     : input#txtUserName  (Customer ID / Login ID)
 * Password   : input#txtPassword
 * Submit     : button or input[type="submit"] on the form
 *
 * After submit YES Bank sends an OTP to the registered email (and mobile).
 * This adapter fetches the OTP from Gmail automatically.
 *
 * Selectors to verify: Open https://netbanking.yesbank.in/ in DevTools
 * and inspect the actual element IDs/names before first use.
 *
 * otpMode = 'email'  (default)
 */

import { Page } from 'playwright';
import { LoginAdapter, LoginCredentials } from './browser';

const LOGIN_URL = 'https://netbanking.yesbank.in/';

export const yesBankAdapter: LoginAdapter = {
  code: 'YES',
  displayName: 'YES Bank',
  otpMode: 'email',

  async login(page: Page, creds: LoginCredentials, fetchOtp: () => Promise<string>): Promise<void> {
    // ── Navigate ─────────────────────────────────────────────────────────────
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(2000);

    // ── Fill Customer ID / Login ID ──────────────────────────────────────────
    try {
      const userField = page.locator([
        'input#txtUserName',
        'input[name="txtUserName"]',
        'input[placeholder*="Customer ID" i]',
        'input[placeholder*="Login ID" i]',
        'input[placeholder*="User ID" i]',
        'input[type="text"]',
      ].join(', ')).first();
      await userField.waitFor({ state: 'visible', timeout: 15_000 });
      await userField.fill(creds.username);
      console.log('[YES Bank] ✓ Customer ID filled');
    } catch {
      console.warn('[YES Bank] Could not find username field — check selectors.');
    }

    // ── Fill Password ─────────────────────────────────────────────────────────
    try {
      const passField = page.locator([
        'input#txtPassword',
        'input[name="txtPassword"]',
        'input[type="password"]',
        'input[placeholder*="Password" i]',
      ].join(', ')).first();
      await passField.waitFor({ state: 'visible', timeout: 10_000 });
      await passField.fill(creds.password);
      console.log('[YES Bank] ✓ Password filled');
    } catch {
      console.warn('[YES Bank] Could not find password field — check selectors.');
    }

    // ── Click Login ───────────────────────────────────────────────────────────
    try {
      const submitBtn = page.locator([
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Login")',
        'button:has-text("LOG IN")',
        'a:has-text("Login")',
        '.btn-login',
        '#btnLogin',
      ].join(', ')).first();
      await submitBtn.waitFor({ state: 'visible', timeout: 10_000 });
      await submitBtn.click();
      console.log('[YES Bank] ✓ Login button clicked');
    } catch {
      console.warn('[YES Bank] Could not click login button — try pressing Enter manually.');
    }

    // ── Wait for OTP page ─────────────────────────────────────────────────────
    console.log('[YES Bank] ⏳ Waiting for OTP page…');
    const otpField = page.locator([
      'input[name="otp"]',
      'input[name="OTP"]',
      'input[id*="otp" i]',
      'input[placeholder*="OTP" i]',
      'input[placeholder*="one time" i]',
      'input[maxlength="6"][type="text"]',
      'input[maxlength="6"][type="number"]',
      'input[maxlength="6"][type="tel"]',
    ].join(', ')).first();

    try {
      await otpField.waitFor({ state: 'visible', timeout: 90_000 });
      console.log('[YES Bank] ✓ OTP page detected');
    } catch {
      console.warn('[YES Bank] OTP page did not appear — login may have failed or page structure changed.');
      return;
    }

    // ── Fetch OTP from Gmail ──────────────────────────────────────────────────
    try {
      const otp = await fetchOtp();
      console.log('[YES Bank] ✓ OTP received:', otp);
      await otpField.clear();
      await otpField.fill(otp);

      // ── Submit OTP ────────────────────────────────────────────────────────
      const submitOtpBtn = page.locator([
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Submit")',
        'button:has-text("Verify")',
        'button:has-text("Confirm")',
        'button:has-text("Proceed")',
      ].join(', ')).first();

      if (await submitOtpBtn.isVisible().catch(() => false)) {
        await submitOtpBtn.click();
        console.log('[YES Bank] ✓ OTP submitted');
      } else {
        await otpField.press('Enter');
        console.log('[YES Bank] ✓ Pressed Enter to submit OTP');
      }
    } catch (e: any) {
      const msg: string = e?.message ?? String(e);
      if (msg.includes('OTP_TIMEOUT') || msg.includes('OTP_CANCELLED')) {
        console.warn('[YES Bank] OTP entry was cancelled or timed out.');
      } else {
        console.warn('[YES Bank] OTP step failed:', msg);
      }
    }

    console.log('[YES Bank] Browser remains open for IPO application.');
  },

  async fetchBalance(page: Page): Promise<string | null> {
    try {
      await page.waitForTimeout(3000);
      const balance = await page.evaluate((): string | null => {
        const text = (document.body as HTMLElement).innerText || '';
        const patterns: RegExp[] = [
          /Available\s+Balance[\s\S]{0,40}?₹?\s*([\d,]+\.\d{2})/i,
          /Avail(?:able)?\.?\s*Bal(?:ance)?\.?[\s\S]{0,40}?₹?\s*([\d,]+\.\d{2})/i,
          /₹\s*([\d,]+\.\d{2})/,
          /Rs\.?\s*([\d,]+\.\d{2})/i,
        ];
        for (const re of patterns) {
          const m = text.match(re);
          if (m?.[1]) return '₹' + m[1];
        }
        return null;
      });
      if (balance) console.log('[YES Bank] ✓ Balance fetched:', balance);
      return balance;
    } catch (e: any) {
      console.warn('[YES Bank] Balance fetch error:', e?.message ?? e);
      return null;
    }
  },
};
