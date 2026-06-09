/**
 * Master password KDF tests — Argon2id round-trip + salt sensitivity.
 *
 * These guard the most critical security boundary in the app: if Argon2 ever
 * silently changes behaviour (different default params, different output
 * encoding), every encrypted vault becomes un-openable.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Each test gets a clean data dir via IPO_DATA_DIR. crypto/master.ts reads
// vault.meta.json from this dir via getDataDir().
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ipo-test-'));
  process.env.IPO_DATA_DIR = dataDir;
});

afterEach(() => {
  if (dataDir && existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
  delete process.env.IPO_DATA_DIR;
});

describe('crypto/master', () => {
  it('derives a 32-byte key for SQLCipher', async () => {
    const { deriveMasterKey } = await import('../../src/main/crypto/master');
    const key = await deriveMasterKey('CorrectHorseBatteryStaple-12345');
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it('produces the SAME key on repeated calls with the same password', async () => {
    const { deriveMasterKey } = await import('../../src/main/crypto/master');
    const a = await deriveMasterKey('CorrectHorseBatteryStaple-12345');
    const b = await deriveMasterKey('CorrectHorseBatteryStaple-12345');
    expect(a.equals(b)).toBe(true);
  });

  it('produces DIFFERENT keys for different passwords (same salt)', async () => {
    const { deriveMasterKey } = await import('../../src/main/crypto/master');
    const a = await deriveMasterKey('CorrectHorseBatteryStaple-12345');
    const b = await deriveMasterKey('CorrectHorseBatteryStaple-67890');
    expect(a.equals(b)).toBe(false);
  });

  it('produces DIFFERENT keys for the same password under different salts', async () => {
    // Simulate two machines: each has its own random salt.
    const { deriveMasterKey } = await import('../../src/main/crypto/master');
    const a = await deriveMasterKey('CorrectHorseBatteryStaple-12345');

    // Switch to a fresh dataDir → vault.meta.json with a new random salt
    // will be created on the next derive call (master.ts reads getDataDir()
    // dynamically, so this just works).
    const newDir = mkdtempSync(join(tmpdir(), 'ipo-test-'));
    process.env.IPO_DATA_DIR = newDir;
    const b = await deriveMasterKey('CorrectHorseBatteryStaple-12345');

    expect(a.equals(b)).toBe(false);
    rmSync(newDir, { recursive: true, force: true });
  });

  it('deriveMasterKeyFromMeta reproduces the original key when given the original meta', async () => {
    const { deriveMasterKey, deriveMasterKeyFromMeta, getVaultMeta } = await import('../../src/main/crypto/master');
    const originalKey = await deriveMasterKey('CorrectHorseBatteryStaple-12345');
    const meta = getVaultMeta();
    expect(meta).not.toBeNull();
    const restoredKey = await deriveMasterKeyFromMeta('CorrectHorseBatteryStaple-12345', meta!);
    expect(restoredKey.equals(originalKey)).toBe(true);
  });

  it('deriveMasterKeyFromMeta gives a DIFFERENT key with the wrong password', async () => {
    const { deriveMasterKey, deriveMasterKeyFromMeta, getVaultMeta } = await import('../../src/main/crypto/master');
    const realKey = await deriveMasterKey('CorrectHorseBatteryStaple-12345');
    const meta = getVaultMeta();
    const wrongKey = await deriveMasterKeyFromMeta('different-password', meta!);
    expect(wrongKey.equals(realKey)).toBe(false);
  });

  describe('passwordStrengthIssues', () => {
    it('flags short passwords', async () => {
      const { passwordStrengthIssues } = await import('../../src/main/crypto/master');
      const issues = passwordStrengthIssues('aA1$');
      expect(issues.some(i => /at least 12/.test(i))).toBe(true);
    });

    it('flags missing uppercase / digit / symbol', async () => {
      const { passwordStrengthIssues } = await import('../../src/main/crypto/master');
      expect(passwordStrengthIssues('alllowercaseword')).toContain('Add an uppercase letter.');
      expect(passwordStrengthIssues('NoDigitsHerexx')).toContain('Add a digit.');
      expect(passwordStrengthIssues('NoSymbol12345Z')).toContain('Add a symbol.');
    });

    it('rejects common weak words', async () => {
      const { passwordStrengthIssues } = await import('../../src/main/crypto/master');
      const issues = passwordStrengthIssues('Password123!XX');
      expect(issues.some(i => /password/.test(i))).toBe(true);
    });

    it('accepts a strong password (no issues)', async () => {
      const { passwordStrengthIssues } = await import('../../src/main/crypto/master');
      expect(passwordStrengthIssues('Tr0pic@l-Mango-Whirl')).toEqual([]);
    });
  });
});
