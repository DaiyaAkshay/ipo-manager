/**
 * SBI Internet Banking login adapter.
 *
 * LOGIN URL  : https://retail.sbi.bank.in/retail/login.htm
 *
 * Since 2026 that address redirects to the YONO SBI web login
 * (yonoretail.sbi.bank.in, Angular Material — verified live 2026-09-26):
 *   Username   : mat-form-field labelled "Username"      (input, maxlength 20)
 *   Password   : input[type="password"]                   (maxlength 20)
 *   CAPTCHA    : mat-form-field labelled "Enter Captcha"  (maxlength 5) — user fills
 *   Submit     : "Login" button — user clicks after typing the CAPTCHA
 * The mat-input-N ids are generated per load, so fields are found by label.
 *
 * The classic OnlineSBI page (a.login_button → input#username / input#label2 /
 * input#loginCaptchaValue) is still handled in case SBI serves it again.
 *
 * After login SBI shows a separate OTP page (mobile OTP only, no email).
 * The app pops an OTP dialog so the user can type it in from their phone.
 *
 * otpMode = 'manual' — skips Gmail polling; uses the in-app IPC dialog.
 */

import { Locator, Page } from 'playwright';
import { otpOrManual } from './manualStep';
import { LoginAdapter, LoginCredentials } from './browser';

const LOGIN_URL = 'https://retail.sbi.bank.in/retail/login.htm';

async function firstVisible(page: Page, selectors: string[], timeoutMs: number): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const selector of selectors) {
      const loc = page.locator(selector).first();
      if (await loc.isVisible().catch(() => false)) return loc;
    }
    await page.waitForTimeout(300);
  } while (Date.now() < deadline);
  return null;
}

const YONO_USERNAME = [
  'mat-form-field:has(mat-label:has-text("Username")) input',
  'input[formcontrolname*="user" i]',
  'input[type="text"][maxlength="20"]',
];
const YONO_CAPTCHA = [
  'mat-form-field:has(mat-label:has-text("Captcha")) input',
  'input[formcontrolname*="captcha" i]',
  'input[type="text"][maxlength="5"]',
];

export const sbiBankAdapter: LoginAdapter = {
  code: 'SBI',
  displayName: 'State Bank of India',
  otpMode: 'manual',

  async login(page: Page, creds: LoginCredentials, fetchOtp: () => Promise<string>): Promise<void> {
    // ── Navigate ──────────────────────────────────────────────────────────────
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(2500);

    const classic = await page.locator('a.login_button').first().isVisible().catch(() => false);
    let passwordField: Locator | null = null;

    if (classic) {
      // ── Classic OnlineSBI page ─────────────────────────────────────────────
      await page.locator('a.login_button').first().click().catch(() => {});
      console.log('[SBI] ✓ Clicked "CONTINUE TO LOGIN" (classic page)');
      const usernameField = await firstVisible(page, ['input#username'], 15_000);
      if (usernameField) {
        await usernameField.fill(creds.username);
        console.log('[SBI] ✓ Username filled');
      } else {
        console.warn('[SBI] Could not find username field (input#username).');
      }
      passwordField = await firstVisible(page, ['input#label2', 'input[type="password"]'], 10_000);
    } else {
      // ── YONO SBI web login ─────────────────────────────────────────────────
      let usernameField = await firstVisible(page, YONO_USERNAME, 8_000);
      if (!usernameField) {
        // Another login method may be pre-selected — switch to Username/Password.
        await page.locator('button:has-text("Username / Password"), button:has-text("Username/Password")')
          .first().click({ timeout: 3_000 }).catch(() => {});
        usernameField = await firstVisible(page, YONO_USERNAME, 12_000);
      }
      if (usernameField) {
        await usernameField.click().catch(() => {});
        await usernameField.fill(creds.username);
        console.log('[SBI] ✓ Username filled (YONO)');
      } else {
        console.warn('[SBI] Could not find the YONO username field — the page may have changed.');
      }
      passwordField = await firstVisible(page, ['input[type="password"]'], 10_000);
    }

    if (passwordField) {
      await passwordField.fill(creds.password);
      console.log('[SBI] ✓ Password filled');
    } else {
      console.warn('[SBI] Could not find the password field.');
    }

    // ── CAPTCHA — user must fill manually ────────────────────────────────────
    // Put the cursor in the CAPTCHA box so the user can just type and press Login.
    const captchaField = await firstVisible(page, classic ? ['input#loginCaptchaValue'] : YONO_CAPTCHA, 5_000);
    await captchaField?.focus().catch(() => {});
    console.log('[SBI] ⏳ Enter the CAPTCHA in the browser and click LOGIN…');

    // ── Wait until the user has submitted the login form ─────────────────────
    // Classic page: the URL leaves login.htm. YONO: the password field goes away
    // (OTP / dashboard replaces the login card). Up to 3 min for the CAPTCHA.
    try {
      if (classic) {
        await page.waitForFunction(() => !window.location.href.includes('login.htm'), { timeout: 180_000 });
      } else {
        await page.waitForFunction(() => {
          const pw = document.querySelector<HTMLInputElement>('input[type="password"]');
          const rect = pw?.getBoundingClientRect();
          return !pw || !rect || rect.width === 0 || rect.height === 0;
        }, { timeout: 180_000 });
      }
      console.log('[SBI] ✓ Login form submitted, URL:', page.url());
    } catch {
      console.warn('[SBI] Still on the login page after 3 min — login may have failed.');
      return;
    }

    // After the login form is submitted, wait for an OTP input to appear
    try {
      const otpField = page.locator([
        'mat-form-field:has(mat-label:has-text("OTP")) input',
        'input[formcontrolname*="otp" i]',
        'input[name="txnAuthCode"]',
        'input[name="otp"]',
        'input[name="OTP"]',
        'input[id*="otp" i]',
        'input[id*="auth" i][maxlength]',
        'input[placeholder*="OTP" i]',
        'input[maxlength="6"][type="text"]',
        'input[maxlength="6"][type="number"]',
        'input[maxlength="6"][type="tel"]',
        'input[maxlength="6"][type="password"]',
      ].join(', ')).first();

      await otpField.waitFor({ state: 'visible', timeout: 30_000 });
      console.log('[SBI] ✓ OTP page detected — requesting OTP from user…');

      // ── Step 6: OTP from Gmail, or wait for the user to type it ────────────
      const otp = await otpOrManual(page, fetchOtp, 'SBI', otpField);
      if (!otp) {
        console.log('[SBI] OTP step finished in the browser (or timed out) — continuing.');
      } else {
        console.log('[SBI] ✓ OTP received');
        await otpField.clear();
        await otpField.fill(otp);

        // ── Step 7: Submit OTP ───────────────────────────────────────────────
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
        // Paise optional, but then Indian comma grouping is required, so a
        // whole-rupee balance ("₹2,00,000") is read while dates/account numbers aren't.
        const AMT = '(\\d{1,3}(?:,\\d{2,3})+(?:\\.\\d{1,2})?|\\d+\\.\\d{1,2})';
        const patterns: RegExp[] = [
          new RegExp(`Available\\s+Balance[\\s\\S]{0,40}?₹?\\s*${AMT}`, 'i'),
          new RegExp(`Avail(?:able)?\\.?\\s*Bal(?:ance)?\\.?[\\s\\S]{0,40}?₹?\\s*${AMT}`, 'i'),
          new RegExp(`Clear\\s+Balance[\\s\\S]{0,40}?₹?\\s*${AMT}`, 'i'),
          new RegExp(`₹\\s*${AMT}`),          // first ₹ amount
          new RegExp(`Rs\\.?\\s*${AMT}`, 'i'), // "Rs." prefix variant
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
