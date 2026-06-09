import { getDb } from '../db/connection';

export interface IpoCatalogIssue {
  issueName: string;
  symbol: string | null;
  exchangePlatform: string | null;
  issueType: string | null;
  status: 'LIVE' | 'FORTHCOMING' | 'UNKNOWN';
  openDate: string | null;
  closeDate: string | null;
  priceMin: number | null;
  priceMax: number | null;
  lotSize: number | null;
  minimumBidQuantity: number | null;
  faceValue: number | null;
  detailUrl: string | null;
  fetchedAt?: string | null;
}

const BSE_LIST_URL = 'https://www.bseindia.com/publicissue.html';
const BSE_ALT_LIST_URL = 'https://www.bseindia.com/markets/PublicIssues/IPOIssues_new.aspx?Type=p&id=1';
const BSE_API_BASE = 'https://api.bseindia.com/BseIndiaAPI/api';
const BSE_PUBLIC_ISSUES_PAGE = 'https://www.bseindia.com/markets/PublicIssues/IPOIssues?id=1&Type=p';
const NSE_LIST_URL = 'https://www.nseindia.com/market-data/public-issues-initial-public-offering-ipo';

const COMMON_HEADERS: Record<string, string> = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  referer: 'https://www.google.com/',
  pragma: 'no-cache',
  'cache-control': 'no-cache',
};

const BSE_API_HEADERS: Record<string, string> = {
  ...COMMON_HEADERS,
  accept: 'application/json, text/plain, */*',
  origin: 'https://www.bseindia.com',
  referer: BSE_PUBLIC_ISSUES_PAGE,
};

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripHtml(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, '\n')
  )
    .replace(/\r/g, '')
    .replace(/\t/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function normalizeStatus(input: string | null | undefined): 'LIVE' | 'FORTHCOMING' | 'UNKNOWN' {
  const text = (input || '').toLowerCase();
  if (text === 'l') return 'LIVE';
  if (text === 'f') return 'FORTHCOMING';
  if (text.includes('forthcoming')) return 'FORTHCOMING';
  if (text.includes('live') || text.includes('active')) return 'LIVE';
  return 'UNKNOWN';
}

function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  let match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = trimmed.match(/(\d{2})[-/](\d{2})[-/](\d{4})/);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  match = trimmed.match(/(\d{2})[\s-]([A-Za-z]{3,})[\s-](\d{4})/);
  if (!match) return null;
  const months: Record<string, string> = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };
  const mm = months[match[2].toLowerCase()];
  return mm ? `${match[3]}-${mm}-${match[1]}` : null;
}

function parseNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function parsePriceBand(value: string | null | undefined): { min: number | null; max: number | null } {
  if (!value) return { min: null, max: null };
  const matches = value.match(/(\d+(?:\.\d+)?)/g);
  if (!matches?.length) return { min: null, max: null };
  if (matches.length === 1) {
    const only = parseNumber(matches[0]);
    return { min: only, max: only };
  }
  return { min: parseNumber(matches[0]), max: parseNumber(matches[1]) };
}

function extractField(text: string, label: string, nextLabelHints: string[] = []): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stop = nextLabelHints.length
    ? `(?=\\n(?:${nextLabelHints.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b|$)`
    : '(?=\\n[A-Z][A-Za-z][^\\n]{0,40}:|$)';
  const re = new RegExp(`${escaped}\\s*:?\\s*([^\\n]+?)${stop}`, 'i');
  const match = text.match(re);
  return match?.[1]?.trim() || null;
}

function parseBseDetailPage(html: string, detailUrl: string): IpoCatalogIssue | null {
  const text = stripHtml(html);
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const bannerIndex = lines.findIndex(line => /-\s*(Live|Forthcoming|Historical)/i.test(line));
  let issueName: string | null = null;
  if (bannerIndex >= 0) {
    for (let i = bannerIndex + 1; i < Math.min(lines.length, bannerIndex + 8); i += 1) {
      const line = lines[i];
      if (/^back$/i.test(line) || /^all prices/i.test(line)) continue;
      if (/^(security type|symbol|issue period|market lot|price band|offer price)/i.test(line)) break;
      issueName = line;
      break;
    }
  }
  if (!issueName) {
    issueName = extractField(text, 'Company Name', ['Security Type', 'Symbol', 'Issue Period']);
  }
  if (!issueName) return null;

  const status = normalizeStatus(lines[bannerIndex] || '');
  const issuePeriod = extractField(text, 'Issue Period', ['IPO Market Timings', 'Issue Size', 'Price Band', 'Offer Price / Face Value']);
  const periodMatch = issuePeriod?.match(/(.+?)\s+to\s+(.+)/i);
  const priceBandText = extractField(text, 'Price Band', ['Price-Band Advertisement', 'IPO Categories', 'UPI Categories', 'Cut off Amount', 'Face Value', 'Tick Size', 'Market Lot']);
  const priceBand = parsePriceBand(priceBandText || extractField(text, 'Offer Price / Face Value', ['Minimum Bid Quantity', 'Issue Size', 'Ratings']));

  return {
    issueName,
    symbol: extractField(text, 'Symbol', ['Issue Period', 'IPO Market Timings', 'Issue Size']),
    exchangePlatform: extractField(text, 'Exchange Platform', ['Start Date', 'End Date', 'Offer Price']),
    issueType: extractField(text, 'Security Type', ['Symbol', 'Issue Period', 'IPO Market Timings']),
    status,
    openDate: normalizeDate(periodMatch?.[1] || null),
    closeDate: normalizeDate(periodMatch?.[2] || null),
    priceMin: priceBand.min,
    priceMax: priceBand.max,
    lotSize: parseNumber(extractField(text, 'Market Lot', ['Minimum Bid Quantity', 'Maximum Bid Quantity', 'Book Running Lead Manager'])),
    minimumBidQuantity: parseNumber(extractField(text, 'Minimum Bid Quantity', ['Maximum Bid Quantity', 'Book Running Lead Manager', 'Registrar'])),
    faceValue: parseNumber(extractField(text, 'Face Value', ['Tick Size', 'Market Lot', 'Minimum Bid Quantity'])),
    detailUrl,
  };
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, { headers: COMMON_HEADERS });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

async function fetchBseJson(url: string): Promise<any> {
  const response = await fetch(url, { headers: BSE_API_HEADERS });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);

  const text = await response.text();
  const trimmed = text.trim();
  if (trimmed.startsWith('<')) {
    throw new Error(`BSE API returned HTML instead of JSON for ${url}`);
  }

  return JSON.parse(trimmed);
}

function bseDetailUrl(row: any): string {
  const params = new URLSearchParams({
    id: String(row.Scrip_cd ?? ''),
    type: String(row.IR_flag ?? ''),
    idtype: '1',
    status: String(row.Status ?? ''),
    IPONo: String(row.IPO_NO ?? ''),
    startdt: formatBseDetailDate(row.Start_Dt),
  });
  return `https://www.bseindia.com/markets/publicIssues/DisplayIPO?${params.toString()}`;
}

function formatBseDetailDate(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(date.getDate()).padStart(2, '0')}/${months[date.getMonth()]}/${date.getFullYear()}`;
}

function rowLabel(rows: any[], label: string): string | null {
  const found = rows.find(row => String(row.Label || '').toLowerCase() === label.toLowerCase());
  return found?.Value ? String(found.Value) : null;
}

async function fetchBseIssueDetails(row: any): Promise<Partial<IpoCatalogIssue>> {
  const ipoNo = String(row.IPO_NO ?? '').trim();
  if (!ipoNo) return {};

  const url = `${BSE_API_BASE}/ipo_details_ng/w?stripono=${encodeURIComponent(ipoNo)}`;
  const json = await fetchBseJson(url);
  const rows = Array.isArray(json?.TableRows) ? json.TableRows : [];
  const issuePeriod = rowLabel(rows, 'Issue Period');
  const periodMatch = issuePeriod?.match(/(.+?)\s+to\s+(.+)/i);
  const priceBand = parsePriceBand(rowLabel(rows, 'Price Band') || row.Price_Band);

  return {
    symbol: rowLabel(rows, 'Symbol'),
    issueType: rowLabel(rows, 'Security Type') || row.IR_FLAG_FULL || row.IR_flag || null,
    openDate: normalizeDate(periodMatch?.[1] || row.Start_Dt),
    closeDate: normalizeDate(periodMatch?.[2] || row.End_Dt),
    priceMin: priceBand.min,
    priceMax: priceBand.max,
    lotSize: parseNumber(rowLabel(rows, 'Market Lot')),
    minimumBidQuantity: parseNumber(rowLabel(rows, 'Minimum Bid Quantity')),
    faceValue: parseNumber(rowLabel(rows, 'Face Value') || String(row.Face_Val ?? '')),
    detailUrl: bseDetailUrl(row),
  };
}

async function fetchBseApiIssues(): Promise<IpoCatalogIssue[]> {
  const url = `${BSE_API_BASE}/HomePage_Issues_BBS_Landing_ng/w?flag=1&scrip_Name=&end_dt=&IR_FLAG=&Start_DT=`;
  const json = await fetchBseJson(url);
  const rows = Array.isArray(json?.Table) ? json.Table : [];
  const ipoRows = rows.filter((row: any) => String(row.IR_flag || '').toUpperCase() === 'IPO');

  const issues: IpoCatalogIssue[] = ipoRows.map((row: any) => {
    const priceBand = parsePriceBand(row.Price_Band);
    return {
      issueName: String(row.Scrip_Name || row.LONG_NAME || '').trim(),
      symbol: row.short_name || null,
      exchangePlatform: row.eXCHANGE_PLATFORM || null,
      issueType: row.IR_FLAG_FULL || row.IR_flag || 'IPO',
      status: normalizeStatus(row.Status),
      openDate: normalizeDate(row.Start_Dt),
      closeDate: normalizeDate(row.End_Dt),
      priceMin: priceBand.min,
      priceMax: priceBand.max,
      lotSize: null,
      minimumBidQuantity: null,
      faceValue: parseNumber(String(row.Face_Val ?? '')),
      detailUrl: bseDetailUrl(row),
    };
  }).filter((issue: IpoCatalogIssue) => issue.issueName);

  const enriched = await Promise.all(issues.map(async (issue, index) => {
    try {
      const details = await fetchBseIssueDetails(ipoRows[index]);
      return { ...issue, ...details, issueName: issue.issueName };
    } catch {
      return issue;
    }
  }));

  return enriched;
}

function parseBseListPage(html: string): IpoCatalogIssue[] {
  const text = stripHtml(html);
  const issues: IpoCatalogIssue[] = [];
  const rowRegex = /([A-Z0-9&().,'\/\-\s]+?)\s+(MainBoard|SME|Debt)\s+(\d{2}-\d{2}-\d{4})\s+(\d{2}-\d{2}-\d{4})\s+([0-9.\s-]+|DPI)\s+([0-9.]+|--)\s+([A-Z]+)\s+(Live|Forthcoming)/gi;

  for (const match of text.matchAll(rowRegex)) {
    const issueTypeFlag = (match[7] || '').trim().toUpperCase();
    if (issueTypeFlag !== 'IPO') continue;

    const priceBand = parsePriceBand(match[5]);
    issues.push({
      issueName: match[1].replace(/\s{2,}/g, ' ').trim(),
      symbol: null,
      exchangePlatform: match[2] || null,
      issueType: issueTypeFlag,
      status: normalizeStatus(match[8]),
      openDate: normalizeDate(match[3]),
      closeDate: normalizeDate(match[4]),
      priceMin: priceBand.min,
      priceMax: priceBand.max,
      lotSize: null,
      minimumBidQuantity: null,
      faceValue: parseNumber(match[6]),
      detailUrl: null,
    });
  }

  return issues;
}

function normalizeBseDetailUrl(link: string): string {
  const decoded = decodeHtmlEntities(link).trim();
  if (!decoded) return decoded;
  if (/^https?:\/\//i.test(decoded)) return decoded;
  if (/^\/?markets\/publicissues\/displayipo\.aspx/i.test(decoded)) {
    const path = decoded.startsWith('/') ? decoded : `/${decoded}`;
    return `https://www.bseindia.com${path}`;
  }
  if (/^displayipo\.aspx/i.test(decoded)) {
    return `https://www.bseindia.com/markets/PublicIssues/${decoded}`;
  }
  return new URL(decoded, BSE_LIST_URL).toString();
}

function extractBseDetailLinks(html: string): string[] {
  const hrefMatches = Array.from(
    html.matchAll(/href\s*=\s*["']([^"']*DisplayIPO\.aspx[^"']*type=IPO[^"']*)["']/gi)
  ).map(match => match[1]);

  const jsMatches = Array.from(
    html.matchAll(/DisplayIPO\.aspx[^"')\s>]*type=IPO[^"')\s>]*/gi)
  ).map(match => match[0]);

  return Array.from(new Set([...hrefMatches, ...jsMatches].map(normalizeBseDetailUrl)));
}

async function fetchBseIssues(): Promise<IpoCatalogIssue[]> {
  try {
    const apiIssues = await fetchBseApiIssues();
    if (apiIssues.length) return apiIssues;
  } catch {
    // Fall through to the older page parser below; BSE occasionally changes API gating.
  }

  const sourceUrls = [BSE_ALT_LIST_URL, BSE_LIST_URL];
  const listIssues: IpoCatalogIssue[] = [];
  const detailUrls = new Set<string>();
  let lastError: Error | null = null;

  for (const sourceUrl of sourceUrls) {
    try {
      const html = await fetchHtml(sourceUrl);
      extractBseDetailLinks(html).forEach(url => detailUrls.add(url));
      parseBseListPage(html).forEach(issue => listIssues.push(issue));
    } catch (e: any) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }

  const detailIssues: IpoCatalogIssue[] = [];
  for (const url of Array.from(detailUrls).slice(0, 40)) {
    try {
      const detailHtml = await fetchHtml(url);
      const parsed = parseBseDetailPage(detailHtml, url);
      if (parsed && (parsed.status === 'LIVE' || parsed.status === 'FORTHCOMING')) {
        detailIssues.push(parsed);
      }
    } catch {
      // Ignore individual issue failures; list-page data is still usable.
    }
  }

  const merged = new Map<string, IpoCatalogIssue>();
  for (const issue of listIssues) {
    merged.set(issue.issueName.toUpperCase(), issue);
  }
  for (const issue of detailIssues) {
    const key = issue.issueName.toUpperCase();
    const existing = merged.get(key);
    merged.set(key, {
      ...(existing || issue),
      ...issue,
      issueName: issue.issueName || existing?.issueName || '',
      detailUrl: issue.detailUrl || existing?.detailUrl || null,
      lotSize: issue.lotSize ?? existing?.lotSize ?? null,
      minimumBidQuantity: issue.minimumBidQuantity ?? existing?.minimumBidQuantity ?? null,
      faceValue: issue.faceValue ?? existing?.faceValue ?? null,
      priceMin: issue.priceMin ?? existing?.priceMin ?? null,
      priceMax: issue.priceMax ?? existing?.priceMax ?? null,
      openDate: issue.openDate ?? existing?.openDate ?? null,
      closeDate: issue.closeDate ?? existing?.closeDate ?? null,
      status: issue.status || existing?.status || 'UNKNOWN',
    });
  }

  const issues = Array.from(merged.values()).filter(issue =>
    (issue.status === 'LIVE' || issue.status === 'FORTHCOMING')
      && (issue.issueType === 'IPO' || !!issue.detailUrl)
  );

  if (!issues.length && lastError) throw lastError;
  return issues;
}

async function fetchNseFallbackIssues(): Promise<IpoCatalogIssue[]> {
  const html = await fetchHtml(NSE_LIST_URL);
  const text = stripHtml(html);
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const issues: IpoCatalogIssue[] = [];

  function consumeTable(afterHeading: string, status: 'LIVE' | 'FORTHCOMING') {
    const idx = lines.findIndex(line => line.toLowerCase() === afterHeading.toLowerCase());
    if (idx < 0) return;
    for (let i = idx + 2; i < Math.min(lines.length, idx + 30); i += 1) {
      const line = lines[i];
      if (/^#{1,6}\s|^About NSE$/i.test(line) || /Download NSE App/i.test(line)) break;
      const parts = line.split(/\s{2,}/).map(part => part.trim()).filter(Boolean);
      if (parts.length < 5) continue;
      const [issueName, issueType, openDate, closeDate] = parts;
      issues.push({
        issueName,
        symbol: null,
        exchangePlatform: 'NSE',
        issueType,
        status,
        openDate: normalizeDate(openDate),
        closeDate: normalizeDate(closeDate),
        priceMin: null,
        priceMax: null,
        lotSize: null,
        minimumBidQuantity: null,
        faceValue: null,
        detailUrl: null,
      });
    }
  }

  consumeTable('Current Issue at NSE', 'LIVE');
  consumeTable('Red-Herring Prospectus of Upcoming Issues', 'FORTHCOMING');
  return issues;
}

function upsertIssues(issues: IpoCatalogIssue[]): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO ipo_master_cache
    (source, issue_name, symbol, exchange_platform, issue_type, status, open_date, close_date,
     price_min, price_max, lot_size, minimum_bid_quantity, face_value, detail_url, raw_json,
     fetched_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(issue_name) DO UPDATE SET
      source=excluded.source,
      symbol=excluded.symbol,
      exchange_platform=excluded.exchange_platform,
      issue_type=excluded.issue_type,
      status=excluded.status,
      open_date=excluded.open_date,
      close_date=excluded.close_date,
      price_min=excluded.price_min,
      price_max=excluded.price_max,
      lot_size=excluded.lot_size,
      minimum_bid_quantity=excluded.minimum_bid_quantity,
      face_value=excluded.face_value,
      detail_url=excluded.detail_url,
      raw_json=excluded.raw_json,
      fetched_at=CURRENT_TIMESTAMP,
      updated_at=CURRENT_TIMESTAMP
  `);

  const tx = db.transaction((rows: IpoCatalogIssue[]) => {
    rows.forEach((issue) => {
      stmt.run(
        issue.detailUrl ? 'BSE' : 'NSE',
        issue.issueName,
        issue.symbol,
        issue.exchangePlatform,
        issue.issueType,
        issue.status,
        issue.openDate,
        issue.closeDate,
        issue.priceMin,
        issue.priceMax,
        issue.lotSize,
        issue.minimumBidQuantity,
        issue.faceValue,
        issue.detailUrl,
        JSON.stringify(issue)
      );
    });
  });
  tx(issues);
}

export function listCachedIpoIssues(): IpoCatalogIssue[] {
  const db = getDb();
  return db.prepare(`
    SELECT issue_name as issueName,
           symbol,
           exchange_platform as exchangePlatform,
           issue_type as issueType,
           status,
           open_date as openDate,
           close_date as closeDate,
           price_min as priceMin,
           price_max as priceMax,
           lot_size as lotSize,
           minimum_bid_quantity as minimumBidQuantity,
           face_value as faceValue,
           detail_url as detailUrl,
           fetched_at as fetchedAt
    FROM ipo_master_cache
    WHERE status IN ('LIVE', 'FORTHCOMING')
    ORDER BY
      CASE status WHEN 'LIVE' THEN 0 WHEN 'FORTHCOMING' THEN 1 ELSE 2 END,
      close_date,
      open_date,
      issue_name
  `).all() as IpoCatalogIssue[];
}

export async function refreshIpoCatalog(): Promise<{ ok: true; issues: IpoCatalogIssue[]; source: string } | { ok: false; error: string; issues: IpoCatalogIssue[] }> {
  try {
    let issues = await fetchBseIssues();
    let source = 'BSE';
    if (!issues.length) {
      issues = await fetchNseFallbackIssues();
      source = 'NSE';
    }
    if (!issues.length) throw new Error('No IPO issues could be parsed from official sources');
    upsertIssues(issues);
    return { ok: true, issues: listCachedIpoIssues(), source };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e), issues: listCachedIpoIssues() };
  }
}
