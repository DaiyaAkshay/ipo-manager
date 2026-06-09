/**
 * Gmail-based OTP fetcher.
 *
 * Uses OAuth 2.0 with the read-only Gmail scope. The first time the user runs
 * this, a browser window opens for Google sign-in. Google issues a refresh
 * token which we store in the OS keychain — never on disk in plaintext.
 *
 * SETUP (one-time, see README):
 *   1. Create a Google Cloud project
 *   2. Enable the Gmail API
 *   3. Create an OAuth 2.0 Client ID (Desktop app)
 *   4. Download credentials.json and place at <userData>/data/gmail-credentials.json
 *
 * After setup, this module finds OTPs by:
 *   - Polling for emails matching a sender pattern + subject regex
 *   - Extracting the 6-digit code via regex
 *   - Returning it (or timing out)
 */

import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import keytar from 'keytar';
import { shell } from 'electron';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { getDataDir } from '../db/connection';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const KEYTAR_SERVICE = 'ipo-manager';
const KEYTAR_ACCOUNT_REFRESH = 'gmail-refresh-token-v1';
const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/oauth2callback`;

interface ClientSecrets {
  installed: {
    client_id: string;
    client_secret: string;
    redirect_uris?: string[];
  };
}

export type GmailConnectionState =
  | 'connected'
  | 'not_connected'
  | 'needs_reauth'
  | 'missing_credentials'
  | 'error';

export interface GmailConnectionStatus {
  state: GmailConnectionState;
  configured: boolean;
  hasRefreshToken: boolean;
  label: string;
  detail?: string;
}

function credentialsPath(): string {
  return join(getDataDir(), 'gmail-credentials.json');
}

function validateClientSecrets(raw: string): ClientSecrets {
  const parsed = JSON.parse(raw) as ClientSecrets;
  const installed = parsed?.installed;
  if (!installed?.client_id || !installed?.client_secret) {
    throw new Error('Google OAuth JSON must include installed.client_id and installed.client_secret.');
  }
  return parsed;
}

function loadClientSecrets(): ClientSecrets {
  const path = credentialsPath();
  if (!existsSync(path)) {
    throw new Error(
      `Gmail credentials not found. Add your downloaded OAuth client JSON in the app settings. Expected path:\n${path}`
    );
  }
  return validateClientSecrets(readFileSync(path, 'utf8'));
}

function buildOAuthClient(secrets: ClientSecrets): OAuth2Client {
  return new google.auth.OAuth2(
    secrets.installed.client_id,
    secrets.installed.client_secret,
    REDIRECT_URI
  );
}

async function getAuthorizedClient(): Promise<OAuth2Client> {
  const secrets = loadClientSecrets();
  const client = buildOAuthClient(secrets);

  const refreshToken = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT_REFRESH);
  if (refreshToken) {
    client.setCredentials({ refresh_token: refreshToken });
    return client;
  }

  // First-run OAuth dance
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'  // force refresh token issuance
  });

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url!, `http://127.0.0.1:${REDIRECT_PORT}`);
        const authCode = url.searchParams.get('code');
        if (authCode) {
          res.end('Authorization complete. You can close this window.');
          server.close();
          resolve(authCode);
        } else {
          res.statusCode = 400;
          res.end('No code provided.');
          server.close();
          reject(new Error('No authorization code returned'));
        }
      } catch (e) {
        reject(e);
      }
    });
    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      shell.openExternal(authUrl);
    });
    setTimeout(() => {
      server.close();
      reject(new Error('OAuth timeout (5 min)'));
    }, 5 * 60 * 1000);
  });

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh token. Revoke app access and try again.');
  }
  await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT_REFRESH, tokens.refresh_token);
  client.setCredentials(tokens);
  return client;
}

async function clearRefreshToken(): Promise<void> {
  await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT_REFRESH).catch(() => {});
}

export async function saveGmailCredentialsJson(raw: string): Promise<GmailConnectionStatus> {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Google OAuth JSON is required.');
  const secrets = validateClientSecrets(trimmed);
  writeFileSync(credentialsPath(), JSON.stringify(secrets, null, 2), 'utf8');
  await clearRefreshToken();
  return getGmailConnectionStatus();
}

export async function clearGmailCredentialsConfig(): Promise<GmailConnectionStatus> {
  await clearRefreshToken();
  const path = credentialsPath();
  if (existsSync(path)) unlinkSync(path);
  return getGmailConnectionStatus();
}

function isInvalidGrantError(err: any): boolean {
  const errorCode = err?.response?.data?.error;
  const description = err?.response?.data?.error_description;
  return errorCode === 'invalid_grant' || String(description || '').toLowerCase().includes('expired or revoked');
}

async function probeGmailAccess(client: OAuth2Client): Promise<void> {
  const gmail = google.gmail({ version: 'v1', auth: client });
  await gmail.users.getProfile({ userId: 'me' });
}

export async function getGmailConnectionStatus(): Promise<GmailConnectionStatus> {
  let secrets: ClientSecrets;
  try {
    secrets = loadClientSecrets();
  } catch (err: any) {
    return {
      state: 'missing_credentials',
      configured: false,
      hasRefreshToken: false,
      label: 'Gmail not configured',
      detail: err?.message || String(err)
    };
  }

  const refreshToken = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT_REFRESH);
  if (!refreshToken) {
    return {
      state: 'not_connected',
      configured: true,
      hasRefreshToken: false,
      label: 'Gmail needs sign-in'
    };
  }

  const client = buildOAuthClient(secrets);
  client.setCredentials({ refresh_token: refreshToken });

  try {
    await probeGmailAccess(client);
    return {
      state: 'connected',
      configured: true,
      hasRefreshToken: true,
      label: 'Gmail connected'
    };
  } catch (err: any) {
    if (isInvalidGrantError(err)) {
      return {
        state: 'needs_reauth',
        configured: true,
        hasRefreshToken: true,
        label: 'Gmail needs re-login',
        detail: 'Saved Google access has expired or was revoked.'
      };
    }
    return {
      state: 'error',
      configured: true,
      hasRefreshToken: true,
      label: 'Gmail status error',
      detail: err?.message || String(err)
    };
  }
}

export async function reconnectGmail(): Promise<GmailConnectionStatus> {
  await clearRefreshToken();
  await getAuthorizedClient();
  return getGmailConnectionStatus();
}

interface OtpQuery {
  /** Gmail search query, e.g. 'from:noreply@aubank.in newer_than:5m' */
  query: string;
  /** Regex with one capture group around the OTP digits */
  otpRegex: RegExp;
  /** How long to wait for the OTP to arrive (ms) */
  timeoutMs?: number;
  /** Polling interval (ms) */
  pollMs?: number;
  /** Only consider emails received after this Date */
  receivedAfter?: Date;
}

export async function waitForOtp(opts: OtpQuery): Promise<string> {
  let auth = await getAuthorizedClient();
  let gmail = google.gmail({ version: 'v1', auth });
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const pollMs = opts.pollMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  const sinceUnix = opts.receivedAfter
    ? Math.floor(opts.receivedAfter.getTime() / 1000)
    : Math.floor((Date.now() - 60_000) / 1000);

  const fullQuery = `${opts.query} after:${sinceUnix}`;
  console.log(`[Gmail] Polling for OTP (timeout ${timeoutMs / 1000}s): ${fullQuery}`);

  let pollCount = 0;
  let sawCandidates = 0;
  let retriedAfterInvalidGrant = false;
  while (Date.now() < deadline) {
    let list;
    try {
      list = await gmail.users.messages.list({
        userId: 'me',
        q: fullQuery,
        maxResults: 5
      });
    } catch (err: any) {
      if (!retriedAfterInvalidGrant && isInvalidGrantError(err)) {
        console.warn('[Gmail] Saved Google token expired or was revoked. Clearing it and re-running Google sign-in...');
        await clearRefreshToken();
        auth = await getAuthorizedClient();
        gmail = google.gmail({ version: 'v1', auth });
        retriedAfterInvalidGrant = true;
        continue;
      }
      throw err;
    }

    if (list.data.messages?.length) {
      sawCandidates = list.data.messages.length;
      for (const msg of list.data.messages) {
        let detail;
        try {
          detail = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id!,
            format: 'full'
          });
        } catch (err: any) {
          if (!retriedAfterInvalidGrant && isInvalidGrantError(err)) {
            console.warn('[Gmail] Saved Google token expired during OTP read. Clearing it and re-running Google sign-in...');
            await clearRefreshToken();
            auth = await getAuthorizedClient();
            gmail = google.gmail({ version: 'v1', auth });
            retriedAfterInvalidGrant = true;
            break;
          }
          throw err;
        }
        const text = extractText(detail.data);

        // 1) Strict pattern (e.g. \b(\d{6})\b for a continuous 6-digit code)
        let otp = text.match(opts.otpRegex)?.[1] || null;
        let how = 'strict';

        // 2) Loose fallback: HTML emails sometimes render each OTP digit
        //    in its own <td>, so after tag stripping we get "4 2 6 8 6 5"
        //    (digits separated by whitespace). Reconstruct the code.
        if (!otp) {
          const loose = text.match(/\b\d(?:\s+\d){5}\b/);
          if (loose) {
            otp = loose[0].replace(/\D/g, '');
            how = 'loose-spaced';
          }
        }

        if (otp) {
          const headers = detail.data.payload?.headers || [];
          const subj = headers.find((h: any) => h.name?.toLowerCase() === 'subject')?.value || '';
          const from = headers.find((h: any) => h.name?.toLowerCase() === 'from')?.value || '';
          console.log(`[Gmail] ✓ OTP found (${how}) — from: ${from}, subject: ${subj}`);
          return otp;
        }
      }
    }

    pollCount++;
    // Heartbeat every 10s so the user knows it's still polling
    if (pollCount % 10 === 0) {
      const remaining = Math.ceil((deadline - Date.now()) / 1000);
      console.log(`[Gmail] still polling (${remaining}s remaining, ${sawCandidates} candidate email(s) seen so far)…`);
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  console.warn(`[Gmail] OTP_TIMEOUT after ${timeoutMs / 1000}s. Saw ${sawCandidates} candidate email(s) but none matched the regex. Check the Gmail query: ${opts.query}`);
  throw new Error('OTP_TIMEOUT');
}

/**
 * Extract searchable text from a Gmail message.
 *
 * Multipart emails commonly contain BOTH a text/plain and a text/html part
 * with the same content. The HTML part has lots of extra junk — image
 * dimensions like `height="600"`, tracking-pixel URLs with numeric IDs,
 * inline CSS with hex colors that look like digits, etc. — and a naive
 * concat of raw HTML + text/plain often makes the OTP regex pick up an
 * HTML attribute value instead of the real code.
 *
 * Strategy: prefer text/plain. If only text/html is present, strip
 * <style>/<script> blocks and tag attributes before scanning.
 */
function extractText(msg: any): string {
  let plain = '';
  let html  = '';
  function walk(p: any): void {
    if (!p) return;
    if (p.body?.data) {
      const decoded = Buffer.from(p.body.data, 'base64').toString('utf8');
      const mime = (p.mimeType || '').toLowerCase();
      if (mime.includes('text/plain')) plain += '\n' + decoded;
      else if (mime.includes('text/html')) html += '\n' + decoded;
      else if (!plain && !html) plain += '\n' + decoded; // unknown type — keep
    }
    if (p.parts) p.parts.forEach(walk);
  }
  walk(msg.payload);

  // Strip HTML to leave only the visible body text, so attribute values
  // like `height="600"` don't pollute the regex search space.
  const stripped = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Order matters: plain text wins over stripped HTML wins over the
  // Gmail snippet preview. The OTP regex returns the FIRST match, so
  // putting the cleanest source first improves accuracy.
  return [plain, stripped, msg.snippet || ''].filter(Boolean).join('\n');
}

/**
 * Per-bank/broker OTP query presets.
 * These are starting points — confirm sender addresses by checking your inbox
 * after the first real OTP arrives, then refine the query.
 */
export const OTP_PRESETS = {
  AU_BANK: {
    // AU has used multiple sender identities/subjects over time.
    // Keep this broad enough to survive template changes.
    query: 'from:(@aubank.in OR @au.bank OR @au.smallfinancebank OR aubank OR "AU Small Finance")',
    otpRegex: /\b(\d{6})\b/
  },
  YES_BANK: {
    query: 'from:(@yesbank.in) subject:(OTP)',
    otpRegex: /\b(\d{6})\b/
  },
  SBI: {
    query: 'from:(sbi OR @onlinesbi.sbi) subject:(OTP)',
    otpRegex: /\b(\d{6})\b/
  },
  KOTAK: {
    query: 'from:(@kotak.com) subject:(OTP)',
    otpRegex: /\b(\d{6})\b/
  },
  ZERODHA: {
    query: 'from:(@zerodha.com OR noreply@zerodha.com) subject:(OTP OR login)',
    otpRegex: /\b(\d{6})\b/
  },
  DHAN: {
    // Dhan has changed sender/subject phrasing over time. Keep this broad
    // enough to survive template changes while still biasing toward login mail.
    query: 'from:(@dhan.co OR @mailer.dhan.co OR dhan) subject:(OTP OR login OR verification OR code)',
    otpRegex: /\b(\d{6})\b/
  },
  ANGEL: {
    // Angel has used OTP, verification-code, and login-code subjects.
    // Keep this broader than subject:(OTP) so Gmail polling does not miss
    // newer templates.
    query: 'from:(@angelbroking.com OR @angelone.in OR angelone OR "Angel One" OR "Angel Broking") subject:(OTP OR login OR verification OR code)',
    otpRegex: /\b(\d{6})\b/
  },
  MIRAE: {
    // Drop the subject filter — mStock OTP emails often use subjects like
    // "Verification Code" or "Login Code" rather than literal "OTP".
    query: 'from:(@miraeasset.co.in OR @mstock.com OR mstock OR miraeasset)',
    otpRegex: /\b(\d{6})\b/
  }
};
