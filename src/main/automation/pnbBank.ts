import { createRetailBankAdapter } from './genericBank';

export const pnbBankAdapter = createRetailBankAdapter({
  code: 'PNB',
  displayName: 'Punjab National Bank',
  loginUrl: 'https://ibanking.pnb.bank.in/',
  usernameLabel: 'User ID',
  otpMode: 'manual',
  preLoginSelectors: [
    'a:has-text("Retail Internet Banking")',
    'button:has-text("Retail Internet Banking")',
    'a:has-text("Retail")',
    'button:has-text("Retail")',
  ],
  usernameSelectors: [
    'input[name*="USER_PRINCIPAL" i]',
    'input[id*="USER_PRINCIPAL" i]',
    'input[name*="user" i]',
    'input[id*="user" i]',
    'input[placeholder*="User ID" i]',
    'input[placeholder*="Login ID" i]',
  ],
  passwordSelectors: [
    'input[name*="PASSWORD" i]',
    'input[id*="PASSWORD" i]',
    'input[type="password"]',
  ],
  nextLabels: ['Login', 'Next', 'Continue', 'Proceed'],
  loginLabels: ['Login', 'Submit', 'Continue', 'Proceed'],
  manualStepHint: 'PNB may require CAPTCHA/security prompt handling. Complete visible prompts manually if they appear.',
  balanceNavSelectors: [
    'a:has-text("Account Summary")',
    'button:has-text("Account Summary")',
    'a:has-text("Operative Accounts")',
    'a:has-text("Accounts")',
  ],
});
