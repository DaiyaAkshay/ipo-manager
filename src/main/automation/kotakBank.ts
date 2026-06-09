/**
 * Kotak Mahindra Bank NetBanking login adapter.
 *
 * Login URL  : https://netbanking.kotak.com/knb2/
 *
 * CONFIRMED FLOW (from DOM diagnostics):
 *   Step 1 — CRN page:
 *     • Active field : input#credentialInputField  (placeholder "CRN, Username or Card number")
 *     • "Next" button exists but is HIDDEN (visible:false). It is triggered by
 *       pressing Enter in the CRN field, NOT by a visible button click.
 *     • "Secure login" is visible but disabled at this step (no password yet).
 *   Step 2 — Password page (appears after Enter on CRN):
 *     • Password field appears in DOM
 *     • "Secure login" becomes enabled once password is valid
 *   Step 3 — OTP page
 *
 *   KEY FINDINGS:
 *   - fill() keeps Angular in ng-pristine — must use keyboard.type()
 *   - #userName is NOT the active field; typing there doesn't register
 *   - Enter key in CRN field triggers the hidden "Next" submission
 *
 * otpMode = 'email'
 */

import { Page, Locator } from 'playwright';
import { LoginAdapter, LoginCredentials } from './browser';

const LOGIN_URL = 'https://netbanking.kotak.com/knb2/';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function dumpInputs(page: Page, label: string): Promise<void> {
  const data = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLInputElement>('input')).map(i => {
      const rect = i.getBoundingClientRect();
      return {
        id: i.id,
        type: i.type,
        fcn: i.getAttribute('formcontrolname'),
        placeholder: i.placeholder,
        value: i.value ? `<${i.value.length}ch>` : '',
        visible: rect.width > 0 && rect.height > 0 && i.offsetParent !== null,
        cls: i.className,
      };
    })
  );
  console.log(`[Kotak] ${label}:`, JSON.stringify(data));
}

async function dumpButtons(page: Page, label: string): Promise<void> {
  const data = await page.evaluate(() => {
    const sel = 'button, [role="button"], input[type="submit"], input[type="button"]';
    return Array.from(document.querySelectorAll<HTMLElement>(sel)).map(el => {
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        text: ((el.textContent || '') + ((el as HTMLInputElement).value || '')).trim().replace(/\s+/g, ' ').slice(0, 80),
        cls: el.className,
        disabledAttr: el.hasAttribute('disabled'),
        visible: rect.width > 0 && rect.height > 0 && el.offsetParent !== null,
      };
    });
  });
  console.log(`[Kotak] ${label}:`, JSON.stringify(data));
}

/**
 * Type text into an Angular input that uses a custom ValueAccessor.
 * keyboard.type() fires real keydown/keypress/keyup events that Angular listens
 * to, flipping the field from ng-pristine to ng-dirty/ng-valid.
 */
async function typeIntoAngular(
  page: Page,
  selector: string,
  text: string,
  label: string,
): Promise<boolean> {
  try {
    const loc = page.locator(selector).first();
    await loc.waitFor({ state: 'visible', timeout: 10_000 });
    await loc.click();
    await page.waitForTimeout(150);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(100);
    await page.keyboard.type(text, { delay: 80 });
    await page.waitForTimeout(400);

    const dirty = await page.evaluate((sel: string) => {
      const el = document.querySelector<HTMLInputElement>(sel);
      return !!el && el.value.length > 0 && !el.className.includes('ng-pristine');
    }, selector);

    if (dirty) {
      console.log(`[Kotak] ✓ ${label} accepted by Angular`);
      return true;
    }
    console.log(`[Kotak] ! ${label}: typed but still ng-pristine`);
    return false;
  } catch (e: any) {
    console.warn(`[Kotak] ${label} typing failed:`, e?.message ?? e);
    return false;
  }
}

/**
 * Click a visible button-like element matching textRegex.
 * Tries normal → force → JS click in order.
 */
async function clickByText(page: Page, textRegex: RegExp, label: string): Promise<boolean> {
  const tagSelectors = [
    'button',
    '[role="button"]',
    'input[type="submit"]',
    'input[type="button"]',
  ];
  for (const tagSel of tagSelectors) {
    const loc = page.locator(tagSel).filter({ hasText: textRegex }).first();
    if (await loc.count().catch(() => 0) === 0) continue;
    if (!await loc.isVisible({ timeout: 500 }).catch(() => false)) continue;
    for (const [strategy, fn] of [
      ['normal',  () => loc.click({ timeout: 3000 })],
      ['force',   () => loc.click({ timeout: 3000, force: true })],
      ['JS',      () => loc.evaluate((el: HTMLElement) => el.click())],
    ] as const) {
      try {
        await fn();
        console.log(`[Kotak] ✓ ${strategy}-clicked "${label}" via ${tagSel}`);
        return true;
      } catch {}
    }
  }
  return false;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export const kotakAdapter: LoginAdapter = {
  code: 'KOTAK',
  displayName: 'Kotak Mahindra Bank',
  otpMode: 'email',

  async login(page: Page, creds: LoginCredentials, fetchOtp: () => Promise<string>): Promise<void> {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(2500);

    const crn = creds.customerId || creds.username;

    // ── Step 1: Enter CRN ────────────────────────────────────────────────────
    // The active field is #credentialInputField. #userName is in the DOM but
    // its Angular form is inactive — typing there doesn't register.
    const crnOk = await typeIntoAngular(
      page,
      'input#credentialInputField',
      crn,
      'CRN',
    );

    if (!crnOk) {
      console.warn('[Kotak] CRN not accepted. ⏳ Please type CRN manually, then press Enter.');
    }

    await dumpInputs(page, 'After CRN entry');
    await dumpButtons(page, 'Buttons after CRN entry');

    // ── Step 1b: Submit CRN via Enter key ─────────────────────────────────────
    // The "Next" button is HIDDEN (visible:false). Pressing Enter in the CRN
    // field triggers the same Angular form action, sending CRN to the server.
    if (crnOk) {
      await page.keyboard.press('Enter');
      console.log('[Kotak] ✓ Pressed Enter to submit CRN');
      await page.waitForTimeout(2000);
    } else {
      console.warn('[Kotak] Waiting up to 90s for manual CRN entry + Enter…');
    }

    // ── Step 2: Wait for password field ──────────────────────────────────────
    // After CRN is validated server-side, the password field appears on the
    // same page (Angular conditional rendering). Give 90s to cover manual flow.
    const PASSWORD_SEL = [
      'input[type="password"]',
      'input[formcontrolname="password"]',
      'input[id*="pass" i]',
      'input[placeholder*="Password" i]',
    ].join(', ');

    let passVisible = false;
    try {
      await page.locator(PASSWORD_SEL).first().waitFor({ state: 'visible', timeout: 90_000 });
      passVisible = true;
      console.log('[Kotak] ✓ Password field appeared');
    } catch {
      console.warn('[Kotak] Password field never appeared within 90s.');
    }

    await dumpInputs(page, 'After Enter / before password');
    await dumpButtons(page, 'Buttons before password entry');

    if (!passVisible) {
      console.warn('[Kotak] Skipping to OTP detection — complete steps manually if needed.');
    } else {
      // ── Step 2b: Enter password ─────────────────────────────────────────────
      const passOk = await typeIntoAngular(page, PASSWORD_SEL, creds.password, 'Password');

      await dumpInputs(page, 'After password entry');
      await dumpButtons(page, 'Buttons after password entry');

      if (!passOk) {
        console.warn('[Kotak] Password not accepted. ⏳ Please type password manually, then click "Secure login".');
      } else {
        // ── Step 2c: Click "Secure login" ────────────────────────────────────
        await page.waitForTimeout(400);
        const loginClicked = await clickByText(page, /Secure\s*login/i, 'Secure login');
        if (!loginClicked) {
          console.warn('[Kotak] Could not click "Secure login". ⏳ Please click it manually.');
        }
      }
    }

    // ── Step 3: Wait for OTP screen (up to 3 minutes) ────────────────────────
    const OTP_SEL = [
      'input[name="otp"]',
      'input[name="OTP"]',
      'input[formcontrolname="otp"]',
      'input[formcontrolname="OTP"]',
      'input[id*="otp" i]',
      'input[placeholder*="OTP" i]',
      'input[placeholder*="One Time" i]',
      'input[maxlength="6"][type="text"]',
      'input[maxlength="6"][type="number"]',
      'input[maxlength="6"][type="tel"]',
    ].join(', ');

    let otpLoc: Locator | null = null;
    try {
      const loc = page.locator(OTP_SEL).first();
      await loc.waitFor({ state: 'visible', timeout: 3 * 60_000 });
      otpLoc = loc;
      console.log('[Kotak] ✓ OTP screen detected');
    } catch {
      console.warn('[Kotak] OTP screen did not appear within 3 minutes.');
      return;
    }

    // ── Step 4: Fill OTP ──────────────────────────────────────────────────────
    try {
      const otp = await fetchOtp();
      console.log('[Kotak] ✓ OTP received');
      await otpLoc!.click({ timeout: 3000 }).catch(() => {});
      await page.keyboard.type(otp, { delay: 80 });
      await page.waitForTimeout(400);

      const submitted = await clickByText(page, /Submit|Verify|Confirm|Proceed/i, 'OTP Submit');
      if (!submitted) await page.keyboard.press('Enter');
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (msg.includes('OTP_TIMEOUT') || msg.includes('OTP_CANCELLED')) {
        console.warn('[Kotak] OTP entry was cancelled or timed out.');
      } else {
        console.warn('[Kotak] OTP step failed:', msg);
      }
    }

    console.log('[Kotak] Browser remains open for IPO application.');
  },

  async fetchBalance(page: Page): Promise<string | null> {
    try {
      await page.waitForTimeout(3000);
      const balance = await page.evaluate((): string | null => {
        const text = (document.body as HTMLElement).innerText || '';
        for (const re of [
          /Available\s+Balance[\s\S]{0,40}?₹?\s*([\d,]+\.\d{2})/i,
          /Avail(?:able)?\.?\s*Bal(?:ance)?\.?[\s\S]{0,40}?₹?\s*([\d,]+\.\d{2})/i,
          /₹\s*([\d,]+\.\d{2})/,
          /Rs\.?\s*([\d,]+\.\d{2})/i,
        ]) {
          const m = text.match(re);
          if (m?.[1]) return '₹' + m[1];
        }
        return null;
      });
      if (balance) console.log('[Kotak] ✓ Balance fetched:', balance);
      return balance;
    } catch (e: any) {
      console.warn('[Kotak] Balance fetch error:', e?.message ?? e);
      return null;
    }
  },
};
