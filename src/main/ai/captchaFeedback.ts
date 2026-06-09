import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../db/connection';
import { appendAutomationLog } from '../logging';
import type { CaptchaAiProvider } from './captcha';

type CaptchaOutcome = 'success' | 'failure';
type CaptchaInputSource = 'auto' | 'manual' | 'alternate';

interface CaptchaFeedbackEntry {
  bankCode: string;
  provider: CaptchaAiProvider;
  imageHash: string;
  primaryGuess: string;
  confidence?: number;
  alternates?: Array<{ text: string; confidence?: number }>;
  finalText?: string;
  outcome: CaptchaOutcome;
  inputSource: CaptchaInputSource;
  createdAt: string;
}

interface CaptchaFeedbackStore {
  version: 1;
  entries: CaptchaFeedbackEntry[];
  substitutions: Record<string, Record<string, number>>;
}

export interface CaptchaFeedbackRecordInput {
  bankCode: string;
  provider: CaptchaAiProvider;
  imageHash: string;
  primaryGuess: string;
  confidence?: number;
  alternates?: Array<{ text: string; confidence?: number }>;
  finalText?: string;
  outcome: CaptchaOutcome;
  inputSource: CaptchaInputSource;
}

function getFeedbackPath(): string {
  const dir = join(getDataDir(), 'learning');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'captcha-feedback.json');
}

function readStore(): CaptchaFeedbackStore {
  try {
    const path = getFeedbackPath();
    if (!existsSync(path)) return { version: 1, entries: [], substitutions: {} };
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return {
      version: 1,
      entries: Array.isArray(parsed?.entries) ? parsed.entries : [],
      substitutions: parsed?.substitutions && typeof parsed.substitutions === 'object' ? parsed.substitutions : {},
    };
  } catch {
    return { version: 1, entries: [], substitutions: {} };
  }
}

function writeStore(store: CaptchaFeedbackStore): void {
  try {
    writeFileSync(getFeedbackPath(), JSON.stringify(store, null, 2), 'utf8');
  } catch (error: any) {
    appendAutomationLog('AU_CAPTCHA', `Failed to write CAPTCHA feedback store: ${error?.message || error}`);
  }
}

function normalizeFeedbackText(value: string | undefined): string | null {
  const cleaned = (value || '').replace(/[^A-Za-z0-9]/g, '').trim();
  return cleaned.length >= 5 && cleaned.length <= 8 ? cleaned : null;
}

function learnSubstitutions(store: CaptchaFeedbackStore, guess: string, finalText: string): void {
  if (guess.length !== finalText.length) return;
  let differences = 0;
  for (let i = 0; i < guess.length; i += 1) {
    if (guess[i] !== finalText[i]) differences += 1;
  }
  // Guess and final must be similar (>= half the characters match) — otherwise
  // they're two unrelated CAPTCHAs (e.g. user refreshed and typed a new one)
  // and the per-position substitutions would be garbage.
  if (differences > Math.floor(guess.length / 2)) return;
  for (let i = 0; i < guess.length; i += 1) {
    const from = guess[i];
    const to = finalText[i];
    if (!from || !to || from === to) continue;
    store.substitutions[from] = store.substitutions[from] || {};
    store.substitutions[from][to] = (store.substitutions[from][to] || 0) + 1;
  }
}

export function recordCaptchaFeedback(input: CaptchaFeedbackRecordInput): void {
  const primaryGuess = normalizeFeedbackText(input.primaryGuess);
  if (!primaryGuess) return;
  const finalText = normalizeFeedbackText(input.finalText);
  const store = readStore();
  const entry: CaptchaFeedbackEntry = {
    ...input,
    primaryGuess,
    finalText: finalText || undefined,
    createdAt: new Date().toISOString(),
  };
  store.entries.unshift(entry);
  store.entries = store.entries.slice(0, 500);

  if (input.outcome === 'success' && finalText) {
    learnSubstitutions(store, primaryGuess, finalText);
    for (const alternate of input.alternates || []) {
      const alternateText = normalizeFeedbackText(alternate.text);
      if (alternateText) learnSubstitutions(store, alternateText, finalText);
    }
  }

  writeStore(store);
  appendAutomationLog(
    'AU_CAPTCHA',
    `Recorded CAPTCHA feedback: outcome=${input.outcome} source=${input.inputSource} primary="${primaryGuess}" final="${finalText || ''}".`,
  );
}

export function applyCaptchaFeedbackCorrections(text: string): { text: string; evidence: number } | null {
  const cleaned = normalizeFeedbackText(text);
  if (!cleaned) return null;
  const store = readStore();
  const chars = cleaned.split('');
  let evidence = 0;
  let changed = false;

  for (let i = 0; i < chars.length; i += 1) {
    const from = chars[i];
    const options = store.substitutions[from];
    if (!options) continue;
    const best = Object.entries(options).sort((a, b) => b[1] - a[1])[0];
    if (!best || best[1] < 2) continue;
    chars[i] = best[0];
    evidence += best[1];
    changed = true;
  }

  const corrected = chars.join('');
  if (!changed || corrected === cleaned) return null;
  return { text: corrected, evidence };
}
