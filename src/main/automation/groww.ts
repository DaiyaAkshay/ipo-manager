/**
 * Groww login adapter — rewritten 2026-05-21.
 *
 * Login URL : https://groww.in/login
 *
 * Flow (linear state machine):
 *   1. Goto LOGIN_URL → detect current step
 *   2. credentials → fill email/mobile + password → Login
 *   3. (optional) otp → manual / SMS-based, we wait for it to clear
 *   4. (optional) pin → fill 4 or 6 digit Groww PIN → Continue
 *   5. dashboard
 *
 * `creds.username` = email or 10-digit mobile, `creds.password` = the account
 * password. If the user has a Groww PIN, it's typically stored as a separate
 * `totp_secret` (we treat any saved numeric value ≤ 6 digits as a PIN).
 */

import { Page, Locator, BrowserContext } from 'playwright';
import { LoginAdapter, LoginCredentials } from './browser';

const LOGIN_URL = 'https://groww.in/login';

const GROWW_FUNDS_URLS = [
  'https://groww.in/user/account',
  'https://groww.in/v2/user/account',
  'https://groww.in/user/balance',
  'https://groww.in/stocks/user/funds',
];
const GROWW_HOLDINGS_URLS = [
  'https://groww.in/stocks/user/holdings',
  'https://groww.in/stocks/user/portfolio',
  'https://groww.in/stocks/user/investments',
];
const GROWW_POSITIONS_URLS = [
  'https://groww.in/stocks/user/positions',
  'https://groww.in/stocks/user/orders',
];

// ─── Page resolution ──────────────────────────────────────────────────────

function safeUrl(page: Page): string {
  try { return page.url() || ''; } catch { return ''; }
}

async function findGrowwPage(context: BrowserContext, fallback: Page): Promise<Page> {
  const open = context.pages().filter(p => !p.isClosed());
  const groww = [...open].reverse().find(p => /groww\.in/i.test(safeUrl(p)));
  const chosen = groww ?? (!fallback.isClosed() ? fallback : open[open.length - 1]);
  if (chosen && !chosen.isClosed()) {
    await chosen.bringToFront().catch(() => {});
  }
  return chosen ?? fallback;
}

// ─── Step detection ───────────────────────────────────────────────────────

type LoginStep = 'credentials' | 'otp' | 'pin' | 'dashboard' | 'unknown';
type StepHint = 'expect-otp' | 'expect-pin' | 'expect-dashboard' | null;

async function detectStep(page: Page, hint: StepHint = null): Promise<LoginStep> {
  return page.evaluate((hint) => {
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const s = window.getComputedStyle(el as HTMLElement);
      return r.width > 1 && r.height > 1
        && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };
    const path = location.pathname + location.hash;
    const text = (document.body?.innerText || '').toLowerCase();

    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input'))
      .filter(i => visible(i) && i.type !== 'hidden' && !i.disabled);
    const attrsOf = (i: HTMLInputElement) => [
      i.type, i.name, i.id, i.placeholder, i.autocomplete,
      i.getAttribute('aria-label') || '', i.getAttribute('data-testid') || ''
    ].join(' ').toLowerCase();

    const emailField = inputs.find(i => {
      const a = attrsOf(i);
      return /email|mobile|phone|userid|user[_ ]?name/.test(a)
        || i.type === 'email' || i.type === 'tel';
    });
    const passwordField = inputs.find(i => i.type === 'password');
    const digitBoxes = inputs.filter(i => {
      if (i.maxLength === 1) return true;
      if ((i.getAttribute('autocomplete') || '').toLowerCase() === 'one-time-code') return true;
      const r = i.getBoundingClientRect();
      if (r.width > 0 && r.width <= 60 && r.height >= 28 && r.height <= 80) {
        const a = attrsOf(i);
        if (!/mobile|phone|email|user|search|^name$/.test(a)) return true;
      }
      return false;
    });

    const hasOtpText = /\botp\b|one[\s-]?time|verification\s+code|6[\s-]?digit\s+code|sent\s+to\s+your\s+(?:mobile|phone|email)|enter\s+the\s+code/i.test(text);
    const hasPinText = /\bgroww\s*pin\b|4[\s-]?digit\s+pin|enter\s+(?:your\s+)?pin|set\s+(?:up\s+)?(?:your\s+)?pin|create\s+pin/i.test(text);
    const dashboardText = /(dashboard|net\s+worth|available\s+margin|holdings|stocks|invest|portfolio|watchlist|explore)/i.test(text);
    const insideApp = /\/(dashboard|stocks|mf|user|funds|holdings|orders|portfolio|investments|explore|watchlist)(?:[/?#]|$)/i.test(path);

    // Dashboard wins.
    if (insideApp && !passwordField && digitBoxes.length === 0 && !emailField) return 'dashboard';
    if (insideApp && dashboardText && digitBoxes.length === 0 && !passwordField) return 'dashboard';

    // Hint-driven tie breaker.
    if (hint === 'expect-pin' && digitBoxes.length >= 4) return 'pin';
    if (hint === 'expect-otp' && digitBoxes.length >= 4) return 'otp';
    if (hint === 'expect-dashboard' && insideApp && !passwordField) return 'dashboard';

    // Strong signals.
    if (hasPinText && digitBoxes.length >= 4) return 'pin';
    if (hasOtpText && digitBoxes.length >= 4) return 'otp';

    // Bare digit-box row: prefer the hint, else PIN (Groww uses PIN more
    // often than OTP for cached sessions).
    if (digitBoxes.length >= 4 && !passwordField && !emailField) {
      return hint === 'expect-otp' ? 'otp' : 'pin';
    }

    // Credentials form.
    if ((emailField || passwordField) && !insideApp) return 'credentials';

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

/** Email/mobile input locator chain. */
function userInputLocator(page: Page): Locator {
  return page.locator('input[type="email"]')
    .or(page.locator('input[name*="email" i]'))
    .or(page.locator('input[name*="mobile" i]'))
    .or(page.locator('input[name*="userid" i]'))
    .or(page.locator('input[placeholder*="email" i]'))
    .or(page.locator('input[placeholder*="mobile" i]'))
    .or(page.locator('input[type="tel"]'))
    .or(page.locator('input[autocomplete="username"]'))
    .or(page.locator('input[type="text"]:not([name*="pass" i]):not([name*="otp" i]):not([name*="pin" i])'));
}

/** Password input locator chain. */
function passwordInputLocator(page: Page): Locator {
  return page.locator('input[type="password"]')
    .or(page.locator('input[name*="pass" i]'))
    .or(page.locator('input[id*="pass" i]'))
    .or(page.locator('input[autocomplete="current-password"]'));
}

/** Fill an input robustly: triple-click to select existing text, type, blur. */
async function fillInputRobustly(loc: Locator, value: string): Promise<boolean> {
  try {
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await loc.click({ timeout: 2_500 });
    // Select & delete any existing value (fill('') sometimes doesn't trigger
    // change events on controlled React inputs).
    await loc.click({ clickCount: 3 }).catch(() => {});
    await loc.press('Delete').catch(() => {});
    await loc.fill(value);
    // Blur to fire validation — Groww enables Continue only after a valid
    // email/mobile is detected, which happens on blur in some flows.
    await loc.evaluate((el: HTMLInputElement) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }).catch(() => {});
    const v = await loc.inputValue().catch(() => '');
    return v === value || v.length === value.length;
  } catch (e) {
    console.warn('[Groww] fillInputRobustly failed:', (e as Error).message);
    return false;
  }
}

/**
 * Fill ONE step of the credentials flow.
 *   - If email field is visible and empty, fill it.
 *   - If password field is visible and empty, fill it.
 * Returns the set of fields actually filled this step.
 *
 * Groww has both single-page (email+password together) and split-page
 * (email first → Continue → password next) flows. The caller loops over
 * this until both are filled or we reach a non-credentials step.
 */
async function fillVisibleCredentialFields(page: Page, username: string, password: string): Promise<{ filledEmail: boolean; filledPassword: boolean }> {
  let filledEmail = false;
  let filledPassword = false;

  // Email/mobile
  const userLoc = userInputLocator(page).first();
  if (await userLoc.isVisible({ timeout: 1_500 }).catch(() => false)) {
    const current = (await userLoc.inputValue().catch(() => '')).trim();
    if (current !== username && username) {
      if (await fillInputRobustly(userLoc, username)) {
        filledEmail = true;
        console.log('[Groww] Filled email/mobile.');
      }
    } else if (current === username) {
      filledEmail = true;  // already filled
    }
  }

  // Password
  const passLoc = passwordInputLocator(page).first();
  if (await passLoc.isVisible({ timeout: 1_500 }).catch(() => false)) {
    const current = (await passLoc.inputValue().catch(() => ''));
    if (current.length !== password.length && password) {
      if (await fillInputRobustly(passLoc, password)) {
        filledPassword = true;
        console.log('[Groww] Filled password.');
      }
    } else if (current.length === password.length) {
      filledPassword = true;
    }
  }

  return { filledEmail, filledPassword };
}

async function tagDigitBoxes(page: Page, digitsLen: number): Promise<number> {
  return page.evaluate((len) => {
    document.querySelectorAll('[data-groww-digit]').forEach(el => el.removeAttribute('data-groww-digit'));

    const visible = (el: HTMLInputElement) => {
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

    const all = Array.from(document.querySelectorAll<HTMLInputElement>('input')).filter(visible);
    const candidates = all.filter(i => {
      if (i.maxLength === 1) return true;
      if ((i.getAttribute('autocomplete') || '').toLowerCase() === 'one-time-code') return true;
      const a = attrs(i);
      if (/mobile|phone|email|user|search|^name$/.test(a)) return false;
      const r = i.getBoundingClientRect();
      return r.width > 0 && r.width <= 60 && r.height >= 28 && r.height <= 80;
    });
    if (candidates.length === 0) return 0;

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
    take.forEach((it, idx) => it.el.setAttribute('data-groww-digit', String(idx)));
    return take.length;
  }, digitsLen).catch(() => 0);
}

async function fillDigitsIntoBoxes(page: Page, digits: string): Promise<boolean> {
  const tagged = await tagDigitBoxes(page, digits.length);
  if (tagged < digits.length) return false;
  try {
    const first = page.locator('input[data-groww-digit="0"]').first();
    await first.scrollIntoViewIfNeeded().catch(() => {});
    await first.click({ timeout: 2_000 });
    await page.keyboard.type(digits, { delay: 70 });
    await page.waitForTimeout(200);
    const filled = await page.evaluate((len: number) => {
      const arr: string[] = [];
      for (let i = 0; i < len; i += 1) {
        const el = document.querySelector<HTMLInputElement>(`input[data-groww-digit="${i}"]`);
        arr.push(el?.value || '');
      }
      return arr.join('');
    }, digits.length);
    if (filled === digits) return true;

    // Native-setter fallback
    return page.evaluate((d: string) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      for (let i = 0; i < d.length; i += 1) {
        const el = document.querySelector<HTMLInputElement>(`input[data-groww-digit="${i}"]`);
        if (!el) return false;
        el.focus();
        if (setter) setter.call(el, d[i]); else el.value = d[i];
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: d[i], bubbles: true }));
      }
      for (let i = 0; i < d.length; i += 1) {
        const el = document.querySelector<HTMLInputElement>(`input[data-groww-digit="${i}"]`);
        if ((el?.value || '') !== d[i]) return false;
      }
      return true;
    }, digits);
  } catch (e) {
    console.warn('[Groww] fillDigitsIntoBoxes failed:', (e as Error).message);
    return false;
  }
}

async function fillSingleDigitInput(page: Page, digits: string): Promise<boolean> {
  const loc = page.locator('input[autocomplete="one-time-code"]')
    .or(page.locator('input[name*="otp" i]'))
    .or(page.locator('input[name*="pin" i]'))
    .or(page.locator('input[id*="otp" i]'))
    .or(page.locator('input[id*="pin" i]'))
    .or(page.locator(`input[maxlength="${digits.length}"]`))
    .or(page.locator('input[type="password"]'))
    .first();
  try {
    if (!(await loc.isVisible({ timeout: 1_500 }).catch(() => false))) return false;
    await loc.click({ timeout: 2_000 });
    await loc.fill('');
    await loc.fill(digits);
    return (await loc.inputValue().catch(() => '')).replace(/\D/g, '') === digits;
  } catch {
    return false;
  }
}

async function fillDigits(page: Page, digits: string): Promise<boolean> {
  if (!digits) return false;
  if (await fillDigitsIntoBoxes(page, digits)) return true;
  return fillSingleDigitInput(page, digits);
}

// ─── Click helpers ────────────────────────────────────────────────────────

async function clickPrimary(page: Page, labels: string[], opts: { waitEnabledMs?: number; force?: boolean } = {}): Promise<boolean> {
  const waitEnabledMs = opts.waitEnabledMs ?? 5_000;
  for (const label of labels) {
    // Five selector variants per label — handles <button>, <a>, role=button,
    // input[type=submit], AND div/span with the literal text inside.
    const btn = page.locator(`button:has-text("${label}")`)
      .or(page.locator(`[role="button"]:has-text("${label}")`))
      .or(page.locator(`input[type="submit"][value*="${label}" i]`))
      .or(page.locator(`a:has-text("${label}")`))
      .or(page.locator(`button[aria-label*="${label}" i]`))
      .first();
    if (!(await btn.isVisible({ timeout: 600 }).catch(() => false))) continue;
    const deadline = Date.now() + waitEnabledMs;
    while (!(await btn.isEnabled().catch(() => true)) && Date.now() < deadline) {
      await page.waitForTimeout(150);
    }
    const enabled = await btn.isEnabled().catch(() => true);
    if (!enabled && !opts.force) continue;
    await btn.click({ force: opts.force }).catch(() => {});
    console.log(`[Groww] Clicked button matching label "${label}"`);
    return true;
  }
  return false;
}

async function submitForm(page: Page, kind: 'CREDS' | 'OTP' | 'PIN'): Promise<boolean> {
  await page.waitForTimeout(450);
  // Labels broadened — Groww's buttons can read "Continue", "Get OTP",
  // "Continue with email", "Login", "Next" depending on the flow.
  const labels = kind === 'CREDS'
    ? ['Continue', 'Continue with email', 'Continue with mobile', 'Login', 'Sign In', 'Get OTP', 'Send OTP', 'Submit', 'Proceed', 'Next']
    : kind === 'OTP'
      ? ['Verify', 'Verify OTP', 'Submit', 'Continue', 'Confirm', 'Proceed', 'Login']
      : ['Continue', 'Submit', 'Confirm', 'Verify', 'Login', 'Set PIN', 'Done', 'Proceed', 'Next'];

  if (await clickPrimary(page, labels, { waitEnabledMs: 8_000 })) {
    return true;
  }

  // Strategy 2: press Enter on the focused input.
  await page.keyboard.press('Enter').catch(() => {});
  await page.waitForTimeout(700);

  // Strategy 3: ANY submit-shaped button.
  const submitBtn = page.locator('button[type="submit"]:visible')
    .or(page.locator('input[type="submit"]:visible'))
    .or(page.locator('form button:visible'))
    .first();
  if (await submitBtn.isVisible({ timeout: 700 }).catch(() => false)) {
    await submitBtn.click({ force: true }).catch(() => {});
    console.log(`[Groww] ${kind} submitted via submit-type button`);
    return true;
  }

  // Strategy 4: force-click any matching label even if marked disabled.
  if (await clickPrimary(page, labels, { waitEnabledMs: 0, force: true })) {
    return true;
  }

  // Strategy 5: programmatic form.submit().
  const submitted = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    const form = active?.closest('form');
    if (form) {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      try { (form as HTMLFormElement).submit(); } catch { /* might be blocked */ }
      return true;
    }
    // Or find ANY visible form on the page.
    const anyForm = Array.from(document.querySelectorAll('form')).find(f => {
      const r = (f as HTMLElement).getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (anyForm) {
      anyForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      try { (anyForm as HTMLFormElement).submit(); } catch { /* nope */ }
      return true;
    }
    return false;
  }).catch(() => false);
  if (submitted) {
    console.log(`[Groww] ${kind} submitted via programmatic form.submit()`);
    return true;
  }

  console.warn(`[Groww] All ${kind} submission strategies failed`);
  await dumpDiagnostics(page, `submit-${kind.toLowerCase()}-failed`);
  return false;
}

// ─── Overlays / diagnostics ───────────────────────────────────────────────

async function dismissOverlays(page: Page): Promise<void> {
  const targets: Locator[] = [
    page.getByRole('button', { name: /got\s*it/i }).first(),
    page.getByRole('button', { name: /^ok$/i }).first(),
    page.getByRole('button', { name: /^skip$/i }).first(),
    page.getByRole('button', { name: /close|dismiss/i }).first(),
    page.locator('button[aria-label*="close" i]').first(),
  ];
  for (const t of targets) {
    if (!(await t.isVisible({ timeout: 500 }).catch(() => false))) continue;
    await t.click({ timeout: 1_200 }).catch(() => {});
    await page.waitForTimeout(300);
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
        .map(b => `<btn> ${trim((b as HTMLElement).innerText)}`);
      return {
        url: location.href,
        title: document.title,
        snippet: trim((document.body?.innerText || '').slice(0, 300)),
        inputs, buttons,
      };
    });
    console.log(`[Groww][${label}] url=${info.url}`);
    console.log(`[Groww][${label}] title=${info.title}`);
    console.log(`[Groww][${label}] body="${info.snippet}"`);
    console.log(`[Groww][${label}] inputs:`, info.inputs);
    console.log(`[Groww][${label}] buttons:`, info.buttons);
  } catch (e) {
    console.warn(`[Groww][${label}] diagnostics failed:`, (e as Error).message);
  }
}

// ─── Balance scraping ─────────────────────────────────────────────────────

async function scrapeValue(page: Page, labels: string[]): Promise<string | null> {
  return page.evaluate((labels: string[]) => {
    const text = document.body?.innerText || '';
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
      await page.waitForTimeout(800);
      if (match.test(page.url())) return true;
    } catch { /* try next */ }
  }
  return false;
}

async function waitForAmount(page: Page, timeoutMs: number): Promise<boolean> {
  try {
    const result = await page.waitForFunction(() => {
      const text = (document.body as HTMLElement | null)?.innerText || '';
      if (/(?:₹|INR|Rs\.?)\s*-?\d[\d,]*(?:\.\d{1,2})?/i.test(text)) return 'amount';
      if (/no\s+(?:holdings?|positions?|investments?|data\s+found|records?)/i.test(text)) return 'empty';
      return null;
    }, { timeout: timeoutMs, polling: 200 }).then(h => h.jsonValue() as Promise<string>).catch(() => null);
    return result === 'amount';
  } catch {
    return false;
  }
}

// ─── Adapter ──────────────────────────────────────────────────────────────

export const growwAdapter: LoginAdapter = {
  code: 'GROWW',
  displayName: 'Groww',
  otpMode: 'manual',

  async login(page: Page, creds: LoginCredentials, _fetchOtp: () => Promise<string>): Promise<void> {
    const context = page.context();
    page = await findGrowwPage(context, page);

    // Navigate if not already on Groww.
    if (!safeUrl(page).includes('groww.in')) {
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    }
    await page.waitForTimeout(1_500);
    page = await findGrowwPage(context, page);

    let step = await waitForStep(page, ['credentials', 'otp', 'pin', 'dashboard'], 15_000);
    console.log(`[Groww] Initial step: ${step}`);

    // Already logged in?
    if (step === 'dashboard') {
      await dismissOverlays(page);
      console.log('[Groww] Already logged in (session cached).');
      return;
    }

    // 1) Credentials — Groww has TWO variants of this screen:
    //    A) Single page: email + password + Login
    //    B) Split pages: email → Continue → password → Login
    //    We loop up to 2 rounds so both flows resolve here.
    if (step === 'credentials') {
      let emailDone = false;
      let passwordDone = false;
      for (let round = 1; round <= 3 && step === 'credentials'; round += 1) {
        const filled = await fillVisibleCredentialFields(page, creds.username || '', creds.password || '');
        emailDone = emailDone || filled.filledEmail;
        passwordDone = passwordDone || filled.filledPassword;

        if (!filled.filledEmail && !filled.filledPassword && round === 1) {
          // Nothing visible was filled and nothing was already filled — bail.
          console.warn('[Groww] No credential field was visible on round 1.');
          await dumpDiagnostics(page, 'credentials-no-fields');
          return;
        }

        // Submit whatever's on this screen.
        const submitted = await submitForm(page, 'CREDS');
        if (!submitted) {
          console.warn(`[Groww] Credentials submit failed on round ${round}.`);
          await dumpDiagnostics(page, `credentials-submit-fail-r${round}`);
          return;
        }
        console.log(`[Groww] Credentials round ${round} submitted (emailDone=${emailDone}, passwordDone=${passwordDone}).`);

        // Wait for the next screen — could be the password page (still
        // 'credentials' for us), OTP, PIN, or dashboard.
        step = await waitForStep(page, ['credentials', 'otp', 'pin', 'dashboard'], 25_000);
        console.log(`[Groww] After credentials round ${round}: ${step}`);
        page = await findGrowwPage(context, page);

        // If both creds are filled and we're STILL on credentials, something
        // is wrong (e.g., wrong password). Stop looping to avoid spamming.
        if (step === 'credentials' && emailDone && passwordDone) {
          console.warn('[Groww] Still on credentials after both fields filled — credentials may be wrong.');
          await dumpDiagnostics(page, 'credentials-stuck-after-fill');
          return;
        }
      }
      if (step === 'unknown') await dumpDiagnostics(page, 'post-creds-unknown');
    }

    if (step === 'dashboard') {
      await dismissOverlays(page);
      console.log('[Groww] Logged in directly (no OTP/PIN).');
      return;
    }

    // 2) OTP (SMS — user must complete manually, we just wait)
    if (step === 'otp') {
      console.log('[Groww] OTP screen — complete the SMS OTP manually in the browser.');
      step = await waitForStep(page, ['pin', 'dashboard'], 120_000, 'expect-pin');
      console.log(`[Groww] Post-OTP step: ${step}`);
      page = await findGrowwPage(context, page);
    }

    if (step === 'dashboard') {
      await dismissOverlays(page);
      console.log('[Groww] Logged in after OTP.');
      return;
    }

    // 3) Groww PIN — try the stored password as a 4 or 6 digit PIN.
    if (step === 'pin') {
      // Some users save the 4-digit Groww PIN as `password`; if password
      // looks like a PIN (4-6 digits), try filling it. Otherwise wait.
      const pinCandidate = (creds.password || '').replace(/\D/g, '');
      if (pinCandidate.length >= 4 && pinCandidate.length <= 6) {
        if (await fillDigits(page, pinCandidate)) {
          console.log(`[Groww] PIN filled (${pinCandidate.length} digits).`);
          await submitForm(page, 'PIN');
        } else {
          console.warn('[Groww] PIN screen detected but auto-fill failed.');
          await dumpDiagnostics(page, 'pin-fill-fail');
        }
      } else {
        console.log('[Groww] PIN screen detected, but no numeric PIN saved — complete manually.');
      }

      step = await waitForStep(page, ['dashboard'], 90_000, 'expect-dashboard');
      page = await findGrowwPage(context, page);
      if (step !== 'dashboard') {
        await dumpDiagnostics(page, 'post-pin-no-dashboard');
      }
    }

    if (step === 'dashboard') {
      await dismissOverlays(page);
      console.log('[Groww] Login complete:', safeUrl(page));
    } else {
      console.warn(`[Groww] Did not reach dashboard — final step: ${step}`);
    }

    console.log('[Groww] Browser remains open.');
  },

  async fetchBalance(page: Page): Promise<string | null> {
    const t0 = Date.now();
    const INR = '₹';
    const parts: string[] = [];
    const context = page.context();
    page = await findGrowwPage(context, page);
    await dismissOverlays(page);

    // Wait briefly for SPA hydration.
    const ready = await waitForStep(page, ['dashboard'], 8_000);
    if (ready !== 'dashboard') {
      console.warn(`[Groww] fetchBalance: not on dashboard (step=${ready}), trying anyway`);
    }
    await dismissOverlays(page);

    // ── Funds ───────────────────────────────────────────────────────────
    page = await findGrowwPage(context, page);
    if (await navigateOrClick(
      page,
      GROWW_FUNDS_URLS,
      ['Funds', 'Balance', 'Account', 'Margin', 'My Account'],
      /user\/(?:account|balance)|funds|margin/i,
    )) {
      await waitForAmount(page, 6_000);
      const v = await scrapeValue(page, [
        'Available\\s+(?:to\\s+(?:Trade|Invest|Withdraw)|Balance|Cash|Margin|Funds?|Limit)',
        'Net\\s+Available', 'Withdrawable(?:\\s+Balance)?',
        'Total\\s+(?:Balance|Funds?)', 'Cash\\s+Balance',
        'Equity\\s+(?:Margin|Balance)', 'Trading\\s+Balance', 'Free\\s+Cash',
        'Wallet\\s+Balance', 'Account\\s+Balance',
      ]);
      if (v) parts.push(`Funds: ${INR}${v}`);
      else console.warn(`[Groww] Funds page rendered but no labeled value found at ${page.url()}`);
    } else {
      console.warn(`[Groww] Could not reach Funds page from ${page.url()}`);
    }

    // ── Holdings ────────────────────────────────────────────────────────
    page = await findGrowwPage(context, page);
    if (await navigateOrClick(
      page,
      GROWW_HOLDINGS_URLS,
      ['Holdings', 'Portfolio', 'Stocks', 'Investments'],
      /holding|portfolio|investment/i,
    )) {
      await waitForAmount(page, 6_000);
      const v = await scrapeValue(page, [
        'Current\\s+Value', 'Total\\s+(?:Current\\s+)?Value', 'Portfolio\\s+Value',
        'Market\\s+Value', 'Holdings?\\s+Value', 'Invested(?:\\s+Value)?',
        'Total\\s+Investment', 'Net\\s+Worth', 'Total\\s+Holdings',
      ]);
      if (v) parts.push(`Portfolio: ${INR}${v}`);
      else console.warn(`[Groww] Holdings page rendered but no labeled value found at ${page.url()}`);
    } else {
      console.warn(`[Groww] Could not reach Holdings page from ${page.url()}`);
    }

    // ── Positions ───────────────────────────────────────────────────────
    page = await findGrowwPage(context, page);
    if (await navigateOrClick(
      page,
      GROWW_POSITIONS_URLS,
      ['Positions', 'Position'],
      /position/i,
    )) {
      await page.waitForTimeout(1_000);
      const v = await scrapeValue(page, [
        'Net\\s+Value', 'Total\\s+Value', 'Net\\s+P&L', 'Total\\s+P&L',
        'P&L', 'PnL', 'P/L', 'M2M', 'MTM', 'Day\\s+P&L', 'Overall\\s+P&L',
      ]);
      if (v) parts.push(`Positions: ${INR}${v}`);
    }

    if (parts.length === 0) {
      console.warn(`[Groww] No balance values scraped (${Date.now() - t0}ms). Final URL: ${page.url()}`);
      await dumpDiagnostics(page, 'fetchBalance-no-values');
      return null;
    }
    const out = parts.join(' | ');
    console.log(`[Groww] Balance (${Date.now() - t0}ms):`, out);
    return out;
  },
};
