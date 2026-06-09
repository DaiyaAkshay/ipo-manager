import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../db/connection';
import { appendAutomationLog } from '../logging';
import {
  clearClaudeCaptchaApiKey,
  getClaudeCaptchaStatus,
  saveClaudeCaptchaApiKey,
  solveCaptchaTextWithClaude,
} from './anthropic';

export type CaptchaAiProvider = 'anthropic';
export type CaptchaApiKeyProvider = 'anthropic';
export type CaptchaAiState = 'connected' | 'not_connected' | 'error';

export interface CaptchaProviderStatus {
  provider: CaptchaAiProvider;
  displayName: string;
  state: CaptchaAiState;
  configured: boolean;
  label: string;
  detail?: string;
  model: string;
  source: 'environment' | 'keychain' | null;
}

export interface CaptchaAiStatus {
  state: CaptchaAiState;
  configured: boolean;
  label: string;
  detail?: string;
  activeProvider: CaptchaAiProvider;
  configuredProviders: CaptchaAiProvider[];
  providers: Record<CaptchaAiProvider, CaptchaProviderStatus>;
}

export interface CaptchaSolveResult {
  text: string;
  provider: CaptchaAiProvider;
  confidence?: number;
  alternates?: Array<{ text: string; confidence?: number }>;
  shouldSubmit: boolean;
}

function getConfigPath(): string {
  return join(getDataDir(), 'captcha-ai.json');
}

function readStoredProviderPreference(): CaptchaAiProvider | null {
  try {
    if (!existsSync(getConfigPath())) return null;
    const raw = JSON.parse(readFileSync(getConfigPath(), 'utf8'));
    return raw?.activeProvider === 'anthropic' ? 'anthropic' : null;
  } catch {
    return null;
  }
}

function writeStoredProviderPreference(activeProvider: CaptchaAiProvider): void {
  writeFileSync(getConfigPath(), JSON.stringify({ activeProvider }, null, 2), 'utf8');
}

export async function getCaptchaAiStatus(): Promise<CaptchaAiStatus> {
  const anthropic = await getClaudeCaptchaStatus();
  const provider: CaptchaProviderStatus = {
    provider: 'anthropic',
    displayName: 'Claude',
    ...anthropic,
  };

  const statusSuffix = provider.state === 'connected'
    ? ' ready'
    : provider.state === 'error'
      ? ' error'
      : ' off';

  return {
    state: provider.state,
    configured: provider.configured,
    label: `CAPTCHA AI: Claude${statusSuffix}`,
    detail: provider.detail,
    activeProvider: 'anthropic',
    configuredProviders: provider.configured ? ['anthropic'] : [],
    providers: { anthropic: provider },
  };
}

export async function setCaptchaAiProvider(_provider: CaptchaAiProvider): Promise<CaptchaAiStatus> {
  writeStoredProviderPreference('anthropic');
  return getCaptchaAiStatus();
}

export async function saveCaptchaApiKey(_provider: CaptchaApiKeyProvider, apiKey: string): Promise<CaptchaAiStatus> {
  await saveClaudeCaptchaApiKey(apiKey);
  writeStoredProviderPreference('anthropic');
  return getCaptchaAiStatus();
}

export async function clearCaptchaApiKey(_provider: CaptchaApiKeyProvider): Promise<CaptchaAiStatus> {
  await clearClaudeCaptchaApiKey();
  return getCaptchaAiStatus();
}

export async function solveCaptchaText(imageBytes: Buffer, mediaType = 'image/png'): Promise<CaptchaSolveResult | null> {
  appendAutomationLog('AU_CAPTCHA', 'Using anthropic as the CAPTCHA provider.');
  try {
    const text = await solveCaptchaTextWithClaude(imageBytes, mediaType);
    if (text) return { text, provider: 'anthropic', shouldSubmit: true };
    appendAutomationLog('AU_CAPTCHA', 'anthropic returned no usable CAPTCHA text.');
  } catch (error: any) {
    appendAutomationLog('AU_CAPTCHA', `anthropic provider failed: ${error?.message || error}`);
  }
  return null;
}
