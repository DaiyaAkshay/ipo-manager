/**
 * Field-level encryption tests — AES-256-GCM round-trip + tamper detection.
 *
 * Every credential in the vault (PAN, Aadhaar, bank password, TOTP secret)
 * is stored as a blob produced by encryptField(). If round-trip ever breaks,
 * the entire vault becomes unreadable in place. These tests catch that.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ipo-field-'));
  process.env.IPO_DATA_DIR = dataDir;
});

afterEach(() => {
  if (dataDir && existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
  delete process.env.IPO_DATA_DIR;
});

describe('crypto/field', () => {
  it('round-trips ASCII text', async () => {
    const { encryptField, decryptField } = await import('../../src/main/crypto/field');
    const plain = 'this is a secret';
    const blob = await encryptField(plain);
    const out = await decryptField(blob);
    expect(out).toBe(plain);
  });

  it('round-trips Unicode (₹, Devanagari, emoji)', async () => {
    const { encryptField, decryptField } = await import('../../src/main/crypto/field');
    const plain = 'अक्षय ₹ 12,345 🎉 — परिवार';
    const blob = await encryptField(plain);
    const out = await decryptField(blob);
    expect(out).toBe(plain);
  });

  it('treats empty string as null (no blob to store)', async () => {
    const { encryptField } = await import('../../src/main/crypto/field');
    expect(await encryptField('')).toBeNull();
    expect(await encryptField(null)).toBeNull();
    expect(await encryptField(undefined)).toBeNull();
  });

  it('round-trips a very long string (10K chars)', async () => {
    const { encryptField, decryptField } = await import('../../src/main/crypto/field');
    const long = 'x'.repeat(10_000);
    const out = await decryptField(await encryptField(long));
    expect(out).toBe(long);
  });

  it('produces a different ciphertext each call (random IV)', async () => {
    const { encryptField } = await import('../../src/main/crypto/field');
    const a = await encryptField('hello world');
    const b = await encryptField('hello world');
    expect(a.equals(b)).toBe(false);
  });

  it('refuses to decrypt a tampered ciphertext (GCM auth tag check)', async () => {
    const { encryptField, decryptField } = await import('../../src/main/crypto/field');
    const blob = await encryptField('hello world');
    // Flip a byte in the ciphertext region (after iv(12) + tag(16))
    blob[30] = blob[30] ^ 0x01;
    await expect(decryptField(blob)).rejects.toThrow();
  });

  it('decryptField returns null for null/empty input', async () => {
    const { decryptField } = await import('../../src/main/crypto/field');
    expect(await decryptField(null)).toBeNull();
    expect(await decryptField(undefined as any)).toBeNull();
  });

  it('lastN returns the last N alphanumeric chars', async () => {
    const { lastN } = await import('../../src/main/crypto/field');
    expect(lastN('ABCDE1234F', 4)).toBe('234F');
    expect(lastN('1234 5678 9012', 4)).toBe('9012');
    expect(lastN(null)).toBeNull();
    expect(lastN('')).toBeNull();
  });
});
