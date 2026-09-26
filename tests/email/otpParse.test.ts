import { describe, expect, it } from 'vitest';
import { extractText, pickOtp } from '../../src/main/email/otpParse';

const SIX = /\b(\d{6})\b/;

describe('pickOtp', () => {
  it('returns the only 6-digit number', () => {
    expect(pickOtp('Your OTP is 482913. Do not share it.', SIX)).toEqual({ otp: '482913', how: 'strict' });
  });

  it('ignores a branch PIN code in the footer ("Your OTP is …")', () => {
    const text = 'Your OTP for login is 482913. Valid for 5 minutes. Regd office: Jaipur, PIN code 302001.';
    expect(pickOtp(text, SIX)?.otp).toBe('482913');
  });

  it('handles the code coming before the keyword ("… is your OTP")', () => {
    const text = 'Dear Customer, 482913 is the OTP for login. Registered office PIN code 302001.';
    expect(pickOtp(text, SIX)?.otp).toBe('482913');
  });

  it('handles an address with a PIN code BEFORE the OTP text', () => {
    const text = 'AU Small Finance Bank, Jaipur 302001. Dear customer, your one time password is 771204.';
    expect(pickOtp(text, SIX)?.otp).toBe('771204');
  });

  it('reconstructs digit-per-cell HTML codes', () => {
    expect(pickOtp('Your verification code: 4 2 6 8 6 5', SIX)).toEqual({ otp: '426865', how: 'loose-spaced' });
  });

  it('reads split codes next to an OTP keyword', () => {
    expect(pickOtp('Your login code is 426-865', SIX)).toEqual({ otp: '426865', how: 'split' });
  });

  it('does not mistake a helpline number for an OTP', () => {
    expect(pickOtp('For help call 1800-419-5959 or visit a branch.', SIX)).toBeNull();
  });
});

describe('extractText', () => {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

  it('prefers text/plain and strips HTML attributes that look like codes', () => {
    const msg = {
      payload: {
        parts: [
          { mimeType: 'text/html', body: { data: b64('<img height="600000"><p>OTP <b>123456</b></p>') } },
          { mimeType: 'text/plain', body: { data: b64('OTP 123456') } },
        ],
      },
    };
    const text = extractText(msg);
    expect(text.startsWith('\nOTP 123456') || text.startsWith('OTP 123456')).toBe(true);
    expect(text).not.toContain('600000');
    expect(pickOtp(text, SIX)?.otp).toBe('123456');
  });
});
