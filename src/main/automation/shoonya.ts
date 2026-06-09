/**
 * Shoonya login adapter.
 *
 * Login URL : https://trade.shoonya.com/
 *
 * Shoonya is a Flutter web app, so the login controls are drawn on a canvas
 * instead of normal HTML inputs. For that reason this adapter drives the login
 * screen using stable viewport-relative click points that were verified against
 * the current desktop layout.
 *
 * Flow:
 *   1. Fill User ID
 *   2. Fill Password
 *   3. Fill OTP/TOTP
 *      - If a TOTP secret is stored, generate it automatically
 *      - Otherwise click "Get OTP" and ask the user for the code manually
 *   4. Click Login
 */

import { Page } from 'playwright';
import { LoginAdapter, LoginCredentials } from './browser';
import { TOTP } from 'totp-generator';

const LOGIN_URL = 'https://trade.shoonya.com/';
const SHOONYA_API_SEGMENT = '/NorenWClientWeb';

// Verified against the 1280x800 headed viewport used by launchSession().
const FIELD_X_RATIO = 0.503;
const USER_Y_RATIO = 0.220;
const PASSWORD_Y_RATIO = 0.283;
const OTP_Y_RATIO = 0.346;
const LOGIN_Y_RATIO = 0.442;
const GET_OTP_X_RATIO = 0.430;
const GET_OTP_Y_RATIO = 0.495;

type ShoonyaSession = {
  uid: string;
  actid: string;
  susertoken: string;
  urlbasedonuserid: string;
};

type ShoonyaApiAction = 'Limits' | 'Holdings' | 'PositionBook';

function pointAt(page: Page, xRatio: number, yRatio: number): { x: number; y: number } {
  const viewport = page.viewportSize() || { width: 1280, height: 800 };
  return {
    x: Math.round(viewport.width * xRatio),
    y: Math.round(viewport.height * yRatio),
  };
}

async function clickAt(page: Page, xRatio: number, yRatio: number): Promise<void> {
  const { x, y } = pointAt(page, xRatio, yRatio);
  await page.mouse.click(x, y);
}

async function focusAndTypeAt(page: Page, yRatio: number, value: string, label: string): Promise<void> {
  await clickAt(page, FIELD_X_RATIO, yRatio);
  await page.waitForTimeout(60);
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await page.keyboard.type(value, { delay: 0 });
  console.log(`[Shoonya] Filled ${label}`);
}

async function buildShoonyaCode(page: Page, creds: LoginCredentials, fetchOtp: () => Promise<string>): Promise<string> {
  const secret = (creds.totpSecret || '').replace(/\s+/g, '').trim();
  if (secret) {
    const { otp } = await TOTP.generate(secret);
    console.log('[Shoonya] Generated TOTP from stored secret');
    return otp;
  }

  await clickAt(page, GET_OTP_X_RATIO, GET_OTP_Y_RATIO);
  console.log('[Shoonya] Clicked Get OTP. Waiting for manual OTP entry...');
  return fetchOtp();
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const text = String(value ?? '').replace(/,/g, '').trim();
  if (!text || text.toLowerCase() === 'null' || text.toLowerCase() === 'na') return 0;
  const out = Number(text);
  return Number.isFinite(out) ? out : 0;
}

function hasValue(value: unknown): boolean {
  const text = String(value ?? '').trim().toLowerCase();
  return text !== '' && text !== 'null' && text !== 'na' && text !== 'undefined';
}

function formatInr(value: number): string {
  const sign = value < 0 ? '-' : '';
  return `${sign}${Math.abs(value).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function isNotOkResponse(value: unknown): boolean {
  return !!value
    && !Array.isArray(value)
    && typeof value === 'object'
    && String((value as Record<string, unknown>).stat ?? '').toLowerCase() === 'not_ok';
}

function isEmptyBrokerResponse(value: unknown): boolean {
  if (!value) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  const stat = String(obj.stat ?? '').toLowerCase();
  const msg = String(obj.emsg ?? '').toLowerCase();
  return stat === 'not_ok' && /no\s+(data|positions?|holdings?)/i.test(msg);
}

function buildShoonyaApiBase(urlBasedOnUserId: string, fallbackOrigin: string): string {
  const raw = (urlBasedOnUserId || fallbackOrigin || LOGIN_URL).trim();
  const withoutTrailingSlash = raw.replace(/\/+$/, '');
  if (new RegExp(`${SHOONYA_API_SEGMENT}$`, 'i').test(withoutTrailingSlash)) {
    return withoutTrailingSlash;
  }
  if (new RegExp(`${SHOONYA_API_SEGMENT}/`, 'i').test(withoutTrailingSlash)) {
    return withoutTrailingSlash.replace(new RegExp(`${SHOONYA_API_SEGMENT}.*$`, 'i'), SHOONYA_API_SEGMENT);
  }
  return `${withoutTrailingSlash}${SHOONYA_API_SEGMENT}`;
}

async function getShoonyaSession(page: Page): Promise<ShoonyaSession | null> {
  return page.evaluate(() => {
    const directKeyMap: Record<string, string> = {
      uid: '',
      actid: '',
      susertoken: '',
      urlbasedonuserid: '',
    };

    const targets = new Set(Object.keys(directKeyMap));

    const assign = (key: string, value: unknown) => {
      const normalized = key.toLowerCase();
      if (!targets.has(normalized)) return;
      const text = String(value ?? '').trim();
      if (text && !directKeyMap[normalized]) directKeyMap[normalized] = text;
    };

    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        assign(k, v);
        if (typeof v === 'string') {
          const text = v.trim();
          if (text.startsWith('{') || text.startsWith('[')) {
            try {
              visit(JSON.parse(text));
            } catch {
              // ignore non-JSON strings
            }
          }
        } else if (v && typeof v === 'object') {
          visit(v);
        }
      }
    };

    const scanStorage = (storage: Storage | undefined) => {
      if (!storage) return;
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (!key) continue;
        const value = storage.getItem(key);
        assign(key, value);
        if (!value) continue;
        assign(value, value);
        const text = value.trim();
        if (text.startsWith('{') || text.startsWith('[')) {
          try {
            visit(JSON.parse(text));
          } catch {
            // ignore non-JSON values
          }
        }
      }
    };

    scanStorage(window.localStorage);
    scanStorage(window.sessionStorage);

    if (!directKeyMap.uid || !directKeyMap.actid || !directKeyMap.susertoken) {
      return null;
    }

    return {
      uid: directKeyMap.uid,
      actid: directKeyMap.actid,
      susertoken: directKeyMap.susertoken,
      urlbasedonuserid: directKeyMap.urlbasedonuserid || window.location.origin,
    };
  }).catch(() => null);
}

async function waitForShoonyaSession(page: Page, timeoutMs = 25_000): Promise<ShoonyaSession | null> {
  try {
    await page.waitForFunction(() => {
      const candidateValues: Record<string, string> = {
        uid: '',
        actid: '',
        susertoken: '',
        urlbasedonuserid: '',
      };

      const assign = (key: string, value: unknown) => {
        const normalized = key.toLowerCase();
        if (!(normalized in candidateValues)) return;
        const text = String(value ?? '').trim();
        if (text && !candidateValues[normalized]) candidateValues[normalized] = text;
      };

      const walk = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
          value.forEach(walk);
          return;
        }
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          assign(k, v);
          if (typeof v === 'string') {
            const text = v.trim();
            if (text.startsWith('{') || text.startsWith('[')) {
              try {
                walk(JSON.parse(text));
              } catch {
                // ignore invalid JSON
              }
            }
          } else if (v && typeof v === 'object') {
            walk(v);
          }
        }
      };

      const scan = (storage: Storage | undefined) => {
        if (!storage) return;
        for (let i = 0; i < storage.length; i += 1) {
          const key = storage.key(i);
          if (!key) continue;
          const value = storage.getItem(key);
          assign(key, value);
          if (!value) continue;
          const text = value.trim();
          if (text.startsWith('{') || text.startsWith('[')) {
            try {
              walk(JSON.parse(text));
            } catch {
              // ignore invalid JSON
            }
          }
        }
      };

      scan(window.localStorage);
      scan(window.sessionStorage);

      return !!candidateValues.uid && !!candidateValues.actid && !!candidateValues.susertoken;
    }, { timeout: timeoutMs, polling: 250 });
  } catch {
    return getShoonyaSession(page);
  }

  return getShoonyaSession(page);
}

async function callShoonyaApi(page: Page, session: ShoonyaSession, action: ShoonyaApiAction, jData: Record<string, string>): Promise<unknown> {
  const result = await page.evaluate(async ({ actionName, payload, sessionState, apiSegment }) => {
    const trimSlashes = (value: string) => value.replace(/\/+$/, '');
    const rawBase = (sessionState.urlbasedonuserid || window.location.origin || 'https://trade.shoonya.com').trim();
    let apiBase = trimSlashes(rawBase);
    const segmentRe = new RegExp(`${apiSegment}$`, 'i');
    const nestedSegmentRe = new RegExp(`${apiSegment}/`, 'i');

    if (!segmentRe.test(apiBase)) {
      if (nestedSegmentRe.test(apiBase)) {
        apiBase = apiBase.replace(new RegExp(`${apiSegment}.*$`, 'i'), apiSegment);
      } else {
        apiBase = `${apiBase}${apiSegment}`;
      }
    }

    const body = `jData=${JSON.stringify(payload)}&jKey=${sessionState.susertoken}`;
    const response = await fetch(`${apiBase}/${actionName}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body,
    });

    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      text,
      url: `${apiBase}/${actionName}`,
    };
  }, {
    actionName: action,
    payload: jData,
    sessionState: session,
    apiSegment: SHOONYA_API_SEGMENT,
  });

  const parsed = parseShoonyaPayload(result.text);
  if (!result.ok) {
    throw new Error(`Shoonya ${action} request failed (${result.status})`);
  }
  if (isNotOkResponse(parsed) && !isEmptyBrokerResponse(parsed)) {
    const msg = String((parsed as Record<string, unknown>).emsg || 'unknown error');
    throw new Error(`Shoonya ${action} error: ${msg}`);
  }
  return parsed;
}

function parseShoonyaPayload(text: string): unknown {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function computeShoonyaHoldingQuantity(row: Record<string, unknown>): number {
  let quantity = 0;

  const btstQty = toNumber(row.btstqty);
  const npoadT1Qty = toNumber(row.npoadt1qty);
  const holdQty = toNumber(row.holdqty);
  const brkColQty = toNumber(row.brkcolqty);
  const unpledgedQty = toNumber(row.unplgdqty);
  const benQty = toNumber(row.benqty);
  const tradedQty = toNumber(row.trdqty);
  const dpQty = toNumber(row.dpqty);
  const npoadQty = toNumber(row.npoadqty);

  if (hasValue(row.btstqty)) {
    quantity += hasValue(row.npoadt1qty) ? Math.max(npoadT1Qty, btstQty) : btstQty;
  } else if (hasValue(row.npoadt1qty)) {
    quantity += npoadT1Qty;
  }

  if (hasValue(row.holdqty)) quantity += holdQty;
  if (hasValue(row.brkcolqty)) quantity += brkColQty;
  if (hasValue(row.unplgdqty)) quantity += unpledgedQty;
  if (hasValue(row.benqty)) quantity += benQty;
  if (hasValue(row.trdqty)) quantity -= tradedQty;

  if (hasValue(row.dpqty)) {
    quantity += hasValue(row.npoadqty) ? Math.max(npoadQty, dpQty) : dpQty;
  } else if (hasValue(row.npoadqty)) {
    quantity += npoadQty;
  }

  return quantity;
}

function computeShoonyaAvailableMargin(raw: Record<string, unknown>): number {
  const totalCredits = [
    raw.cash,
    raw.payin,
    raw.payout,
    raw.blk_amt,
    raw.daycash,
    raw.unclearedcash,
    raw.brkcollamt,
    raw.cash_coll,
    raw.aux_brkcollamt,
  ].reduce<number>((sum, value) => sum + toNumber(value), 0);

  return totalCredits - toNumber(raw.marginused);
}

function computeShoonyaPortfolioValue(rawRows: Record<string, unknown>[]): number {
  return rawRows.reduce((sum, row) => {
    const quantity = computeShoonyaHoldingQuantity(row);
    const currentPrice = hasValue(row.c) ? toNumber(row.c) : toNumber(row.lp);
    return sum + quantity * currentPrice;
  }, 0);
}

function computeShoonyaPositionsValue(rawRows: Record<string, unknown>[]): number {
  return rawRows.reduce((sum, row) => {
    return sum + toNumber(row.rpnl) + toNumber(row.urmtom);
  }, 0);
}

export const shoonyaAdapter: LoginAdapter = {
  code: 'SHOONYA',
  displayName: 'Shoonya',
  otpMode: 'manual',

  async login(page: Page, creds: LoginCredentials, fetchOtp: () => Promise<string>): Promise<void> {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // The Shoonya Flutter shell paints the login form a little after DOM ready,
    // but a full 12s sleep makes the flow feel sluggish.
    await page.waitForTimeout(3_500);

    const title = await page.title().catch(() => 'unknown');
    console.log(`[Shoonya] Login page loaded: ${title}`);

    await focusAndTypeAt(page, USER_Y_RATIO, creds.username, 'user id');
    await focusAndTypeAt(page, PASSWORD_Y_RATIO, creds.password, 'password');

    const code = await buildShoonyaCode(page, creds, fetchOtp);
    await focusAndTypeAt(page, OTP_Y_RATIO, code, 'OTP/TOTP');

    await clickAt(page, FIELD_X_RATIO, LOGIN_Y_RATIO);
    console.log('[Shoonya] Login submitted');
    const session = await waitForShoonyaSession(page, 25_000);
    if (session) {
      const apiBase = buildShoonyaApiBase(session.urlbasedonuserid, LOGIN_URL);
      console.log('[Shoonya] Post-login session detected:', apiBase);
    } else {
      console.warn('[Shoonya] Post-login session not detected yet. Balance fetch will retry.');
    }
    console.log('[Shoonya] Browser remains open for IPO application.');
  },

  async fetchBalance(page: Page): Promise<string | null> {
    const t0 = Date.now();
    const INR = '\u20B9';
    try {
      const session = await waitForShoonyaSession(page, 25_000);
      if (!session) {
        console.warn('[Shoonya] Could not detect a logged-in session. Balance fetch skipped.');
        return null;
      }

      const limitsRaw = await callShoonyaApi(page, session, 'Limits', {
        uid: session.uid,
        actid: session.actid,
      });
      const holdingsRaw = await callShoonyaApi(page, session, 'Holdings', {
        uid: session.uid,
        actid: session.actid,
        prd: 'C',
      }).catch((error) => {
        console.warn('[Shoonya] Holdings fetch warning:', (error as Error).message);
        return [];
      });
      const positionsRaw = await callShoonyaApi(page, session, 'PositionBook', {
        uid: session.uid,
        actid: session.actid,
      }).catch((error) => {
        console.warn('[Shoonya] Positions fetch warning:', (error as Error).message);
        return [];
      });

      const limits = !limitsRaw || Array.isArray(limitsRaw) || typeof limitsRaw !== 'object'
        ? null
        : limitsRaw as Record<string, unknown>;
      if (!limits || isEmptyBrokerResponse(limits)) {
        console.warn('[Shoonya] Limits response was empty or invalid.');
        return null;
      }

      const holdings = Array.isArray(holdingsRaw) ? holdingsRaw as Record<string, unknown>[] : [];
      const positions = Array.isArray(positionsRaw) ? positionsRaw as Record<string, unknown>[] : [];

      const funds = computeShoonyaAvailableMargin(limits);
      const portfolio = computeShoonyaPortfolioValue(holdings);
      const positionsValue = computeShoonyaPositionsValue(positions);

      const out = [
        `Funds: ${INR}${formatInr(funds)}`,
        `Portfolio: ${INR}${formatInr(portfolio)}`,
        `Positions: ${INR}${formatInr(positionsValue)}`,
      ].join(' | ');

      console.log(`[Shoonya] Balance (${Date.now() - t0}ms):`, out);
      return out;
    } catch (e) {
      console.warn('[Shoonya] Balance fetch error:', (e as Error).message);
      return null;
    }
  },
};
