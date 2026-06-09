import { createRetailBankAdapter } from './genericBank';

export const bobBankAdapter = createRetailBankAdapter({
  code: 'BOB',
  displayName: 'Bank of Baroda',
  loginUrl: 'https://www.bobibanking.com/',
  usernameLabel: 'User ID',
  otpMode: 'manual',
  preLoginSelectors: [
    'a:has-text("Retail User")',
    'button:has-text("Retail User")',
    'input[value*="Retail" i]',
    'a:has-text("Retail")',
  ],
  usernameSelectors: [
    'input[name*="USER_PRINCIPAL" i]',
    'input[id*="USER_PRINCIPAL" i]',
    'input[name*="user" i]',
    'input[id*="user" i]',
    'input[placeholder*="User ID" i]',
  ],
  passwordSelectors: [
    'input[name*="PASSWORD" i]',
    'input[id*="PASSWORD" i]',
    'input[type="password"]',
  ],
  nextLabels: ['Enter', 'Next', 'Continue', 'Proceed'],
  loginLabels: ['Enter', 'Login', 'Submit', 'Continue', 'Proceed'],
  manualStepHint: 'Baroda Connect may require retail selection, CAPTCHA, or security prompts. Complete visible prompts manually if they appear.',
  balanceNavSelectors: [
    'a:has-text("Account Summary")',
    'button:has-text("Account Summary")',
    'a:has-text("Operative Accounts")',
    'a:has-text("Accounts")',
  ],
});
