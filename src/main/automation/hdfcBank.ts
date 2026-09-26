import { createRetailBankAdapter } from './genericBank';

export const hdfcBankAdapter = createRetailBankAdapter({
  code: 'HDFC',
  displayName: 'HDFC Bank',
  // Verified 2026-09-26: both addresses land on the new Keycloak sign-in at
  // now.hdfc.bank.in (#username / #password / #kc-login "Login").
  loginUrl: ['https://now.hdfc.bank.in/retail-app/', 'https://netbanking.hdfcbank.com/netbanking/'],
  usernameLabel: 'Customer ID',
  otpMode: 'manual',
  usernameSelectors: [
    'input#username',
    'input[name="username"]',
    'input[name="fldLoginUserId"]',
    'input#fldLoginUserId',
    'input[name*="customer" i]',
    'input[id*="customer" i]',
    'input[placeholder*="Customer ID" i]',
  ],
  passwordSelectors: [
    'input#password',
    'input[name="password"]',
    'input[name="fldPassword"]',
    'input#fldPassword',
    'input[type="password"]',
  ],
  loginSelectors: ['#kc-login', 'input[name="login"][type="submit"]'],
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
