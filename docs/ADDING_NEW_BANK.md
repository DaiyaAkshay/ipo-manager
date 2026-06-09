# Adding a new bank or broker login adapter

There are two stub adapters per bank/broker in `src/main/automation/stubs.ts`.
A stub just opens the login page in a Chrome window — it does not auto-fill
anything. To turn a stub into a real adapter, follow these steps.

## 1. Capture the selectors

1. Visit the real login page in normal Chrome.
2. Open DevTools (F12) → click the picker icon → click the **username** field.
3. Look for stable identifiers in this order of preference:
   - `id="..."` → use `#id`
   - `name="..."` → use `[name="..."]`
   - `data-testid="..."` → use `[data-testid="..."]`
   - placeholder text → use `[placeholder*="username" i]`
4. Repeat for **password** field and **OTP** field and **submit/continue** buttons.

Avoid CSS class selectors — most banks rebuild their CSS on every release and
your selector will silently break.

## 2. Identify the OTP email pattern

Trigger a login OTP. Check Gmail. Note:

- The exact sender (e.g., `noreply@aubank.in`)
- A consistent subject line keyword (e.g., "OTP", "verification", "login code")
- Where the 6-digit code appears in the body

Update `OTP_PRESETS` in `src/main/email/gmail.ts` if the existing preset
doesn't match. Test with:

```
gmail search box: from:noreply@aubank.in subject:OTP newer_than:1d
```

## 3. Replace the stub with a real adapter

Use `src/main/automation/auBank.ts` as a template. The shape:

```ts
export const someBankAdapter: LoginAdapter = {
  code: 'YES',
  displayName: 'YES Bank',
  async login(page, creds, fetchOtp) {
    await page.goto('https://...', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#username', { timeout: 30_000 });
    await page.fill('#username', creds.username);
    await page.click('button[type="submit"]');

    await page.waitForSelector('input[type="password"]');
    await page.fill('input[type="password"]', creds.password);
    await page.click('button[type="submit"]');

    const otpField = await page.waitForSelector('#otp', { timeout: 30_000 }).catch(() => null);
    if (otpField) {
      const otp = await fetchOtp();
      await page.fill('#otp', otp);
      await page.click('button:has-text("Verify")');
    }

    // Hand control to user. Do NOT navigate further.
  }
};
```

Then update `registry.ts` to point the bank code at your new adapter instead
of the stub.

## 4. Test, gently

Test with **one** account first. If it works, commit. If a CAPTCHA appears
or the page changes, the script will pause harmlessly — you take over manually.

## 5. Watch for breakages

Banks redesign their login pages every 6-12 months. When a login breaks:
- Re-inspect the page for new selectors.
- Update the adapter.
- The audit log (`audit_log` table) will tell you when it last worked.

## TOTP instead of email OTP (recommended for brokers)

Zerodha and Angel One support TOTP. To use it:

1. Enable TOTP in the broker's web console.
2. Save the QR code's secret key (16-32 character base32 string) when shown.
3. Store it in `broker_accounts.totp_secret_enc`.
4. In the adapter, generate the code using `speakeasy` or `otplib`:

```ts
import { authenticator } from 'otplib';
const code = authenticator.generate(totpSecret);
await page.fill('#totp', code);
```

This eliminates the email round-trip entirely — much faster and more reliable.
