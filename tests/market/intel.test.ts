import { describe, expect, it } from 'vitest';
import {
  buildQuotaPicks,
  classifyBoardMeeting,
  classifyCorporateAction,
  dedupeAnnouncements,
  matchGmp,
  parseActiveCategories,
  parseGmpHtml,
  parseNseDate,
  previousWeekday,
  retailAllotmentOdds,
  scoreIpo,
  type GmpRow,
} from '../../src/main/market/intel';

// Synthetic markup shaped like the IPO Watch GMP page (two tables: mainboard, SME).
const GMP_HTML = `
<table><tr><th>Company</th><th>GMP*</th><th>Trend</th><th>Price Band</th><th>Est. Gain</th><th>Date</th></tr>
<tr><td><a>Alpha Platforms</a> Upcoming</td><td>&#8377;180</td><td>x</td><td>&#8377;-</td><td>-</td><td>21-23 Oct*</td></tr>
<tr><td>Beta Fire Protect Upcoming</td><td>₹60</td><td>x</td><td>₹271</td><td>₹331 (22.14%)</td><td>13-15 Oct</td></tr>
<tr><td>Gamma Nirmiti Closed</td><td>₹-5</td><td>x</td><td>₹220</td><td>-</td><td>30-5 Oct</td></tr>
</table>
<table><tr><td>unrelated</td></tr></table>
<table><tr><th>Company</th><th>GMP</th><th>Trend</th><th>Price Band</th><th>Est. Gain</th><th>Date</th></tr>
<tr><td>R.K.Fashion   Open</td><td>₹15</td><td>x</td><td>₹82</td><td>-</td><td>5-7 Oct</td></tr>
</table>`;

describe('parseGmpHtml', () => {
  const rows = parseGmpHtml(GMP_HTML);
  it('reads both GMP tables and tags the segment', () => {
    expect(rows.map(r => [r.name, r.segment])).toEqual([
      ['Alpha Platforms', 'MAINBOARD'],
      ['Beta Fire Protect', 'MAINBOARD'],
      ['Gamma Nirmiti', 'MAINBOARD'],
      ['R.K.Fashion', 'SME'],
    ]);
  });
  it('parses GMP, price band and status words', () => {
    expect(rows[0]).toMatchObject({ gmp: 180, priceHigh: null, statusText: 'upcoming' });
    expect(rows[1]).toMatchObject({ gmp: 60, priceHigh: 271, dates: '13-15 Oct' });
    expect(rows[2].gmp).toBe(-5);
    expect(rows[3]).toMatchObject({ gmp: 15, priceHigh: 82, statusText: 'open' });
  });
  it('returns nothing for a page without a GMP table', () => {
    expect(parseGmpHtml('<table><tr><th>Name</th></tr></table>')).toEqual([]);
  });
});

describe('matchGmp', () => {
  const rows = parseGmpHtml(GMP_HTML);
  it('matches exchange names to GMP names despite legal-form noise', () => {
    expect(matchGmp('Beta Fire Protect Limited', rows)?.gmp).toBe(60);
    expect(matchGmp('R.K. Fashion Accessories Limited', rows, 'SME')?.gmp).toBe(15);
  });
  it('does not match on a shared generic word alone', () => {
    const generic: GmpRow[] = [{ name: 'Delta Platforms', segment: 'MAINBOARD', gmp: 1, priceHigh: 10, statusText: '', dates: '' }];
    expect(matchGmp('Alpha Platforms Limited', generic)).toBeNull();
  });
  it('respects the segment filter', () => {
    expect(matchGmp('R.K. Fashion Accessories', rows, 'MAINBOARD')).toBeNull();
  });
});

describe('parseActiveCategories', () => {
  const activeCat = {
    dataList: [
      { category: 'Category', noOfTotalMeant: 'No. of times' },
      { category: 'Qualified Institutional Buyers(QIBs)', noOfShareOffered: '100', noOfTotalMeant: '45.20' },
      { category: 'Non Institutional Investors', noOfShareOffered: '50', noOfTotalMeant: '30.1' },
      { category: 'Retail Individual Investors(RIIs)', noOfShareOffered: '120', noOfTotalMeant: '8.5' },
      { category: 'Employees', noOfShareOffered: '5', noOfTotalMeant: '2.0' },
      { category: 'Shareholders', noOfShareOffered: '20', noOfTotalMeant: '12.0' },
      { category: 'Total', noOfShareOffered: '295', noOfTotalMeant: '22.3' },
    ],
  };
  it('extracts category subscription and quota flags', () => {
    expect(parseActiveCategories(activeCat)).toEqual({
      total: 22.3, qib: 45.2, nii: 30.1, retail: 8.5, employee: 2, shareholder: 12,
      hasShareholderQuota: true, hasEmployeeQuota: true,
    });
  });
  it('treats 0.00x on a category with nothing offered as unknown', () => {
    const snap = parseActiveCategories({ dataList: [
      { category: 'Non Institutional Investors', noOfShareOffered: '0', noOfTotalMeant: '0.00' },
      { category: 'Shareholders', noOfShareOffered: '', noOfTotalMeant: '' },
      { category: 'Total', noOfShareOffered: '0.0', noOfTotalMeant: '0.00' },
    ] });
    expect(snap.nii).toBeNull();
    expect(snap.total).toBeNull();
    expect(snap.hasShareholderQuota).toBe(false);
  });
  it('handles missing data', () => {
    expect(parseActiveCategories(undefined).hasShareholderQuota).toBe(false);
  });
});

describe('scoreIpo', () => {
  const sub = (total: number, qib: number) => ({ total, qib, nii: null, retail: null, employee: null, shareholder: null, hasShareholderQuota: false, hasEmployeeQuota: false });
  it('APPLY for strong GMP and heavy subscription', () => {
    const r = scoreIpo({ segment: 'MAINBOARD', status: 'OPEN', priceHigh: 100, gmp: 40, subscription: sub(60, 100) });
    expect(r.score).toBe(6);
    expect(r.verdict).toBe('APPLY');
    expect(r.gmpPct).toBe(40);
  });
  it('AVOID for negative GMP', () => {
    expect(scoreIpo({ segment: 'MAINBOARD', status: 'OPEN', priceHigh: 100, gmp: -5, subscription: null }).verdict).toBe('AVOID');
  });
  it('penalises SME issues', () => {
    const main = scoreIpo({ segment: 'MAINBOARD', status: 'OPEN', priceHigh: 100, gmp: 20, subscription: null });
    const sme = scoreIpo({ segment: 'SME', status: 'OPEN', priceHigh: 100, gmp: 20, subscription: null });
    expect(sme.score).toBe(main.score - 1);
  });
  it('CONSIDER at score 1, AVOID at 0', () => {
    const sme = scoreIpo({ segment: 'SME', status: 'OPEN', priceHigh: 82, gmp: 15, subscription: sub(2.6, 0) });
    expect([sme.score, sme.verdict]).toEqual([1, 'CONSIDER']);
    const flat = scoreIpo({ segment: 'MAINBOARD', status: 'OPEN', priceHigh: 100, gmp: 2, subscription: null });
    expect([flat.score, flat.verdict]).toEqual([0, 'AVOID']);
  });
  it('WAIT for an upcoming issue with no GMP', () => {
    expect(scoreIpo({ segment: 'MAINBOARD', status: 'UPCOMING', priceHigh: null, gmp: null, subscription: null }).verdict).toBe('WAIT');
  });
  it('flags under-subscription on an open issue', () => {
    const r = scoreIpo({ segment: 'MAINBOARD', status: 'OPEN', priceHigh: 100, gmp: 0, subscription: sub(0.4, 0) });
    expect(r.score).toBe(-1);
    expect(r.reasons.join(' ')).toMatch(/Under-subscribed/);
  });
});

describe('retailAllotmentOdds', () => {
  it('is 1/x when oversubscribed and capped at 1', () => {
    expect(retailAllotmentOdds(4)).toBe(0.25);
    expect(retailAllotmentOdds(0.5)).toBe(1);
    expect(retailAllotmentOdds(null)).toBeNull();
  });
});

describe('dates', () => {
  it('parses NSE date styles', () => {
    expect(parseNseDate('07-Oct-2026')).toBe('2026-10-07');
    expect(parseNseDate('5-OCT-2026')).toBe('2026-10-05');
    expect(parseNseDate('2026-10-07')).toBe('2026-10-07');
    expect(parseNseDate('-')).toBeNull();
  });
  it('previousWeekday skips weekends', () => {
    expect(previousWeekday('2026-10-12')).toBe('2026-10-09'); // Mon → Fri
    expect(previousWeekday('2026-10-08')).toBe('2026-10-07');
  });
});

describe('classifyCorporateAction', () => {
  it('reads bonus ratio and the last cum date', () => {
    const a = classifyCorporateAction({ symbol: 'ABC', comp: 'ABC Ltd', subject: 'Bonus 1:1', exDate: '12-Oct-2026', recDate: '12-Oct-2026' });
    expect(a).toMatchObject({ kind: 'BONUS', ratio: '1:1', exDate: '2026-10-12', buyBy: '2026-10-09' });
  });
  it('recognises rights and splits, ignores dividends', () => {
    expect(classifyCorporateAction({ subject: 'Rights 1:5 @ Premium Rs 90/-', exDate: '15-Oct-2026' })?.kind).toBe('RIGHTS');
    expect(classifyCorporateAction({ subject: 'Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 2/- Per Share' })?.kind).toBe('SPLIT');
    expect(classifyCorporateAction({ subject: 'Dividend - Rs 5.50 Per Share' })).toBeNull();
  });
});

describe('classifyBoardMeeting', () => {
  it('detects bonus, rights and preferential proposals', () => {
    expect(classifyBoardMeeting({ bm_symbol: 'A', bm_purpose: 'Bonus/Other business matters', bm_desc: 'To consider bonus', bm_date: '03-Oct-2026' })?.kind).toBe('BONUS');
    expect(classifyBoardMeeting({ bm_symbol: 'B', bm_purpose: 'Fund Raising', bm_desc: 'To consider raising funds by way of issuance of Equity Shares on a RightsIssue basis.' })?.kind).toBe('RIGHTS');
    expect(classifyBoardMeeting({ bm_symbol: 'C', bm_purpose: 'Fund Raising', bm_desc: 'issuance of equity shares by way of preferential allotment' })?.kind).toBe('PREFERENTIAL');
  });
  it('skips intimation duplicates, plain results meetings and non-NSE attachments', () => {
    expect(classifyBoardMeeting({ bm_purpose: 'Board Meeting Intimation', bm_desc: 'to consider bonus' })).toBeNull();
    expect(classifyBoardMeeting({ bm_purpose: 'Financial Results', bm_desc: 'approve results' })).toBeNull();
    expect(classifyBoardMeeting({ bm_purpose: 'Bonus', bm_desc: 'x', attachment: 'https://evil.example/x.pdf' })?.attachment).toBeNull();
  });
  it('dedupes by symbol, kind and date', () => {
    const a = classifyBoardMeeting({ bm_symbol: 'A', bm_purpose: 'Bonus', bm_desc: 'short', bm_date: '03-Oct-2026' })!;
    const b = classifyBoardMeeting({ bm_symbol: 'A', bm_purpose: 'Bonus', bm_desc: 'a longer description', bm_date: '03-Oct-2026' })!;
    expect(dedupeAnnouncements([a, b])).toEqual([b]);
  });
});

describe('buildQuotaPicks', () => {
  it('computes the T+1 buy-by date and days left, soonest first', () => {
    const picks = buildQuotaPicks([
      { id: '1', parentSymbol: 'PARENTA', ipoName: 'Child A', cutoffDate: '2026-10-20' },
      { id: '2', parentSymbol: 'PARENTB', ipoName: 'Child B', cutoffDate: '2026-10-12' },
      { id: '3', parentSymbol: 'PARENTC', ipoName: 'Child C', cutoffDate: null },
    ], '2026-10-07');
    expect(picks.map(p => [p.parentSymbol, p.buyBy, p.daysLeft])).toEqual([
      ['PARENTB', '2026-10-09', 2],
      ['PARENTA', '2026-10-19', 12],
      ['PARENTC', null, null],
    ]);
    expect(picks[0].action).toMatch(/Buy at least 1 share of PARENTB/);
  });
  it('says when the cut-off has passed', () => {
    const [p] = buildQuotaPicks([{ id: '1', parentSymbol: 'OLD', ipoName: 'X', cutoffDate: '2026-10-01' }], '2026-10-07');
    expect(p.action).toMatch(/Cut-off passed/);
  });
});
