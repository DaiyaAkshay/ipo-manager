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
import { balanceLabelLines, formatKotakLoanBalance, parseKotakLoanText, sumWithdrawableCells } from './kotakLoan';

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

/** Click every visible "View balance" / eye toggle. Returns how many were clicked. */
async function revealKotakBalances(page: Page): Promise<number> {
  let clicked = 0;
  for (let pass = 0; pass < 6; pass += 1) {
    const target = page.locator('button, a, [role="button"], span, div')
      .filter({ hasText: /^\s*View\s+balance\s*$/i })
      .filter({ visible: true })
      .last(); // innermost match
    if (!(await target.count().catch(() => 0))) break;
    const ok = await target.click({ timeout: 3000 }).then(() => true).catch(() => false);
    if (!ok) break;
    clicked += 1;
    await page.waitForTimeout(1200);
  }
  if (clicked) console.log(`[Kotak] Clicked "View balance" ${clicked} time(s).`);
  return clicked;
}

async function waitForKotakAmounts(
  page: Page,
  readBody: () => Promise<string>,
  complete: (t: string) => boolean,
): Promise<string> {
  let text = '';
  for (let i = 0; i < 8; i += 1) {
    text = await readBody();
    if (complete(text)) break;
    await page.waitForTimeout(1000);
  }
  return text;
}

/**
 * Open Accounts/Deposits → "Savings / Current account" and sum the cells under
 * the "Withdrawable" heading. Column found by geometry (cells horizontally
 * under the heading, below it, in the same card), so it works for <table> and
 * div-based grids alike.
 */
async function readKotakWithdrawableColumn(page: Page): Promise<{ amount: string | null; pageText: string }> {
  const nav = page.getByText(/^\s*Accounts\s*\/\s*Deposits\s*$/i).first();
  if (await nav.isVisible({ timeout: 3000 }).catch(() => false)) {
    await nav.click({ timeout: 4000 }).catch(() => {});
    console.log('[Kotak] Opened Accounts/Deposits.');
    await page.waitForTimeout(2500);
  }
  const tab = page.getByText(/^\s*Savings\s*\/\s*Current\s+account\s*$/i).first();
  if (await tab.isVisible({ timeout: 3000 }).catch(() => false)) {
    await tab.click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  await revealKotakBalances(page);

  let cells: string[] = [];
  for (let i = 0; i < 8 && !cells.length; i += 1) {
    cells = await page.evaluate(() => {
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        const st = window.getComputedStyle(el as HTMLElement);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      const headers = Array.from(document.querySelectorAll<HTMLElement>('body *'))
        .filter(el => visible(el) && (el.innerText || '').trim().toLowerCase() === 'withdrawable');
      // Innermost header elements; take the lowest one on the page — the
      // Savings / Current table sits below the overdraft summary row.
      const header = headers
        .filter(h => !headers.some(o => o !== h && h.contains(o)))
        .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
      if (!header) return [];
      const hr = header.getBoundingClientRect();
      // Smallest ancestor that also holds something below the header.
      let box: HTMLElement | null = header.parentElement;
      while (box && box !== document.body) {
        if (box.getBoundingClientRect().bottom > hr.bottom + 20) break;
        box = box.parentElement;
      }
      const scope = box || document.body;
      const left = hr.left - 30, right = hr.right + 30;
      const out: string[] = [];
      for (const el of Array.from(scope.querySelectorAll<HTMLElement>('*'))) {
        if (!visible(el) || el.children.length > 0) continue;
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        if (r.top <= hr.bottom || cx < left || cx > right || r.top > hr.bottom + 600) continue;
        const t = (el.innerText || el.textContent || '').trim();
        if (t) out.push(t);
      }
      return out;
    }).catch(() => [] as string[]);
    if (!cells.length) await page.waitForTimeout(1000);
  }

  const amount = sumWithdrawableCells(cells);
  if (amount) console.log(`[Kotak] Withdrawable column: ${cells.length} cell(s) read.`);
  else console.warn(`[Kotak] Withdrawable column not read (${cells.length} cell(s) under the heading).`);
  const pageText = await page.evaluate(() => (document.body as HTMLElement).innerText || '').catch(() => '');
  return { amount, pageText };
}

/** Log what the page shows around balances, digits masked, so labels can be tuned. */
async function logKotakBalanceDiagnostics(page: Page, text: string, reason: string): Promise<void> {
  const nodes = await page.evaluate(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      if (el.children.length > 3) continue;
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 90 || seen.has(t)) continue;
      if (!/₹|rs\.?|inr|balance|outstanding|available|limit|loan|due|withdraw|overdraft|unavailable|amount/i.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      seen.add(t);
      out.push(`${el.tagName.toLowerCase()}: ${t.replace(/\d/g, '#')}`);
      if (out.length >= 40) break;
    }
    return out;
  }).catch(() => [] as string[]);
  console.warn(`[Kotak] ${reason}. url=${page.url().replace(/[?#].*$/, '')}`);
  console.warn('[Kotak] Labels on page:', JSON.stringify(balanceLabelLines(text)));
  console.warn('[Kotak] Balance-related elements:', JSON.stringify(nodes));
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
      const readBody = () => page.evaluate(() => (document.body as HTMLElement).innerText || '').catch(() => '');
      const complete = (t: string) => { const p = parseKotakLoanText(t); return !!(p.withdrawable && p.outstanding); };

      // The dashboard fills its tiles a moment after the OTP step.
      let text = '';
      for (let i = 0; i < 4; i += 1) {
        await page.waitForTimeout(2000);
        text = await readBody();
        if (complete(text) || /view\s+balance/i.test(text)) break;
      }

      // Amounts are masked behind "View balance" (seen 2026-10-08: the page
      // showed only "Loans", "Unavailable", "View balance").
      if (!complete(text)) {
        const clicked = await revealKotakBalances(page);
        if (clicked) text = await waitForKotakAmounts(page, readBody, complete);
      }

      // Outstanding: the overdraft's negative balance on the dashboard
      // (confirmed correct by the owner 2026-10-08).
      // Withdrawable: Accounts/Deposits → "Savings / Current account" table,
      // "Withdrawable" column (plain "815567.96", no ₹/commas). Read by column
      // position — the text matcher would grab the account number there.
      const dashboard = parseKotakLoanText(text);
      let withdrawable = dashboard.withdrawable;
      let accountsText = '';
      if (!withdrawable) {
        const res = await readKotakWithdrawableColumn(page);
        withdrawable = res.amount;
        accountsText = res.pageText;
      }

      const loan = { withdrawable, outstanding: dashboard.outstanding };
      if (accountsText && !loan.withdrawable) text = accountsText; // diagnose the page we ended on
      const balance = formatKotakLoanBalance(loan);
      if (balance) {
        console.log('[Kotak] ✓ Loan balance fetched:', balance);
        if (!loan.withdrawable || !loan.outstanding) await logKotakBalanceDiagnostics(page, text, 'Only part of the loan balance was found');
        return balance;
      }
      await logKotakBalanceDiagnostics(page, text, 'No withdrawable/outstanding amount found');
      return null;
    } catch (e: any) {
      console.warn('[Kotak] Balance fetch error:', e?.message ?? e);
      return null;
    }
  },
};
