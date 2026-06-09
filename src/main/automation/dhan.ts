/**
 * Dhan login adapter.
 *
 * Login URL : https://login.dhan.co/
 *
 * Dhan login flow (as of 2026):
 *   Step 0: Platform-select screen — click the "Dhan" tile to advance to
 *           https://login.dhan.co/?location=DH_WEB
 *   Step 1: QR-code screen — Dhan defaults to QR sign-in via the mobile app.
 *           Click the "Login with Mobile Number" button to switch.
 *   Step 2: Enter Mobile Number (10 digits, +91 prefix preset) → Continue
 *   Step 3: 6-digit OTP sent to registered email → fetched from Gmail
 *   Step 4: Enter login PIN (typically 4-6 digits) → Login
 *
 * The mobile number is stored in `creds.username`; the PIN is stored in
 * `creds.password`. The OTP is fetched from Gmail via `fetchOtp()`.
 *
 * Dhan's OTP/PIN inputs are commonly rendered as 6 separate `<input>` boxes
 * (or 4 for the PIN). The adapter supports both: a single input field
 * (`fill`) and multi-box layouts (focus first box + `keyboard.type`).
 *
 * otpMode = 'email'
 */

import { Download, Page, Locator } from 'playwright';
import { DownloadedBrokerReport, LoginAdapter, LoginCredentials, resolveBrowserDownload } from './browser';

// Skip the platform-select screen entirely by deep-linking to the
// web-trading login. This is the URL the platform-select page redirects to
// when the "Dhan" tile is clicked.
const LOGIN_URL = 'https://login.dhan.co/?location=DH_WEB';
const DHAN_DASHBOARD_URL_RE = /^https:\/\/web\.dhan\.co(\/|$)/i;
const JOURNAL_HOLDINGS_URL = 'https://journal.dhan.co/holdings';
const JOURNAL_HOLDINGS_RE = /^https:\/\/journal\.dhan\.co\/holdings(?:[/?#]|$)/i;

async function waitForDhanDashboard(page: Page, timeout = 20_000): Promise<boolean> {
  try {
    await page.waitForURL(DHAN_DASHBOARD_URL_RE, { timeout });
    return true;
  } catch {
    return DHAN_DASHBOARD_URL_RE.test(page.url());
  }
}

/**
 * Dump a list of visible buttons, inputs, and links on the current page —
 * helps debug when our selectors don't match Dhan's actual DOM.
 */
async function dumpDiagnostics(page: Page, label: string): Promise<void> {
  try {
    const info = await page.evaluate(() => {
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'))
        .filter(visible)
        .slice(0, 20)
        .map(el => {
          const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
          const tag = el.tagName.toLowerCase();
          const id  = (el as HTMLElement).id || '';
          const cls = ((el as HTMLElement).className || '').toString().slice(0, 40);
          return `<${tag}${id ? ' id="' + id + '"' : ''}${cls ? ' class="' + cls + '"' : ''}> ${txt}`;
        });
      const inputs = Array.from(document.querySelectorAll('input'))
        .filter(visible)
        .slice(0, 15)
        .map(el => {
          const i = el as HTMLInputElement;
          return `<input type="${i.type}" name="${i.name || ''}" id="${i.id || ''}" placeholder="${i.placeholder || ''}" maxlength="${i.maxLength}" autocomplete="${i.autocomplete || ''}">`;
        });
      return { url: location.href, buttons, inputs };
    });
    console.log(`[Dhan][debug:${label}] url = ${info.url}`);
    console.log(`[Dhan][debug:${label}] visible buttons/links (${info.buttons.length}):`);
    info.buttons.forEach(b => console.log('  ' + b));
    console.log(`[Dhan][debug:${label}] visible inputs (${info.inputs.length}):`);
    info.inputs.forEach(i => console.log('  ' + i));
  } catch (e) {
    console.warn(`[Dhan][debug:${label}] dump failed:`, (e as Error).message);
  }
}

/**
 * Type a digit string into either a single OTP/PIN input or a row of
 * single-character boxes. Returns true if at least one input was filled.
 */
async function fillDigits(page: Page, digits: string, kind: 'OTP' | 'PIN'): Promise<boolean> {
  const boxSelector = [
    'input[autocomplete="one-time-code"]',
    'input[maxlength="1"]',
    'input[data-testid*="otp" i]',
    'input[data-testid*="pin" i]',
  ].join(', ');
  const boxes = page.locator(boxSelector);
  const boxCount = await boxes.count().catch(() => 0);

  // Multi-box layout (Dhan typically uses this for OTP and PIN)
  // delay: 60ms per keystroke — fast enough to feel instant, slow enough for
  // React's auto-advance-on-input handler between boxes to process each digit.
  // delay: 0 caused Dhan to read a garbled PIN (digits lost between boxes).
  if (boxCount >= digits.length) {
    try {
      await boxes.first().click();
      await page.keyboard.type(digits, { delay: 60 });
      await page.waitForTimeout(120);
      console.log(`[Dhan] ✓ ${kind} typed into ${digits.length} boxes`);
      return true;
    } catch (e) {
      console.warn(`[Dhan] Multi-box ${kind} fill failed:`, (e as Error).message);
    }
  }

  // Single-input fallback
  const singleSelectors = kind === 'OTP'
    ? [
      'input[name="otp"]',
      'input[id="otp"]',
      'input[id*="otp" i]',
      'input[placeholder*="OTP" i]',
      'input[placeholder*="One Time" i]',
      'input[placeholder*="verification" i]',
      'input[maxlength="6"][type="text"]',
      'input[maxlength="6"][type="number"]',
      'input[maxlength="6"][type="tel"]',
    ]
    : [
      'input[name="pin"]',
      'input[id="pin"]',
      'input[id*="pin" i]',
      'input[placeholder*="PIN" i]',
      'input[placeholder*="MPIN" i]',
      'input[type="password"]',
    ];
  const single: Locator = page.locator(singleSelectors.join(', ')).first();
  if (await single.isVisible().catch(() => false)) {
    await single.clear().catch(() => {});
    await single.fill(digits);
    console.log(`[Dhan] ✓ ${kind} filled into single input`);
    return true;
  }

  return false;
}

async function clickPrimary(page: Page, labels: string[]): Promise<boolean> {
  const selector = [
    ...labels.map(l => `button:has-text("${l}")`),
    'button[type="submit"]',
    'input[type="submit"]',
  ].join(', ');
  const btn = page.locator(selector).first();
  if (await btn.isVisible().catch(() => false)) {
    const enabled = await btn.isEnabled().catch(() => true);
    if (!enabled) return false;
    await btn.click();
    return true;
  }
  return false;
}

export const dhanAdapter: LoginAdapter = {
  code: 'DHAN',
  displayName: 'Dhan',
  otpMode: 'email',

  async login(page: Page, creds: LoginCredentials, fetchOtp: () => Promise<string>): Promise<void> {
    // ── Navigate directly to the web-trading login (skips platform-select) ──
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(800);

    // ── Already-logged-in shortcut ───────────────────────────────────────────
    // If Dhan's persistent profile has a live session, login.dhan.co immediately
    // redirects to web.dhan.co/index/* — no QR / OTP / PIN needed.
    if (DHAN_DASHBOARD_URL_RE.test(page.url())) {
      console.log('[Dhan] ✓ Already logged in (session cached):', page.url());
      return;
    }

    const MOBILE_FIELD_SEL = [
      'input[type="tel"]',
      'input[name="mobile"]',
      'input[name="phone"]',
      'input[name="mobileNumber"]',
      'input[id*="mobile" i]',
      'input[id*="phone" i]',
      'input[placeholder*="mobile" i]',
      'input[placeholder*="phone" i]',
      'input[autocomplete="tel"]',
      'input[maxlength="10"]',
      'input[inputmode="numeric"]',
    ].join(', ');

    const MOBILE_SWITCH_SEL = [
      'button:has-text("Login with Mobile Number")',
      'button:has-text("Login with Mobile")',
      'button:has-text("Show login with Mobile")',
      'button:has-text("Use Mobile Number")',
      'button:has-text("Mobile Number")',
      'button:has-text("Use mobile")',
      'a:has-text("Login with Mobile Number")',
      'a:has-text("Show login with Mobile")',
      'a:has-text("Use Mobile Number")',
      'a:has-text("Mobile Number")',
      '[role="button"]:has-text("Mobile Number")',
      'div[role="button"]:has-text("Mobile")',
    ].join(', ');

    // ── Step 1: QR screen → switch to Mobile Number login ────────────────────
    // Wait for EITHER the QR-switch button OR the mobile field to appear,
    // whichever comes first. Some sessions skip the QR screen on cached state.
    const mobileField  = page.locator(MOBILE_FIELD_SEL).first();
    const mobileSwitch = page.locator(MOBILE_SWITCH_SEL).first();
    const mobileSwitchText = page.getByText(/show\s+login\s+with\s+mobile/i).first();

    let mobileFieldReady = false;
    try {
      await Promise.race([
        mobileField.waitFor({ state: 'visible', timeout: 30_000 }).then(() => { mobileFieldReady = true; }),
        mobileSwitch.waitFor({ state: 'visible', timeout: 30_000 }),
        mobileSwitchText.waitFor({ state: 'visible', timeout: 30_000 }),
      ]);
    } catch {
      console.warn('[Dhan] Neither mobile field nor mobile-switch button appeared in 30s.');
      await dumpDiagnostics(page, 'qr-screen');
      console.warn('[Dhan] Please complete login manually — copy the diagnostic above so we can fix selectors.');
      return;
    }

    if (!mobileFieldReady) {
      try {
        const switchTarget = await mobileSwitch.isVisible().catch(() => false)
          ? mobileSwitch
          : mobileSwitchText;
        await switchTarget.scrollIntoViewIfNeeded().catch(() => {});
        await switchTarget.click();
        console.log('[Dhan] ✓ Switched from QR to Mobile Number login');
        await mobileField.waitFor({ state: 'visible', timeout: 15_000 });
        mobileFieldReady = true;
      } catch (e) {
        console.warn('[Dhan] Clicked mobile-switch but mobile field never appeared:', (e as Error).message);
        await dumpDiagnostics(page, 'after-switch');
        return;
      }
    }

    if (!mobileFieldReady) {
      console.warn('[Dhan] Mobile field not ready — aborting.');
      await dumpDiagnostics(page, 'mobile-not-ready');
      return;
    }

    // ── Step 2: Enter Mobile Number ───────────────────────────────────────────
    const mobile = (creds.username || '').replace(/\D/g, '').slice(-10);
    if (mobile.length !== 10) {
      console.warn(`[Dhan] Mobile number "${creds.username}" is not 10 digits — proceeding anyway.`);
    }

    try {
      await mobileField.click();
      await mobileField.fill(mobile || creds.username);
      console.log('[Dhan] ✓ Mobile number filled');
    } catch (e) {
      console.warn('[Dhan] Could not fill mobile field:', (e as Error).message);
      await dumpDiagnostics(page, 'mobile-fill-fail');
      return;
    }

    // ── Click Continue (after mobile) ─────────────────────────────────────────
    if (await clickPrimary(page, ['Continue', 'CONTINUE', 'Next', 'Get OTP', 'Send OTP', 'Proceed'])) {
      console.log('[Dhan] ✓ Clicked Continue after mobile');
    } else {
      // Some pages auto-advance on Enter
      await page.keyboard.press('Enter').catch(() => {});
      console.log('[Dhan] ✓ Pressed Enter after mobile');
    }

    // ── Step 2: Wait for OTP or PIN screen ───────────────────────────────────
    console.log('[Dhan] ⏳ Waiting for OTP or PIN screen…');
    const otpProbe = page.locator([
      'input[autocomplete="one-time-code"]',
      'input[name="otp"]',
      'input[id*="otp" i]',
      'input[placeholder*="OTP" i]',
      'input[maxlength="1"]',
      'input[maxlength="6"]',
    ].join(', ')).first();
    const pinProbe = page.locator([
      'input[type="password"]',
      'input[name="pin"]',
      'input[id*="pin" i]',
      'input[placeholder*="PIN" i]',
      'input[placeholder*="MPIN" i]',
    ].join(', ')).first();

    let nextStep: 'otp' | 'pin' | 'logged-in' = 'otp';

    try {
      await Promise.race([
        otpProbe.waitFor({ state: 'visible', timeout: 60_000 }).then(() => {
          nextStep = 'otp';
        }),
        pinProbe.waitFor({ state: 'visible', timeout: 60_000 }).then(() => {
          nextStep = 'pin';
        }),
        waitForDhanDashboard(page, 60_000).then((ready) => {
          if (ready) nextStep = 'logged-in';
          else throw new Error('dashboard-not-ready');
        })
      ]);
      await page.waitForTimeout(150);
      if (nextStep === 'otp') {
        console.log('[Dhan] ✓ OTP screen detected');
      } else if (nextStep === 'pin') {
        console.log('[Dhan] ✓ PIN screen detected without a separate OTP step');
      } else {
        console.log('[Dhan] ✓ Logged in without an OTP/PIN prompt:', page.url());
        console.log('[Dhan] Browser remains open for IPO application.');
        return;
      }
    } catch {
      console.warn('[Dhan] Neither OTP nor PIN screen appeared — login may have failed or selectors changed.');
      await dumpDiagnostics(page, 'post-mobile');
      return;
    }

    // ── Fetch OTP from Gmail and fill, if needed ─────────────────────────────
    if (nextStep === 'otp') {
      try {
        const otp = await fetchOtp();
        console.log('[Dhan] ✓ OTP received:', otp);
        const filled = await fillDigits(page, otp, 'OTP');
        if (!filled) {
          console.warn('[Dhan] Could not find OTP input(s) to fill.');
          return;
        }

        // OTP screen often auto-advances on 6 digits; click Submit if present
        if (await clickPrimary(page, ['Verify', 'Submit', 'Continue', 'Confirm'])) {
          console.log('[Dhan] ✓ OTP submitted');
        } else {
          await page.keyboard.press('Enter').catch(() => {});
          console.log('[Dhan] ✓ Pressed Enter to submit OTP');
        }
      } catch (e: any) {
        const msg: string = e?.message ?? String(e);
        if (msg.includes('OTP_TIMEOUT') || msg.includes('OTP_CANCELLED')) {
          console.warn('[Dhan] OTP entry was cancelled or timed out.');
        } else {
          console.warn('[Dhan] OTP step failed:', msg);
        }
        return;
      }
    }

    // ── Step 3: Wait for PIN screen ───────────────────────────────────────────
    console.log('[Dhan] ⏳ Waiting for PIN screen…');
    const pinWaitProbe = page.locator([
      'input[type="password"]',
      'input[name="pin"]',
      'input[id*="pin" i]',
      'input[placeholder*="PIN" i]',
      'input[placeholder*="MPIN" i]',
      'input[autocomplete="one-time-code"]',
      'input[maxlength="1"]',
    ].join(', ')).first();

    try {
      await pinWaitProbe.waitFor({ state: 'visible', timeout: 30_000 });
      await page.waitForTimeout(150);
      console.log('[Dhan] ✓ PIN screen detected');
    } catch {
      console.warn('[Dhan] PIN screen did not appear — Dhan may have logged in directly.');
      return;
    }

    // ── Fill PIN ──────────────────────────────────────────────────────────────
    try {
      const pin = (creds.password || '').replace(/\D/g, '');
      const filled = await fillDigits(page, pin, 'PIN');
      if (!filled) {
        console.warn('[Dhan] Could not find PIN input(s) to fill.');
        return;
      }

      if (await clickPrimary(page, ['Login', 'LOGIN', 'Sign In', 'Continue', 'Submit'])) {
        console.log('[Dhan] ✓ PIN submitted');
      } else {
        await page.keyboard.press('Enter').catch(() => {});
        console.log('[Dhan] ✓ Pressed Enter to submit PIN');
      }
    } catch (e) {
      console.warn('[Dhan] PIN step failed:', (e as Error).message);
      return;
    }

    // ── Step 4: Wait for post-login redirect ─────────────────────────────────
    // After PIN, Dhan typically redirects to web.dhan.co (the trading app).
    try {
      const ready = await waitForDhanDashboard(page, 20_000);
      if (ready) {
        console.log('[Dhan] ✓ Post-login dashboard detected:', page.url());
      } else {
        console.warn('[Dhan] Post-login redirect not detected within 20s. Balance fetch may fail.');
      }
    } catch {
      console.warn('[Dhan] Post-login redirect check failed. Balance fetch may fail.');
    }

    console.log('[Dhan] Browser remains open for IPO application.');
  },

  async fetchBalance(page: Page): Promise<string | null> {
    const t0 = Date.now();
    const INR = '₹';
    const parts: string[] = [];
    try {
      // ── Funds (Money tab) ────────────────────────────────────────────────
      const funds = await fetchDhanTabValue(page, {
        url: 'https://web.dhan.co/index/money',
        urlMatch: /index\/money/,
        kind: 'funds',
        labels: [
          'Available\\s+Balance', 'Available\\s+Margin', 'Available\\s+Funds?',
          'Withdrawable\\s+Balance', 'Total\\s+Balance', 'Cash\\s+Balance',
        ],
      });
      if (funds) parts.push(`Funds: ${INR}${funds}`);

      // ── Portfolio (Holdings) ─────────────────────────────────────────────
      const portfolio = await fetchDhanTabValue(page, {
        url: 'https://web.dhan.co/index/portfolio',
        urlMatch: /index\/portfolio/,
        kind: 'portfolio',
        labels: [
          'Current\\s+Value', 'Portfolio\\s+Value', 'Total\\s+Value',
          'Market\\s+Value', 'Holdings?\\s+Value', 'Invested',
        ],
      });
      if (portfolio) parts.push(`Portfolio: ${INR}${portfolio}`);

      // ── Positions ────────────────────────────────────────────────────────
      // If the user has no open positions Dhan often renders an empty-state
      // (no ₹ amount). We tolerate that and just skip the part.
      const positions = await fetchDhanTabValue(page, {
        url: 'https://web.dhan.co/index/positions',
        urlMatch: /index\/positions/,
        kind: 'positions',
        labels: [
          'Net\\s+Value', 'Total\\s+Value', 'Net\\s+P&L', 'Total\\s+P&L',
          'M2M', 'MTM', 'Mark[\\s-]?to[\\s-]?Market',
        ],
        allowEmpty: true,
      });
      if (positions) parts.push(`Positions: ${INR}${positions}`);

      if (parts.length === 0) {
        console.warn(`[Dhan] No values scraped from any tab (${Date.now() - t0}ms).`);
        return null;
      }

      const out = parts.join(' | ');
      console.log(`[Dhan] ✓ Balance (${Date.now() - t0}ms):`, out);
      return out;
    } catch (e) {
      console.warn('[Dhan] Balance fetch error:', (e as Error).message);
      return parts.length > 0 ? parts.join(' | ') : null;
    }
  },

  async downloadPortfolioReport(page: Page, creds: LoginCredentials, fetchOtp: () => Promise<string>): Promise<DownloadedBrokerReport | null> {
    const t0 = Date.now();
    await dhanAdapter.login(page, creds, fetchOtp);

    const journalPage = await ensureDhanJournalHoldingsPage(page);
    const asOfDate = (await readDhanJournalDate(journalPage)) || todayIso();
    await ensureDhanHoldingsTab(journalPage);
    const downloadStartedAt = Date.now();
    const download = await triggerDhanHoldingsDownload(journalPage);
    const savedDownload = await resolveBrowserDownload(journalPage, download, downloadStartedAt);
    const fileName = savedDownload.fileName || download.suggestedFilename() || `dhan-holdings-${asOfDate}.xlsx`;
    console.log(`[Dhan] Holdings report downloaded (${Date.now() - t0}ms total):`, fileName);

    return {
      reportKind: 'holdings',
      asOfDate,
      fileName,
      filePath: savedDownload.filePath,
    };
  },
};

/**
 * Navigate to a Dhan tab URL, wait for ₹ to render, scrape the labelled
 * value (with first-₹ fallback). Returns the digit string or null.
 *
 * On `allowEmpty: true`, an empty-state page (no ₹) returns null without
 * a warning log — used for Positions where "no open positions" is normal.
 */
async function fetchDhanTabValue(page: Page, opts: {
  url: string;
  urlMatch: RegExp;
  kind: 'funds' | 'portfolio' | 'positions';
  labels: string[];
  allowEmpty?: boolean;
}): Promise<string | null> {
  try {
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (e) {
    console.warn(`[Dhan] goto ${opts.kind} failed:`, (e as Error).message);
    return null;
  }

  const rendered = await page.waitForFunction((re: string) => {
    const text = (document.body as HTMLElement | null)?.innerText || '';
    if (!new RegExp(re).test(location.href)) return null;
    return /(?:₹|INR|Rs\.?)\s*\d[\d,]*(?:\.\d{1,2})?/i.test(text) ? text : null;
  }, opts.urlMatch.source, { timeout: 12_000, polling: 250 }).then(h => h.jsonValue() as Promise<string>).catch(() => null);

  if (!rendered) {
    if (!opts.allowEmpty) {
      console.warn(`[Dhan] ${opts.kind} page didn't render any ₹ amount within 12s.`);
      await dumpDiagnostics(page, `${opts.kind}-page`);
    } else {
      console.log(`[Dhan] ${opts.kind} page is empty (no open positions).`);
    }
    return null;
  }

  const value = await page.evaluate((labels: string[]) => {
    const text = (document.body as HTMLElement | null)?.innerText || '';
    const AMT = '(\\d[\\d,]*(?:\\.\\d{1,2})?)';
    for (const lbl of labels) {
      const re = new RegExp(`${lbl}[\\s\\S]{0,80}?(?:₹|INR|Rs\\.?)\\s*${AMT}`, 'i');
      const m = text.match(re);
      if (m?.[1]) return m[1];
    }
    const first = text.match(new RegExp(`(?:₹|INR|Rs\\.?)\\s*${AMT}`, 'i'));
    return first?.[1] || null;
  }, opts.labels);

  if (!value) {
    console.warn(`[Dhan] ${opts.kind} page rendered but value not parsed.`);
    await dumpDiagnostics(page, `${opts.kind}-page-parse`);
  }
  return value;
}

async function ensureDhanJournalHoldingsPage(page: Page): Promise<Page> {
  try {
    await page.goto(JOURNAL_HOLDINGS_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    // isDhanJournalHoldingsReady already waits up to 8s polling — no need for
    // an additional fixed sleep here.
    if (await isDhanJournalHoldingsReady(page)) {
      console.log('[Dhan] Journal holdings opened directly:', page.url());
      return page;
    }
  } catch (e) {
    console.warn('[Dhan] Direct journal holdings open failed:', (e as Error).message);
  }

  console.log('[Dhan] Falling back to web profile -> Journal by Dhan...');
  await page.goto('https://web.dhan.co/index', { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
  await page.waitForTimeout(400);

  const profileOpened = await clickAny(page, [
    page.getByText(/profile\s*&\s*account details/i).first(),
    page.getByText(/account details/i).first(),
    page.getByText(/profile/i).first(),
    page.locator('[aria-label*="profile" i], [title*="profile" i], img[alt*="profile" i], img[alt*="account" i]').first(),
  ]);

  if (!profileOpened) {
    console.warn('[Dhan] Could not open profile area before Journal by Dhan.');
  }

  const journalPage = await clickTextMaybePopup(page, /journal by dhan/i);
  if (!journalPage) {
    await dumpDiagnostics(page, 'journal-entry-missing');
    throw new Error('Journal by Dhan option not found');
  }

  await journalPage.waitForLoadState('domcontentloaded').catch(() => {});

  if (!(await isDhanJournalHoldingsReady(journalPage))) {
    try {
      await journalPage.goto(JOURNAL_HOLDINGS_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (e) {
      console.warn('[Dhan] Journal holdings goto after profile handoff failed:', (e as Error).message);
    }
  }

  if (!(await isDhanJournalHoldingsReady(journalPage))) {
    await dumpDiagnostics(journalPage, 'journal-holdings-not-ready');
    throw new Error('Dhan Journal holdings page did not become ready');
  }

  console.log('[Dhan] Journal holdings page ready:', journalPage.url());
  return journalPage;
}

async function ensureDhanHoldingsTab(page: Page): Promise<void> {
  if (await clickAny(page, [
    page.getByText(/^holdings$/i).first(),
    page.getByRole('link', { name: /holdings/i }).first(),
    page.getByRole('button', { name: /holdings/i }).first(),
  ])) {
    await page.waitForTimeout(500);
  }
}

async function isDhanJournalHoldingsReady(page: Page): Promise<boolean> {
  if (!JOURNAL_HOLDINGS_RE.test(page.url())) return false;
  try {
    return await page.waitForFunction(() => {
      const text = (document.body as HTMLElement | null)?.innerText || '';
      return /holdings/i.test(text)
        && /investment/i.test(text)
        && /current value/i.test(text)
        && /(excel|xlsx|csv)/i.test(text);
    }, { timeout: 8_000, polling: 250 }).then(() => true).catch(() => false);
  } catch {
    return false;
  }
}

async function triggerDhanHoldingsDownload(page: Page): Promise<Download> {
  const candidates: Locator[] = [
    page.getByText(/^excel$/i).first(),
    page.getByText(/^xlsx$/i).first(),
    page.getByRole('button', { name: /excel/i }).first(),
    page.getByRole('button', { name: /xlsx/i }).first(),
    page.getByRole('link', { name: /excel/i }).first(),
    page.getByRole('link', { name: /xlsx/i }).first(),
    page.getByText(/^csv$/i).first(),
    page.getByRole('button', { name: /^csv$/i }).first(),
  ];

  for (const candidate of candidates) {
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const enabled = await candidate.isEnabled().catch(() => true);
    if (!enabled) continue;
    console.log('[Dhan] Attempting holdings download...');
    const downloadPromise = page.waitForEvent('download', { timeout: 20_000 });
    await candidate.scrollIntoViewIfNeeded().catch(() => {});
    await candidate.click();
    try {
      const download = await downloadPromise;
      console.log('[Dhan] Holdings download started');
      return download;
    } catch (e) {
      console.warn('[Dhan] Download click did not start a file:', (e as Error).message);
    }
  }

  await dumpDiagnostics(page, 'journal-download-missing');
  throw new Error('Excel / CSV download button not found on Dhan Journal holdings page');
}

async function clickAny(page: Page, locators: Locator[]): Promise<boolean> {
  for (const locator of locators) {
    try {
      if (!(await locator.isVisible({ timeout: 800 }).catch(() => false))) continue;
      await locator.scrollIntoViewIfNeeded().catch(() => {});
      await locator.click();
      await page.waitForTimeout(250);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function clickTextMaybePopup(page: Page, pattern: RegExp): Promise<Page | null> {
  const ctx = page.context();
  const before = new Set(ctx.pages());
  const candidates: Locator[] = [
    page.getByText(pattern).first(),
    page.getByRole('link', { name: pattern }).first(),
    page.getByRole('button', { name: pattern }).first(),
  ];

  for (const candidate of candidates) {
    try {
      if (!(await candidate.isVisible({ timeout: 800 }).catch(() => false))) continue;
      await candidate.scrollIntoViewIfNeeded().catch(() => {});
      await candidate.click();
      // Wait briefly for popup to spawn — race rather than fixed sleep.
      const popup = await Promise.race([
        ctx.waitForEvent('page', { timeout: 2_500 }).catch(() => null),
        page.waitForTimeout(400).then(() => null),
      ]);
      const fallback = ctx.pages().find(p => !before.has(p));
      const target = popup || fallback || page;
      await target.bringToFront().catch(() => {});
      return target;
    } catch {
      continue;
    }
  }

  return null;
}

async function readDhanJournalDate(page: Page): Promise<string | null> {
  const dateInput = page.locator('input[type="date"]').first();
  if (await dateInput.isVisible().catch(() => false)) {
    const value = (await dateInput.inputValue().catch(() => '')).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  }

  try {
    const text = await page.evaluate(() => (document.body as HTMLElement | null)?.innerText || '');
    const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const dmy = text.match(/\b(\d{2})[\/-](\d{2})[\/-](\d{4})\b/);
    if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  } catch {
    return null;
  }

  return null;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
