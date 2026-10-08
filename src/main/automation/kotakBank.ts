/**
 * Kotak Mahindra Bank NetBanking login adapter.
 *
 * Login URL  : https://netbanking.kotak.bank.in/knb2/  (was netbanking.kotak.com)
 *
 * CURRENT FLOW (checked live 2026-10-08, single screen):
 *   • input#userName            label "CRN, Username or Card Number"
 *   • input#credentialInputField label "Password" — a type="text" box masked by
 *                                the apppasswordmask directive, so it is NOT an
 *                                input[type=password]
 *   • "Secure login" button, then OTP.
 *
 * The 2025 layout was two-step (CRN in #credentialInputField, Enter, then a
 * password box). On the new page that put the CRN into the password box and
 * waited for a password field that never comes — the 2026-10-03 failure.
 * The old path is kept as a fallback for when #userName is not visible.
 *
 *   - fill() leaves Angular inputs ng-pristine, so keys are typed.
 *
 * Kotak accounts in this app are loan / overdraft accounts: fetchBalance
 * returns "Withdrawable: ₹x | Outstanding: ₹y", and the dashboard keeps Kotak
 * out of the savings totals.
 *
 * otpMode = 'email'
 */

import { Page, Locator } from 'playwright';
import { otpOrManual } from './manualStep';
import { gotoFirstReachable, LoginAdapter, LoginCredentials } from './browser';
import { balanceLabelLines, formatKotakLoanBalance, parseKotakLoanText } from './kotakLoan';

// kotak.com currently redirects to the RBI .bank.in domain (verified
// 2026-09-26; #credentialInputField unchanged). Go there directly so the
// login keeps working once the old hostname is retired.
const LOGIN_URLS = ['https://netbanking.kotak.bank.in/knb2/', 'https://netbanking.kotak.com/knb2/'];

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

    // Accept "has a value and Angular no longer flags it invalid": Playwright
    // typing can leave the control ng-pristine while ng-valid (seen live).
    const dirty = await page.evaluate((sel: string) => {
      const el = document.querySelector<HTMLInputElement>(sel);
      if (!el || el.value.length === 0) return false;
      return !el.className.includes('ng-pristine') || el.className.includes('ng-valid');
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

/** 2025 layout: CRN in #credentialInputField, Enter, then a password box. */
async function legacyTwoStepLogin(page: Page, crn: string, password: string): Promise<void> {
  console.log('[Kotak] #userName not visible — using the older two-step login.');
  const crnOk = await typeIntoAngular(page, 'input#credentialInputField', crn, 'CRN');
  if (crnOk) {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
  } else {
    console.warn('[Kotak] CRN not accepted. ⏳ Please type CRN manually, then press Enter.');
  }

  const PASSWORD_SEL = [
    'input[type="password"]',
    'input[formcontrolname="password"]',
    'input[id*="pass" i]',
    'input[placeholder*="Password" i]',
  ].join(', ');
  try {
    await page.locator(PASSWORD_SEL).first().waitFor({ state: 'visible', timeout: 90_000 });
  } catch {
    console.warn('[Kotak] Password field never appeared within 90s.');
    await dumpInputs(page, 'Legacy flow, no password field');
    return;
  }
  const passOk = await typeIntoAngular(page, PASSWORD_SEL, password, 'Password');
  if (passOk) {
    await page.waitForTimeout(400);
    if (!await clickByText(page, /Secure\s*login/i, 'Secure login')) {
      console.warn('[Kotak] Could not click "Secure login". ⏳ Please click it manually.');
    }
  }
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export const kotakAdapter: LoginAdapter = {
  code: 'KOTAK',
  displayName: 'Kotak Mahindra Bank',
  otpMode: 'email',

  async login(page: Page, creds: LoginCredentials, fetchOtp: () => Promise<string>): Promise<void> {
    await gotoFirstReachable(page, LOGIN_URLS, { label: 'Kotak' });
    await page.waitForTimeout(2500);

    const crn = creds.customerId || creds.username;
    const singleScreen = await page.locator('input#userName').isVisible({ timeout: 5_000 }).catch(() => false);

    if (singleScreen) {
      // ── Current layout: CRN + password on one screen ──────────────────────
      const crnOk = await typeIntoAngular(page, 'input#userName', crn, 'CRN');
      const passOk = await typeIntoAngular(page, 'input#credentialInputField', creds.password, 'Password');
      await dumpInputs(page, 'After CRN + password');
      await dumpButtons(page, 'Buttons after CRN + password');

      if (!crnOk || !passOk) {
        console.warn('[Kotak] CRN or password not accepted. ⏳ Please fix the fields and click "Secure login".');
      } else {
        await page.waitForTimeout(400);
        const secure = page.locator('button').filter({ hasText: /Secure\s*login/i }).first();
        const enabled = await secure.isEnabled({ timeout: 3_000 }).catch(() => false);
        if (!(enabled && await clickByText(page, /Secure\s*login/i, 'Secure login'))) {
          console.warn('[Kotak] "Secure login" is still disabled — pressing Enter in the password box.');
          await page.locator('input#credentialInputField').press('Enter').catch(() => {});
        }
      }
    } else {
      await legacyTwoStepLogin(page, crn, creds.password);
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
      const otp = await otpOrManual(page, fetchOtp, 'Kotak', otpLoc!);
      if (!otp) {
        console.log('[Kotak] OTP step finished in the browser (or timed out) — continuing.');
      } else {
        console.log('[Kotak] ✓ OTP received');
        await otpLoc!.click({ timeout: 3000 }).catch(() => {});
        await page.keyboard.type(otp, { delay: 80 });
        await page.waitForTimeout(400);

        const submitted = await clickByText(page, /Submit|Verify|Confirm|Proceed/i, 'OTP Submit');
        if (!submitted) await page.keyboard.press('Enter');
      }
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
      // The dashboard fills its account tiles a moment after the OTP step.
      let text = '';
      for (let i = 0; i < 6; i += 1) {
        await page.waitForTimeout(2000);
        text = await page.evaluate(() => (document.body as HTMLElement).innerText || '').catch(() => '');
        const parsed = parseKotakLoanText(text);
        if (parsed.withdrawable && parsed.outstanding) break;
      }
      const loan = parseKotakLoanText(text);
      const balance = formatKotakLoanBalance(loan);
      if (balance) {
        console.log('[Kotak] ✓ Loan balance fetched:', balance);
        if (!loan.withdrawable || !loan.outstanding) {
          console.warn('[Kotak] Only part of the loan balance was found. Labels on page:', JSON.stringify(balanceLabelLines(text)));
        }
        return balance;
      }
      console.warn('[Kotak] No withdrawable/outstanding amount found. Labels on page:', JSON.stringify(balanceLabelLines(text)));
      return null;
    } catch (e: any) {
      console.warn('[Kotak] Balance fetch error:', e?.message ?? e);
      return null;
    }
  },
};
