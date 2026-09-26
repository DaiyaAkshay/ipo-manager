import { describe, expect, it } from 'vitest';
import { redactLogText } from '../../src/main/logging';

describe('redactLogText', () => {
  it('drops URL query strings (login redirects can carry tokens)', () => {
    expect(redactLogText('[Zerodha] at https://kite.zerodha.com/connect/finish?request_token=abc123&action=login'))
      .toBe('[Zerodha] at https://kite.zerodha.com/connect/finish?…');
  });

  it('masks long digit runs but keeps the last four', () => {
    expect(redactLogText('[Dhan] mobile 9829012345 account 2101234567890')).toBe('[Dhan] mobile ••••2345 account ••••7890');
  });

  it('masks the local part of email addresses', () => {
    expect(redactLogText('[Gmail] from: alerts@aubank.in')).toBe('[Gmail] from: a***@aubank.in');
  });

  it('leaves short numbers and plain text alone', () => {
    const line = '[AU Bank] Attempt 2/3: CAPTCHA field holds 6 chars (expected 6; match=true).';
    expect(redactLogText(line)).toBe(line);
  });
});
