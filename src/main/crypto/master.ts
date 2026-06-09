/**
 * Master password key derivation using Argon2id.
 *
 * Argon2id is the winner of the Password Hashing Competition (2015) and the
 * current industry standard. It's memory-hard (defeats GPU brute-forcing) and
 * has time-cost parameters tunable for the target hardware.
 *
 * The salt is stored in plaintext in a small JSON sidecar file. This is fine —
 * salts are not secret. What protects you is the password strength + Argon2's
 * memory hardness.
 */

import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../db/connection';

interface VaultMeta {
  saltHex: string;
  argonOpts: {
    type: number;
    memoryCost: number;
    timeCost: number;
    parallelism: number;
  };
  createdAt: string;
}

const META_FILENAME = 'vault.meta.json';

const ARGON_OPTS = {
  type: argon2.argon2id,
  memoryCost: 256 * 1024,  // 256 MB. Heavy but only runs at unlock time.
  timeCost: 4,
  parallelism: 2,
  hashLength: 32           // 32 bytes = 256 bits, used as SQLCipher key
};

function getMetaPath(): string {
  return join(getDataDir(), META_FILENAME);
}

export function vaultInitialized(): boolean {
  return existsSync(getMetaPath());
}

export function getOrCreateMeta(): VaultMeta {
  const path = getMetaPath();
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf8')) as VaultMeta;
  }
  const meta: VaultMeta = {
    saltHex: randomBytes(16).toString('hex'),
    argonOpts: {
      type: ARGON_OPTS.type,
      memoryCost: ARGON_OPTS.memoryCost,
      timeCost: ARGON_OPTS.timeCost,
      parallelism: ARGON_OPTS.parallelism
    },
    createdAt: new Date().toISOString()
  };
  writeFileSync(path, JSON.stringify(meta, null, 2));
  return meta;
}

export async function deriveMasterKey(password: string): Promise<Buffer> {
  const meta = getOrCreateMeta();
  return deriveMasterKeyFromMeta(password, meta);
}

/**
 * Re-derive the master key using the salt + Argon2 params from a *specific*
 * vault.meta.json snapshot — used by the backup engine on restore so the
 * derived key matches the one that originally encrypted the snapshot
 * (the local machine may have its own salt that doesn't match).
 */
export async function deriveMasterKeyFromMeta(password: string, meta: VaultMeta): Promise<Buffer> {
  const salt = Buffer.from(meta.saltHex, 'hex');
  const argonOpts = meta.argonOpts || ARGON_OPTS;
  const key = await argon2.hash(password, {
    type: argonOpts.type ?? ARGON_OPTS.type,
    memoryCost: argonOpts.memoryCost ?? ARGON_OPTS.memoryCost,
    timeCost: argonOpts.timeCost ?? ARGON_OPTS.timeCost,
    parallelism: argonOpts.parallelism ?? ARGON_OPTS.parallelism,
    hashLength: ARGON_OPTS.hashLength,
    salt,
    raw: true,
  });
  return key as unknown as Buffer;
}

export function getVaultMeta(): VaultMeta | null {
  if (!existsSync(getMetaPath())) return null;
  try { return JSON.parse(readFileSync(getMetaPath(), 'utf8')) as VaultMeta; } catch { return null; }
}

export type { VaultMeta };

/**
 * Strength check (very basic — UI should also enforce this client-side).
 */
export function passwordStrengthIssues(pw: string): string[] {
  const issues: string[] = [];
  if (pw.length < 12) issues.push('Use at least 12 characters.');
  if (!/[a-z]/.test(pw)) issues.push('Add a lowercase letter.');
  if (!/[A-Z]/.test(pw)) issues.push('Add an uppercase letter.');
  if (!/[0-9]/.test(pw)) issues.push('Add a digit.');
  if (!/[^a-zA-Z0-9]/.test(pw)) issues.push('Add a symbol.');
  // Reject common weak patterns
  const lowered = pw.toLowerCase();
  ['password', 'qwerty', '123456', 'admin', 'abhi', 'letmein'].forEach(bad => {
    if (lowered.includes(bad)) issues.push(`Avoid common pattern: "${bad}".`);
  });
  return issues;
}
