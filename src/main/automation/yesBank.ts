/**
 * YES Bank NetBanking login adapter.
 *
 * Login URL  : https://yesonline.yes.bank.in/  (RBI .bank.in domain). The old
 *              netbanking.yesbank.in stopped resolving (verified 2026-09-26).
 *              The page is an Oracle JET app that redirects itself to
 *              index.html?module=login after load.
 * Login ID   : input[name="username"]  (id "login_username|input", visible)
 * Password   : input[name="password"]  (id "login_password|input", visible)
 * Submit     : "LOGIN" button
 *
 * Checked live 2026-10-08: the page also carries HIDDEN autofill decoys
 * #username / #password (class "hide"). They come first in the DOM, so a broad
 * selector + .first() picked the hidden box and the Login ID was never typed.
 * Every locator here is restricted to :visible for that reason.
 *
 * After submit YES Bank sends an OTP to the registered email (and mobile).
 * This adapter fetches the OTP from Gmail automatically.
 *
 * otpMode = 'email'  (default)
 */

import { Locator, Page } from 'playwright';
import { otpOrManual } from './manualStep';
import { gotoFirstReachable, LoginAdapter, LoginCredentials } from './browser';

const LOGIN_URLS = ['https://yesonline.yes.bank.in/', 'https://netbanking.yesbank.in/'];

/**
 * Oracle JET inputs update their bound value on input/change and validate on
 * blur. fill() sets the value but some JET builds keep the old (empty) value
 * until a key event arrives, so type it and blur. Falls back to fill().
 */
async function typeIntoJet(field: Locator, value: string): Promise<void> {
  await field.click({ timeout: 5_000 }).catch(() => {});
  await field.fill('');
  await field.pressSequentially(value, { delay: 40 });
  if ((await field.inputValue().catch(() => '')) !== value) await field.fill(value);
  await field.dispatchEvent('change').catch(() => {});
  await field.blur().catch(() => {});
}

export const yesBankAdapter: LoginAdapter = {
  code: 'YES',
  displayName: 'YES Bank',
  otpMode: 'email',

  async login(page: Page, creds: LoginCredentials, fetchOtp: () => Promise<string>): Promise<void> {
    // ── Navigate ─────────────────────────────────────────────────────────────
    await gotoFirstReachable(page, LOGIN_URLS, { label: 'YES Bank' });
    // The JET shell redirects to ?module=login and renders the form late.
    await page.waitForURL(/module=login/i, { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // ── Fill Customer ID / Login ID ──────────────────────────────────────────
    try {
      const userField = page.locator([
        'input[name="username"]',
        'input[id^="login_username"]',
        'input#txtUserName',
        'input[name="txtUserName"]',
        'input[placeholder*="Customer ID" i]',
        'input[placeholder*="Login ID" i]',
        'input[name*="user" i]:not([type="hidden"])',
        'input[id*="user" i]:not([type="hidden"])',
      ].map(sel => `${sel}:visible`).join(', ')).first();
      await userField.waitFor({ state: 'visible', timeout: 20_000 });
      await typeIntoJet(userField, creds.username);
      console.log('[YES Bank] ✓ Login ID filled');
    } catch {
      console.warn('[YES Bank] Could not find username field — check selectors.');
    }

    // ── Fill Password ─────────────────────────────────────────────────────────
    try {
      const passField = page.locator([
        'input[name="password"]',
        'input[id^="login_password"]',
        'input#txtPassword',
        'input[type="password"]',
      ].map(sel => `${sel}:visible`).join(', ')).first();
      await passField.waitFor({ state: 'visible', timeout: 10_000 });
      await typeIntoJet(passField, creds.password);
      console.log('[YES Bank] ✓ Password filled');
    } catch {
      console.warn('[YES Bank] Could not find password field — check selectors.');
    }

    // ── Click Login ───────────────────────────────────────────────────────────
    try {
      const submitBtn = page.locator([
        'button:has-text("LOGIN"):visible',
        'button[type="submit"]:visible',
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
      const otp = await otpOrManual(page, fetchOtp, 'YES Bank', otpField);
      if (!otp) {
        console.log('[YES Bank] OTP step finished in the browser (or timed out) — continuing.');
      } else {
        console.log(`[YES Bank] ✓ OTP received (${otp.length} digits)`);
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
        // Paise optional, but then Indian comma grouping is required, so a
        // whole-rupee balance ("₹2,00,000") is read while dates/account numbers aren't.
        const AMT = '(\\d{1,3}(?:,\\d{2,3})+(?:\\.\\d{1,2})?|\\d+\\.\\d{1,2})';
        const patterns: RegExp[] = [
          new RegExp(`Available\\s+Balance[\\s\\S]{0,40}?₹?\\s*${AMT}`, 'i'),
          new RegExp(`Avail(?:able)?\\.?\\s*Bal(?:ance)?\\.?[\\s\\S]{0,40}?₹?\\s*${AMT}`, 'i'),
          new RegExp(`₹\\s*${AMT}`),
          new RegExp(`Rs\\.?\\s*${AMT}`, 'i'),
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
