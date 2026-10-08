import { createRetailBankAdapter } from './genericBank';

export const pnbBankAdapter = createRetailBankAdapter({
  code: 'PNB',
  displayName: 'Punjab National Bank',
  // ibanking.pnb.bank.in is a landing page whose "Retail Internet Banking"
  // link opens the login in a NEW tab (target=_blank), which the adapter never
  // saw (checked live 2026-10-08). Open the retail login form directly.
  loginUrl: [
    'https://iretail.pnb.bank.in/corp/AuthenticationController?FORMSGROUP_ID__=AuthenticationFG&__START_TRAN_FLAG__=Y&__FG_BUTTONS__=LOAD&ACTION.LOAD=Y&AuthenticationFG.LOGIN_FLAG=1&BANK_ID=024',
    'https://ibanking.pnb.bank.in/',
  ],
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
