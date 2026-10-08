import { describe, expect, it } from 'vitest';
import { balanceLabelLines, formatKotakLoanBalance, parseKotakLoanText } from '../../src/main/automation/kotakLoan';

describe('parseKotakLoanText', () => {
  it('reads withdrawable and outstanding on separate lines', () => {
    const text = 'Loan Account\nXXXX1234\nWithdrawable Balance\n₹ 2,74,571.80\nOutstanding Amount\n₹1,25,000.00 Dr\n';
    expect(parseKotakLoanText(text)).toEqual({ withdrawable: '2,74,571.80', outstanding: '1,25,000.00' });
  });

  it('reads inline label: amount pairs and alternative wordings', () => {
    expect(parseKotakLoanText('Available Limit: INR 50,000 | Principal Outstanding: Rs. 4,50,000.00')).toEqual({
      withdrawable: '50,000', outstanding: '4,50,000.00',
    });
    expect(parseKotakLoanText('Drawing Power ₹3,00,000.00  Utilised Amount ₹1,00,000.00')).toEqual({
      withdrawable: '3,00,000.00', outstanding: '1,00,000.00',
    });
  });

  it('does not take the account number as an amount', () => {
    const r = parseKotakLoanText('Outstanding Amount\n₹ 9,999.00\nAccount No 123456789012');
    expect(r.outstanding).toBe('9,999.00');
  });

  it('reads an overdraft shown as a negative banking balance (live 2026-10-08 layout)', () => {
    const text = 'Assets\n-₹12,34,567.89\nBanking Accounts (INR)\n1 PRIMARY . 1 JOINT\n-₹12,34,567.89\nLiabilities\nUnavailable';
    expect(parseKotakLoanText(text)).toEqual({ withdrawable: null, outstanding: '12,34,567.89' });
  });

  it('treats a negative available balance as outstanding, a positive one as withdrawable', () => {
    expect(parseKotakLoanText('Available Balance\n-₹50,000.00')).toEqual({ withdrawable: null, outstanding: '50,000.00' });
    expect(parseKotakLoanText('Available Balance\n₹1,50,000.00\nBanking Accounts (INR) -₹3,50,000.00'))
      .toEqual({ withdrawable: '1,50,000.00', outstanding: '3,50,000.00' });
  });

  it('returns nulls when nothing matches', () => {
    expect(parseKotakLoanText('Welcome back\nLast login 12:30')).toEqual({ withdrawable: null, outstanding: null });
  });
});

describe('formatKotakLoanBalance', () => {
  it('builds the dashboard string', () => {
    expect(formatKotakLoanBalance({ withdrawable: '1,000.00', outstanding: '5,000.00' }))
      .toBe('Withdrawable: ₹1,000.00 | Outstanding: ₹5,000.00');
    expect(formatKotakLoanBalance({ withdrawable: null, outstanding: '5,000.00' })).toBe('Outstanding: ₹5,000.00');
    expect(formatKotakLoanBalance({ withdrawable: null, outstanding: null })).toBeNull();
  });
});

describe('balanceLabelLines', () => {
  it('keeps short label lines and masks digits', () => {
    expect(balanceLabelLines('Total Outstanding\n₹1,234.00\nHello\nAvailable Limit 5000')).toEqual([
      'Total Outstanding', 'Available Limit ####',
    ]);
  });
});
