/**
 * Kotak loan / overdraft balance parsing — pure, no Playwright imports, so it
 * is unit-tested in tests/automation/kotakLoan.test.ts.
 *
 * Seen live 2026-10-08: the owner's Kotak account is an overdraft that the
 * dashboard lists under "Banking Accounts (INR)" with a NEGATIVE balance
 * ("Assets -₹xx,xx,xxx.xx"), while "Liabilities" reads "Unavailable". The
 * negative balance is the outstanding amount. Explicit loan labels are still
 * tried first. kotakBank.ts logs the page's labels when something is missing.
 */

const AMOUNT = String.raw`(-?)\s*(?:₹|INR|Rs\.?)?\s*(-?)\s*(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(Dr|Cr)?\b`;

const WITHDRAWABLE_LABELS = [
  String.raw`Withdrawable\s+(?:Balance|Amount|Limit)`,
  String.raw`Withdrawable`,
  String.raw`Available\s+(?:to\s+withdraw|for\s+withdrawal)`,
  String.raw`Available\s+(?:Limit|Amount|Balance)`,
  String.raw`Drawing\s+Power`,
];

const OUTSTANDING_LABELS = [
  String.raw`Total\s+Outstanding(?:\s+(?:Amount|Balance))?`,
  String.raw`(?:Principal|Loan)\s+Outstanding`,
  String.raw`Outstanding\s+(?:Amount|Balance|Principal)`,
  String.raw`Amount\s+Outstanding`,
  String.raw`Outstanding`,
  String.raw`Utili[sz]ed\s+(?:Amount|Limit)`,
];

export interface KotakLoanBalance {
  withdrawable: string | null; // "2,74,571.80"
  outstanding: string | null;
}

interface Found { amount: string; negative: boolean }

function findAfterLabel(text: string, labels: string[]): Found | null {
  for (const label of labels) {
    // Label, up to 60 non-digit characters (":", newline, "₹" …), then the amount.
    const re = new RegExp(`(?:${label})[^\\d₹\\n-]{0,40}\\n?[^\\d₹-]{0,20}${AMOUNT}`, 'i');
    const m = text.match(re);
    if (m?.[3]) return { amount: m[3], negative: m[1] === '-' || m[2] === '-' || /^dr$/i.test(m[4] || '') };
  }
  return null;
}

/** Overdraft shown as a negative banking balance: "Banking Accounts (INR) … -₹x". */
function negativeBankingBalance(text: string): string | null {
  const AMT = String.raw`(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`;
  const m = text.match(new RegExp(String.raw`Banking\s+Accounts[^₹]{0,80}?-\s*₹\s*` + AMT, 'i'))
    || text.match(new RegExp(String.raw`Assets\s*-\s*₹\s*` + AMT, 'i'));
  return m?.[1] ?? null;
}

export function parseKotakLoanText(text: string): KotakLoanBalance {
  const flat = text.replace(/ /g, ' ');
  const w = findAfterLabel(flat, WITHDRAWABLE_LABELS);
  const o = findAfterLabel(flat, OUTSTANDING_LABELS);
  // A negative "Available balance" on an OD is money owed, not money available.
  const withdrawable = w && !w.negative ? w.amount : null;
  const outstanding = o?.amount ?? (w?.negative ? w.amount : null) ?? negativeBankingBalance(flat);
  return { withdrawable, outstanding };
}

/** "Withdrawable: ₹x | Outstanding: ₹y" — the format the dashboard parses. */
export function formatKotakLoanBalance(b: KotakLoanBalance): string | null {
  const parts: string[] = [];
  if (b.withdrawable) parts.push(`Withdrawable: ₹${b.withdrawable}`);
  if (b.outstanding) parts.push(`Outstanding: ₹${b.outstanding}`);
  return parts.length ? parts.join(' | ') : null;
}

/** Short lines that carry a balance-ish label, for diagnostics (no amounts). */
export function balanceLabelLines(text: string): string[] {
  return text
    .split('\n')
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(l => l.length > 0 && l.length < 60)
    .filter(l => /balance|outstanding|withdraw|available|limit|drawing|due|utili[sz]ed|loan|overdraft/i.test(l))
    .map(l => l.replace(/\d/g, '#'))
    .slice(0, 25);
}
