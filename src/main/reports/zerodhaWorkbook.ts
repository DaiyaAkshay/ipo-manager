import * as XLSX from 'xlsx';

export interface ZerodhaReportSummary {
  sheetName: string;
  assetScope: 'EQUITY' | 'MUTUAL_FUNDS' | 'COMBINED';
  clientId: string | null;
  statementTitle: string | null;
  asOfDate: string | null;
  investedValue: number | null;
  presentValue: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPct: number | null;
}

export interface ZerodhaHoldingRow {
  sheetName: string;
  assetScope: 'EQUITY' | 'MUTUAL_FUNDS' | 'COMBINED';
  isCombinedView: boolean;
  rowOrder: number;
  symbol: string;
  isin: string | null;
  sector: string | null;
  instrumentType: string | null;
  quantityAvailable: number | null;
  quantityDiscrepant: number | null;
  quantityLongTerm: number | null;
  quantityPledgedMargin: number | null;
  quantityPledgedLoan: number | null;
  averagePrice: number | null;
  previousClosingPrice: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPct: number | null;
}

export interface ParsedZerodhaPortfolioReport {
  clientId: string | null;
  asOfDate: string | null;
  summaries: ZerodhaReportSummary[];
  holdings: ZerodhaHoldingRow[];
}

const SUMMARY_LABELS = new Map<string, keyof Pick<
  ZerodhaReportSummary,
  'investedValue' | 'presentValue' | 'unrealizedPnl' | 'unrealizedPnlPct'
>>([
  ['Invested Value', 'investedValue'],
  ['Present Value', 'presentValue'],
  ['Unrealized P&L', 'unrealizedPnl'],
  ['Unrealized P&L Pct.', 'unrealizedPnlPct'],
  ['Unrealize P&L Pct.', 'unrealizedPnlPct'],
]);

const HEADER_ALIASES: Record<string, keyof ZerodhaHoldingRow | undefined> = {
  'Symbol': 'symbol',
  'ISIN': 'isin',
  'Sector': 'sector',
  'Instrument Type': 'instrumentType',
  'Quantity Available': 'quantityAvailable',
  'Quantity Discrepant': 'quantityDiscrepant',
  'Quantity Long Term': 'quantityLongTerm',
  'Quantity Pledged (Margin)': 'quantityPledgedMargin',
  'Quantity Pledged (Loan)': 'quantityPledgedLoan',
  'Average Price': 'averagePrice',
  'Previous Closing Price': 'previousClosingPrice',
  'Unrealized P&L': 'unrealizedPnl',
  'Unrealized P&L Pct.': 'unrealizedPnlPct',
  'Unrealize P&L Pct.': 'unrealizedPnlPct',
};

export function parseZerodhaPortfolioReport(filePath: string): ParsedZerodhaPortfolioReport {
  const workbook = XLSX.readFile(filePath, { cellDates: false });
  const summaries: ZerodhaReportSummary[] = [];
  const holdings: ZerodhaHoldingRow[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, {
      header: 1,
      defval: null,
      blankrows: false,
      raw: true,
    });
    if (!rows.length) continue;

    const assetScope = toAssetScope(sheetName);
    const summary = parseSheetSummary(rows, sheetName, assetScope);
    summaries.push(summary);

    const headerRowIdx = rows.findIndex((row) => {
      const normalized = row.map((cell) => normalizeLabel(cell));
      return normalized.includes('symbol') && normalized.includes('isin');
    });
    if (headerRowIdx < 0) continue;

    const headerMap = buildHeaderMap(rows[headerRowIdx] || []);
    if (headerMap.symbol === undefined) continue;
    let rowOrder = 0;

    for (let rowIdx = headerRowIdx + 1; rowIdx < rows.length; rowIdx += 1) {
      const row = rows[rowIdx] || [];
      const symbol = readText(row, headerMap.symbol);
      if (!symbol) continue;
      rowOrder += 1;

      const quantityAvailable = readNumber(row, headerMap.quantityAvailable);
      const quantityDiscrepant = readNumber(row, headerMap.quantityDiscrepant);
      const quantityLongTerm = readNumber(row, headerMap.quantityLongTerm);
      const quantityPledgedMargin = readNumber(row, headerMap.quantityPledgedMargin);
      const quantityPledgedLoan = readNumber(row, headerMap.quantityPledgedLoan);
      const averagePrice = readNumber(row, headerMap.averagePrice);
      const previousClosingPrice = readNumber(row, headerMap.previousClosingPrice);
      const derived = deriveHoldingPnl({
        quantityAvailable,
        quantityDiscrepant,
        quantityLongTerm,
        quantityPledgedMargin,
        quantityPledgedLoan,
        averagePrice,
        previousClosingPrice,
      });

      holdings.push({
        sheetName,
        assetScope,
        isCombinedView: assetScope === 'COMBINED',
        rowOrder,
        symbol,
        isin: readText(row, headerMap.isin),
        sector: readDashAsNull(readText(row, headerMap.sector)),
        instrumentType: readDashAsNull(readText(row, headerMap.instrumentType)),
        quantityAvailable,
        quantityDiscrepant,
        quantityLongTerm,
        quantityPledgedMargin,
        quantityPledgedLoan,
        averagePrice,
        previousClosingPrice,
        unrealizedPnl: derived.unrealizedPnl,
        unrealizedPnlPct: derived.unrealizedPnlPct,
      });
    }
  }

  const recomputedSummaries = summaries.map(summary => recomputeSummaryFromHoldings(summary, holdings));

  return {
    clientId: recomputedSummaries[0]?.clientId ?? null,
    asOfDate: recomputedSummaries[0]?.asOfDate ?? null,
    summaries: recomputedSummaries,
    holdings,
  };
}

function toAssetScope(sheetName: string): ZerodhaReportSummary['assetScope'] {
  const normalized = sheetName.trim().toLowerCase();
  if (normalized === 'equity') return 'EQUITY';
  if (normalized === 'mutual funds') return 'MUTUAL_FUNDS';
  return 'COMBINED';
}

function parseSheetSummary(
  rows: (string | number | null)[][],
  sheetName: string,
  assetScope: ZerodhaReportSummary['assetScope'],
): ZerodhaReportSummary {
  const summary: ZerodhaReportSummary = {
    sheetName,
    assetScope,
    clientId: null,
    statementTitle: null,
    asOfDate: null,
    investedValue: null,
    presentValue: null,
    unrealizedPnl: null,
    unrealizedPnlPct: null,
  };

  for (const row of rows.slice(0, 10)) {
    const label = String(row[0] ?? '').trim();
    if (label === 'Client ID') {
      summary.clientId = readText(row, 1);
      continue;
    }
    if (/Holdings Statement as on/i.test(label)) {
      summary.statementTitle = label;
      const m = label.match(/as on (\d{4}-\d{2}-\d{2})/i);
      summary.asOfDate = m?.[1] ?? null;
      continue;
    }
    const field = SUMMARY_LABELS.get(label);
    if (field) {
      summary[field] = readNumber(row, 1);
    }
  }

  return summary;
}

function buildHeaderMap(headerRow: (string | number | null)[]) {
  const map: Partial<Record<keyof ZerodhaHoldingRow, number>> = {};
  headerRow.forEach((cell, idx) => {
    const key = HEADER_ALIASES[String(cell ?? '').trim()];
    if (key) map[key] = idx;
  });
  return map;
}

function normalizeLabel(value: string | number | null): string {
  return String(value ?? '').trim().toLowerCase();
}

function readText(row: (string | number | null)[], index: number | undefined): string | null {
  if (index === undefined) return null;
  const value = row[index];
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function readDashAsNull(value: string | null): string | null {
  if (!value || value === '-') return null;
  return value;
}

function readNumber(row: (string | number | null)[], index: number | undefined): number | null {
  if (index === undefined) return null;
  const value = row[index];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function deriveHoldingPnl(input: {
  quantityAvailable: number | null;
  quantityDiscrepant: number | null;
  quantityLongTerm: number | null;
  quantityPledgedMargin: number | null;
  quantityPledgedLoan: number | null;
  averagePrice: number | null;
  previousClosingPrice: number | null;
}) {
  const totalQuantity =
    (input.quantityAvailable || 0)
    + (input.quantityDiscrepant || 0)
    + (input.quantityPledgedMargin || 0)
    + (input.quantityPledgedLoan || 0);
  const investedValue = totalQuantity > 0 && input.averagePrice !== null ? totalQuantity * input.averagePrice : 0;
  const presentValue = totalQuantity > 0 && input.previousClosingPrice !== null ? totalQuantity * input.previousClosingPrice : 0;
  const unrealizedPnl = presentValue - investedValue;
  const unrealizedPnlPct = investedValue > 0
    ? (unrealizedPnl / investedValue) * 100
    : presentValue > 0 ? 100 : 0;

  return { totalQuantity, investedValue, presentValue, unrealizedPnl, unrealizedPnlPct };
}

function recomputeSummaryFromHoldings(summary: ZerodhaReportSummary, holdings: ZerodhaHoldingRow[]): ZerodhaReportSummary {
  const scoped = holdings.filter(h => h.sheetName === summary.sheetName);
  let investedValue = 0;
  let presentValue = 0;

  for (const holding of scoped) {
    const derived = deriveHoldingPnl({
      quantityAvailable: holding.quantityAvailable,
      quantityDiscrepant: holding.quantityDiscrepant,
      quantityLongTerm: holding.quantityLongTerm,
      quantityPledgedMargin: holding.quantityPledgedMargin,
      quantityPledgedLoan: holding.quantityPledgedLoan,
      averagePrice: holding.averagePrice,
      previousClosingPrice: holding.previousClosingPrice,
    });
    investedValue += derived.investedValue;
    presentValue += derived.presentValue;
  }

  const unrealizedPnl = presentValue - investedValue;
  const unrealizedPnlPct = investedValue > 0
    ? (unrealizedPnl / investedValue) * 100
    : presentValue > 0 ? 100 : 0;

  return {
    ...summary,
    investedValue,
    presentValue,
    unrealizedPnl,
    unrealizedPnlPct,
  };
}
