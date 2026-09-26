/**
 * Gmail-based OTP fetcher.
 *
 * Uses OAuth 2.0 with the read-only Gmail scope. Google sign-in only ever
 * happens when the user explicitly clicks Sign in / Reconnect — never in the
 * middle of an automated bank/broker login. Google issues a refresh token
 * which we store in the OS keychain — never on disk in plaintext.
 *
 * SETUP (one-time, see README):
 *   1. Create a Google Cloud project
 *   2. Enable the Gmail API
 *   3. Create an OAuth 2.0 Client ID (Desktop app)
 *   4. Paste the downloaded client JSON into the app's Gmail settings
 *   5. On the OAuth consent screen, set Publishing status to "In production".
 *      While it is "Testing", Google expires the refresh token after 7 days and
 *      Gmail needs a re-login every week.
 *
 * After setup, this module finds OTPs by:
 *   - Polling for emails matching a sender pattern + subject regex
 *   - Extracting the 6-digit code via regex (preferring the number that
 *     follows an "OTP"/"code" keyword, not e.g. a branch PIN code in the footer)
 *   - Returning it (or timing out)
 */

import { google } from 'googleapis';
// Type-only: google-auth-library is a transitive dependency of googleapis, so a
// runtime import would make electron-vite bundle its whole tree into main.
import type { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import keytar from 'keytar';
import { shell } from 'electron';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';
import { getDataDir } from '../db/connection';
import { extractText, pickOtp } from './otpParse';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const KEYTAR_SERVICE = 'ipo-manager';
const KEYTAR_ACCOUNT_REFRESH = 'gmail-refresh-token-v1';
const CALLBACK_PATH = '/oauth2callback';
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
// Status probes hit Google (users.getProfile); cache briefly so repeated UI
// refreshes don't hammer the API. Invalidated on sign-in / clear / auth error.
const STATUS_CACHE_MS = 30_000;
// Tolerate a PC clock that runs slightly fast relative to Google when building
// the `after:` search bound. Consumed-message tracking (below) keeps the wider
// window from re-using an OTP email an earlier login already consumed.
const OTP_CLOCK_GRACE_MS = 30_000;

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

/**
 * Thrown when Gmail can't be used until the user acts (signs in again or adds
 * the OAuth client JSON). Callers in the automation layer catch this and fall
 * back to manual OTP entry instead of hanging or popping a sign-in tab.
 */
export class GmailAuthError extends Error {
  readonly code: 'GMAIL_REAUTH_REQUIRED' | 'GMAIL_NOT_CONFIGURED';
  constructor(code: 'GMAIL_REAUTH_REQUIRED' | 'GMAIL_NOT_CONFIGURED', message: string) {
    super(message);
    this.name = 'GmailAuthError';
    this.code = code;
  }
}

export function isGmailAuthError(err: unknown): err is GmailAuthError {
  return err instanceof GmailAuthError;
}

// ── Non-secret auth bookkeeping ──────────────────────────────────────────────
// When the current refresh token was obtained, and the last auth failure. Used
// to explain *why* Gmail needs a re-login (e.g. the 7-day "Testing" expiry).
interface GmailAuthInfo {
  connectedAt: string | null;
  lastAuthError: string | null;
  lastAuthErrorAt: string | null;
}

function authInfoPath(): string {
  return join(getDataDir(), 'gmail-auth.json');
}

function readAuthInfo(): GmailAuthInfo {
  try {
    if (existsSync(authInfoPath())) {
      const parsed = JSON.parse(readFileSync(authInfoPath(), 'utf8'));
      return {
        connectedAt: typeof parsed.connectedAt === 'string' ? parsed.connectedAt : null,
        lastAuthError: typeof parsed.lastAuthError === 'string' ? parsed.lastAuthError : null,
        lastAuthErrorAt: typeof parsed.lastAuthErrorAt === 'string' ? parsed.lastAuthErrorAt : null,
      };
    }
  } catch { /* fall through to defaults */ }
  return { connectedAt: null, lastAuthError: null, lastAuthErrorAt: null };
}

function writeAuthInfo(patch: Partial<GmailAuthInfo>): void {
  try {
    writeFileSync(authInfoPath(), JSON.stringify({ ...readAuthInfo(), ...patch }, null, 2), 'utf8');
  } catch { /* bookkeeping only — never break auth over it */ }
}

function clearAuthInfo(): void {
  try { if (existsSync(authInfoPath())) unlinkSync(authInfoPath()); } catch { /* */ }
}

// ── Client secrets ───────────────────────────────────────────────────────────

function credentialsPath(): string {
  return join(getDataDir(), 'gmail-credentials.json');
}

function validateClientSecrets(raw: string): ClientSecrets {
  const parsed = JSON.parse(raw) as any;
  if (parsed?.web && !parsed?.installed) {
    throw new Error(
      'This is a "Web application" OAuth client. In Google Cloud Console create an OAuth client ' +
      'of type "Desktop app" and paste that JSON instead.'
    );
  }
  const installed = parsed?.installed;
  if (!installed?.client_id || !installed?.client_secret) {
    throw new Error('Google OAuth JSON must include installed.client_id and installed.client_secret.');
  }
  return parsed as ClientSecrets;
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

function buildOAuthClient(secrets: ClientSecrets, redirectUri?: string): OAuth2Client {
  return new google.auth.OAuth2(
    secrets.installed.client_id,
    secrets.installed.client_secret,
    redirectUri
  );
}

async function readRefreshToken(): Promise<string | null> {
  return keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT_REFRESH);
}

async function clearRefreshToken(): Promise<void> {
  await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT_REFRESH).catch(() => {});
}

/**
 * Classify errors that mean "the saved Google access is no longer usable" —
 * as opposed to transient network/5xx problems that are worth retrying.
 */
function isAuthFailure(err: any): boolean {
  const oauthError = err?.response?.data?.error;
  const description = String(err?.response?.data?.error_description || err?.message || '').toLowerCase();
  if (oauthError === 'invalid_grant' || oauthError === 'invalid_client' || oauthError === 'unauthorized_client') {
    return true;
  }
  if (description.includes('expired or revoked') || description.includes('invalid_grant')) return true;
  return err?.response?.status === 401 || err?.code === 401 || err?.status === 401;
}

function isTransientError(err: any): boolean {
  const status = err?.response?.status;
  if (typeof status === 'number') return status >= 500 || status === 429;
  const code = String(err?.code || '');
  return ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH'].includes(code);
}

/**
 * A human explanation for a dead token. If it died roughly 7 days after it was
 * issued, the OAuth consent screen is almost certainly still in "Testing" mode.
 */
function reauthDetail(info: GmailAuthInfo): string {
  const base = 'Saved Google access has expired or was revoked.';
  if (!info.connectedAt) return base;
  const ageDays = (Date.now() - new Date(info.connectedAt).getTime()) / 86_400_000;
  if (ageDays >= 6.5 && ageDays <= 9) {
    return `${base} It lasted about 7 days, which is what Google does while the OAuth app is in ` +
      '"Testing" mode. In Google Cloud Console → Google Auth Platform → Audience, click ' +
      '"Publish app" so sign-ins stop expiring every week, then reconnect once.';
  }
  return base;
}

// ── Authorised client for automation (never interactive) ────────────────────

async function getAuthorizedClient(): Promise<OAuth2Client> {
  let secrets: ClientSecrets;
  try {
    secrets = loadClientSecrets();
  } catch (err: any) {
    throw new GmailAuthError('GMAIL_NOT_CONFIGURED', err?.message || String(err));
  }

  const refreshToken = await readRefreshToken();
  if (!refreshToken) {
    throw new GmailAuthError(
      'GMAIL_REAUTH_REQUIRED',
      'Gmail is not signed in. Click the Gmail pill in the sidebar and sign in to enable automatic OTPs.'
    );
  }
  const client = buildOAuthClient(secrets);
  client.setCredentials({ refresh_token: refreshToken });
  // Google rarely rotates refresh tokens for installed apps, but if it does we
  // must persist the new one or the next refresh fails with invalid_grant.
  client.on('tokens', tokens => {
    if (tokens.refresh_token && tokens.refresh_token !== refreshToken) {
      void keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT_REFRESH, tokens.refresh_token).catch(() => {});
    }
  });
  return client;
}

function markAuthFailure(err: any): GmailAuthError {
  const message = err?.response?.data?.error_description || err?.message || String(err);
  writeAuthInfo({ lastAuthError: message, lastAuthErrorAt: new Date().toISOString() });
  invalidateStatusCache();
  return new GmailAuthError('GMAIL_REAUTH_REQUIRED', reauthDetail(readAuthInfo()));
}

// ── Interactive sign-in (explicit user action only) ─────────────────────────

let signInInFlight: Promise<void> | null = null;

function callbackPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
    '<style>body{font-family:system-ui,sans-serif;background:#0d0e12;color:#e8e6e1;display:grid;' +
    'place-items:center;height:100vh;margin:0}main{max-width:420px;text-align:center}' +
    'h1{font-size:20px;margin:0 0 8px}p{color:#a8a59c;line-height:1.5}</style></head>' +
    `<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
}

/**
 * Run the loopback OAuth flow once. Uses an ephemeral port (no EADDRINUSE from
 * a stale earlier attempt), PKCE + state, a hard timeout, and always closes the
 * local server. The previous refresh token is only replaced once a NEW one has
 * been obtained, so an abandoned or failed attempt never disconnects Gmail.
 */
async function runInteractiveSignIn(): Promise<void> {
  const secrets = loadClientSecrets();
  const state = randomBytes(16).toString('hex');

  const server = createServer();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const client = buildOAuthClient(secrets, redirectUri);
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    const code = await new Promise<string>((resolve, reject) => {
      server.on('error', reject);
      server.on('request', (req, res) => {
        let url: URL;
        try {
          url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
        } catch {
          res.statusCode = 400;
          res.end();
          return;
        }
        // Ignore anything that isn't the OAuth callback (favicon, probes…)
        // instead of failing the whole sign-in over it.
        if (url.pathname !== CALLBACK_PATH) {
          res.statusCode = 404;
          res.end();
          return;
        }
        if (url.searchParams.get('state') !== state) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(callbackPage('Sign-in link expired', 'Start the Gmail sign-in again from IPO Manager.'));
          return;
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        const oauthError = url.searchParams.get('error');
        if (oauthError) {
          res.end(callbackPage('Gmail sign-in cancelled', 'You can close this tab and try again from IPO Manager.'));
          reject(new Error(oauthError === 'access_denied'
            ? 'Google sign-in was cancelled.'
            : `Google sign-in failed: ${oauthError}`));
          return;
        }
        const authCode = url.searchParams.get('code');
        if (!authCode) {
          res.statusCode = 400;
          res.end(callbackPage('No authorization code', 'Start the Gmail sign-in again from IPO Manager.'));
          reject(new Error('Google did not return an authorization code.'));
          return;
        }
        res.end(callbackPage('Gmail connected', 'IPO Manager can now read OTP emails. You can close this tab.'));
        resolve(authCode);
      });

      timeoutHandle = setTimeout(
        () => reject(new Error('Google sign-in timed out after 5 minutes. Click Sign in to try again.')),
        SIGN_IN_TIMEOUT_MS
      );

      const authUrl = client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent', // force a fresh refresh token on every consent
        scope: SCOPES,
        state,
        code_challenge_method: 'S256' as unknown as CodeChallengeMethod,
        code_challenge: codeChallenge,
      });
      shell.openExternal(authUrl).catch(reject);
    });

    const { tokens } = await client.getToken({ code, codeVerifier });
    if (!tokens.refresh_token) {
      throw new Error(
        'Google did not return a refresh token. Remove "IPO Manager" at myaccount.google.com/permissions ' +
        'and sign in again.'
      );
    }
    await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT_REFRESH, tokens.refresh_token);
    writeAuthInfo({ connectedAt: new Date().toISOString(), lastAuthError: null, lastAuthErrorAt: null });
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    // Stop listening and drop idle keep-alive sockets; a response still being
    // written (the "connected"/"cancelled" page) is allowed to finish.
    server.close();
    server.closeIdleConnections();
    invalidateStatusCache();
  }
}

/**
 * Start (or join) an interactive Google sign-in. Concurrent callers share one
 * flow, so clicking Sign in twice never opens two local servers.
 */
export async function connectGmail(): Promise<GmailConnectionStatus> {
  if (!signInInFlight) {
    signInInFlight = runInteractiveSignIn().finally(() => { signInInFlight = null; });
  }
  await signInInFlight;
  return getGmailConnectionStatus({ force: true });
}

/** Kept for callers that still use the old name — same as connectGmail(). */
export async function reconnectGmail(): Promise<GmailConnectionStatus> {
  return connectGmail();
}

// ── Credentials config ───────────────────────────────────────────────────────

export async function saveGmailCredentialsJson(raw: string): Promise<GmailConnectionStatus> {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Google OAuth JSON is required.');
  const secrets = validateClientSecrets(trimmed);
  writeFileSync(credentialsPath(), JSON.stringify(secrets, null, 2), 'utf8');
  // A token minted for a different OAuth client can't be refreshed with this one.
  await clearRefreshToken();
  clearAuthInfo();
  invalidateStatusCache();
  return getGmailConnectionStatus({ force: true });
}

export async function clearGmailCredentialsConfig(): Promise<GmailConnectionStatus> {
  await clearRefreshToken();
  clearAuthInfo();
  const path = credentialsPath();
  if (existsSync(path)) unlinkSync(path);
  invalidateStatusCache();
  return getGmailConnectionStatus({ force: true });
}

// ── Status ───────────────────────────────────────────────────────────────────

let statusCache: { at: number; status: GmailConnectionStatus } | null = null;

function invalidateStatusCache(): void {
  statusCache = null;
}

async function probeGmailAccess(client: OAuth2Client): Promise<void> {
  const gmail = google.gmail({ version: 'v1', auth: client });
  await gmail.users.getProfile({ userId: 'me' });
}

export async function getGmailConnectionStatus(opts?: { force?: boolean }): Promise<GmailConnectionStatus> {
  if (!opts?.force && statusCache && Date.now() - statusCache.at < STATUS_CACHE_MS) {
    return statusCache.status;
  }
  const status = await computeGmailConnectionStatus();
  statusCache = { at: Date.now(), status };
  return status;
}

async function computeGmailConnectionStatus(): Promise<GmailConnectionStatus> {
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

  const refreshToken = await readRefreshToken();
  if (!refreshToken) {
    return {
      state: 'not_connected',
      configured: true,
      hasRefreshToken: false,
      label: signInInFlight ? 'Gmail: finish sign-in in browser' : 'Gmail needs sign-in',
      detail: signInInFlight ? 'Complete the Google consent screen that opened in your browser.' : undefined,
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
    if (isAuthFailure(err)) {
      writeAuthInfo({
        lastAuthError: err?.response?.data?.error_description || err?.message || String(err),
        lastAuthErrorAt: new Date().toISOString(),
      });
      return {
        state: 'needs_reauth',
        configured: true,
        hasRefreshToken: true,
        label: 'Gmail needs re-login',
        detail: reauthDetail(readAuthInfo()),
      };
    }
    return {
      state: 'error',
      configured: true,
      hasRefreshToken: true,
      label: 'Gmail status error',
      detail: isTransientError(err)
        ? `Could not reach Gmail (${err?.code || err?.response?.status || 'network'}). Check the internet connection.`
        : (err?.message || String(err))
    };
  }
}

// ── OTP polling ──────────────────────────────────────────────────────────────

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

// Message ids whose OTP has already been handed to a login, so back-to-back
// logins to the same bank (bulk refresh — every relative's OTP lands in the
// same inbox) can't be fed a previous member's code. id → consumed-at ms.
const consumedOtpMessages = new Map<string, number>();
const CONSUMED_TTL_MS = 30 * 60 * 1000;

function pruneConsumed(now: number): void {
  for (const [id, at] of consumedOtpMessages) {
    if (now - at > CONSUMED_TTL_MS) consumedOtpMessages.delete(id);
  }
}

/**
 * Poll Gmail for an OTP. Never starts an interactive sign-in: if the saved
 * access is missing or dead this throws GmailAuthError straight away, so the
 * caller can fall back to manual entry while the bank's OTP is still valid.
 */
export async function waitForOtp(opts: OtpQuery): Promise<string> {
  const auth = await getAuthorizedClient();
  const gmail = google.gmail({ version: 'v1', auth });
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const pollMs = opts.pollMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  const sinceMs = (opts.receivedAfter ? opts.receivedAfter.getTime() : Date.now() - 60_000) - OTP_CLOCK_GRACE_MS;
  const sinceUnix = Math.floor(sinceMs / 1000);

  const fullQuery = `${opts.query} after:${sinceUnix}`;
  console.log(`[Gmail] Polling for OTP (timeout ${timeoutMs / 1000}s): ${fullQuery}`);

  // Messages already fetched this call that contained no OTP — don't re-download
  // them on every poll.
  const checkedWithoutOtp = new Set<string>();
  let pollCount = 0;
  let sawCandidates = 0;
  while (Date.now() < deadline) {
    pruneConsumed(Date.now());
    try {
      const list = await gmail.users.messages.list({
        userId: 'me',
        q: fullQuery,
        maxResults: 5
      });

      // Gmail lists newest first, so the first usable match is the latest OTP.
      for (const msg of list.data.messages || []) {
        const id = msg.id!;
        if (consumedOtpMessages.has(id) || checkedWithoutOtp.has(id)) continue;
        sawCandidates += 1;
        const detail = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
        const picked = pickOtp(extractText(detail.data), opts.otpRegex);
        if (!picked) {
          checkedWithoutOtp.add(id);
          continue;
        }
        consumedOtpMessages.set(id, Date.now());
        const headers = detail.data.payload?.headers || [];
        const subj = headers.find((h: any) => h.name?.toLowerCase() === 'subject')?.value || '';
        const from = headers.find((h: any) => h.name?.toLowerCase() === 'from')?.value || '';
        // Some banks put the code in the subject ("123456 is your OTP") — mask digits.
        console.log(`[Gmail] ✓ OTP found (${picked.how}) — from: ${from}, subject: ${subj.replace(/\d{3,}/g, '•••')}`);
        return picked.otp;
      }
    } catch (err: any) {
      if (isAuthFailure(err)) {
        console.warn('[Gmail] Saved Google access expired or was revoked — falling back to manual OTP.');
        throw markAuthFailure(err);
      }
      if (!isTransientError(err)) throw err;
      console.warn(`[Gmail] transient error while polling (${err?.code || err?.response?.status}); retrying…`);
    }

    pollCount++;
    // Heartbeat every 10 polls so the user knows it's still polling
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
