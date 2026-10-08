import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import {
  MANUAL_OTP_ERROR,
  getOtpOrWaitForManualEntry,
  isManualOtpError,
  otpOrManual,
  otpPromptOnPage,
  waitForManualStep,
} from '../../src/main/automation/manualStep';

// Minimal Page stand-in: the helper only needs isClosed() and evaluate()
// (for the hint banner, which is best-effort).
function fakePage(): Page & { hints: number } {
  const page = {
    hints: 0,
    isClosed: () => false,
    evaluate: async () => { page.hints += 1; },
  };
  return page as unknown as Page & { hints: number };
}

const never = () => new Promise<string>(() => {});

describe('isManualOtpError', () => {
  it('recognises the OTP_MANUAL prefix only', () => {
    expect(isManualOtpError(new Error(`${MANUAL_OTP_ERROR}: Gmail is not set up`))).toBe(true);
    expect(isManualOtpError(new Error('Timed out waiting for OTP'))).toBe(false);
    expect(isManualOtpError(null)).toBe(false);
  });
});

describe('getOtpOrWaitForManualEntry', () => {
  it('returns the OTP when the automatic source delivers it first', async () => {
    const otp = await getOtpOrWaitForManualEntry(fakePage(), async () => '482913', {
      label: 'Test', isOtpStepDone: async () => false, pollMs: 5, timeoutMs: 1_000,
    });
    expect(otp).toBe('482913');
  });

  it('returns null once the user finished the OTP step in the browser (Gmail still polling)', async () => {
    let polls = 0;
    const otp = await getOtpOrWaitForManualEntry(fakePage(), never, {
      label: 'Test', isOtpStepDone: async () => ++polls >= 3, pollMs: 5, timeoutMs: 1_000,
    });
    expect(otp).toBeNull();
  });

  it('keeps waiting for manual entry after a manual-OTP error, and shows a hint', async () => {
    const page = fakePage();
    let polls = 0;
    const started = Date.now();
    const otp = await getOtpOrWaitForManualEntry(
      page,
      async () => { throw new Error(`${MANUAL_OTP_ERROR}: mobile OTP`); },
      { label: 'Test', isOtpStepDone: async () => ++polls >= 5, pollMs: 5, timeoutMs: 1_000 },
    );
    expect(otp).toBeNull();
    expect(polls).toBeGreaterThanOrEqual(5);
    expect(page.hints).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('needs two consecutive "done" polls (ignores a field that blinks during a re-render)', async () => {
    const answers = [true, false, false, true, true];
    let i = 0;
    const otp = await getOtpOrWaitForManualEntry(fakePage(), never, {
      label: 'Test', isOtpStepDone: async () => answers[Math.min(i++, answers.length - 1)], pollMs: 5, timeoutMs: 1_000,
    });
    expect(otp).toBeNull();
    expect(i).toBe(5);
  });

  it('gives up with null after the timeout', async () => {
    const otp = await getOtpOrWaitForManualEntry(fakePage(), never, {
      label: 'Test', isOtpStepDone: async () => false, pollMs: 5, timeoutMs: 40,
    });
    expect(otp).toBeNull();
  });
});

describe('waitForManualStep', () => {
  it('resolves true when the step completes and false on timeout', async () => {
    let n = 0;
    expect(await waitForManualStep(fakePage(), async () => ++n > 2, 1_000, 5)).toBe(true);
    expect(await waitForManualStep(fakePage(), async () => false, 30, 5)).toBe(false);
  });
});

describe('otpOrManual', () => {
  it('returns the automatic OTP', async () => {
    const field = { isVisible: async () => true };
    expect(await otpOrManual(fakePage(), async () => '123456', 'Test', field, 5_000)).toBe('123456');
  });

  it('returns null when Gmail is unavailable and the OTP box disappears', async () => {
    let visible = 3;
    const field = { isVisible: async () => --visible > 0 };
    const manual = async () => { throw new Error(`${MANUAL_OTP_ERROR}: no Gmail`); };
    expect(await otpOrManual(fakePage(), manual, 'Test', field, 5_000)).toBeNull();
  });
});

describe('otpPromptOnPage', () => {
  const pageWithText = (text: string) => ({ evaluate: async () => text }) as unknown as Page;
  it('is visible while the page asks for an OTP, not on a PIN screen', async () => {
    expect(await otpPromptOnPage(pageWithText('Enter the OTP sent to your email')).isVisible()).toBe(true);
    expect(await otpPromptOnPage(pageWithText('Enter your 4-digit PIN')).isVisible()).toBe(false);
  });
});
