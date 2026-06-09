import keytar from 'keytar';
import { appendAutomationLog } from '../logging';
import { canMakeCaptchaCall, recordCaptchaCall } from './usage';

const KEYTAR_SERVICE = 'ipo-manager';
const KEYTAR_ACCOUNT_API_KEY = 'anthropic-api-key-v1';
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

export type ClaudeCaptchaState =
  | 'connected'
  | 'not_connected'
  | 'error';

export interface ClaudeCaptchaStatus {
  state: ClaudeCaptchaState;
  configured: boolean;
  label: string;
  detail?: string;
  model: string;
  source: 'environment' | 'keychain' | null;
}

function configuredModel(): string {
  const model = (process.env.ANTHROPIC_CAPTCHA_MODEL || '').trim();
  return model || DEFAULT_MODEL;
}

function candidateModels(): string[] {
  return Array.from(new Set([
    configuredModel(),
    'claude-sonnet-4-20250514',
    'claude-3-7-sonnet-20250219',
    'claude-3-5-haiku-20241022',
    'claude-3-5-haiku-latest',
  ].filter(Boolean)));
}

function cleanCaptchaResponse(rawText: string): string | null {
  const raw = rawText.trim().replace(/^["'`]+|["'`]+$/g, '');
  if (!raw || /^unknown$/i.test(raw)) return null;

  const compact = raw.replace(/\s+/g, '').replace(/[^A-Za-z0-9]/g, '');
  if (/^[A-Za-z0-9]{5,8}$/.test(compact) && !/^unknown$/i.test(compact)) {
    return compact;
  }

  const tokens = raw.match(/[A-Za-z0-9]{5,8}/g) || [];
  const useful = tokens.filter(token => !/^(unknown|captcha|banking|login|image|shared|appears|challenge)$/i.test(token));
  return useful.length === 1 ? useful[0] : null;
}

async function readStoredApiKey(): Promise<string | null> {
  const envKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (envKey) return envKey;
  return keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT_API_KEY);
}

export async function getClaudeCaptchaStatus(): Promise<ClaudeCaptchaStatus> {
  try {
    const envKey = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (envKey) {
      return {
        state: 'connected',
        configured: true,
        label: 'Claude CAPTCHA ready',
        detail: 'Using ANTHROPIC_API_KEY from the environment.',
        model: configuredModel(),
        source: 'environment',
      };
    }

    const key = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT_API_KEY);
    if (key) {
      return {
        state: 'connected',
        configured: true,
        label: 'Claude CAPTCHA ready',
        detail: 'Anthropic API key is stored securely in the OS keychain.',
        model: configuredModel(),
        source: 'keychain',
      };
    }

    return {
      state: 'not_connected',
      configured: false,
      label: 'Claude CAPTCHA off',
      detail: 'Add an Anthropic API key to let AU Bank CAPTCHA be solved automatically.',
      model: configuredModel(),
      source: null,
    };
  } catch (err: any) {
    return {
      state: 'error',
      configured: false,
      label: 'Claude CAPTCHA error',
      detail: err?.message || String(err),
      model: configuredModel(),
      source: null,
    };
  }
}

export async function saveClaudeCaptchaApiKey(apiKey: string): Promise<ClaudeCaptchaStatus> {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error('Anthropic API key is required.');
  await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT_API_KEY, trimmed);
  return getClaudeCaptchaStatus();
}

export async function clearClaudeCaptchaApiKey(): Promise<ClaudeCaptchaStatus> {
  await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT_API_KEY).catch(() => {});
  return getClaudeCaptchaStatus();
}

export async function solveCaptchaTextWithClaude(imageBytes: Buffer, mediaType = 'image/png'): Promise<string | null> {
  const apiKey = await readStoredApiKey();
  if (!apiKey) {
    appendAutomationLog('AU_CAPTCHA', 'Claude solve skipped: no Anthropic API key available.');
    return null;
  }

  // Cost-safety gates: explicit consent + daily cap. Both stop runaway
  // spending and ensure the user has acknowledged that bank CAPTCHA images
  // are being uploaded to api.anthropic.com.
  const gate = canMakeCaptchaCall();
  if (!gate.ok) {
    if (gate.reason === 'CONSENT_REQUIRED') {
      appendAutomationLog(
        'AU_CAPTCHA',
        'Claude solve skipped: user has not yet consented to uploading CAPTCHA images to Anthropic. ' +
        'Open the CAPTCHA AI pill in the sidebar to give consent.'
      );
    } else if (gate.reason === 'DAILY_CAP_REACHED') {
      appendAutomationLog(
        'AU_CAPTCHA',
        `Claude solve skipped: daily cap of ${gate.state.cap} calls reached (made ${gate.state.calls} today). ` +
        'Open the CAPTCHA AI pill in the sidebar to raise the cap or reset the counter.'
      );
    }
    return null;
  }

  let lastError: Error | null = null;
  for (const model of candidateModels()) {
    appendAutomationLog('AU_CAPTCHA', `Calling Anthropic model ${model} with ${imageBytes.length} image bytes (today: ${gate.state.calls + 1}/${gate.state.cap || '∞'}).`);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 24,
        temperature: 0,
        system: 'You read AU Bank login CAPTCHA images. The CAPTCHA is exactly 6 characters: lowercase letters a-z and digits 0-9 only (no uppercase, no symbols). A single diagonal strike-through line crosses the characters from upper-left to lower-right; that line is NOT part of the text — read the characters underneath it. The glyphs are slightly wavy/distorted. Return ONLY the 6 characters with no spaces, quotes, or explanation. If genuinely unreadable, return UNKNOWN.',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType,
                  data: imageBytes.toString('base64'),
                },
              },
              {
                type: 'text',
                text: 'Read the 6-character CAPTCHA. Reply with only the 6 lowercase-letter-or-digit characters. No spaces. No explanation.',
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      lastError = new Error(`Anthropic API ${response.status} (${model}): ${body.slice(0, 300)}`);
      appendAutomationLog('AU_CAPTCHA', `Anthropic API error from ${model}: ${lastError.message}`);
      // Count the failed attempt too — the request was billable.
      recordCaptchaCall({ inputTokens: 0, outputTokens: 0, ok: false });
      if (response.status === 400 || response.status === 404) continue;
      throw lastError;
    }

    const payload = await response.json() as any;
    const rawText = Array.isArray(payload?.content)
      ? payload.content
        .filter((block: any) => block?.type === 'text' && typeof block?.text === 'string')
        .map((block: any) => block.text)
        .join(' ')
      : '';

    // Record the call + token counts (Anthropic returns usage.input_tokens
    // and usage.output_tokens on successful responses).
    const usage = payload?.usage || {};
    recordCaptchaCall({
      inputTokens: Number(usage.input_tokens) || 0,
      outputTokens: Number(usage.output_tokens) || 0,
      ok: true,
    });

    const cleaned = cleanCaptchaResponse(rawText);

    appendAutomationLog('AU_CAPTCHA', `Anthropic raw response from ${model}: "${rawText}" => cleaned "${cleaned}" (in=${usage.input_tokens || 0} out=${usage.output_tokens || 0} tokens)`);
    if (!cleaned) return null;
    return cleaned;
  }

  if (lastError) throw lastError;
  return null;
}
