import { Frame, Locator, Page } from 'playwright';
import { LoginAdapter, LoginCredentials } from './browser';

type SearchRoot = Page | Frame;

interface RetailBankConfig {
  code: string;
  displayName: string;
  loginUrl: string;
  usernameLabel?: string;
  otpMode?: 'manual' | 'email';
  preLoginSelectors?: string[];
  usernameSelectors?: string[];
  passwordSelectors?: string[];
  nextSelectors?: string[];
  nextLabels?: string[];
  loginSelectors?: string[];
  loginLabels?: string[];
  otpSubmitSelectors?: string[];
  otpSubmitLabels?: string[];
  balanceNavSelectors?: string[];
  balanceRevealSelectors?: string[];
  manualStepHint?: string;
  preferScopedLoginSubmit?: boolean;
}

const NOT_HIDDEN = ':not([type="hidden"]):not([type="checkbox"]):not([type="radio"])';

const GENERIC_USERNAME_SELECTORS = [
  `input[name*="user" i]${NOT_HIDDEN}`,
  `input[id*="user" i]${NOT_HIDDEN}`,
  `input[name*="login" i]${NOT_HIDDEN}`,
  `input[id*="login" i]${NOT_HIDDEN}`,
  `input[name*="customer" i]${NOT_HIDDEN}`,
  `input[id*="customer" i]${NOT_HIDDEN}`,
  `input[name*="cust" i]${NOT_HIDDEN}`,
  `input[id*="cust" i]${NOT_HIDDEN}`,
  `input[placeholder*="User" i]${NOT_HIDDEN}`,
  `input[placeholder*="Login" i]${NOT_HIDDEN}`,
  `input[placeholder*="Customer" i]${NOT_HIDDEN}`,
  `input[placeholder*="CRN" i]${NOT_HIDDEN}`,
  `input[autocomplete="username"]${NOT_HIDDEN}`,
  `input[type="tel"]${NOT_HIDDEN}`,
  `input[type="text"]${NOT_HIDDEN}`,
];

const GENERIC_PASSWORD_SELECTORS = [
  'input[type="password"]',
  `input[name*="pass" i]${NOT_HIDDEN}`,
  `input[id*="pass" i]${NOT_HIDDEN}`,
  `input[placeholder*="Password" i]${NOT_HIDDEN}`,
  `input[autocomplete="current-password"]${NOT_HIDDEN}`,
];

const GENERIC_OTP_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  `input[name*="otp" i]${NOT_HIDDEN}`,
  `input[id*="otp" i]${NOT_HIDDEN}`,
  `input[placeholder*="OTP" i]${NOT_HIDDEN}`,
  `input[placeholder*="one time" i]${NOT_HIDDEN}`,
  `input[placeholder*="verification" i]${NOT_HIDDEN}`,
  `input[maxlength="6"]${NOT_HIDDEN}`,
  `input[maxlength="8"]${NOT_HIDDEN}`,
];

const DEFAULT_NEXT_LABELS = ['Next', 'Continue', 'Proceed', 'Enter'];
const DEFAULT_LOGIN_LABELS = ['Login', 'LOG IN', 'Sign In', 'Secure Login', 'Submit', 'Continue', 'Proceed'];
const DEFAULT_OTP_LABELS = ['Submit', 'Verify', 'Confirm', 'Continue', 'Proceed'];

function roots(page: Page): SearchRoot[] {
  return [page, ...page.frames()];
}

async function firstVisibleEnabled(page: Page, selectors: string[], timeoutMs = 0): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const root of roots(page)) {
      for (const selector of selectors) {
        const loc = root.locator(selector);
        const count = await loc.count().catch(() => 0);
        for (let i = 0; i < Math.min(count, 40); i += 1) {
          const candidate = loc.nth(i);
          if (!(await candidate.isVisible().catch(() => false))) continue;
          if (!(await candidate.isEnabled().catch(() => true))) continue;
          return candidate;
        }
      }
    }
    if (!timeoutMs) break;
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);

  return null;
}

function textButtonSelectors(labels: string[]): string[] {
  return labels.flatMap(label => [
    `button:has-text("${label}")`,
    `a:has-text("${label}")`,
    `[role="button"]:has-text("${label}")`,
    `input[type="submit"][value*="${label}" i]`,
    `input[type="button"][value*="${label}" i]`,
  ]);
}

async function clickFirst(page: Page, selectors: string[], label: string): Promise<boolean> {
  const target = await firstVisibleEnabled(page, selectors, 1_000);
  if (!target) return false;
  try {
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.click({ timeout: 5_000 });
    console.log(`[${label}] Clicked navigation/control`);
    await page.waitForTimeout(900);
    return true;
  } catch (e) {
    try {
      await target.click({ timeout: 5_000, force: true });
      console.log(`[${label}] Force-clicked navigation/control`);
      await page.waitForTimeout(900);
      return true;
    } catch {
      try {
        await target.evaluate((el: HTMLElement) => el.click());
        console.log(`[${label}] JS-clicked navigation/control`);
        await page.waitForTimeout(900);
        return true;
      } catch {
        console.warn(`[${label}] Click failed:`, (e as Error).message);
        return false;
      }
    }
  }
}

async function fillField(page: Page, locator: Locator, value: string, label: string): Promise<boolean> {
  try {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.click({ timeout: 4_000 });
    await locator.fill(value, { timeout: 4_000 });
    await locator.dispatchEvent('input').catch(() => {});
    await locator.dispatchEvent('change').catch(() => {});
    await page.waitForTimeout(150);

    const accepted = await locator.inputValue().then(v => v.length > 0).catch(() => true);
    if (accepted) {
      console.log(`[${label}] Field filled`);
      return true;
    }

    await locator.click({ clickCount: 3, timeout: 2_000 }).catch(() => {});
    await page.keyboard.type(value, { delay: 30 });
    console.log(`[${label}] Field typed`);
    return true;
  } catch (e) {
    console.warn(`[${label}] Field fill failed:`, (e as Error).message);
    return false;
  }
}

async function submitClosestForm(page: Page, locator: Locator, label: string, preferredLabels: string[] = []): Promise<boolean> {
  try {
    const submitted = await locator.evaluate((node, { preferredLabels }) => {
      const labelMatchers = preferredLabels
        .map(value => value.trim().toLowerCase())
        .filter(Boolean);

      const controlText = (el: HTMLElement) => [
        el.innerText || '',
        el.getAttribute('value') || '',
        el.getAttribute('aria-label') || '',
        el.getAttribute('title') || '',
        el.getAttribute('alt') || '',
      ].join(' ').trim().toLowerCase();

      const scoreControl = (el: HTMLElement) => {
        const text = controlText(el);
        if (!text) return 0;
        for (const matcher of labelMatchers) {
          if (text.includes(matcher)) return 2;
        }
        return /login|log in|sign in|submit|continue|proceed|start in/i.test(text) ? 1 : 0;
      };

      const element = node as HTMLElement;
      const form = element.closest('form') as HTMLFormElement | null;
      if (!form) return false;

      const controls = Array.from(form.querySelectorAll<HTMLElement>([
        'button[type="submit"]',
        'input[type="submit"]',
        'input[type="image"]',
        'button',
        'a[role="button"]',
        '[onclick*="submit" i]',
        '[onclick*="login" i]',
      ].join(', ')));

      const submitControl = controls
        .map(control => ({ control, score: scoreControl(control) }))
        .sort((a, b) => b.score - a.score)
        .find(entry => entry.score > 0)?.control
        ?? controls[0]
        ?? null;

      if (submitControl) {
        submitControl.click();
        return true;
      }

      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
        return true;
      }

      form.submit();
      return true;
    }, { preferredLabels }).catch(() => false);

    if (submitted) {
      console.log(`[${label}] Submitted closest form`);
      await page.waitForTimeout(1_000);
      return true;
    }
  } catch (e) {
    console.warn(`[${label}] Form submit failed:`, (e as Error).message);
  }

  return false;
}

async function isOtpScreen(page: Page): Promise<boolean> {
  return page.evaluate((selectors) => {
    const visible = (input: HTMLInputElement) => {
      const rect = input.getBoundingClientRect();
      const style = window.getComputedStyle(input);
      return rect.width > 0
        && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && input.type !== 'hidden'
        && !input.disabled;
    };

    const text = (document.body as HTMLElement | null)?.innerText || '';
    const hasOtpText = /otp|one\s*time|verification\s+code|netsecure|security\s+code/i.test(text);
    const controls = selectors
      .flatMap((selector: string) => Array.from(document.querySelectorAll<HTMLInputElement>(selector)))
      .filter((input, index, arr) => arr.indexOf(input) === index)
      .filter(visible);
    const attrText = controls.map(input => [
      input.name,
      input.id,
      input.placeholder,
      input.autocomplete,
      input.getAttribute('aria-label') || '',
    ].join(' ')).join(' ');
    const attrHasOtp = /otp|one[-\s]?time|verification|netsecure|token|auth/i.test(attrText);

    return controls.length > 0 && (hasOtpText || attrHasOtp);
  }, GENERIC_OTP_SELECTORS).catch(() => false);
}

async function waitForLoginOutcome(
  page: Page,
  timeoutMs: number,
  opts: { acceptManual?: boolean } = {},
): Promise<'otp' | 'logged-in' | 'manual' | 'timeout'> {
  const acceptManual = opts.acceptManual !== false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isOtpScreen(page)) return 'otp';

    const state = await page.evaluate((acceptManual) => {
      const text = (document.body as HTMLElement | null)?.innerText || '';
      const visibleInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input')).filter(input => {
        const rect = input.getBoundingClientRect();
        const style = window.getComputedStyle(input);
        return rect.width > 0
          && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden'
          && input.type !== 'hidden';
      });
      const hasPassword = visibleInputs.some(input => input.type === 'password');
      const hasOtp = /otp|one\s*time|verification\s+code|netsecure/i.test(text);
      const hasManualGate = /captcha|security\s+question|secure\s+access|personal\s+message|image|phrase|grid|virtual\s+keyboard/i.test(text);
      const looksLoggedIn = /account\s+summary|available\s+balance|account\s+balance|operative\s+account|welcome|last\s+login|logout|log\s*out/i.test(text);
      if (hasOtp) return 'otp';
      if (looksLoggedIn && !hasPassword) return 'logged-in';
      if (acceptManual && hasManualGate) return 'manual';
      return null;
    }, acceptManual).catch(() => null);

    if (state === 'otp' || state === 'logged-in' || state === 'manual') return state;
    await page.waitForTimeout(500);
  }
  return 'timeout';
}

async function submitOtpIfPresent(
  page: Page,
  config: RetailBankConfig,
  fetchOtp: () => Promise<string>,
): Promise<boolean> {
  const otpField = await firstVisibleEnabled(page, GENERIC_OTP_SELECTORS, 2_000);
  if (!otpField) return false;

  try {
    const otp = await fetchOtp();
    console.log(`[${config.displayName}] OTP received`);
    await fillField(page, otpField, otp, `${config.displayName} OTP`);
    const submitted = await clickFirst(
      page,
      [...(config.otpSubmitSelectors ?? []), ...textButtonSelectors(config.otpSubmitLabels ?? DEFAULT_OTP_LABELS)],
      config.displayName,
    );
    if (!submitted) {
      await otpField.press('Enter').catch(() => {});
      console.log(`[${config.displayName}] Pressed Enter to submit OTP`);
    }
    return true;
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    if (msg.includes('OTP_TIMEOUT') || msg.includes('OTP_CANCELLED')) {
      console.warn(`[${config.displayName}] OTP entry was cancelled or timed out.`);
    } else {
      console.warn(`[${config.displayName}] OTP step failed:`, msg);
    }
    return false;
  }
}

async function scrapeBalance(page: Page): Promise<string | null> {
  return page.evaluate((): string | null => {
    const text = (document.body as HTMLElement | null)?.innerText || '';
    const amount = '(\\d[\\d,]*(?:\\.\\d{1,2})?)';
    const labels = [
      'Available\\s+Balance',
      'Effective\\s+Available\\s+Balance',
      'Account\\s+Balance',
      'Savings\\s+Account\\s+Balance',
      'Clear\\s+Balance',
      'Balance',
    ];

    for (const label of labels) {
      const re = new RegExp(`${label}[\\s\\S]{0,100}?(?:\\u20B9|INR|Rs\\.?)?\\s*${amount}`, 'i');
      const match = text.match(re);
      if (match?.[1]) return `\u20B9${match[1]}`;
    }

    const first = text.match(new RegExp(`(?:\\u20B9|INR|Rs\\.?)\\s*${amount}`, 'i'));
    return first?.[1] ? `\u20B9${first[1]}` : null;
  });
}

async function revealBalanceIfNeeded(page: Page, config: RetailBankConfig): Promise<void> {
  if (!config.balanceRevealSelectors?.length) return;
  const clicked = await clickFirst(page, config.balanceRevealSelectors, `${config.displayName} balance reveal`);
  if (clicked) await page.waitForTimeout(1_200);
}

export function createRetailBankAdapter(config: RetailBankConfig): LoginAdapter {
  return {
    code: config.code,
    displayName: config.displayName,
    otpMode: config.otpMode ?? 'manual',

    async login(page: Page, creds: LoginCredentials, fetchOtp: () => Promise<string>): Promise<void> {
      await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(1_500);

      if (config.preLoginSelectors?.length) {
        await clickFirst(page, config.preLoginSelectors, config.displayName);
      }

      const username = creds.customerId || creds.username;
      const usernameField = await firstVisibleEnabled(
        page,
        [...(config.usernameSelectors ?? []), ...GENERIC_USERNAME_SELECTORS],
        20_000,
      );
      if (usernameField) {
        await fillField(page, usernameField, username, `${config.displayName} ${config.usernameLabel ?? 'User ID'}`);
      } else {
        console.warn(`[${config.displayName}] User/customer ID field not found. Continue manually if the page changed.`);
      }

      const passwordBeforeNext = await firstVisibleEnabled(page, [
        ...(config.passwordSelectors ?? []),
        ...GENERIC_PASSWORD_SELECTORS,
      ]);
      if (!passwordBeforeNext && usernameField) {
        await clickFirst(
          page,
          [...(config.nextSelectors ?? []), ...textButtonSelectors(config.nextLabels ?? DEFAULT_NEXT_LABELS)],
          config.displayName,
        ) || await usernameField.press('Enter').catch(() => false);
        await page.waitForTimeout(1_200);
      }

      const passwordField = await firstVisibleEnabled(
        page,
        [...(config.passwordSelectors ?? []), ...GENERIC_PASSWORD_SELECTORS],
        20_000,
      );
      if (passwordField) {
        await fillField(page, passwordField, creds.password, `${config.displayName} Password`);
      } else {
        console.warn(`[${config.displayName}] Password field not found. ${config.manualStepHint ?? 'Complete the current bank step manually if needed.'}`);
      }

      if (passwordField) {
        let clicked = false;
        if (config.preferScopedLoginSubmit) {
          clicked = await submitClosestForm(
            page,
            passwordField,
            config.displayName,
            config.loginLabels ?? DEFAULT_LOGIN_LABELS,
          );
        }
        if (!clicked) {
          clicked = await clickFirst(
            page,
            [...(config.loginSelectors ?? []), ...textButtonSelectors(config.loginLabels ?? DEFAULT_LOGIN_LABELS)],
            config.displayName,
          );
        }
        if (!clicked) {
          await passwordField.press('Enter').catch(() => {});
          await page.waitForTimeout(1_000);
          const submitted = await submitClosestForm(
            page,
            passwordField,
            config.displayName,
            config.loginLabels ?? DEFAULT_LOGIN_LABELS,
          );
          if (!submitted) {
            await passwordField.press('Tab').catch(() => {});
            await page.keyboard.press('Enter').catch(() => {});
            console.log(`[${config.displayName}] Tried keyboard submit after password`);
          } else {
            console.log(`[${config.displayName}] Submitted form after password`);
          }
        }
      }

      const outcome = await waitForLoginOutcome(page, 25_000);
      if (outcome === 'otp') {
        await submitOtpIfPresent(page, config, fetchOtp);
      } else if (outcome === 'manual') {
        console.log(`[${config.displayName}] Manual security/CAPTCHA step detected. ${config.manualStepHint ?? 'Complete it in the browser window.'}`);
        const afterManual = await waitForLoginOutcome(page, 180_000, { acceptManual: false });
        if (afterManual === 'otp') await submitOtpIfPresent(page, config, fetchOtp);
        else if (afterManual === 'logged-in') console.log(`[${config.displayName}] Post-login page detected after manual step.`);
        else console.log(`[${config.displayName}] Still waiting on bank security prompts. Continue manually in the browser.`);
      } else if (outcome === 'timeout') {
        console.log(`[${config.displayName}] Login automation paused. Complete any remaining bank prompts manually in the browser.`);
      } else {
        console.log(`[${config.displayName}] Post-login page detected.`);
      }

      console.log(`[${config.displayName}] Browser remains open for IPO application.`);
    },

    async fetchBalance(page: Page): Promise<string | null> {
      try {
        await page.waitForTimeout(3_000);
        await revealBalanceIfNeeded(page, config);
        let balance = await scrapeBalance(page);
        if (!balance && config.balanceNavSelectors?.length) {
          await clickFirst(page, config.balanceNavSelectors, config.displayName);
          await page.waitForTimeout(2_500);
          await revealBalanceIfNeeded(page, config);
          balance = await scrapeBalance(page);
        }
        if (balance) console.log(`[${config.displayName}] Balance fetched:`, balance);
        else console.log(`[${config.displayName}] Balance not found on current page.`);
        return balance;
      } catch (e: any) {
        console.warn(`[${config.displayName}] Balance fetch error:`, e?.message ?? e);
        return null;
      }
    },
  };
}
