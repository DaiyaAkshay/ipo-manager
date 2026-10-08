/**
 * Market intelligence — fetching, caching and the local watchlist file.
 *
 * Sources (all public, no login):
 *   NSE  api/ipo-current-issue           open issues + total subscription
 *   NSE  api/all-upcoming-issues?category=ipo
 *   NSE  api/ipo-detail?symbol=&series=  category-wise subscription, shareholder quota
 *   NSE  api/corporates-corporateActions bonus / rights / split with ex-dates
 *   NSE  api/corporate-board-meetings    bonus / rights / preferential proposals
 *   ipowatch.in GMP page                 unofficial grey-market premium (optional)
 *
 * The watchlist and the GMP toggle live in data/market.json — symbols only, no
 * secrets, so it is not part of the encrypted vault and does not sync.
 */
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BoardAnnouncement,
  CorporateAction,
  GmpRow,
  IssueStatus,
  QuotaPick,
  QuotaWatchEntry,
  Segment,
  SubscriptionSnapshot,
  Verdict,
  buildQuotaPicks,
  classifyBoardMeeting,
  classifyCorporateAction,
  dedupeAnnouncements,
  matchGmp,
  parseActiveCategories,
  parseGmpHtml,
  parseNseDate,
  retailAllotmentOdds,
  scoreIpo,
} from './intel';

const NSE = 'https://www.nseindia.com/api';
const GMP_URL = 'https://ipowatch.in/ipo-grey-market-premium-latest-ipo-gmp/';
const CACHE_MS = 10 * 60_000;
const TIMEOUT_MS = 20_000;

const HEADERS: Record<string, string> = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  'accept-language': 'en-IN,en;q=0.9',
};

export interface IpoIntel {
  symbol: string | null;
  name: string;
  segment: Segment;
  status: IssueStatus;
  openDate: string | null;
  closeDate: string | null;
  priceHigh: number | null;
  gmp: number | null;
  gmpPct: number | null;
  gmpSource: string | null;
  subscription: SubscriptionSnapshot | null;
  retailOdds: number | null;
  verdict: Verdict;
  score: number;
  reasons: string[];
}

export interface MarketSnapshot {
  fetchedAt: string;
  ipos: IpoIntel[];
  corporateActions: CorporateAction[];
  announcements: BoardAnnouncement[];
  quotaPicks: QuotaPick[];
  gmpEnabled: boolean;
  errors: string[];
}

interface MarketFile {
  gmpEnabled: boolean;
  watchlist: QuotaWatchEntry[];
}

// ── Local settings file ──────────────────────────────────────────────────────

function marketFilePath(): string {
  const dir = join(app.getPath('userData'), 'data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'market.json');
}

function readMarketFile(): MarketFile {
  try {
    const parsed = JSON.parse(readFileSync(marketFilePath(), 'utf8'));
    return {
      gmpEnabled: parsed?.gmpEnabled !== false,
      watchlist: Array.isArray(parsed?.watchlist) ? parsed.watchlist : [],
    };
  } catch {
    return { gmpEnabled: true, watchlist: [] };
  }
}

function writeMarketFile(file: MarketFile): void {
  writeFileSync(marketFilePath(), JSON.stringify(file, null, 2), 'utf8');
}

export function getMarketSettings(): MarketFile {
  return readMarketFile();
}

export function setGmpEnabled(enabled: boolean): MarketFile {
  const file = readMarketFile();
  file.gmpEnabled = !!enabled;
  writeMarketFile(file);
  cache = null;
  return file;
}

const SYMBOL_RE = /^[A-Z0-9&_-]{1,20}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function addQuotaWatch(input: { parentSymbol: string; ipoName: string; cutoffDate?: string | null; note?: string }): { ok: true; watchlist: QuotaWatchEntry[] } | { ok: false; error: string } {
  const parentSymbol = String(input.parentSymbol || '').trim().toUpperCase();
  const ipoName = String(input.ipoName || '').trim().slice(0, 120);
  const cutoffDate = input.cutoffDate ? String(input.cutoffDate).trim() : null;
  if (!SYMBOL_RE.test(parentSymbol)) return { ok: false, error: 'Enter the parent company NSE symbol, e.g. RELIANCE.' };
  if (!ipoName) return { ok: false, error: 'Enter the IPO (subsidiary) name.' };
  if (cutoffDate && !DATE_RE.test(cutoffDate)) return { ok: false, error: 'Cut-off date must be yyyy-mm-dd.' };
  const file = readMarketFile();
  file.watchlist.push({ id: randomUUID(), parentSymbol, ipoName, cutoffDate, note: input.note?.slice(0, 200) });
  writeMarketFile(file);
  cache = null;
  return { ok: true, watchlist: file.watchlist };
}

export function removeQuotaWatch(id: string): QuotaWatchEntry[] {
  const file = readMarketFile();
  file.watchlist = file.watchlist.filter(e => e.id !== id);
  writeMarketFile(file);
  cache = null;
  return file.watchlist;
}

// ── Fetching ─────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function nseJson(path: string): Promise<any> {
  const res = await fetchWithTimeout(`${NSE}/${path}`, {
    ...HEADERS,
    accept: 'application/json, text/plain, */*',
    referer: 'https://www.nseindia.com/',
  });
  const text = await res.text();
  if (text.trimStart().startsWith('<')) throw new Error('NSE returned HTML instead of JSON');
  return JSON.parse(text);
}

function ddmmyyyy(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
}

function istToday(): string {
  // en-CA formats as yyyy-mm-dd.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

async function fetchGmpRows(errors: string[]): Promise<GmpRow[]> {
  try {
    const res = await fetchWithTimeout(GMP_URL, { ...HEADERS, accept: 'text/html' });
    const rows = parseGmpHtml(await res.text());
    if (!rows.length) errors.push('GMP page loaded but no GMP table was recognised (layout may have changed).');
    return rows;
  } catch (e: any) {
    errors.push(`GMP unavailable: ${e?.message || e}`);
    return [];
  }
}

function priceHighFrom(text: unknown): number | null {
  const nums = String(text ?? '').match(/\d+(?:\.\d+)?/g);
  return nums?.length ? Number(nums[nums.length - 1]) : null;
}

async function buildIpos(gmpRows: GmpRow[], errors: string[]): Promise<{ ipos: IpoIntel[]; nseQuota: QuotaPick[] }> {
  const issues = new Map<string, { symbol: string; name: string; segment: Segment; status: IssueStatus; open: string | null; close: string | null; priceHigh: number | null; totalTimes: number | null }>();

  const addRows = (rows: any[], status: IssueStatus) => {
    for (const r of rows || []) {
      const series = String(r?.series || '').toUpperCase();
      // Mainboard only: the owner does not bid in SME issues. Also skips DEBT / NCD / ZCZP.
      if (series !== 'EQ') continue;
      const symbol = String(r?.symbol || '').trim();
      if (!symbol || issues.has(symbol)) continue;
      issues.set(symbol, {
        symbol,
        name: String(r?.companyName || symbol).trim(),
        segment: 'MAINBOARD',
        status,
        open: parseNseDate(r?.issueStartDate),
        close: parseNseDate(r?.issueEndDate),
        priceHigh: priceHighFrom(r?.issuePrice || r?.priceBand),
        // Combined NSE+BSE subscription; only ipo-current-issue carries it.
        totalTimes: r?.noOfTime !== undefined && r?.noOfTime !== '' && Number.isFinite(Number(r.noOfTime)) ? Number(r.noOfTime) : null,
      });
    }
  };

  try { addRows(await nseJson('ipo-current-issue'), 'OPEN'); }
  catch (e: any) { errors.push(`NSE current issues: ${e?.message || e}`); }
  try { addRows(await nseJson('all-upcoming-issues?category=ipo'), 'UPCOMING'); }
  catch (e: any) { errors.push(`NSE upcoming issues: ${e?.message || e}`); }

  const today = istToday();
  const nseQuota: QuotaPick[] = [];
  const ipos: IpoIntel[] = [];

  for (const issue of issues.values()) {
    // An "upcoming" row whose window has started is effectively open.
    const status: IssueStatus = issue.close && issue.close < today ? 'CLOSED'
      : issue.open && issue.open <= today ? 'OPEN' : issue.status;

    let subscription: SubscriptionSnapshot | null = null;
    let priceHigh = issue.priceHigh;
    try {
      const detail = await nseJson(`ipo-detail?symbol=${encodeURIComponent(issue.symbol)}&series=EQ`);
      subscription = parseActiveCategories(detail?.activeCat);
      if (priceHigh === null) {
        const pts = detail?.demandDataNSE;
        if (Array.isArray(pts) && pts.length) priceHigh = Math.max(...pts.map((p: any) => Number(p?.price) || 0)) || null;
      }
    } catch { /* detail is optional — upcoming issues often have none yet */ }
    if (issue.totalTimes !== null) {
      subscription = subscription ?? parseActiveCategories(null);
      subscription.total = issue.totalTimes;
    }

    const gmpRow = matchGmp(issue.name, gmpRows, 'MAINBOARD');
    if (priceHigh === null && gmpRow?.priceHigh) priceHigh = gmpRow.priceHigh;
    const gmp = gmpRow?.gmp ?? null;
    const scored = scoreIpo({ segment: issue.segment, status, priceHigh, gmp, subscription });

    if (subscription?.hasShareholderQuota && status !== 'CLOSED') {
      nseQuota.push({
        id: null,
        parentSymbol: '(see RHP)',
        ipoName: issue.name,
        cutoffDate: null,
        buyBy: null,
        daysLeft: null,
        source: 'NSE',
        action: `${issue.name} has a shareholder reservation. Only demats that held the parent's shares on the RHP date qualify — check the RHP for the parent and date.`,
      });
    }

    ipos.push({
      symbol: issue.symbol,
      name: issue.name,
      segment: issue.segment,
      status,
      openDate: issue.open,
      closeDate: issue.close,
      priceHigh,
      gmp,
      gmpPct: scored.gmpPct,
      gmpSource: gmpRow ? 'ipowatch.in (unofficial)' : null,
      subscription,
      retailOdds: issue.segment === 'MAINBOARD' ? retailAllotmentOdds(subscription?.retail ?? null) : null,
      verdict: scored.verdict,
      score: scored.score,
      reasons: scored.reasons,
    });
  }

  // GMP-only upcoming issues that NSE hasn't listed yet (no dates fixed).
  for (const row of gmpRows) {
    if (row.statusText !== 'upcoming' || row.segment !== 'MAINBOARD') continue;
    if (ipos.some(i => matchGmp(i.name, [row]))) continue;
    const scored = scoreIpo({ segment: row.segment, status: 'UPCOMING', priceHigh: row.priceHigh, gmp: row.gmp, subscription: null });
    ipos.push({
      symbol: null, name: row.name, segment: row.segment, status: 'UPCOMING',
      openDate: null, closeDate: null, priceHigh: row.priceHigh, gmp: row.gmp,
      gmpPct: scored.gmpPct, gmpSource: 'ipowatch.in (unofficial)', subscription: null, retailOdds: null,
      verdict: row.priceHigh ? scored.verdict : 'WAIT', score: scored.score,
      reasons: row.priceHigh ? [...scored.reasons, `Dates: ${row.dates || 'not announced'}.`] : [`Price band not announced yet (${row.dates || 'dates TBA'}). GMP ₹${row.gmp ?? '—'}.`],
    });
  }

  const order: Record<IssueStatus, number> = { OPEN: 0, UPCOMING: 1, CLOSED: 2 };
  ipos.sort((a, b) => order[a.status] - order[b.status] || b.score - a.score);
  return { ipos, nseQuota };
}

async function buildCorporateActions(errors: string[]): Promise<CorporateAction[]> {
  const from = new Date();
  const to = new Date(Date.now() + 90 * 86_400_000);
  try {
    const rows = await nseJson(`corporates-corporateActions?index=equities&from_date=${ddmmyyyy(from)}&to_date=${ddmmyyyy(to)}`);
    const today = istToday();
    return (Array.isArray(rows) ? rows : [])
      .map(classifyCorporateAction)
      .filter((a): a is CorporateAction => !!a && (!a.exDate || a.exDate >= today))
      .sort((a, b) => (a.exDate || '9999').localeCompare(b.exDate || '9999'));
  } catch (e: any) {
    errors.push(`NSE corporate actions: ${e?.message || e}`);
    return [];
  }
}

async function buildAnnouncements(errors: string[]): Promise<BoardAnnouncement[]> {
  const from = new Date(Date.now() - 45 * 86_400_000);
  const to = new Date(Date.now() + 60 * 86_400_000);
  try {
    const rows = await nseJson(`corporate-board-meetings?index=equities&from_date=${ddmmyyyy(from)}&to_date=${ddmmyyyy(to)}`);
    return dedupeAnnouncements(
      (Array.isArray(rows) ? rows : []).map(classifyBoardMeeting).filter((a): a is BoardAnnouncement => !!a),
    );
  } catch (e: any) {
    errors.push(`NSE board meetings: ${e?.message || e}`);
    return [];
  }
}

// ── Public entry point ───────────────────────────────────────────────────────

let cache: { at: number; snapshot: MarketSnapshot } | null = null;
let inFlight: Promise<MarketSnapshot> | null = null;

export async function getMarketSnapshot(force = false): Promise<MarketSnapshot> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.snapshot;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const settings = readMarketFile();
    const errors: string[] = [];
    const gmpRows = settings.gmpEnabled ? await fetchGmpRows(errors) : [];
    const [{ ipos, nseQuota }, corporateActions, announcements] = await Promise.all([
      buildIpos(gmpRows, errors),
      buildCorporateActions(errors),
      buildAnnouncements(errors),
    ]);
    const snapshot: MarketSnapshot = {
      fetchedAt: new Date().toISOString(),
      ipos,
      corporateActions,
      announcements,
      quotaPicks: [...nseQuota, ...buildQuotaPicks(settings.watchlist, istToday())],
      gmpEnabled: settings.gmpEnabled,
      errors,
    };
    cache = { at: Date.now(), snapshot };
    return snapshot;
  })().finally(() => { inFlight = null; });
  return inFlight;
}
