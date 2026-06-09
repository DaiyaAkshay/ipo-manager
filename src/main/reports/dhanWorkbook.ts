import * as XLSX from 'xlsx';

export interface DhanReportSummary {
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

export interface DhanHoldingRow {
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

export interface ParsedDhanPortfolioReport {
  clientId: string | null;
  asOfDate: string | null;
  summaries: DhanReportSummary[];
  holdings: DhanHoldingRow[];
}

type DhanHoldingField =
  | 'symbol'
  | 'isin'
  | 'sector'
  | 'instrumentType'
  | 'quantityAvailable'
  | 'quantityDiscrepant'
  | 'quantityLongTerm'
  | 'quantityPledgedMargin'
  | 'quantityPledgedLoan'
  | 'quantityTotal'
  | 'averagePrice'
  | 'investedValue'
  | 'previousClosingPrice'
  | 'presentValue'
  | 'unrealizedPnl'
  | 'unrealizedPnlPct';

const HEADER_ALIASES: Record<string, DhanHoldingField | undefined> = {
  'scrip name': 'symbol',
  'security name': 'symbol',
  'stock name': 'symbol',
  'symbol': 'symbol',
  'tradingsymbol': 'symbol',
  'instrument': 'symbol',
  'security': 'symbol',
  'company name': 'symbol',
  'isin': 'isin',
  'sector': 'sector',
  'industry': 'sector',
  'segment': 'instrumentType',
  'instrument type': 'instrumentType',
  'exchange': 'instrumentType',
  'product type': 'instrumentType',
  'quantity': 'quantityTotal',
  'qty': 'quantityTotal',
  'net quantity': 'quantityTotal',
  'net qty': 'quantityTotal',
  'holding quantity': 'quantityTotal',
  'free': 'quantityAvailable',
  'free qty': 'quantityAvailable',
  'available quantity': 'quantityAvailable',
  'available qty': 'quantityAvailable',
  'locked-in': 'quantityLongTerm',
  'locked in': 'quantityLongTerm',
  'safekeep': 'quantityDiscrepant',
  'mtf pledge': 'quantityPledgedMargin',
  'margin pledge': 'quantityPledgedMargin',
  'cusa pledge': 'quantityPledgedLoan',
  'avg. buy rate': 'averagePrice',
  'avg buy rate': 'averagePrice',
  'avg buy price': 'averagePrice',
  'avg. buy price': 'averagePrice',
  'average price': 'averagePrice',
  'avg cost': 'averagePrice',
  'avg. cost': 'averagePrice',
  'average cost': 'averagePrice',
  'average traded price': 'averagePrice',
  'buy value': 'investedValue',
  'invested value': 'investedValue',
  'cost value': 'investedValue',
  'invested': 'investedValue',
  'ltp': 'previousClosingPrice',
  'ltp price': 'previousClosingPrice',
  'closing price': 'previousClosingPrice',
  'price': 'previousClosingPrice',
  'current value': 'presentValue',
  'valuation': 'presentValue',
  'market value': 'presentValue',
  'value': 'presentValue',
  'unrealized p&l': 'unrealizedPnl',
  'overall p&l': 'unrealizedPnl',
  'p&l': 'unrealizedPnl',
  'gain/loss': 'unrealizedPnl',
  'gain loss': 'unrealizedPnl',
  'unrealized p&l %': 'unrealizedPnlPct',
  'p&l %': 'unrealizedPnlPct',
  'return %': 'unrealizedPnlPct',
  'gain/loss %': 'unrealizedPnlPct',
  'gain loss %': 'unrealizedPnlPct',
};

const SUMMARY_LABELS = new Map<string, keyof Pick<
  DhanReportSummary,
  'investedValue' | 'presentValue' | 'unrealizedPnl' | 'unrealizedPnlPct'
>>([
  ['investment', 'investedValue'],
  ['invested value', 'investedValue'],
  ['buy value', 'investedValue'],
  ['invested', 'investedValue'],
  ['current value', 'presentValue'],
  ['account value', 'presentValue'],
  ['market value', 'presentValue'],
  ['overall p&l', 'unrealizedPnl'],
  ['unrealized p&l', 'unrealizedPnl'],
  ['p&l', 'unrealizedPnl'],
  ['gain/loss', 'unrealizedPnl'],
  ['gain loss', 'unrealizedPnl'],
  ['overall p&l %', 'unrealizedPnlPct'],
  ['unrealized p&l %', 'unrealizedPnlPct'],
  ['p&l %', 'unrealizedPnlPct'],
  ['gain/loss %', 'unrealizedPnlPct'],
  ['gain loss %', 'unrealizedPnlPct'],
]);

export function parseDhanPortfolioReport(filePath: string): ParsedDhanPortfolioReport {
  const workbook = XLSX.readFile(filePath, { cellDates: false, raw: true });
  const summaries: DhanReportSummary[] = [];
  const holdings: DhanHoldingRow[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, {
      header: 1,
      defval: null,
      blankrows: false,
      raw: true,
    });
    if (!rows.length) continue;

    const assetScope = toAssetScope(sheetName, workbook.SheetNames.length);
    const summary = parseSheetSummary(rows, sheetName, assetScope);
    const headerRowIdx = findHeaderRow(rows);
    if (headerRowIdx < 0) {
      summaries.push(summary);
      continue;
    }

    const headerMap = buildHeaderMap(rows[headerRowIdx] || []);
    let rowOrder = 0;

    for (let rowIdx = headerRowIdx + 1; rowIdx < rows.length; rowIdx += 1) {
      const row = rows[rowIdx] || [];
      const symbol = readText(row, headerMap.symbol);
      if (!symbol) continue;
      const normalizedSymbol = symbol.trim().toLowerCase();
      if (!normalizedSymbol || normalizedSymbol === 'total' || normalizedSymbol === 'grand total') continue;
      rowOrder += 1;

      const quantityAvailable = readNumber(row, headerMap.quantityAvailable);
      const quantityDiscrepant = readNumber(row, headerMap.quantityDiscrepant);
      const quantityLongTerm = readNumber(row, headerMap.quantityLongTerm);
      const quantityPledgedMargin = readNumber(row, headerMap.quantityPledgedMargin);
      const quantityPledgedLoan = readNumber(row, headerMap.quantityPledgedLoan);
      const quantityTotal = readNumber(row, headerMap.quantityTotal);
      const totalQuantity =
        quantityTotal !== null
          ? quantityTotal
          : sumDefined([
              quantityAvailable,
              quantityDiscrepant,
              quantityLongTerm,
              quantityPledgedMargin,
              quantityPledgedLoan,
            ]);

      const averagePrice = readNumber(row, headerMap.averagePrice);
      const investedValue = readNumber(row, headerMap.investedValue);
      const price = readNumber(row, headerMap.previousClosingPrice);
      const presentValue = readNumber(row, headerMap.presentValue);
      const unrealizedPnl = readNumber(row, headerMap.unrealizedPnl);
      const unrealizedPnlPct = readNumber(row, headerMap.unrealizedPnlPct);

      const derivedAveragePrice =
        averagePrice !== null
          ? averagePrice
          : totalQuantity > 0 && investedValue !== null
            ? investedValue / totalQuantity
            : null;

      const derivedPrice =
        price !== null
          ? price
          : totalQuantity > 0 && presentValue !== null
            ? presentValue / totalQuantity
            : null;

      const derivedPnl =
        unrealizedPnl !== null
          ? unrealizedPnl
          : investedValue !== null && presentValue !== null
            ? presentValue - investedValue
            : null;

      const derivedPnlPct =
        unrealizedPnlPct !== null
          ? unrealizedPnlPct
          : derivedPnl !== null && investedValue !== null && investedValue > 0
            ? (derivedPnl / investedValue) * 100
            : null;

      holdings.push({
        sheetName,
        assetScope,
        isCombinedView: assetScope === 'COMBINED',
        rowOrder,
        symbol,
        isin: readText(row, headerMap.isin),
        sector: readDashAsNull(readText(row, headerMap.sector)),
        instrumentType: readDashAsNull(readText(row, headerMap.instrumentType)),
        quantityAvailable:
          quantityAvailable !== null
            ? quantityAvailable
            : quantityTotal,
        quantityDiscrepant,
        quantityLongTerm,
        quantityPledgedMargin,
        quantityPledgedLoan,
        averagePrice: derivedAveragePrice,
        previousClosingPrice: derivedPrice,
        unrealizedPnl: derivedPnl,
        unrealizedPnlPct: derivedPnlPct,
      });
    }

    summaries.push(recomputeSummaryFromHoldings(summary, holdings.filter(h => h.sheetName === sheetName)));
  }

  return {
    clientId: summaries[0]?.clientId ?? null,
    asOfDate: summaries[0]?.asOfDate ?? null,
    summaries,
    holdings,
  };
}

function toAssetScope(sheetName: string, totalSheets: number): DhanReportSummary['assetScope'] {
  const normalized = sheetName.trim().toLowerCase();
  if (normalized.includes('mutual')) return 'MUTUAL_FUNDS';
  if (normalized.includes('equity') || normalized.includes('etf') || normalized.includes('unlisted')) return 'EQUITY';
  return totalSheets > 1 ? 'COMBINED' : 'COMBINED';
}

function parseSheetSummary(
  rows: (string | number | null)[][],
  sheetName: string,
  assetScope: DhanReportSummary['assetScope'],
): DhanReportSummary {
  const summary: DhanReportSummary = {
    sheetName,
    assetScope,
    clientId: null,
    statementTitle: `${sheetName} Holding Summary`,
    asOfDate: null,
    investedValue: null,
    presentValue: null,
    unrealizedPnl: null,
    unrealizedPnlPct: null,
  };

  for (const row of rows.slice(0, 25)) {
    for (let idx = 0; idx < row.length; idx += 1) {
      const raw = row[idx];
      const label = normalizeLabel(raw);
      if (!label) continue;
      if (!summary.clientId && /^(client id|client code|ucc)$/.test(label)) {
        summary.clientId = readText(row, idx + 1);
      }
      if (!summary.asOfDate) {
        const parsedDate = parseIsoDate(String(raw ?? ''));
        if (parsedDate) summary.asOfDate = parsedDate;
      }
      const field = SUMMARY_LABELS.get(label);
      if (field) {
        const value = readNumber(row, idx + 1) ?? extractInlineNumber(String(raw ?? ''));
        if (value !== null) summary[field] = value;
      }
    }
  }

  return summary;
}

function findHeaderRow(rows: (string | number | null)[][]): number {
  return rows.findIndex((row) => {
    const labels = row.map(cell => normalizeLabel(cell));
    const hasSymbol = labels.some(label => HEADER_ALIASES[label] === 'symbol');
    const hasQuantity = labels.some(label => {
      const field = HEADER_ALIASES[label];
      return field === 'quantityTotal' || field === 'quantityAvailable';
    });
    const hasValue = labels.some(label => {
      const field = HEADER_ALIASES[label];
      return field === 'presentValue' || field === 'investedValue' || field === 'previousClosingPrice';
    });
    return hasSymbol && hasQuantity && hasValue;
  });
}

function buildHeaderMap(headerRow: (string | number | null)[]) {
  const map: Partial<Record<DhanHoldingField, number>> = {};
  headerRow.forEach((cell, idx) => {
    const normalized = normalizeLabel(cell);
    const key = HEADER_ALIASES[normalized];
    if (key) map[key] = idx;
  });
  return map;
}

function recomputeSummaryFromHoldings(summary: DhanReportSummary, sheetHoldings: DhanHoldingRow[]): DhanReportSummary {
  let investedValue = 0;
  let presentValue = 0;
  let anyInvested = false;
  let anyPresent = false;

  for (const holding of sheetHoldings) {
    const totalQuantity = sumDefined([
      holding.quantityAvailable,
      holding.quantityDiscrepant,
      holding.quantityLongTerm,
      holding.quantityPledgedMargin,
      holding.quantityPledgedLoan,
    ]);
    const invested = totalQuantity > 0 && holding.averagePrice !== null ? totalQuantity * holding.averagePrice : null;
    const present = totalQuantity > 0 && holding.previousClosingPrice !== null ? totalQuantity * holding.previousClosingPrice : null;
    if (invested !== null) {
      investedValue += invested;
      anyInvested = true;
    }
    if (present !== null) {
      presentValue += present;
      anyPresent = true;
    }
  }

  const resolvedInvested = summary.investedValue ?? (anyInvested ? investedValue : null);
  const resolvedPresent = summary.presentValue ?? (anyPresent ? presentValue : null);
  const resolvedPnl = summary.unrealizedPnl ?? (
    resolvedInvested !== null && resolvedPresent !== null
      ? resolvedPresent - resolvedInvested
      : null
  );
  const resolvedPnlPct = summary.unrealizedPnlPct ?? (
    resolvedPnl !== null && resolvedInvested !== null && resolvedInvested > 0
      ? (resolvedPnl / resolvedInvested) * 100
      : null
  );

  return {
    ...summary,
    investedValue: resolvedInvested,
    presentValue: resolvedPresent,
    unrealizedPnl: resolvedPnl,
    unrealizedPnlPct: resolvedPnlPct,
  };
}

function normalizeLabel(value: string | number | null): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.:]/g, '');
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
  return parseNumber(value);
}

function extractInlineNumber(value: string): number | null {
  const match = value.match(/-?\d[\d,]*(?:\.\d+)?/);
  return match ? parseNumber(match[0]) : null;
}

function parseNumber(value: string | number): number | null {
  const text = String(value)
    .replace(/[()]/g, '')
    .replace(/[^\d,.-]/g, '')
    .replace(/,/g, '')
    .trim();
  if (!text || text === '-' || text === '.') return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseIsoDate(value: string): string | null {
  const iso = value.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = value.match(/\b(\d{2})[\/-](\d{2})[\/-](\d{4})\b/);
  if (!dmy) return null;
  return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
}

function sumDefined(values: Array<number | null>): number {
  return values.reduce((sum: number, value) => sum + (value || 0), 0);
}
