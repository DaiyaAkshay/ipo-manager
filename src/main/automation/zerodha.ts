import { Download, Locator, Page } from 'playwright';
import { TOTP } from 'totp-generator';
import { DownloadedBrokerReport, LoginAdapter, LoginCredentials, resolveBrowserDownload } from './browser';

const LOGIN_URL = 'https://kite.zerodha.com/';
const CONSOLE_HOLDINGS_URL = 'https://console.zerodha.com/portfolio/holdings';
const ZERODHA_DASHBOARD_RE = /kite\.zerodha\.com\/(dashboard|holdings|positions|orders|funds|account)/;
const CONSOLE_HOLDINGS_RE = /console\.zerodha\.com\/portfolio\/holdings/i;

export const zerodhaAdapter: LoginAdapter = {
  code: 'ZERODHA',
  displayName: 'Zerodha Kite',
  otpMode: 'totp',

  async login(page: Page, creds: LoginCredentials, fetchOtp: () => Promise<string>): Promise<void> {
    await ensureKiteSession(page, creds, fetchOtp);
    await dismissZerodhaBlockingOverlays(page);
    console.log('[Zerodha] Browser remains open for IPO application.');
  },

  async fetchBalance(page: Page): Promise<string | null> {
    const t0 = Date.now();
    const INR = '\u20B9';
    const parts: string[] = [];
    const fmt = (v: string) => v.startsWith('-') ? `-${INR}${v.slice(1)}` : `${INR}${v}`;

    try {
      const funds = await fetchZerodhaTabValue(page, {
        url: 'https://kite.zerodha.com/funds',
        urlMatch: /\/funds/,
        kind: 'funds',
        labels: [
          'Available\\s+margin\\s*\\(Cash\\s*\\+\\s*Collateral\\)',
          'Available\\s+margin',
          'Available\\s+cash',
          'Available\\s+balance',
          'Opening\\s+balance',
          'Cash\\s+balance',
        ],
      });
      if (funds !== null) parts.push(`Funds: ${fmt(funds)}`);

      const portfolio = await fetchZerodhaTabValue(page, {
        url: 'https://kite.zerodha.com/holdings',
        urlMatch: /\/holdings/,
        kind: 'portfolio',
        labels: [
          'Current\\s+value',
          'Holdings?\\s+value',
          'Total\\s+value',
          'Market\\s+value',
          'Portfolio\\s+value',
          'Investment',
        ],
        allowEmpty: true,
      });
      if (portfolio !== null) parts.push(`Portfolio: ${fmt(portfolio)}`);

      const positions = await fetchZerodhaTabValue(page, {
        url: 'https://kite.zerodha.com/positions',
        urlMatch: /\/positions/,
        kind: 'positions',
        labels: [
          'Net\\s+P&L',
          "Day's\\s+P&L",
          'Total\\s+P&L',
          'Net\\s+value',
          'Total\\s+value',
          'M2M',
          'MTM',
        ],
        allowEmpty: true,
      });
      if (positions !== null) parts.push(`Positions: ${fmt(positions)}`);

      if (parts.length === 0) {
        console.warn(`[Zerodha] No values scraped from any tab (${Date.now() - t0}ms).`);
        return null;
      }

      const out = parts.join(' | ');
      console.log(`[Zerodha] Balance (${Date.now() - t0}ms):`, out);
      return out;
    } catch (e) {
      console.warn('[Zerodha] Balance fetch error:', (e as Error).message);
      return parts.length > 0 ? parts.join(' | ') : null;
    }
  },

  async downloadPortfolioReport(page: Page, creds: LoginCredentials, fetchOtp: () => Promise<string>): Promise<DownloadedBrokerReport | null> {
    const t0 = Date.now();
    await ensureConsoleHoldingsPage(page, creds, fetchOtp);
    console.log(`[Zerodha] Console holdings became ready in ${Date.now() - t0}ms`);

    const asOfDate = await readConsoleAsOfDate(page);
    const downloadStartedAt = Date.now();
    const download = await triggerConsoleHoldingsDownload(page);
    const completionStart = Date.now();
    const savedDownload = await resolveBrowserDownload(page, download, downloadStartedAt);
    const fileName = savedDownload.fileName || download.suggestedFilename() || `zerodha-holdings-${asOfDate || todayIso()}.xlsx`;
    console.log(`[Zerodha] Holdings XLSX finalized in ${Date.now() - completionStart}ms`);
    console.log(`[Zerodha] Holdings XLSX downloaded (${Date.now() - t0}ms total):`, fileName);

    return {
      reportKind: 'holdings',
      asOfDate: asOfDate || todayIso(),
      fileName,
      filePath: savedDownload.filePath,
    };
  },
};

async function ensureKiteSession(page: Page, creds: LoginCredentials, fetchOtp: () => Promise<string>): Promise<void> {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(900);

  if (ZERODHA_DASHBOARD_RE.test(page.url())) {
    console.log('[Zerodha] Already logged in (session cached):', page.url());
    return;
  }

  await completeZerodhaCredentialFlow(page, creds, fetchOtp, ZERODHA_DASHBOARD_RE);

  try {
    await page.waitForURL(ZERODHA_DASHBOARD_RE, { timeout: 20_000 });
    console.log('[Zerodha] Post-login dashboard detected:', page.url());
  } catch {
    console.warn('[Zerodha] Post-login redirect not detected within 20s. Balance fetch may fail.');
  }
}

async function ensureConsoleHoldingsPage(page: Page, creds: LoginCredentials, fetchOtp: () => Promise<string>): Promise<void> {
  console.log('[Zerodha] Opening Console holdings page...');
  await page.goto(CONSOLE_HOLDINGS_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(1000);
  console.log('[Zerodha] Console landing URL:', page.url());

  if (await isConsoleHoldingsReady(page)) {
    console.log('[Zerodha] Console holdings page ready:', page.url());
    return;
  }

  const loginWithKite = page.getByText(/login with kite/i).first();
  if (await loginWithKite.isVisible().catch(() => false)) {
    await loginWithKite.click();
    await page.waitForTimeout(500);
    console.log('[Zerodha] Clicked Login with Kite');
  }

  await completeZerodhaCredentialFlow(page, creds, fetchOtp, CONSOLE_HOLDINGS_RE);
  console.log('[Zerodha] Console post-login URL:', page.url());
  await waitForConsoleHoldingsReady(page);

  console.log('[Zerodha] Console holdings page ready:', page.url());
}

async function completeZerodhaCredentialFlow(
  page: Page,
  creds: LoginCredentials,
  fetchOtp: () => Promise<string>,
  successUrlRe: RegExp,
): Promise<void> {
  try {
    const userField = page.locator('input#userid').first();
    await userField.waitFor({ state: 'visible', timeout: 1_000 });
    await userField.fill(creds.username);
    console.log('[Zerodha] User ID filled');
  } catch {
    console.log('[Zerodha] User ID field not shown - Zerodha remembered the user, skipping.');
  }

  try {
    const passField = page.locator('input#password').first();
    await passField.waitFor({ state: 'visible', timeout: 10_000 });
    await passField.fill(creds.password);
    console.log('[Zerodha] Password filled');
  } catch {
    console.warn('[Zerodha] Could not find input#password - check selectors.');
  }

  try {
    const submitBtn = page.locator('button[type="submit"]').first();
    await submitBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await submitBtn.click();
    console.log('[Zerodha] Login submitted');
  } catch {
    console.warn('[Zerodha] Could not click submit button.');
  }

  console.log('[Zerodha] Waiting for 2FA screen...');
  const pinField = page.locator([
    'input#pin',
    'input[name="pin"]',
    'input[placeholder*="PIN" i]',
    'input[placeholder*="TOTP" i]',
    'input[placeholder*="OTP" i]',
    'input[maxlength="6"][type="text"]',
    'input[maxlength="6"][type="number"]',
    'input[maxlength="6"][type="tel"]',
  ].join(', ')).first();

  try {
    await pinField.waitFor({ state: 'visible', timeout: 45_000 });
    console.log('[Zerodha] 2FA screen detected');
  } catch {
    console.warn('[Zerodha] 2FA screen did not appear - login may have failed or already logged in.');
    return;
  }

  try {
    const otp = creds.totpSecret
      ? (await TOTP.generate(creds.totpSecret)).otp
      : await fetchOtp();
    console.log('[Zerodha] TOTP generated:', otp);
    await pinField.clear();
    await pinField.fill(otp);

    const autoSubmitted = await page.waitForURL(successUrlRe, { timeout: 4_000 })
      .then(() => true)
      .catch(() => false);

    if (autoSubmitted) {
      console.log('[Zerodha] 2FA auto-submitted');
      return;
    }

    const submitBtn = page.locator('button[type="submit"]').first();
    const canClickSubmit = await submitBtn.isVisible().catch(() => false)
      && await submitBtn.isEnabled().catch(() => false);

    if (canClickSubmit) {
      await submitBtn.click();
      console.log('[Zerodha] 2FA submitted');
    } else {
      await pinField.press('Enter');
      console.log('[Zerodha] Pressed Enter to submit 2FA');
    }
  } catch (e: any) {
    const msg: string = e?.message ?? String(e);
    if (msg.includes('OTP_TIMEOUT') || msg.includes('OTP_CANCELLED')) {
      console.warn('[Zerodha] OTP entry was cancelled or timed out.');
    } else {
      console.warn('[Zerodha] OTP step failed:', msg);
    }
  }
}

async function isConsoleHoldingsReady(page: Page): Promise<boolean> {
  if (!CONSOLE_HOLDINGS_RE.test(page.url())) return false;
  const xlsxButton = await findConsoleXlsxButton(page);
  if (xlsxButton) return true;
  const downloadTrigger = await findConsoleDownloadTrigger(page);
  return !!downloadTrigger;
}

async function findConsoleXlsxButton(page: Page) {
  const candidates = [
    page.getByRole('button', { name: /xlsx/i }).first(),
    page.getByRole('link', { name: /xlsx/i }).first(),
    page.getByText(/^XLSX$/i).first(),
    page.locator('text=/^\\s*xlsx\\s*$/i').first(),
    page.locator('a:has-text("XLSX")').first(),
    page.locator('button:has-text("XLSX")').first(),
    page.locator('[role="menuitem"]:has-text("XLSX")').first(),
    page.locator('a:has-text("Excel")').first(),
    page.locator('button:has-text("Excel")').first(),
  ];

  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

async function findConsoleDownloadTrigger(page: Page) {
  const candidates = [
    page.getByRole('button', { name: /download/i }).first(),
    page.getByRole('link', { name: /download/i }).first(),
    page.locator('button:has-text("Download")').first(),
    page.locator('a:has-text("Download")').first(),
    page.locator('[role="button"]:has-text("Download")').first(),
    page.getByRole('button', { name: /export/i }).first(),
    page.getByRole('link', { name: /export/i }).first(),
    page.locator('button:has-text("Export")').first(),
    page.locator('a:has-text("Export")').first(),
  ];

  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

async function triggerConsoleHoldingsDownload(page: Page) {
  const directXlsx = await findConsoleXlsxButton(page);
  if (directXlsx) {
    return await clickAndWaitForDownload(page, directXlsx, 'direct-xlsx');
  }

  const trigger = await findConsoleDownloadTrigger(page);
  if (!trigger) {
    await dumpConsoleHoldingsDiagnostics(page, 'download-trigger-missing');
    throw new Error('Console download control not found on Holdings page');
  }

  await trigger.click().catch(async () => {
    await trigger.scrollIntoViewIfNeeded().catch(() => {});
    await trigger.click({ force: true });
  });
  await page.waitForTimeout(400);

  const xlsxAfterOpen = await findConsoleXlsxButton(page);
  if (!xlsxAfterOpen) {
    await dumpConsoleHoldingsDiagnostics(page, 'xlsx-action-missing');
    throw new Error('Console XLSX action did not appear after opening download menu');
  }

  return await clickAndWaitForDownload(page, xlsxAfterOpen, 'menu-xlsx');
}

async function clickAndWaitForDownload(page: Page, locator: Locator, label: string): Promise<Download> {
  try {
    const t0 = Date.now();
    console.log(`[Zerodha] Attempting Console download via ${label}...`);
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      locator.click({ noWaitAfter: true }),
    ]);
    console.log(`[Zerodha] Console download started via ${label} in ${Date.now() - t0}ms`);
    return download;
  } catch (e) {
    const retryable = await locator.isVisible().catch(() => false);
    if (retryable) {
      try {
        const t0 = Date.now();
        console.log(`[Zerodha] Retrying Console download via ${label} with forced click...`);
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 30_000 }),
          locator.click({ force: true, noWaitAfter: true }),
        ]);
        console.log(`[Zerodha] Console download started via forced ${label} in ${Date.now() - t0}ms`);
        return download;
      } catch {
        // fall through to diagnostics below
      }
    }
    await dumpConsoleHoldingsDiagnostics(page, `download-failed-${label}`);
    throw e;
  }
}

async function waitForConsoleHoldingsReady(page: Page): Promise<void> {
  const deadline = Date.now() + 45_000;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;

    if (await isConsoleHoldingsReady(page)) return;

    if (CONSOLE_HOLDINGS_RE.test(page.url())) {
      await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(1_000);
      if (await isConsoleHoldingsReady(page)) return;
    } else {
      console.log(`[Zerodha] Reopening Console holdings (attempt ${attempt}) from ${page.url()}`);
      await page.goto(CONSOLE_HOLDINGS_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch((err) => {
        console.warn('[Zerodha] Console holdings reopen failed:', (err as Error).message);
      });
      await page.waitForTimeout(1_000);
      if (await isConsoleHoldingsReady(page)) return;
    }

    await page.waitForTimeout(1_500);
  }

  await dumpConsoleHoldingsDiagnostics(page, 'holdings-ready-timeout');
  throw new Error('Zerodha Console holdings page did not become ready');
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function readConsoleAsOfDate(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(() => {
      const dateInput = document.querySelector<HTMLInputElement>('input[type="date"]');
      if (dateInput?.value) return dateInput.value;

      const text = (document.body as HTMLElement | null)?.innerText || '';
      const match = text.match(/\b(?:Statement|Holdings)\s+as\s+on\s+(\d{4}-\d{2}-\d{2})\b/i);
      return match?.[1] ?? null;
    });
  } catch {
    return null;
  }
}

async function dismissZerodhaBlockingOverlays(page: Page): Promise<void> {
  const promptVisible = await page.evaluate(() => {
    const text = (document.body as HTMLElement | null)?.innerText || '';
    return /f\s*&\s*o|fno|futures?\s*&\s*options|risk disclosure|understand the risks|agree to the risks/i.test(text);
  }).catch(() => false);

  if (!promptVisible) return;

  const selectors = [
    'button:has-text("OK")',
    'button:has-text("Okay")',
    'button:has-text("I Understand")',
    'button:has-text("I agree")',
    'button:has-text("Continue")',
    'button:has-text("Proceed")',
    '[role="button"]:has-text("OK")',
    '[role="button"]:has-text("I Understand")',
  ];

  for (const selector of selectors) {
    const button = page.locator(selector).first();
    if (await button.isVisible().catch(() => false) && await button.isEnabled().catch(() => false)) {
      await button.click().catch(() => {});
      await page.waitForTimeout(250);
      console.log('[Zerodha] Dismissed post-login risk prompt');
      return;
    }
  }
}

async function dumpZerodhaDiagnostics(page: Page, label: string): Promise<void> {
  try {
    const info = await page.evaluate(() => {
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'))
        .filter(visible)
        .slice(0, 15)
        .map(el => {
          const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
          const tag = el.tagName.toLowerCase();
          const id = (el as HTMLElement).id || '';
          const cls = ((el as HTMLElement).className || '').toString().slice(0, 40);
          return `<${tag}${id ? ' id="' + id + '"' : ''}${cls ? ' class="' + cls + '"' : ''}> ${txt}`;
        });
      const body = document.body as HTMLElement | null;
      const inner = (body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 800);
      const fullLen = (body?.textContent || '').length;
      return { url: location.href, buttons, inner, fullLen };
    });
    console.log(`[Zerodha][debug:${label}] url = ${info.url}`);
    console.log(`[Zerodha][debug:${label}] body innerText length = ${info.fullLen}, first 800 chars:`);
    console.log('  ' + info.inner);
    console.log(`[Zerodha][debug:${label}] visible buttons/links (${info.buttons.length}):`);
    info.buttons.forEach(b => console.log('  ' + b));
  } catch (e) {
    console.warn(`[Zerodha][debug:${label}] dump failed:`, (e as Error).message);
  }
}

async function dumpConsoleHoldingsDiagnostics(page: Page, label: string): Promise<void> {
  try {
    const info = await page.evaluate(() => {
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const actions = Array.from(document.querySelectorAll('button, a, [role="button"], [role="menuitem"]'))
        .filter(visible)
        .slice(0, 30)
        .map(el => {
          const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 90);
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role') || '';
          const cls = ((el as HTMLElement).className || '').toString().slice(0, 60);
          return `<${tag}${role ? ` role="${role}"` : ''}${cls ? ` class="${cls}"` : ''}> ${txt}`;
        });
      const body = document.body as HTMLElement | null;
      const text = (body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
      return { url: location.href, actions, text };
    });
    console.log(`[Zerodha][console:${label}] url = ${info.url}`);
    console.log(`[Zerodha][console:${label}] visible actions (${info.actions.length}):`);
    info.actions.forEach(a => console.log('  ' + a));
    console.log(`[Zerodha][console:${label}] text preview:`);
    console.log('  ' + info.text);
  } catch (e) {
    console.warn(`[Zerodha][console:${label}] dump failed:`, (e as Error).message);
  }
}

async function fetchZerodhaTabValue(page: Page, opts: {
  url: string;
  urlMatch: RegExp;
  kind: 'funds' | 'portfolio' | 'positions';
  labels: string[];
  allowEmpty?: boolean;
}): Promise<string | null> {
  await dismissZerodhaBlockingOverlays(page);

  try {
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForLoadState('networkidle', { timeout: 2_000 }).catch(() => {});
    await dismissZerodhaBlockingOverlays(page);
  } catch (e) {
    console.warn(`[Zerodha] goto ${opts.kind} failed:`, (e as Error).message);
    return null;
  }

  const EMPTY_RE = '(?:You\\s+(?:don\'t|do\\s+not|haven\'t)\\s+have\\s+any\\s+(?:open\\s+)?(?:holdings?|positions?|orders?))|(?:\\bNo\\s+(?:open\\s+)?(?:holdings?|positions?)\\s*(?:yet|to\\s+show)?\\b)';

  const rendered = await page.waitForFunction((args: { re: string; labels: string[]; emptyRe: string }) => {
    const body = document.body as HTMLElement | null;
    const text = (body?.innerText || '') + ' ' + (body?.textContent || '');
    if (!new RegExp(args.re).test(location.href)) return null;
    const hasAmt = /(?:\u20B9|INR|Rs\.?)\s*-?\d[\d,]*(?:\.\d{1,2})?/i.test(text);
    const hasLabel = args.labels.some(lbl => new RegExp(lbl, 'i').test(text));
    const empty = new RegExp(args.emptyRe, 'i').test(text);
    return (hasAmt || hasLabel || empty) ? text : null;
  }, { re: opts.urlMatch.source, labels: opts.labels, emptyRe: EMPTY_RE }, { timeout: 8_000, polling: 200 })
    .then(h => h.jsonValue() as Promise<string>)
    .catch(() => null);

  if (!rendered) {
    if (!opts.allowEmpty) {
      console.warn(`[Zerodha] ${opts.kind} page did not render any amount or label within 8s.`);
      await dumpZerodhaDiagnostics(page, `${opts.kind}-page`);
    } else {
      console.log(`[Zerodha] ${opts.kind} page is empty (no holdings/positions).`);
    }
    return null;
  }

  const resolvedEmpty = new RegExp(EMPTY_RE, 'i').test(rendered)
    && !opts.labels.some(lbl => new RegExp(lbl, 'i').test(rendered));
  if (resolvedEmpty && opts.allowEmpty) return '0.00';

  const value = await page.evaluate((labels: string[]) => {
    const body = document.body as HTMLElement | null;
    const text = (body?.innerText || '') + ' ' + (body?.textContent || '');
    const AMT = '(-?\\d[\\d,]*(?:\\.\\d{1,2})?)';

    for (const lbl of labels) {
      const re = new RegExp(`${lbl}[\\s\\S]{0,80}?(?:\\u20B9|INR|Rs\\.?)?\\s*${AMT}`, 'i');
      const m = text.match(re);
      if (m?.[1]) return m[1];
    }

    const first = text.match(new RegExp(`(?:\\u20B9|INR|Rs\\.?)\\s*${AMT}`, 'i'));
    return first?.[1] || null;
  }, opts.labels);

  if (!value) {
    console.warn(`[Zerodha] ${opts.kind} page rendered but value not parsed.`);
    await dumpZerodhaDiagnostics(page, `${opts.kind}-page-parse`);
  }
  return value;
}
