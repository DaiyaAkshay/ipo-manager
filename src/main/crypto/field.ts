/**
 * Field-level encryption for the most sensitive values (passwords, account
 * numbers, PAN, Aadhaar). Uses AES-256-GCM.
 *
 * Why a separate layer on top of SQLCipher?
 * - SQLCipher protects the database file at rest. If someone runs the app
 *   while you're logged in, they see plaintext.
 * - Field-level encryption with a key in the OS keychain (Windows Credential
 *   Manager) means even a database dump + master password is insufficient
 *   to read credentials without OS-level access.
 *
 * Format of stored ciphertext (BLOB):
 *   [12 bytes IV] [16 bytes auth tag] [N bytes ciphertext]
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import keytar from 'keytar';

const SERVICE = 'ipo-manager';
const ACCOUNT = 'field-encryption-key-v1';
const ALGO = 'aes-256-gcm';

let cachedKey: Buffer | null = null;

export async function getOrCreateFieldKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  let hex = await keytar.getPassword(SERVICE, ACCOUNT);
  if (!hex) {
    hex = randomBytes(32).toString('hex');
    await keytar.setPassword(SERVICE, ACCOUNT, hex);
  }
  cachedKey = Buffer.from(hex, 'hex');
  return cachedKey;
}

export async function encryptField(plain: string | null | undefined): Promise<Buffer | null> {
  if (plain === null || plain === undefined || plain === '') return null;
  const key = await getOrCreateFieldKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

export async function decryptField(blob: Buffer | null): Promise<string | null> {
  if (!blob || blob.length < 28) return null;
  const key = await getOrCreateFieldKey();
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const enc = blob.subarray(28);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/**
 * Returns the last N characters of plaintext for display ("****1234" style).
 * Safe to store alongside the encrypted value.
 */
export function lastN(plain: string | null | undefined, n = 4): string | null {
  if (!plain) return null;
  const s = String(plain).replace(/\s+/g, '');
  return s.length <= n ? s : s.slice(-n);
}

export function clearKeyCache(): void {
  cachedKey = null;
}
