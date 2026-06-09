import { createRetailBankAdapter } from './genericBank';

export const axisBankAdapter = createRetailBankAdapter({
  code: 'AXIS',
  displayName: 'Axis Bank',
  loginUrl: 'https://omni.axisbank.co.in/axisretailbanking/',
  usernameLabel: 'Customer/Login ID',
  otpMode: 'manual',
  usernameSelectors: [
    'input[name*="cust" i]',
    'input[id*="cust" i]',
    'input[name*="login" i]',
    'input[id*="login" i]',
    'input[placeholder*="Customer ID" i]',
    'input[placeholder*="Login ID" i]',
  ],
  passwordSelectors: [
    'input[name*="password" i]',
    'input[id*="password" i]',
    'input[type="password"]',
  ],
  nextLabels: ['Next', 'Continue', 'Proceed'],
  loginLabels: ['Login', 'LOG IN', 'Submit', 'Continue', 'Proceed'],
  manualStepHint: 'Axis Netsecure/CAPTCHA prompts may need manual completion in the browser.',
  balanceNavSelectors: [
    'a:has-text("Account Summary")',
    'button:has-text("Account Summary")',
    'a:has-text("Accounts")',
    'a:has-text("Operative Accounts")',
  ],
});
