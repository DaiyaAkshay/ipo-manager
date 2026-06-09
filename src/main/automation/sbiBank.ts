/**
 * SBI Internet Banking login adapter.
 *
 * Verified selectors (inspected live via Playwright on retail.sbi.bank.in):
 *
 *   LOGIN URL  : https://retail.sbi.bank.in/retail/login.htm
 *   Step 1     : click  a.login_button  ("CONTINUE TO LOGIN")
 *   Username   : input#username          (name="userName")
 *   Password   : input#label2            (name="password", type="password")
 *   CAPTCHA    : input#loginCaptchaValue  — user fills manually
 *   Submit     : input#Button2           (type="submit")
 *
 * After login SBI shows a separate OTP page (mobile OTP only, no email).
 * The app pops an OTP dialog so the user can type it in from their phone.
 *
 * otpMode = 'manual' — skips Gmail polling; uses the in-app IPC dialog.
 */

import { Page } from 'playwright';
import { LoginAdapter, LoginCredentials } from './browser';

const LOGIN_URL = 'https://retail.sbi.bank.in/retail/login.htm';

export const sbiBankAdapter: LoginAdapter = {
  code: 'SBI',
  displayName: 'State Bank of India',
  otpMode: 'manual',

  async login(page: Page, creds: LoginCredentials, fetchOtp: () => Promise<string>): Promise<void> {
    // ── Navigate ──────────────────────────────────────────────────────────────
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(2000);

    // ── Step 1: Click "CONTINUE TO LOGIN" ────────────────────────────────────
    try {
      const continueBtn = page.locator('a.login_button').first();
      await continueBtn.waitFor({ state: 'visible', timeout: 15_000 });
      await continueBtn.click();
      console.log('[SBI] ✓ Clicked "CONTINUE TO LOGIN"');
    } catch {
      console.warn('[SBI] Could not find "CONTINUE TO LOGIN" button — the page structure may have changed.');
    }

    // ── Step 2: Fill username ─────────────────────────────────────────────────
    try {
      const usernameField = page.locator('input#username').first();
      await usernameField.waitFor({ state: 'visible', timeout: 15_000 });
      await usernameField.fill(creds.username);
      console.log('[SBI] ✓ Username filled');
    } catch {
      console.warn('[SBI] Could not find username field (input#username).');
    }

    // ── Step 3: Fill password ─────────────────────────────────────────────────
    try {
      const passwordField = page.locator('input#label2').first();
      await passwordField.waitFor({ state: 'visible', timeout: 10_000 });
      await passwordField.fill(creds.password);
      console.log('[SBI] ✓ Password filled');
    } catch {
      console.warn('[SBI] Could not find password field (input#label2).');
    }

    // ── Step 4: CAPTCHA — user must fill manually ─────────────────────────────
    // The CAPTCHA image is at input#loginCaptchaValue.
    // We leave the browser open; the user types the CAPTCHA and clicks LOGIN.
    console.log('[SBI] ⏳ Enter the CAPTCHA in the browser and click LOGIN…');

    // ── Step 5: Wait for OTP page ─────────────────────────────────────────────
    // After a correct login SBI navigates away from login.htm.
    // We watch for: URL change away from login.htm AND an OTP input appearing.
    // Known OTP field names used by SBI: txnAuthCode, otp, OTP
    try {
      // First wait for the page to move past login.htm (up to 2 min for CAPTCHA)
      await page.waitForFunction(
        () => !window.location.href.includes('login.htm'),
        { timeout: 120_000 }
      );
      console.log('[SBI] ✓ Navigated past login page, URL:', page.url());
    } catch {
      console.warn('[SBI] Still on login page after 2 min — login may have failed.');
      return;
    }

    // After leaving login.htm, wait for an OTP input to appear
    try {
      const otpField = page.locator([
        'input[name="txnAuthCode"]',
        'input[name="otp"]',
        'input[name="OTP"]',
        'input[id*="otp" i]',
        'input[id*="auth" i][maxlength]',
        'input[placeholder*="OTP" i]',
        'input[maxlength="6"][type="text"]',
        'input[maxlength="6"][type="number"]',
        'input[maxlength="6"][type="tel"]',
      ].join(', ')).first();

      await otpField.waitFor({ state: 'visible', timeout: 30_000 });
      console.log('[SBI] ✓ OTP page detected — requesting OTP from user…');

      // ── Step 6: Get OTP from in-app dialog ─────────────────────────────────
      const otp = await fetchOtp();   // resolves when user submits the dialog
      console.log('[SBI] ✓ OTP received');

      await otpField.clear();
      await otpField.fill(otp);

      // ── Step 7: Submit OTP ─────────────────────────────────────────────────
      const submitBtn = page.locator([
        'input[type="submit"]',
        'button[type="submit"]',
        'button:has-text("Submit")',
        'button:has-text("SUBMIT")',
        'button:has-text("Confirm")',
        'button:has-text("CONFIRM")',
        'button:has-text("Proceed")',
        'a:has-text("Submit")',
      ].join(', ')).first();

      if (await submitBtn.isVisible().catch(() => false)) {
        await submitBtn.click();
        console.log('[SBI] ✓ OTP submitted — login complete.');
      } else {
        await otpField.press('Enter');
        console.log('[SBI] ✓ Pressed Enter to submit OTP.');
      }

    } catch (e: any) {
      const msg: string = e?.message ?? String(e);
      if (msg.includes('OTP_TIMEOUT') || msg.includes('OTP_CANCELLED')) {
        console.warn('[SBI] OTP entry was cancelled or timed out.');
      } else {
        console.warn('[SBI] OTP step failed:', msg);
        console.warn('[SBI] You may need to enter the OTP manually in the browser.');
      }
    }

    console.log('[SBI] Browser remains open for IPO application.');
  },

  async fetchBalance(page: Page): Promise<string | null> {
    try {
      // Give SBI's post-login dashboard time to load fully
      await page.waitForTimeout(4000);

      const balance = await page.evaluate((): string | null => {
        const text = (document.body as HTMLElement).innerText || '';

        // SBI account summary page shows "Available Balance" per account.
        // We pick the first (typically savings account) available balance.
        const patterns: RegExp[] = [
          /Available\s+Balance[\s\S]{0,40}?₹?\s*([\d,]+\.\d{2})/i,
          /Avail(?:able)?\.?\s*Bal(?:ance)?\.?[\s\S]{0,40}?₹?\s*([\d,]+\.\d{2})/i,
          /Clear\s+Balance[\s\S]{0,40}?₹?\s*([\d,]+\.\d{2})/i,
          /₹\s*([\d,]+\.\d{2})/,          // first ₹ amount with paise
          /Rs\.?\s*([\d,]+\.\d{2})/i,     // "Rs." prefix variant
        ];

        for (const re of patterns) {
          const m = text.match(re);
          if (m?.[1]) return '₹' + m[1];
        }
        return null;
      });

      if (balance) {
        console.log('[SBI] ✓ Balance fetched:', balance);
      } else {
        console.log('[SBI] Balance not found on current page — may need more time to load.');
      }
      return balance;
    } catch (e: any) {
      console.warn('[SBI] Balance fetch error:', e?.message ?? e);
      return null;
    }
  }
};
