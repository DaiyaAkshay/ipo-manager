/**
 * Angel One login adapter — rewritten 2026-05-21.
 *
 * Login URL : https://trade.angelone.in/
 *
 * Flow (linear state machine):
 *   1. Goto LOGIN_URL  →  detect current step
 *   2. mobile → fill 10-digit number → Continue
 *   3. otp    → fetch from Gmail (6 digits) → fill boxes → auto/submit
 *   4. mpin   → fill 4 or 6 digit MPIN → Login
 *   5. dashboard
 *
 * `creds.username` = mobile, `creds.password` = MPIN. OTP via fetchOtp().
 *
 * Design choices vs. the old 1145-line adapter:
 *   - ONE step detector that examines the live DOM and returns
 *     'mobile' | 'otp' | 'mpin' | 'dashboard' | 'unknown'. Every state
 *     transition uses it; no parallel half-states.
 *   - Mobile/OTP/MPIN fillers use Playwright's `.or()` to merge several
 *     selectors into a single locator the engine retries internally —
 *     instead of looping through selectors ourselves and bailing on the
 *     first miss.
 *   - The page reference is the same throughout login unless the SPA
 *     opens a popup; only then do we hop to it via `findAngelPage`.
 *   - All step waits use a single `waitForStep` polling helper.
 */

import { Download, Page, Locator, BrowserContext } from 'playwright';
import { DownloadedBrokerReport, LoginAdapter, LoginCredentials, resolveBrowserDownload } from './browser';

const LOGIN_URL = 'https://trade.angelone.in/';

const ANGEL_PORTFOLIO_URLS = [
  'https://trade.angelone.in/portfolio',
  'https://trade.angelone.in/holdings',
  'https://trade.angelone.in/portfolio/holdings',
  'https://trade.angelone.in/investments/holdings',
];

// ─── Page resolution ──────────────────────────────────────────────────────

function safeUrl(page: Page): string {
  try { return page.url() || ''; } catch { return ''; }
}

/** Return the most recent open Angel page in this browser context, or the
 *  fallback if none. Brings the chosen page to the front. */
async function findAngelPage(context: BrowserContext, fallback: Page): Promise<Page> {
  const open = context.pages().filter(p => !p.isClosed());
  const angel = [...open].reverse().find(p => /angelone\.in/i.test(safeUrl(p)));
  const chosen = angel ?? (!fallback.isClosed() ? fallback : open[open.length - 1]);
  if (chosen && !chosen.isClosed()) {
    await chosen.bringToFront().catch(() => {});
  }
  return chosen ?? fallback;
}

// ─── Step detection ───────────────────────────────────────────────────────

type LoginStep = 'mobile' | 'otp' | 'mpin' | 'dashboard' | 'unknown';

/**
 * Optional hint to bias detection when the same DOM shape could be either
 * OTP or MPIN. After we just submitted OTP we know the next screen is MPIN
 * (or dashboard) — even if Angel's screen text doesn't say "MPIN" loudly.
 */
type StepHint = 'expect-mpin' | 'expect-otp' | null;

/** Examine the live DOM and return the current login step. */
async function detectStep(page: Page, hint: StepHint = null): Promise<LoginStep> {
  return page.evaluate((hint) => {
    const isVisible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const s = window.getComputedStyle(el as HTMLElement);
      return r.width > 1 && r.height > 1
        && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };

    const path = location.pathname + location.hash;
    const text = (document.body?.innerText || '').toLowerCase();

    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input'))
      .filter(i => isVisible(i) && i.type !== 'hidden' && !i.disabled);
    const attrsOf = (i: HTMLInputElement) => [
      i.type, i.name, i.id, i.placeholder, i.autocomplete,
      i.getAttribute('aria-label') || '', i.getAttribute('data-testid') || ''
    ].join(' ').toLowerCase();

    const mobileField = inputs.find(i => {
      const a = attrsOf(i);
      return /mobile|phone|^tel$|tel /.test(a)
        || (i.type === 'tel')
        || (i.maxLength === 10 && (i.type === 'text' || i.type === 'tel' || i.type === 'number'));
    });

    // Digit-box candidates: explicit maxlength=1, OR very small width inputs
    // (Angel sometimes ships OTP/MPIN boxes without maxlength set explicitly),
    // OR `autocomplete="one-time-code"` (standards-compliant OTP attribute).
    const digitBoxes = inputs.filter(i => {
      if (i.maxLength === 1) return true;
      if ((i.getAttribute('autocomplete') || '').toLowerCase() === 'one-time-code') return true;
      const r = i.getBoundingClientRect();
      if (r.width > 0 && r.width <= 60 && r.height >= 28 && r.height <= 80
          && (i.type === 'text' || i.type === 'tel' || i.type === 'number' || i.type === 'password' || !i.type)
          && (i.value === '' || /^\d?$/.test(i.value))) {
        const a = attrsOf(i);
        if (!/mobile|phone|email|user|^name$|search/.test(a)) return true;
      }
      return false;
    });
    const passwordField = inputs.find(i => i.type === 'password');
    const otpAttrInput = inputs.find(i => {
      const a = attrsOf(i);
      return /\botp\b|one[\s-]?time|verification\s*code|email\s*code/.test(a)
        || (i.getAttribute('autocomplete') || '').toLowerCase() === 'one-time-code';
    });
    const mpinAttrInput = inputs.find(i => {
      const a = attrsOf(i);
      return /\bm[\s-]?pin\b|trading[\s-]?pin|transaction[\s-]?pin|login[\s-]?pin/.test(a)
        || i.type === 'password';
    });

    // STRONG signals (unambiguous).
    const hasStrongOtpText = /\botp\b|one[\s-]?time|verification\s+code|security\s+code|email\s+(?:otp|code)|6[\s-]?digit\s+code|sent\s+to\s+your\s+(?:email|mobile)/i.test(text);
    const hasStrongMpinText = /\bm[\s-]?pin\b|trading\s+pin|transaction\s+pin|secure\s+pin|6[\s-]?digit\s+(?:m?pin|password)|4[\s-]?digit\s+(?:m?pin|password)/i.test(text);

    // WEAK signals (the word "PIN" alone — could be either depending on context).
    const hasWeakPinText = /\bpin\b|enter\s+(?:your\s+|the\s+)?pin/i.test(text) && !hasStrongOtpText;

    const insideApp = /\/(dashboard|home|watchlist|portfolio|holdings|positions|funds|orders|order-book|markets|investments|account)(?:[/?#]|$)/i.test(path);
    const dashboardText = /(get\s+ready\s+to\s+invest|watchlist|holdings|positions|net\s+worth|markets|news\s+discovery|open\s+ipo)/i.test(text);

    // 1) Dashboard wins if URL is inside the app AND there's no login form.
    if (insideApp && !mobileField && digitBoxes.length === 0 && !passwordField && !otpAttrInput) return 'dashboard';
    if (insideApp && dashboardText && digitBoxes.length === 0 && !otpAttrInput) return 'dashboard';

    // 2) Hint-driven: when the caller knows what should be next, use that
    //    to break ties in ambiguous digit-box layouts.
    if (hint === 'expect-mpin') {
      if (passwordField) return 'mpin';
      if (digitBoxes.length >= 4 && !hasStrongOtpText) return 'mpin';
      if (mpinAttrInput) return 'mpin';
    }
    if (hint === 'expect-otp') {
      if (otpAttrInput) return 'otp';
      if (digitBoxes.length >= 4 && !hasStrongMpinText) return 'otp';
    }

    // 3) Strong text signals.
    if (hasStrongMpinText && (digitBoxes.length >= 4 || passwordField)) return 'mpin';
    if (hasStrongOtpText && (digitBoxes.length >= 4 || otpAttrInput)) return 'otp';

    // 4) Attribute-level signals on the input itself.
    if (passwordField && !mobileField && !otpAttrInput) return 'mpin';
    if (otpAttrInput && !mpinAttrInput) return 'otp';

    // 5) Weak "PIN" text + boxes → MPIN.
    if (hasWeakPinText && digitBoxes.length >= 4) return 'mpin';

    // 6) Last resort: bare digit boxes with no text. Bias by hint, else OTP.
    if (digitBoxes.length >= 6) return hint === 'expect-mpin' ? 'mpin' : 'otp';
    if (digitBoxes.length >= 4) return hint === 'expect-otp' ? 'otp' : 'mpin';

    // 7) Mobile field present and no other signals.
    if (mobileField) return 'mobile';

    return 'unknown';
  }, hint).catch(() => 'unknown' as LoginStep);
}

async function waitForStep(page: Page, want: LoginStep[], timeoutMs: number, hint: StepHint = null): Promise<LoginStep> {
  const deadline = Date.now() + timeoutMs;
  let last: LoginStep = 'unknown';
  while (Date.now() < deadline) {
    last = await detectStep(page, hint);
    if (want.includes(last) || last === 'dashboard') return last;
    await page.waitForTimeout(350);
  }
  return last;
}

// ─── Fillers ──────────────────────────────────────────────────────────────

/** Build a single OR-chained locator for the mobile-number input. */
function mobileLocator(page: Page): Locator {
  return page.locator('input[type="tel"]')
    .or(page.locator('input[autocomplete="tel"]'))
    .or(page.locator('input[name="mobile" i]'))
    .or(page.locator('input[name="phone" i]'))
    .or(page.locator('input[name*="mobile" i]'))
    .or(page.locator('input[name*="phone" i]'))
    .or(page.locator('input[placeholder*="Mobile" i]'))
    .or(page.locator('input[placeholder*="Phone" i]'))
    .or(page.locator('input[maxlength="10"][type="text"]'))
    .or(page.locator('input[inputmode="numeric"][maxlength="10"]'));
}

async function fillMobile(page: Page, mobile: string): Promise<boolean> {
  const loc = mobileLocator(page).first();
  try {
    await loc.waitFor({ state: 'visible', timeout: 8_000 });
    await loc.click({ timeout: 3_000 });
    // Clear any pre-filled junk, then fill.
    await loc.fill('');
    await loc.fill(mobile);
    const v = (await loc.inputValue().catch(() => '')).replace(/\D/g, '');
    if (v === mobile) return true;

    // Fallback: keyboard type with native setter
    await loc.click({ clickCount: 3 }).catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.keyboard.type(mobile, { delay: 20 });
    return ((await loc.inputValue().catch(() => '')).replace(/\D/g, '') === mobile);
  } catch (e) {
    console.warn('[Angel One] fillMobile failed:', (e as Error).message);
    return false;
  }
}

/**
 * Find the row of digit-input boxes on the page and return:
 *   - a unique CSS selector that targets exactly that set of inputs
 *   - the indexes (in document order under that selector) to use
 *
 * Each box gets a unique data attribute `data-angel-digit="0..n-1"` so we
 * can address them deterministically even on shadow-like markup.
 */
async function tagDigitBoxes(page: Page, digitsLen: number): Promise<number> {
  return page.evaluate((len) => {
    // Clear any prior tagging
    document.querySelectorAll('[data-angel-digit]').forEach(el => el.removeAttribute('data-angel-digit'));

    const isVisible = (el: HTMLInputElement) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0
        && s.display !== 'none' && s.visibility !== 'hidden'
        && !el.disabled && el.type !== 'hidden';
    };
    const attrs = (i: HTMLInputElement) => [
      i.type, i.name, i.id, i.placeholder, i.autocomplete,
      i.getAttribute('aria-label') || '', i.getAttribute('data-testid') || '',
    ].join(' ').toLowerCase();

    // Candidate pool: explicit maxlength=1, OR one-time-code autocomplete,
    // OR small width inputs (≤60px) that don't look like a normal field.
    const all = Array.from(document.querySelectorAll<HTMLInputElement>('input')).filter(isVisible);
    const candidates = all.filter(i => {
      if (i.maxLength === 1) return true;
      if ((i.getAttribute('autocomplete') || '').toLowerCase() === 'one-time-code') return true;
      const a = attrs(i);
      if (/mobile|phone|email|user|search|^name$/.test(a)) return false;
      const r = i.getBoundingClientRect();
      return r.width > 0 && r.width <= 60 && r.height >= 28 && r.height <= 80;
    });

    if (candidates.length === 0) return 0;

    // Group by horizontal row
    const items = candidates.map(el => ({ el, top: el.getBoundingClientRect().top, left: el.getBoundingClientRect().left }));
    items.sort((a, b) => Math.abs(a.top - b.top) > 8 ? a.top - b.top : a.left - b.left);
    const rows: Array<typeof items> = [];
    for (const it of items) {
      const row = rows.find(r => Math.abs(r[0].top - it.top) <= 14);
      if (row) row.push(it); else rows.push([it]);
    }
    rows.forEach(r => r.sort((a, b) => a.left - b.left));

    const exact = rows.find(r => r.length === len);
    const best = exact ?? rows.sort((a, b) => b.length - a.length)[0];
    if (!best) return 0;

    const take = best.slice(0, len);
    take.forEach((it, idx) => it.el.setAttribute('data-angel-digit', String(idx)));
    return take.length;
  }, digitsLen).catch(() => 0);
}

async function fillDigitsIntoBoxes(page: Page, digits: string): Promise<boolean> {
  const tagged = await tagDigitBoxes(page, digits.length);
  if (tagged < digits.length) return false;

  try {
    const first = page.locator('input[data-angel-digit="0"]').first();
    await first.scrollIntoViewIfNeeded().catch(() => {});
    await first.click({ timeout: 2_500 });
    // 70 ms per keystroke — fast enough to feel instant, slow enough for
    // Angel's controlled-input auto-advance handlers to keep up.
    await page.keyboard.type(digits, { delay: 70 });
    await page.waitForTimeout(220);

    const filled = await page.evaluate((len: number) => {
      const arr: string[] = [];
      for (let i = 0; i < len; i += 1) {
        const el = document.querySelector<HTMLInputElement>(`input[data-angel-digit="${i}"]`);
        arr.push(el?.value || '');
      }
      return arr.join('');
    }, digits.length);
    if (filled === digits) return true;

    // Fallback: native-setter injection (some custom React/Angular widgets
    // ignore typed events but accept programmatic value changes).
    const ok = await page.evaluate((d: string) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      for (let i = 0; i < d.length; i += 1) {
        const el = document.querySelector<HTMLInputElement>(`input[data-angel-digit="${i}"]`);
        if (!el) return false;
        el.focus();
        if (setter) setter.call(el, d[i]); else el.value = d[i];
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: d[i], bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: d[i], bubbles: true }));
      }
      // Confirm
      for (let i = 0; i < d.length; i += 1) {
        const el = document.querySelector<HTMLInputElement>(`input[data-angel-digit="${i}"]`);
        if ((el?.value || '') !== d[i]) return false;
      }
      return true;
    }, digits);
    if (ok) return true;

    // Last resort: click+fill each box individually
    for (let i = 0; i < digits.length; i += 1) {
      const box = page.locator(`input[data-angel-digit="${i}"]`).first();
      await box.click({ timeout: 1_200 }).catch(() => {});
      await box.fill(digits[i]).catch(() => {});
    }
    const finalCheck = await page.evaluate((len: number) => {
      const arr: string[] = [];
      for (let i = 0; i < len; i += 1) {
        const el = document.querySelector<HTMLInputElement>(`input[data-angel-digit="${i}"]`);
        arr.push(el?.value || '');
      }
      return arr.join('');
    }, digits.length);
    return finalCheck === digits;
  } catch (e) {
    console.warn('[Angel One] fillDigitsIntoBoxes failed:', (e as Error).message);
    return false;
  }
}

async function fillDigitsIntoSingleInput(page: Page, digits: string): Promise<boolean> {
  const loc = page.locator('input[autocomplete="one-time-code"]')
    .or(page.locator('input[name*="otp" i]'))
    .or(page.locator('input[id*="otp" i]'))
    .or(page.locator('input[placeholder*="OTP" i]'))
    .or(page.locator('input[placeholder*="One Time" i]'))
    .or(page.locator('input[placeholder*="verification" i]'))
    .or(page.locator('input[placeholder*="code" i]'))
    .or(page.locator('input[aria-label*="otp" i]'))
    .or(page.locator('input[aria-label*="code" i]'))
    .or(page.locator('input[name*="mpin" i]'))
    .or(page.locator('input[id*="mpin" i]'))
    .or(page.locator('input[placeholder*="MPIN" i]'))
    .or(page.locator('input[placeholder*="PIN" i]'))
    .or(page.locator(`input[maxlength="${digits.length}"][type="text"]`))
    .or(page.locator(`input[maxlength="${digits.length}"][type="tel"]`))
    .or(page.locator(`input[maxlength="${digits.length}"][type="number"]`))
    .or(page.locator(`input[maxlength="${digits.length}"][type="password"]`))
    .or(page.locator('input[type="password"]'))
    .first();
  try {
    if (!(await loc.isVisible({ timeout: 1_500 }).catch(() => false))) return false;
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await loc.click({ timeout: 2_000 });
    await loc.fill('').catch(() => {});
    await loc.fill(digits);
    const v = (await loc.inputValue().catch(() => '')).replace(/\D/g, '');
    if (v === digits || v.endsWith(digits)) return true;
    // Keyboard fallback
    await loc.click({ clickCount: 3 }).catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.keyboard.type(digits, { delay: 30 });
    const v2 = (await loc.inputValue().catch(() => '')).replace(/\D/g, '');
    return v2 === digits || v2.endsWith(digits);
  } catch {
    return false;
  }
}

async function fillDigits(page: Page, digits: string): Promise<boolean> {
  if (!digits) return false;
  if (await fillDigitsIntoBoxes(page, digits)) return true;
  return fillDigitsIntoSingleInput(page, digits);
}

async function clickPrimary(page: Page, labels: string[], opts: { waitEnabledMs?: number; force?: boolean } = {}): Promise<boolean> {
  const waitEnabledMs = opts.waitEnabledMs ?? 5_000;
  for (const label of labels) {
    const btn = page.locator(`button:has-text("${label}")`)
      .or(page.locator(`[role="button"]:has-text("${label}")`))
      .or(page.locator(`input[type="submit"][value*="${label}" i]`))
      .or(page.locator(`button[aria-label*="${label}" i]`))
      .or(page.locator(`a:has-text("${label}")`))
      .first();
    if (!(await btn.isVisible({ timeout: 600 }).catch(() => false))) continue;

    // Wait for the button to become enabled — Angel disables it until the
    // OTP/MPIN passes client-side validation, which can take a beat.
    const enabledDeadline = Date.now() + waitEnabledMs;
    while (!(await btn.isEnabled().catch(() => true)) && Date.now() < enabledDeadline) {
      await page.waitForTimeout(150);
    }
    const finallyEnabled = await btn.isEnabled().catch(() => true);
    if (!finallyEnabled && !opts.force) continue;
    await btn.click({ force: opts.force }).catch(() => {});
    return true;
  }
  return false;
}

/**
 * Submit an OTP/MPIN form after digits are filled. Tries multiple strategies
 * because Angel's button labels vary by flow (sometimes "Continue", sometimes
 * "Verify", sometimes "Login") and sometimes the form auto-submits.
 *
 * Returns true if we believe a submission was triggered.
 */
async function submitOtpForm(page: Page, kind: 'OTP' | 'MPIN'): Promise<boolean> {
  // Let Angel's input handler run its validation (enables the submit button).
  await page.waitForTimeout(450);

  // Strategy 1: click a known label, allowing time for the button to enable.
  const labels = kind === 'OTP'
    ? ['Verify', 'Verify OTP', 'Submit OTP', 'Submit', 'Continue', 'Confirm', 'OK', 'Proceed', 'Next', 'Login', 'Sign In', 'Done']
    : ['Login', 'Sign In', 'Submit', 'Verify', 'Continue', 'Confirm', 'OK', 'Proceed', 'Done'];

  if (await clickPrimary(page, labels, { waitEnabledMs: 6_000 })) {
    console.log(`[Angel One] ${kind} submitted via primary button click`);
    return true;
  }

  // Strategy 2: press Enter on the focused input. Many React OTP widgets
  // listen for Enter and submit the wrapping form.
  await page.keyboard.press('Enter').catch(() => {});
  await page.waitForTimeout(600);
  if (!(await detectStep(page).then(s => s === 'otp' || s === 'mpin').catch(() => true))) {
    console.log(`[Angel One] ${kind} submitted via Enter key`);
    return true;
  }

  // Strategy 3: find ANY visible submit-shaped button and click it.
  const submitBtn = page.locator('button[type="submit"]:visible')
    .or(page.locator('input[type="submit"]:visible'))
    .or(page.locator('form button:visible'))
    .first();
  if (await submitBtn.isVisible({ timeout: 800 }).catch(() => false)) {
    await submitBtn.click({ force: true }).catch(() => {});
    console.log(`[Angel One] ${kind} submitted via submit-type button`);
    await page.waitForTimeout(500);
    if (!(await detectStep(page).then(s => s === 'otp' || s === 'mpin').catch(() => true))) {
      return true;
    }
  }

  // Strategy 4: force-click a primary-styled button even if it claims to be
  // disabled (some Angular buttons report `aria-disabled` but accept clicks).
  if (await clickPrimary(page, labels, { waitEnabledMs: 0, force: true })) {
    console.log(`[Angel One] ${kind} submitted via force-clicked primary`);
    return true;
  }

  // Strategy 5: programmatically submit the closest form to the focused input.
  const submitted = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    const form = active?.closest('form');
    if (form) {
      const ev = new Event('submit', { bubbles: true, cancelable: true });
      if (form.dispatchEvent(ev)) {
        try { (form as HTMLFormElement).submit(); return true; } catch { /* CORS / blocked */ }
      }
      return true;
    }
    return false;
  }).catch(() => false);
  if (submitted) {
    console.log(`[Angel One] ${kind} submitted via programmatic form.submit()`);
    return true;
  }

  console.warn(`[Angel One] All ${kind} submission strategies failed.`);
  return false;
}

// ─── Overlays / diagnostics ───────────────────────────────────────────────

async function dismissOverlays(page: Page): Promise<void> {
  const targets: Locator[] = [
    page.getByRole('button', { name: /got\s*it/i }).first(),
    page.getByRole('button', { name: /^ok$/i }).first(),
    page.getByRole('button', { name: /close/i }).first(),
    page.locator('button[aria-label*="close" i]').first(),
  ];
  for (const t of targets) {
    if (!(await t.isVisible({ timeout: 600 }).catch(() => false))) continue;
    await t.click({ timeout: 1_500 }).catch(() => {});
    await page.waitForTimeout(400);
  }
}

async function dumpDiagnostics(page: Page, label: string): Promise<void> {
  try {
    const info = await page.evaluate(() => {
      const vis = (el: Element) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.width > 1 && r.height > 1;
      };
      const trim = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 80);
      const inputs = Array.from(document.querySelectorAll('input')).filter(vis).slice(0, 12).map(i => {
        const e = i as HTMLInputElement;
        return `<input type=${e.type} name="${e.name}" id="${e.id}" ml=${e.maxLength} ph="${trim(e.placeholder)}">`;
      });
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(vis).slice(0, 12)
        .map(b => `<btn ${(b as HTMLElement).className.slice(0, 25)}> ${trim((b as HTMLElement).innerText)}`);
      return {
        url: location.href,
        title: document.title,
        snippet: trim((document.body?.innerText || '').slice(0, 300)),
        inputs,
        buttons,
      };
    });
    console.log(`[Angel One][${label}] url=${info.url}`);
    console.log(`[Angel One][${label}] title=${info.title}`);
    console.log(`[Angel One][${label}] body="${info.snippet}"`);
    console.log(`[Angel One][${label}] inputs:`, info.inputs);
    console.log(`[Angel One][${label}] buttons:`, info.buttons);
  } catch (e) {
    console.warn(`[Angel One][${label}] diagnostics failed:`, (e as Error).message);
  }
}

// ─── Balance scraping ─────────────────────────────────────────────────────

async function scrapeValue(page: Page, labels: string[]): Promise<string | null> {
  return page.evaluate((labels: string[]) => {
    const text = (document.body?.innerText || '');
    if (!text) return null;
    const AMT = '\\d[\\d,]*(?:\\.\\d{1,2})?';
    for (const lbl of labels) {
      const re = new RegExp(`${lbl}[\\s\\S]{0,120}?(-?)\\s*(?:\\u20B9|INR|Rs\\.?)\\s*(-?${AMT})`, 'i');
      const m = text.match(re);
      if (m?.[2]) return (m[1] === '-' || m[2].startsWith('-') ? '-' : '') + m[2].replace(/^-/, '');
    }
    const m = text.match(new RegExp(`(-?)\\s*(?:\\u20B9|INR|Rs\\.?)\\s*(-?${AMT})`));
    if (!m?.[2]) return null;
    return (m[1] === '-' || m[2].startsWith('-') ? '-' : '') + m[2].replace(/^-/, '');
  }, labels).catch(() => null);
}

/** Wait until the page renders at least one INR amount, OR an "empty"
 *  indicator (e.g. "No holdings"). Returns true if an amount was found. */
async function waitForAmount(page: Page, timeoutMs: number): Promise<boolean> {
  try {
    const result = await page.waitForFunction(() => {
      const text = (document.body as HTMLElement | null)?.innerText || '';
      // Found an amount?
      if (/(?:₹|INR|Rs\.?)\s*-?\d[\d,]*(?:\.\d{1,2})?/i.test(text)) return 'amount';
      // Or page is legitimately empty?
      if (/no\s+(?:holdings?|positions?|investments?|data\s+found|records?)/i.test(text)) return 'empty';
      return null;
    }, { timeout: timeoutMs, polling: 200 }).then(h => h.jsonValue() as Promise<string>).catch(() => null);
    return result === 'amount';
  } catch {
    return false;
  }
}

async function navigateOrClick(page: Page, urls: string[], textTabs: string[], match: RegExp): Promise<boolean> {
  if (match.test(page.url())) return true;
  for (const t of textTabs) {
    const tab = page.locator(`a:has-text("${t}"), button:has-text("${t}"), [role="tab"]:has-text("${t}")`).first();
    if (await tab.isVisible({ timeout: 600 }).catch(() => false)) {
      await tab.click().catch(() => {});
      await Promise.race([
        page.waitForURL(match, { timeout: 3_000 }).catch(() => null),
        page.waitForTimeout(800),
      ]);
      if (match.test(page.url())) return true;
    }
  }
  for (const u of urls) {
    try {
      await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 10_000 });
      await page.waitForTimeout(700);
      if (match.test(page.url())) return true;
    } catch { /* try next */ }
  }
  return false;
}

// ─── Adapter ──────────────────────────────────────────────────────────────

export const angelAdapter: LoginAdapter = {
  code: 'ANGEL',
  displayName: 'Angel One',
  otpMode: 'email',

  async login(page: Page, creds: LoginCredentials, fetchOtp: () => Promise<string>): Promise<void> {
    const context = page.context();
    const mobile = (creds.username || '').replace(/\D/g, '').slice(-10);
    const mpin   = (creds.password || '').replace(/\D/g, '');

    if (mobile.length !== 10) {
      console.warn(`[Angel One] Mobile "${creds.username}" is not 10 digits — proceeding anyway.`);
    }

    // 1) Navigate (or land on cached session)
    page = await findAngelPage(context, page);
    if (!safeUrl(page).includes('angelone.in')) {
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    }
    // Give the SPA a beat to hydrate.
    await page.waitForTimeout(1_200);
    page = await findAngelPage(context, page);

    let step = await waitForStep(page, ['mobile', 'otp', 'mpin', 'dashboard'], 20_000);
    console.log(`[Angel One] Initial step: ${step}`);

    if (step === 'dashboard') {
      await dismissOverlays(page);
      console.log('[Angel One] Already logged in (session cached):', safeUrl(page));
      return;
    }

    // 2) Mobile
    if (step === 'mobile') {
      const ok = await fillMobile(page, mobile || creds.username || '');
      if (!ok) {
        console.warn('[Angel One] Could not fill mobile field.');
        await dumpDiagnostics(page, 'mobile-fill-fail');
        return;
      }
      console.log('[Angel One] Mobile filled.');

      // Click Continue or press Enter
      if (!await clickPrimary(page, ['Continue', 'Next', 'Get OTP', 'Send OTP', 'Proceed', 'Submit'])) {
        await page.keyboard.press('Enter').catch(() => {});
      }
      console.log('[Angel One] Mobile submitted, waiting for next screen…');

      // No hint — could be OTP or MPIN depending on whether device is trusted.
      step = await waitForStep(page, ['otp', 'mpin', 'dashboard'], 45_000);
      console.log(`[Angel One] Post-mobile step: ${step}`);
      page = await findAngelPage(context, page);
      if (step === 'unknown') {
        await dumpDiagnostics(page, 'post-mobile-unknown');
      }
    }

    if (step === 'dashboard') {
      await dismissOverlays(page);
      console.log('[Angel One] Logged in without OTP/MPIN.');
      return;
    }

    // 3) OTP (sent to email)
    if (step === 'otp') {
      let otp = '';
      try {
        const raw = await fetchOtp();
        otp = (raw || '').replace(/\D/g, '').slice(-6);
      } catch (e: any) {
        const msg = e?.message || String(e);
        if (msg.includes('OTP_TIMEOUT') || msg.includes('OTP_CANCELLED')) {
          console.warn('[Angel One] OTP entry cancelled/timed out.');
        } else {
          console.warn('[Angel One] OTP fetch failed:', msg);
        }
        return;
      }
      if (otp.length < 4) {
        console.warn(`[Angel One] OTP looks invalid: "${otp}"`);
        return;
      }
      console.log(`[Angel One] OTP fetched (${otp.length} digits).`);

      if (!await fillDigits(page, otp)) {
        console.warn('[Angel One] Could not fill OTP.');
        await dumpDiagnostics(page, 'otp-fill-fail');
        return;
      }
      // Submit using multi-strategy approach (click → Enter → submit-type
      // button → force click → form.submit).
      await submitOtpForm(page, 'OTP');
      console.log('[Angel One] OTP submission attempted, waiting for MPIN/dashboard…');

      // We just submitted OTP — the next screen is MPIN (or dashboard if
      // device is trusted). Hint MPIN so detectStep doesn't mistake the
      // identically-shaped MPIN box layout for OTP.
      step = await waitForStep(page, ['mpin', 'dashboard'], 30_000, 'expect-mpin');
      console.log(`[Angel One] Post-OTP step: ${step}`);
      page = await findAngelPage(context, page);
      if (step !== 'mpin' && step !== 'dashboard') {
        await dumpDiagnostics(page, 'post-otp-unexpected');
      }
    }

    if (step === 'dashboard') {
      await dismissOverlays(page);
      console.log('[Angel One] Logged in after OTP:', safeUrl(page));
      return;
    }

    // 4) MPIN
    if (step === 'mpin') {
      if (mpin.length < 4) {
        console.warn('[Angel One] MPIN is missing or too short. Aborting auto-fill — complete login manually.');
        return;
      }
      if (!await fillDigits(page, mpin)) {
        console.warn('[Angel One] Could not fill MPIN.');
        await dumpDiagnostics(page, 'mpin-fill-fail');
        return;
      }
      console.log(`[Angel One] MPIN filled (${mpin.length} digits).`);

      await submitOtpForm(page, 'MPIN');
      console.log('[Angel One] MPIN submission attempted, waiting for dashboard…');

      step = await waitForStep(page, ['dashboard'], 30_000, 'expect-mpin');
      page = await findAngelPage(context, page);
      if (step !== 'dashboard') {
        await dumpDiagnostics(page, 'post-mpin-no-dashboard');
      }
    }

    if (step === 'dashboard') {
      await dismissOverlays(page);
      console.log('[Angel One] Login complete:', safeUrl(page));
    } else {
      console.warn(`[Angel One] Did not reach dashboard — final step: ${step}`);
      await dumpDiagnostics(page, 'final-not-dashboard');
    }

    console.log('[Angel One] Browser remains open.');
  },

  async fetchBalance(page: Page): Promise<string | null> {
    const t0 = Date.now();
    const INR = '₹';
    const parts: string[] = [];
    const context = page.context();
    page = await findAngelPage(context, page);
    await dismissOverlays(page);

    // Wait for the dashboard to actually settle — Angel's SPA can take a
    // few seconds after MPIN to render watchlist/funds widgets.
    const onDashboard = await waitForStep(page, ['dashboard'], 10_000);
    if (onDashboard !== 'dashboard') {
      console.warn(`[Angel One] fetchBalance: not on dashboard (step=${onDashboard}), proceeding anyway`);
    }
    await dismissOverlays(page);

    // ── Funds ────────────────────────────────────────────────────────────
    page = await findAngelPage(context, page);
    if (await navigateOrClick(
      page,
      ['https://trade.angelone.in/funds', 'https://trade.angelone.in/account/funds', 'https://trade.angelone.in/portfolio/funds'],
      ['Funds', 'Fund', 'Cash', 'Margin'],
      /fund|margin|cash/i,
    )) {
      await waitForAmount(page, 6_000);
      const v = await scrapeValue(page, [
        'Available\\s+Balance', 'Available\\s+Margin', 'Available\\s+Funds?',
        'Available\\s+Cash', 'Available\\s+Limit', 'Available\\s+to\\s+(?:Trade|Invest|Withdraw)',
        'Net\\s+Available', 'Withdrawable\\s+Balance', 'Withdrawable',
        'Total\\s+Balance', 'Cash\\s+Balance', 'Total\\s+Funds',
        'Net\\s+Cash', 'Margin\\s+Available', 'Trading\\s+Balance',
        'Equity\\s+Balance', 'Free\\s+Cash', 'Account\\s+Balance',
      ]);
      if (v) parts.push(`Funds: ${INR}${v}`);
      else console.warn(`[Angel One] Funds page rendered but no labeled value found at ${page.url()}`);
    } else {
      console.warn(`[Angel One] Could not reach Funds page from ${page.url()}`);
    }

    // ── Portfolio / Holdings ────────────────────────────────────────────
    page = await findAngelPage(context, page);
    if (await navigateOrClick(
      page,
      ANGEL_PORTFOLIO_URLS,
      ['Holdings', 'Portfolio', 'Investments'],
      /holding|portfolio|investment/i,
    )) {
      await waitForAmount(page, 6_000);
      const v = await scrapeValue(page, [
        'Current\\s+Value', 'Portfolio\\s+Value', 'Total\\s+(?:Current\\s+)?Value',
        'Market\\s+Value', 'Holdings?\\s+Value', 'Invested\\s+Value', 'Invested',
        'Total\\s+Investment', 'Net\\s+Worth', 'Total\\s+Holdings',
      ]);
      if (v) parts.push(`Portfolio: ${INR}${v}`);
      else console.warn(`[Angel One] Portfolio page rendered but no labeled value found at ${page.url()}`);
    } else {
      console.warn(`[Angel One] Could not reach Portfolio page from ${page.url()}`);
    }

    // ── Positions ───────────────────────────────────────────────────────
    page = await findAngelPage(context, page);
    if (await navigateOrClick(
      page,
      ['https://trade.angelone.in/positions', 'https://trade.angelone.in/portfolio/positions', 'https://trade.angelone.in/order-and-trades/positions'],
      ['Positions', 'Position'],
      /position/i,
    )) {
      // Positions can legitimately be empty — short wait, scrape what's there.
      await page.waitForTimeout(1_200);
      const v = await scrapeValue(page, [
        'Net\\s+Value', 'Total\\s+Value', 'Net\\s+P&L', 'Total\\s+P&L',
        'P&L', 'PnL', 'P/L', 'M2M', 'MTM', 'Mark[\\s-]?to[\\s-]?Market',
        'Day\\s+P&L', 'Overall\\s+P&L',
      ]);
      if (v) parts.push(`Positions: ${INR}${v}`);
      // Don't warn for positions — empty is normal.
    }

    if (parts.length === 0) {
      console.warn(`[Angel One] No balance values scraped (${Date.now() - t0}ms). Final URL: ${page.url()}`);
      await dumpDiagnostics(page, 'fetchBalance-no-values');
      return null;
    }
    const out = parts.join(' | ');
    console.log(`[Angel One] Balance (${Date.now() - t0}ms):`, out);
    return out;
  },

  async downloadPortfolioReport(page: Page, creds: LoginCredentials, fetchOtp: () => Promise<string>): Promise<DownloadedBrokerReport | null> {
    const t0 = Date.now();
    await angelAdapter.login!(page, creds, fetchOtp);
    const context = page.context();
    page = await findAngelPage(context, page);
    await dismissOverlays(page);

    // Navigate to portfolio/holdings
    if (!await navigateOrClick(page, ANGEL_PORTFOLIO_URLS, ['Holdings', 'Portfolio'], /holding|portfolio/i)) {
      throw new Error('Angel One portfolio / holdings page not found');
    }
    await page.waitForTimeout(1_500);
    page = await findAngelPage(context, page);
    await dismissOverlays(page);

    // Try Equity / Stocks tab if visible
    for (const t of ['Equity', 'Stocks', 'All']) {
      const tab = page.locator(`button:has-text("${t}"), [role="tab"]:has-text("${t}")`).first();
      if (await tab.isVisible({ timeout: 600 }).catch(() => false)) {
        await tab.click().catch(() => {});
        await page.waitForTimeout(600);
        break;
      }
    }

    // Click Download / Excel
    const downloadStartedAt = Date.now();
    const downloadPromise = waitForAngelDownload(page, 15_000);

    const downloadButton = page.getByRole('button', { name: /download/i }).first()
      .or(page.getByText(/^download$/i).first())
      .or(page.locator('button[aria-label*="download" i], a[aria-label*="download" i]').first());
    if (!(await downloadButton.isVisible({ timeout: 2_500 }).catch(() => false))) {
      await dumpDiagnostics(page, 'portfolio-download-missing');
      throw new Error('Angel One download button not found');
    }
    await downloadButton.click().catch(() => {});

    let download: Download;
    try {
      download = await downloadPromise;
    } catch {
      // Might have opened a submenu — try Excel / xlsx
      const submenu = page.getByText(/^excel$/i).first()
        .or(page.getByText(/^xlsx$/i).first())
        .or(page.getByText(/holding\s+statement/i).first())
        .or(page.getByRole('button', { name: /excel|xlsx/i }).first());
      const sub2 = waitForAngelDownload(page, 12_000);
      await submenu.click().catch(() => {});
      download = await sub2;
    }

    const saved = await resolveBrowserDownload(page, download, downloadStartedAt);
    const asOf = todayIso();
    const fileName = saved.fileName || download.suggestedFilename() || `angel-holdings-${asOf}.xlsx`;
    console.log(`[Angel One] Holdings report (${Date.now() - t0}ms):`, fileName);

    return {
      reportKind: 'holdings',
      asOfDate: asOf,
      fileName,
      filePath: saved.filePath,
    };
  },
};

async function waitForAngelDownload(page: Page, timeoutMs: number): Promise<Download> {
  const context = page.context();
  const existing = context.pages().filter(p => !p.isClosed())
    .map(p => p.waitForEvent('download', { timeout: timeoutMs }));
  const popup = context.waitForEvent('page', { timeout: timeoutMs })
    .then(async p => {
      await p.waitForLoadState('domcontentloaded', { timeout: Math.min(timeoutMs, 5_000) }).catch(() => {});
      return p.waitForEvent('download', { timeout: timeoutMs });
    });
  return Promise.any([...existing, popup]);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
