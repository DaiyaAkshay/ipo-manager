import { createRetailBankAdapter } from './genericBank';

export const hdfcBankAdapter = createRetailBankAdapter({
  code: 'HDFC',
  displayName: 'HDFC Bank',
  loginUrl: 'https://netbanking.hdfcbank.com/netbanking/',
  usernameLabel: 'Customer ID',
  otpMode: 'manual',
  usernameSelectors: [
    'input[name="fldLoginUserId"]',
    'input#fldLoginUserId',
    'input[name*="customer" i]',
    'input[id*="customer" i]',
    'input[placeholder*="Customer ID" i]',
  ],
  passwordSelectors: [
    'input[name="fldPassword"]',
    'input#fldPassword',
    'input[name*="password" i]',
    'input[type="password"]',
  ],
  nextLabels: ['Continue', 'CONTINUE', 'Next'],
  loginLabels: ['Login', 'LOGIN', 'Continue', 'CONTINUE', 'Submit'],
  manualStepHint: 'HDFC Secure Access may show image/phrase or OTP prompts. Complete the visible security step if asked.',
  balanceNavSelectors: [
    'a:has-text("Account Summary")',
    'button:has-text("Account Summary")',
    'a:has-text("Accounts")',
    'a:has-text("Summary")',
  ],
});
