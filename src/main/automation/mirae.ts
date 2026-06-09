/**
 * mStock by Mirae Asset login adapter.
 *
 * Login URL : https://trade.mstock.com/
 *
 * mStock login flow (as of 2026):
 *   Step 0: First screen shows a QR code by default. Click the
 *           "Login with Credentials" / "Use Credentials" option to switch.
 *   Step 1: Enter Mobile Number AND Password (same screen) → Login
 *   Step 2: 6-digit OTP sent to registered email → fetched from Gmail
 *
 * The mobile number is stored in `creds.username`; the password in
 * `creds.password`. The OTP is fetched from Gmail via `fetchOtp()`.
 *
 * otpMode = 'email'
 */

import { Page, Locator } from 'playwright';
import { LoginAdapter, LoginCredentials } from './browser';

const LOGIN_URL = 'https://trade.mstock.com/';
const NOT_HIDDEN = ':not([type="checkbox"]):not([type="hidden"]):not([type="radio"])';

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
    console.log(`[mStock][debug:${label}] url = ${info.url}`);
    console.log(`[mStock][debug:${label}] visible buttons/links (${info.buttons.length}):`);
    info.buttons.forEach(b => console.log('  ' + b));
    console.log(`[mStock][debug:${label}] visible inputs (${info.inputs.length}):`);
    info.inputs.forEach(i => console.log('  ' + i));
  } catch (e) {
    console.warn(`[mStock][debug:${label}] dump failed:`, (e as Error).message);
  }
}

async function fillDigits(page: Page, digits: string, kind: 'OTP'): Promise<boolean> {
  const boxes = page.locator([
    'input[autocomplete="one-time-code"]',
    'input[maxlength="1"]',
    'input[data-testid*="otp" i]',
  ].join(', '));
  const boxCount = await boxes.count().catch(() => 0);

  if (boxCount >= digits.length) {
    try {
      await boxes.first().click();
      await page.keyboard.type(digits, { delay: 0 });
      console.log(`[mStock] ✓ ${kind} typed into ${digits.length} boxes`);
      return true;
    } catch (e) {
      console.warn(`[mStock] Multi-box ${kind} fill failed:`, (e as Error).message);
    }
  }

  const single: Locator = page.locator([
    'input[name="otp"]',
    'input[id="otp"]',
    'input[id*="otp" i]',
    'input[placeholder*="OTP" i]',
    'input[placeholder*="One Time" i]',
    'input[placeholder*="verification" i]',
    'input[maxlength="6"][type="text"]',
    'input[maxlength="6"][type="number"]',
    'input[maxlength="6"][type="tel"]',
  ].join(', ')).first();
  if (await single.isVisible().catch(() => false)) {
    await single.clear().catch(() => {});
    await single.fill(digits);
    console.log(`[mStock] ✓ ${kind} filled into single input`);
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

async function scrapeMstockBalance(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const text = (document.body as HTMLElement | null)?.innerText || '';
    if (!text) return null;
    // Require at least one digit before the decimal — guards against bogus
    // captures like "₹," from placeholder/template text.
    const AMT = '(\\d[\\d,]*(?:\\.\\d{1,2})?)';
    const labelled: RegExp[] = [
      new RegExp(`Available\\s+Balance[\\s\\S]{0,80}?(?:₹|INR|Rs\\.?)\\s*${AMT}`, 'i'),
      new RegExp(`Available\\s+Margin[\\s\\S]{0,80}?(?:₹|INR|Rs\\.?)\\s*${AMT}`, 'i'),
      new RegExp(`Available\\s+Funds?[\\s\\S]{0,80}?(?:₹|INR|Rs\\.?)\\s*${AMT}`, 'i'),
      new RegExp(`Available\\s+Cash[\\s\\S]{0,80}?(?:₹|INR|Rs\\.?)\\s*${AMT}`, 'i'),
      new RegExp(`Net\\s+Available[\\s\\S]{0,80}?(?:₹|INR|Rs\\.?)\\s*${AMT}`, 'i'),
      new RegExp(`Withdrawable\\s+Balance[\\s\\S]{0,80}?(?:₹|INR|Rs\\.?)\\s*${AMT}`, 'i'),
      new RegExp(`Total\\s+Balance[\\s\\S]{0,80}?(?:₹|INR|Rs\\.?)\\s*${AMT}`, 'i'),
      new RegExp(`Cash\\s+Balance[\\s\\S]{0,80}?(?:₹|INR|Rs\\.?)\\s*${AMT}`, 'i'),
    ];
    for (const re of labelled) {
      const m = text.match(re);
      if (m?.[1]) return m[1];
    }
    const first = text.match(new RegExp(`(?:₹|INR|Rs\\.?)\\s*${AMT}`, 'i'));
    return first?.[1] || null;
  });
}

export const miraeAdapter: LoginAdapter = {
  code: 'MIRAE',
  displayName: 'mStock by Mirae Asset',
  otpMode: 'email',

  async login(page: Page, creds: LoginCredentials, fetchOtp: () => Promise<string>): Promise<void> {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(2000);

    // ── Already-logged-in shortcut ───────────────────────────────────────────
    // mStock redirects logged-in sessions away from the QR/login screen.
    if (/trade\.mstock\.com\/(?!login|signin|auth)/.test(page.url()) && !/login|signin|auth/i.test(page.url())) {
      // Heuristic: if we landed on something other than the QR/login page, skip.
      const looksLoggedIn = await page.evaluate(() => {
        const t = (document.body as HTMLElement | null)?.innerText || '';
        return /Portfolio|Funds|Holdings|Watchlist|Dashboard|Orders/.test(t);
      }).catch(() => false);
      if (looksLoggedIn) {
        console.log('[mStock] ✓ Already logged in (session cached):', page.url());
        return;
      }
    }

    const MOBILE_FIELD_SEL = [
      // mStock specifically names the mobile field "username" (id + name)
      `input[name="username"]${NOT_HIDDEN}`,
      `input[id="username"]${NOT_HIDDEN}`,
      `input[placeholder*="Mobile" i]${NOT_HIDDEN}`,
      `input[placeholder*="Phone" i]${NOT_HIDDEN}`,
      'input[type="tel"]',
      'input[name="mobile"]',
      'input[name="phone"]',
      'input[name="mobileNumber"]',
      'input[autocomplete="tel"]',
      `input[type="text"][maxlength="10"]${NOT_HIDDEN}`,
      `input[inputmode="numeric"]${NOT_HIDDEN}`,
    ].join(', ');

    const QR_SWITCH_SEL = [
      'button:has-text("Login with Credentials")',
      'button:has-text("Login Using Credentials")',
      'button:has-text("Use Credentials")',
      'button:has-text("Login with Password")',
      'button:has-text("Login with Mobile")',
      'button:has-text("Use Mobile")',
      'a:has-text("Login with Credentials")',
      'a:has-text("Use Credentials")',
      'a:has-text("Credentials")',
      '[role="button"]:has-text("Credentials")',
      'div[role="button"]:has-text("Credentials")',
    ].join(', ');

    // ── Step 0: QR screen → switch to credentials login ──────────────────────
    // Wait for EITHER the credentials-switch button OR a mobile field
    // (in case mStock auto-skipped QR for this profile).
    const mobileField  = page.locator(MOBILE_FIELD_SEL).first();
    const qrSwitch     = page.locator(QR_SWITCH_SEL).first();

    let mobileFieldReady = false;
    try {
      await Promise.race([
        mobileField.waitFor({ state: 'visible', timeout: 30_000 }).then(() => { mobileFieldReady = true; }),
        qrSwitch.waitFor({ state: 'visible', timeout: 30_000 }),
      ]);
    } catch {
      console.warn('[mStock] Neither mobile field nor credentials-switch button appeared in 30s.');
      await dumpDiagnostics(page, 'qr-screen');
      return;
    }

    if (!mobileFieldReady && await qrSwitch.isVisible().catch(() => false)) {
      try {
        await qrSwitch.scrollIntoViewIfNeeded().catch(() => {});
        await qrSwitch.click();
        console.log('[mStock] ✓ Switched from QR to credentials login');
        await mobileField.waitFor({ state: 'visible', timeout: 15_000 });
        mobileFieldReady = true;
      } catch (e) {
        console.warn('[mStock] Clicked credentials-switch but mobile field never appeared:', (e as Error).message);
        await dumpDiagnostics(page, 'after-switch');
        return;
      }
    }

    if (!mobileFieldReady) {
      console.warn('[mStock] Mobile field not ready — aborting.');
      await dumpDiagnostics(page, 'mobile-not-ready');
      return;
    }

    // ── Step 1: Fill Mobile Number ────────────────────────────────────────────
    const mobile = (creds.username || '').replace(/\D/g, '').slice(-10);
    if (mobile.length !== 10) {
      console.warn(`[mStock] Mobile number "${creds.username}" is not 10 digits — proceeding anyway.`);
    }

    try {
      await mobileField.click();
      await mobileField.fill(mobile || creds.username);
      console.log('[mStock] ✓ Mobile number filled');
    } catch (e) {
      console.warn('[mStock] Could not fill mobile field:', (e as Error).message);
      await dumpDiagnostics(page, 'mobile-fill-fail');
      return;
    }

    // ── Step 2: Fill Password (same screen) ───────────────────────────────────
    try {
      const passField = page.locator([
        `input[type="password"]${NOT_HIDDEN}`,
        'input[name="password"]',
        'input[id="password"]',
        'input[id*="password" i]',
        'input[placeholder*="Password" i]',
      ].join(', ')).first();
      await passField.waitFor({ state: 'visible', timeout: 10_000 });
      await passField.click();
      await passField.fill(creds.password);
      console.log('[mStock] ✓ Password filled');
    } catch (e) {
      console.warn('[mStock] Could not find/fill password field:', (e as Error).message);
      await dumpDiagnostics(page, 'password-fill-fail');
      return;
    }

    // ── Click Login ───────────────────────────────────────────────────────────
    if (await clickPrimary(page, ['Login', 'LOGIN', 'Sign In', 'Submit', 'Continue', 'Proceed'])) {
      console.log('[mStock] ✓ Login submitted');
    } else {
      await page.keyboard.press('Enter').catch(() => {});
      console.log('[mStock] ✓ Pressed Enter to submit credentials');
    }

    // ── Step 3: Wait for OTP screen ───────────────────────────────────────────
    console.log('[mStock] ⏳ Waiting for OTP screen…');
    const otpProbe = page.locator([
      'input[autocomplete="one-time-code"]',
      'input[name="otp"]',
      'input[id*="otp" i]',
      'input[placeholder*="OTP" i]',
      'input[maxlength="1"]',
      'input[maxlength="6"]',
    ].join(', ')).first();

    try {
      await otpProbe.waitFor({ state: 'visible', timeout: 60_000 });
      await page.waitForTimeout(400);
      console.log('[mStock] ✓ OTP screen detected');
    } catch {
      console.warn('[mStock] OTP screen did not appear.');
      await dumpDiagnostics(page, 'no-otp-screen');
      return;
    }

    try {
      const otp = await fetchOtp();
      console.log('[mStock] ✓ OTP received:', otp);
      const filled = await fillDigits(page, otp, 'OTP');
      if (!filled) {
        console.warn('[mStock] Could not find OTP input(s) to fill.');
        await dumpDiagnostics(page, 'otp-fill-fail');
        return;
      }

      if (await clickPrimary(page, ['Verify', 'Submit', 'Continue', 'Confirm', 'Login'])) {
        console.log('[mStock] ✓ OTP submitted');
      } else {
        await page.keyboard.press('Enter').catch(() => {});
        console.log('[mStock] ✓ Pressed Enter to submit OTP');
      }
    } catch (e: any) {
      const msg: string = e?.message ?? String(e);
      if (msg.includes('OTP_TIMEOUT') || msg.includes('OTP_CANCELLED')) {
        console.warn('[mStock] OTP entry was cancelled or timed out.');
      } else {
        console.warn('[mStock] OTP step failed:', msg);
      }
      return;
    }

    // ── Step 4: Wait for post-login redirect ─────────────────────────────────
    try {
      await page.waitForFunction(() => {
        const url = location.href;
        const looksLoggedIn = !/login|signin|auth|otp/i.test(url);
        const dashSignal = /Portfolio|Funds|Holdings|Watchlist|Dashboard|Orders/.test(
          (document.body as HTMLElement | null)?.innerText || ''
        );
        return looksLoggedIn && dashSignal;
      }, { timeout: 30_000 });
      console.log('[mStock] ✓ Post-login dashboard detected:', page.url());
    } catch {
      console.warn('[mStock] Post-login dashboard not detected within 30s. Balance fetch may fail.');
    }

    console.log('[mStock] Browser remains open for IPO application.');
  },

  async fetchBalance(page: Page): Promise<string | null> {
    const t0 = Date.now();
    const INR = '₹';
    try {
      // mStock uses hash-based routing (e.g. /#/index/main-watchlist).
      // page.goto('/funds') hits the server, which serves the SPA shell
      // and bounces to the default route — never lands on Funds. Instead,
      // (1) click the in-app Funds/Wallet nav link, falling back to
      // (2) updating window.location.hash to a candidate hash route.

      let landed = false;

      // ── Strategy 1: hash-route directly (fast, known to work) ──────────
      // mStock's Funds tab is at #/index/funds. The remaining hashes are
      // safety nets in case the route is renamed. We don't waitForTimeout
      // between candidates — the URL changes synchronously on hash assignment.
      const hashCandidates = [
        '#/index/funds',
        '#/index/wallet',
        '#/index/money',
        '#/funds',
        '#/wallet',
        '#/account/funds',
      ];
      for (const hash of hashCandidates) {
        try {
          await page.evaluate((h) => { (window as any).location.hash = h; }, hash);
          if (/fund|wallet|money|cash/i.test(page.url())) {
            landed = true;
            console.log('[mStock] ✓ Hash-routed →', page.url());
            break;
          }
        } catch (e) {
          console.warn(`[mStock] hash nav to ${hash} failed:`, (e as Error).message);
        }
      }

      // ── Strategy 2: click the Funds/Wallet nav link (fallback) ─────────
      if (!landed) {
        const fundsLink = page.locator([
          'a:has-text("Funds")',
          'a:has-text("Wallet")',
          'a:has-text("Money")',
          'button:has-text("Funds")',
          'button:has-text("Wallet")',
          '[role="tab"]:has-text("Funds")',
          '[role="tab"]:has-text("Wallet")',
          'a[href*="funds" i]',
          'a[href*="wallet" i]',
        ].join(', ')).first();
        if (await fundsLink.isVisible().catch(() => false)) {
          try {
            // Tight timeout — off-screen sidebar links would otherwise burn 30s.
            await fundsLink.click({ timeout: 5_000 });
            await page.waitForTimeout(800);
            if (/fund|wallet|money|cash/i.test(page.url())) {
              landed = true;
              console.log('[mStock] ✓ Clicked nav link →', page.url());
            }
          } catch (e) {
            console.warn('[mStock] funds nav click failed:', (e as Error).message);
          }
        }
      }

      if (!landed) {
        console.warn('[mStock] Could not navigate to Funds page.');
        await dumpDiagnostics(page, 'no-funds-link');
        return null;
      }

      // Wait for a ₹ amount with at least one digit to render. Tight polling
      // so we exit as soon as the value paints.
      const found = await page.waitForFunction(() => {
        const text = (document.body as HTMLElement | null)?.innerText || '';
        return /(?:₹|INR|Rs\.?)\s*\d[\d,]*(?:\.\d{1,2})?/i.test(text) ? text : null;
      }, { timeout: 10_000, polling: 200 }).then(h => h.jsonValue() as Promise<string>).catch(() => null);

      if (!found) {
        console.warn(`[mStock] Funds page didn't render any ₹ amount within 15s (${Date.now() - t0}ms).`);
        await dumpDiagnostics(page, 'funds-page');
        return null;
      }

      const balance = await scrapeMstockBalance(page);
      if (!balance) {
        console.warn(`[mStock] Funds page rendered but balance label not found (${Date.now() - t0}ms).`);
        await dumpDiagnostics(page, 'funds-page-parse');
        return null;
      }

      const out = `${INR}${balance}`;
      console.log(`[mStock] ✓ Balance (${Date.now() - t0}ms):`, out);
      return out;
    } catch (e) {
      console.warn('[mStock] Balance fetch error:', (e as Error).message);
      return null;
    }
  },
};
