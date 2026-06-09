/**
 * CAPTCHA API usage tracking + daily cap + first-use consent.
 *
 * Why: every AU Bank login uploads the captcha image to Anthropic with no
 * confirmation. A script-stuck-in-a-loop scenario could burn through the API
 * key budget; the user may not even realize images are being sent off-machine.
 *
 * This module:
 *   - Tracks calls + tokens per UTC date in a JSON file in the data dir
 *   - Enforces a hard daily cap (default 100 calls/day)
 *   - Requires explicit one-time consent before the FIRST captcha upload
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../db/connection';

const FILENAME = 'captcha-usage.json';
const DEFAULT_DAILY_CAP = 100;

export interface CaptchaUsageState {
  date: string;              // 'YYYY-MM-DD' (UTC)
  calls: number;             // calls made today
  inputTokens: number;       // sum across today
  outputTokens: number;
  cap: number;               // hard daily cap; calls past this are refused
  consented: boolean;        // user has acknowledged that images go to Anthropic
  consentedAt: string | null;
  totalCalls: number;        // lifetime
  totalInputTokens: number;
  totalOutputTokens: number;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function getPath(): string {
  return join(getDataDir(), FILENAME);
}

function blankState(): CaptchaUsageState {
  return {
    date: todayUtc(),
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cap: DEFAULT_DAILY_CAP,
    consented: false,
    consentedAt: null,
    totalCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };
}

function readRaw(): CaptchaUsageState {
  try {
    if (!existsSync(getPath())) return blankState();
    const parsed = JSON.parse(readFileSync(getPath(), 'utf8'));
    const base = blankState();
    return {
      ...base,
      ...parsed,
      // Validate numeric types
      calls: Number(parsed.calls) || 0,
      inputTokens: Number(parsed.inputTokens) || 0,
      outputTokens: Number(parsed.outputTokens) || 0,
      cap: Number(parsed.cap) || DEFAULT_DAILY_CAP,
      totalCalls: Number(parsed.totalCalls) || 0,
      totalInputTokens: Number(parsed.totalInputTokens) || 0,
      totalOutputTokens: Number(parsed.totalOutputTokens) || 0,
      consented: !!parsed.consented,
    };
  } catch {
    return blankState();
  }
}

function writeRaw(state: CaptchaUsageState): void {
  writeFileSync(getPath(), JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Return the current state with day-rollover applied (so callers always see
 * today's counts, even across midnight UTC).
 */
export function getCaptchaUsage(): CaptchaUsageState {
  const state = readRaw();
  const today = todayUtc();
  if (state.date !== today) {
    state.date = today;
    state.calls = 0;
    state.inputTokens = 0;
    state.outputTokens = 0;
    writeRaw(state);
  }
  return state;
}

/**
 * Set the daily cap. Pass 0 or negative to disable the cap (uncapped).
 */
export function setCaptchaCap(cap: number): CaptchaUsageState {
  const state = getCaptchaUsage();
  state.cap = Math.max(0, Math.floor(cap));
  writeRaw(state);
  return state;
}

/**
 * Record that the user has explicitly consented to sending CAPTCHA images
 * to Anthropic. Required before the first call goes through.
 */
export function setCaptchaConsent(consented: boolean): CaptchaUsageState {
  const state = getCaptchaUsage();
  state.consented = !!consented;
  state.consentedAt = consented ? new Date().toISOString() : null;
  writeRaw(state);
  return state;
}

/**
 * Reset today's counter (e.g. user wants to manually unblock after hitting
 * the cap and confirming they really mean to keep going).
 */
export function resetCaptchaTodayCounter(): CaptchaUsageState {
  const state = getCaptchaUsage();
  state.calls = 0;
  state.inputTokens = 0;
  state.outputTokens = 0;
  writeRaw(state);
  return state;
}

export interface UsageGateResult {
  ok: boolean;
  reason?: 'CONSENT_REQUIRED' | 'DAILY_CAP_REACHED';
  state: CaptchaUsageState;
}

/**
 * Check whether the next captcha API call is permitted. Returns the
 * canonical state for UI display alongside.
 */
export function canMakeCaptchaCall(): UsageGateResult {
  const state = getCaptchaUsage();
  if (!state.consented) {
    return { ok: false, reason: 'CONSENT_REQUIRED', state };
  }
  if (state.cap > 0 && state.calls >= state.cap) {
    return { ok: false, reason: 'DAILY_CAP_REACHED', state };
  }
  return { ok: true, state };
}

export interface ApiCallMetrics {
  inputTokens: number;
  outputTokens: number;
  ok: boolean;            // counts the call regardless, but records ok-vs-fail
}

/**
 * Persist a single API call. Called by the Anthropic adapter after a
 * request completes (success OR failure both count, since you pay for the
 * upload either way).
 */
export function recordCaptchaCall(metrics: ApiCallMetrics): CaptchaUsageState {
  const state = getCaptchaUsage();
  state.calls += 1;
  state.totalCalls += 1;
  state.inputTokens += Math.max(0, Math.floor(metrics.inputTokens || 0));
  state.outputTokens += Math.max(0, Math.floor(metrics.outputTokens || 0));
  state.totalInputTokens += Math.max(0, Math.floor(metrics.inputTokens || 0));
  state.totalOutputTokens += Math.max(0, Math.floor(metrics.outputTokens || 0));
  writeRaw(state);
  return state;
}
