/**
 * Kotak loan / overdraft balance parsing — pure, no Playwright imports, so it
 * is unit-tested in tests/automation/kotakLoan.test.ts.
 *
 * The logged-in Kotak page has not been captured yet, so the labels below are
 * the usual net-banking wordings for a loan/OD account. kotakBank.ts logs the
 * label lines it saw when nothing matches, so the list can be tightened from
 * a real run.
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

function findAfterLabel(text: string, labels: string[]): string | null {
  for (const label of labels) {
    // Label, up to 60 non-digit characters (":", newline, "₹" …), then the amount.
    const re = new RegExp(`(?:${label})[^\\d₹\\n]{0,40}\\n?[^\\d₹]{0,20}${AMOUNT}`, 'i');
    const m = text.match(re);
    if (m?.[3]) return m[3];
  }
  return null;
}

export function parseKotakLoanText(text: string): KotakLoanBalance {
  const flat = text.replace(/ /g, ' ');
  return {
    withdrawable: findAfterLabel(flat, WITHDRAWABLE_LABELS),
    outstanding: findAfterLabel(flat, OUTSTANDING_LABELS),
  };
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
