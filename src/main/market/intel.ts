/**
 * Market intelligence — pure parsing and scoring.
 *
 * No Electron, network or DB imports here so every rule stays unit-testable
 * (tests/market/intel.test.ts). Fetching lives in market/service.ts.
 *
 * Nothing in this file is investment advice. The verdicts are a transparent
 * checklist (GMP, subscription, segment) that the owner can read and disagree
 * with; every verdict carries the reasons that produced it.
 */

export type Segment = 'MAINBOARD' | 'SME';
export type IssueStatus = 'OPEN' | 'UPCOMING' | 'CLOSED';
export type Verdict = 'APPLY' | 'CONSIDER' | 'AVOID' | 'WAIT';

export interface GmpRow {
  name: string;
  segment: Segment;
  gmp: number | null;
  priceHigh: number | null;
  statusText: string;
  dates: string;
}

export interface SubscriptionSnapshot {
  total: number | null;
  qib: number | null;
  nii: number | null;
  retail: number | null;
  employee: number | null;
  shareholder: number | null;
  hasShareholderQuota: boolean;
  hasEmployeeQuota: boolean;
}

export interface IpoScoreInput {
  segment: Segment;
  status: IssueStatus;
  priceHigh: number | null;
  gmp: number | null;
  subscription: SubscriptionSnapshot | null;
}

export interface IpoScore {
  score: number;
  verdict: Verdict;
  gmpPct: number | null;
  reasons: string[];
}

export type CorporateActionKind = 'BONUS' | 'RIGHTS' | 'SPLIT';

export interface CorporateAction {
  symbol: string;
  company: string;
  kind: CorporateActionKind;
  ratio: string | null;
  exDate: string | null;      // ISO yyyy-mm-dd
  recordDate: string | null;  // ISO yyyy-mm-dd
  buyBy: string | null;       // last day to buy (cum-date), ISO
  subject: string;
}

export type AnnouncementKind = 'BONUS' | 'RIGHTS' | 'PREFERENTIAL' | 'SPLIT';

export interface BoardAnnouncement {
  symbol: string;
  company: string;
  kind: AnnouncementKind;
  meetingDate: string | null; // ISO
  purpose: string;
  description: string;
  attachment: string | null;
}

// ── Small helpers ─────────────────────────────────────────────────────────────

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** "07-Oct-2026" / "07-OCT-2026" / "2026-10-07" → "2026-10-07". */
export function parseNseDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = v.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{4})/);
  if (!m) return null;
  const mm = MONTHS[m[2].toLowerCase()];
  return mm ? `${m[3]}-${mm}-${m[1].padStart(2, '0')}` : null;
}

/** Previous weekday (Mon–Fri). Exchange holidays are not known here. */
export function previousWeekday(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  do { d.setUTCDate(d.getUTCDate() - 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/[^0-9.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const NAME_NOISE = new Set([
  'limited', 'ltd', 'ipo', 'the', 'india', 'pvt', 'private', 'co', 'company',
  'upcoming', 'open', 'closed', 'allotted', 'listed', 'sme', 'nse', 'bse', 'and',
]);

/** Lower-case tokens without legal-form noise, for fuzzy name matching. */
export function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !NAME_NOISE.has(t));
}

/** Find the GMP row for an issue name. Needs ≥ 2 shared tokens (or 1 when the name has only 1). */
export function matchGmp(name: string, rows: GmpRow[], segment?: Segment): GmpRow | null {
  const want = nameTokens(name);
  if (!want.length) return null;
  let best: { row: GmpRow; hits: number } | null = null;
  for (const row of rows) {
    if (segment && row.segment !== segment) continue;
    const have = new Set(nameTokens(row.name));
    let hits = 0;
    for (const t of want) if (have.has(t)) hits += 1;
    // First token is usually the brand ("hd fire", "rk fashion") — require it.
    if (!have.has(want[0])) continue;
    const needed = Math.min(2, want.length, have.size);
    if (hits < needed) continue;
    if (!best || hits > best.hits) best = { row, hits };
  }
  return best?.row ?? null;
}

// ── GMP page (ipowatch.in) ────────────────────────────────────────────────────

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#8377;|&#x20b9;/gi, '₹')
    .replace(/&#8211;|&ndash;/gi, '-')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse the IPO Watch GMP page. It carries two tables with the header
 * "Company | GMP | Trend | Price Band | Est. Gain | Date": mainboard first,
 * SME second. Status words ("Upcoming", "Open", "Closed") are glued to the
 * company cell and split off here.
 */
export function parseGmpHtml(html: string): GmpRow[] {
  const rows: GmpRow[] = [];
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  let gmpTableIndex = 0;
  for (const table of tables) {
    const trs = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    const firstRow = trs[0];
    if (!firstRow) continue;
    const header = (firstRow.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || []).map(stripTags).map(s => s.toLowerCase());
    if (!header[0]?.includes('company') || !header.some(h => h.startsWith('gmp'))) continue;
    const segment: Segment = gmpTableIndex === 0 ? 'MAINBOARD' : 'SME';
    gmpTableIndex += 1;
    const gmpCol = header.findIndex(h => h.startsWith('gmp'));
    const priceCol = header.findIndex(h => h.includes('price'));
    const dateCol = header.findIndex(h => h.includes('date'));
    for (const tr of trs.slice(1)) {
      const cells = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map(stripTags);
      if (cells.length < 3) continue;
      const rawName = cells[0];
      const statusMatch = rawName.match(/\b(upcoming|open|closed|allotted|listed)\b\s*$/i);
      const name = (statusMatch ? rawName.slice(0, statusMatch.index) : rawName).replace(/\s+/g, ' ').trim();
      if (!name) continue;
      rows.push({
        name,
        segment,
        gmp: gmpCol >= 0 ? toNumber(cells[gmpCol]) : null,
        priceHigh: priceCol >= 0 ? toNumber(cells[priceCol]) : null,
        statusText: statusMatch ? statusMatch[1].toLowerCase() : '',
        dates: dateCol >= 0 ? (cells[dateCol] || '') : '',
      });
    }
  }
  return rows;
}

// ── NSE subscription (api/ipo-detail → activeCat) ────────────────────────────

/**
 * Pull category-wise subscription (× times) out of NSE's activeCat table and
 * detect shareholder / employee reservations.
 */
export function parseActiveCategories(activeCat: any): SubscriptionSnapshot {
  const list: any[] = Array.isArray(activeCat?.dataList) ? activeCat.dataList : Array.isArray(activeCat) ? activeCat : [];
  const snap: SubscriptionSnapshot = {
    total: null, qib: null, nii: null, retail: null, employee: null, shareholder: null,
    hasShareholderQuota: false, hasEmployeeQuota: false,
  };
  for (const row of list) {
    const cat = String(row?.category || '').toLowerCase();
    if (!cat || cat === 'category') continue;
    const offered = toNumber(row?.noOfShareOffered);
    // NSE prints "0.00" times when it has no reservation figure for the
    // category (offered = 0) — that is "unknown", not "unsubscribed".
    const times = offered && offered > 0 ? toNumber(row?.noOfTotalMeant) : null;
    if (cat.startsWith('qualified institutional')) snap.qib = times;
    else if (cat.startsWith('non institutional')) snap.nii = snap.nii ?? times;
    else if (cat.startsWith('retail individual') || cat.startsWith('individual investors')) snap.retail = snap.retail ?? times;
    else if (cat.includes('employee')) {
      snap.employee = times;
      snap.hasEmployeeQuota = (offered ?? 0) > 0;
    } else if (cat.includes('shareholder')) {
      snap.shareholder = times;
      snap.hasShareholderQuota = (offered ?? 0) > 0;
    } else if (cat === 'total') snap.total = times;
  }
  return snap;
}

// ── Scoring ───────────────────────────────────────────────────────────────────

/**
 * Transparent checklist score. Points:
 *   GMP %  : ≥30 +3 · ≥15 +2 · ≥5 +1 · <0 −3 · unknown 0
 *   Total ×: ≥50 +2 · ≥10 +1 · <1 (open issue) −1
 *   QIB ×  : ≥20 +1 (mainboard only — SME QIB books are thin)
 *   SME    : −1 (small float, large ticket, exit liquidity risk)
 * Verdict: ≥4 APPLY · 1–3 CONSIDER · ≤0 AVOID; upcoming with no GMP → WAIT.
 */
export function scoreIpo(input: IpoScoreInput): IpoScore {
  const reasons: string[] = [];
  let score = 0;
  const gmpPct = input.gmp !== null && input.priceHigh ? (input.gmp / input.priceHigh) * 100 : null;

  if (gmpPct === null) {
    reasons.push('No grey-market premium available.');
  } else if (gmpPct < 0) {
    score -= 3; reasons.push(`GMP is negative (${gmpPct.toFixed(1)}%) — listing below issue price is being priced in.`);
  } else if (gmpPct >= 30) {
    score += 3; reasons.push(`Strong GMP ${gmpPct.toFixed(1)}%.`);
  } else if (gmpPct >= 15) {
    score += 2; reasons.push(`Healthy GMP ${gmpPct.toFixed(1)}%.`);
  } else if (gmpPct >= 5) {
    score += 1; reasons.push(`Modest GMP ${gmpPct.toFixed(1)}%.`);
  } else {
    reasons.push(`Flat GMP ${gmpPct.toFixed(1)}%.`);
  }

  const sub = input.subscription;
  if (sub?.total !== null && sub?.total !== undefined) {
    if (sub.total >= 50) { score += 2; reasons.push(`Heavily subscribed (${sub.total.toFixed(1)}×).`); }
    else if (sub.total >= 10) { score += 1; reasons.push(`Well subscribed (${sub.total.toFixed(1)}×).`); }
    else if (sub.total < 1 && input.status === 'OPEN') { score -= 1; reasons.push(`Under-subscribed so far (${sub.total.toFixed(2)}×).`); }
    else reasons.push(`Subscribed ${sub.total.toFixed(1)}×.`);
  }
  if (input.segment === 'MAINBOARD' && sub?.qib !== null && sub?.qib !== undefined && sub.qib >= 20) {
    score += 1; reasons.push(`Institutions are in (QIB ${sub.qib.toFixed(1)}×).`);
  }
  if (input.segment === 'SME') {
    score -= 1; reasons.push('SME issue: large minimum ticket and thin post-listing liquidity.');
  }

  let verdict: Verdict;
  if (input.status === 'UPCOMING' && input.gmp === null) verdict = 'WAIT';
  else if (score >= 4) verdict = 'APPLY';
  else if (score >= 1) verdict = 'CONSIDER';
  else verdict = 'AVOID';

  return { score, verdict, gmpPct, reasons };
}

/**
 * Rough chance that one retail application gets one lot when the retail book
 * is oversubscribed. SEBI's mainboard rule is "minimum lot by lottery", so the
 * odds approach 1 / retail× (less, when lots outnumber applications). Shown as
 * a hint, not a promise.
 */
export function retailAllotmentOdds(retailTimes: number | null): number | null {
  if (retailTimes === null || retailTimes <= 0) return null;
  return Math.min(1, 1 / retailTimes);
}

// ── Corporate actions (api/corporates-corporateActions) ──────────────────────

export function classifyCorporateAction(row: any): CorporateAction | null {
  const subject = String(row?.subject || '').trim();
  const s = subject.toLowerCase();
  let kind: CorporateActionKind | null = null;
  if (s.includes('bonus')) kind = 'BONUS';
  else if (s.includes('rights')) kind = 'RIGHTS';
  else if (s.includes('split') || s.includes('sub-division') || s.includes('sub division')) kind = 'SPLIT';
  if (!kind) return null;

  const ratio = subject.match(/(\d+\s*:\s*\d+)/)?.[1]?.replace(/\s+/g, '') || null;
  const exDate = parseNseDate(row?.exDate);
  return {
    symbol: String(row?.symbol || '').trim(),
    company: String(row?.comp || row?.company || '').trim(),
    kind,
    ratio,
    exDate,
    recordDate: parseNseDate(row?.recDate),
    // T+1 rolling settlement: ex-date = record date, so the last day to buy
    // and still be entitled is the trading day before the ex-date.
    buyBy: exDate ? previousWeekday(exDate) : null,
    subject,
  };
}

// ── Board meetings (api/corporate-board-meetings) ────────────────────────────

export function classifyBoardMeeting(row: any): BoardAnnouncement | null {
  const purpose = String(row?.bm_purpose || '').trim();
  const description = String(row?.bm_desc || '').trim();
  const text = `${purpose} ${description}`.toLowerCase();
  // Intimation / rescheduling rows duplicate the real purpose row.
  if (/^board meeting (intimation|rescheduled)/i.test(purpose)) return null;

  let kind: AnnouncementKind | null = null;
  if (/\bbonus\b/.test(text)) kind = 'BONUS';
  else if (/rights?\s*issue|on a rights|rights basis|by way of rights/.test(text)) kind = 'RIGHTS';
  else if (/preferential/.test(text)) kind = 'PREFERENTIAL';
  else if (/sub-?division|stock split|split of/.test(text)) kind = 'SPLIT';
  if (!kind) return null;

  return {
    symbol: String(row?.bm_symbol || '').trim(),
    company: String(row?.sm_name || '').trim(),
    kind,
    meetingDate: parseNseDate(row?.bm_date),
    purpose,
    description: description.slice(0, 400),
    attachment: typeof row?.attachment === 'string' && /^https:\/\/[a-z0-9.-]*nseindia\.com\//i.test(row.attachment) ? row.attachment : null,
  };
}

/** One row per symbol+kind+date; keeps the longest description. */
export function dedupeAnnouncements(items: BoardAnnouncement[]): BoardAnnouncement[] {
  const map = new Map<string, BoardAnnouncement>();
  for (const a of items) {
    const key = `${a.symbol}|${a.kind}|${a.meetingDate}`;
    const prev = map.get(key);
    if (!prev || a.description.length > prev.description.length) map.set(key, a);
  }
  return [...map.values()].sort((a, b) => (b.meetingDate || '').localeCompare(a.meetingDate || ''));
}

// ── Shareholder-quota picks ──────────────────────────────────────────────────

export interface QuotaWatchEntry {
  id: string;
  parentSymbol: string;     // listed parent whose shareholders get the quota
  ipoName: string;          // subsidiary / group company going public
  cutoffDate: string | null; // RHP date: hold ≥1 parent share in demat by end of this day
  note?: string;
}

export interface QuotaPick {
  id: string | null;        // watchlist id (null for NSE-detected rows)
  parentSymbol: string;
  ipoName: string;
  cutoffDate: string | null;
  buyBy: string | null;     // trade date that settles in demat by the cut-off (T+1)
  daysLeft: number | null;
  source: 'NSE' | 'WATCHLIST';
  action: string;
}

/** Days from `todayIso` to `iso` (negative = past). */
export function daysBetween(todayIso: string, iso: string): number {
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86_400_000);
}

/**
 * Turn the watchlist into actionable picks. Shares bought on T settle in demat
 * on T+1, so to be a shareholder on the RHP date you must buy at least one
 * trading day before it.
 */
export function buildQuotaPicks(entries: QuotaWatchEntry[], todayIso: string): QuotaPick[] {
  return entries
    .map((e): QuotaPick => {
      const buyBy = e.cutoffDate ? previousWeekday(e.cutoffDate) : null;
      const daysLeft = buyBy ? daysBetween(todayIso, buyBy) : null;
      let action: string;
      if (!e.cutoffDate) action = `Cut-off (RHP) date not announced. Buy 1 share of ${e.parentSymbol} in every family demat early — the quota usually needs the shares held on the RHP date.`;
      else if (daysLeft !== null && daysLeft < 0) action = `Cut-off passed on ${e.cutoffDate}. Only demats that held ${e.parentSymbol} by then qualify.`;
      else action = `Buy at least 1 share of ${e.parentSymbol} in every family demat by ${buyBy} (settles T+1 before the ${e.cutoffDate} cut-off).`;
      return { id: e.id, parentSymbol: e.parentSymbol, ipoName: e.ipoName, cutoffDate: e.cutoffDate, buyBy, daysLeft, source: 'WATCHLIST', action };
    })
    .sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));
}
