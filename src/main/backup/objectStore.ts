/**
 * Object storage used as a backup target (Cloudflare R2 today).
 *
 * Kept free of Electron / keytar / native imports so the replicator that uses
 * it can be unit-tested under plain Node with an in-memory store.
 *
 * R2 speaks the S3 API. Requests are signed with SigV4 by aws4fetch (tiny, no
 * AWS SDK). R2 is strongly consistent: once a PUT returns, every reader sees
 * the object — which is what lets the replicator treat "manifest.json exists"
 * as "this snapshot is complete".
 */

import { AwsClient } from 'aws4fetch';

export interface StoredObject {
  key: string;
  size: number;
  /** ms since epoch */
  lastModified: number;
}

export interface ObjectStore {
  /** Every object whose key starts with `prefix` (all pages). */
  list(prefix: string): Promise<StoredObject[]>;
  get(key: string): Promise<Buffer>;
  put(key: string, body: Buffer): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface R2Settings {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
/** Per-request timeouts — a stalled network must not hang lock/quit. */
const SMALL_REQUEST_TIMEOUT_MS = 20_000;
const TRANSFER_TIMEOUT_MS = 180_000;

/** Returns why the settings can't be used, or null when they look valid. */
export function validateR2Settings(s: Partial<R2Settings>): string | null {
  if (!s.accountId || !ACCOUNT_ID_RE.test(s.accountId)) {
    return 'Account ID must be the 32-character hex id shown in the Cloudflare dashboard.';
  }
  if (!s.bucket || !BUCKET_RE.test(s.bucket)) {
    return 'Bucket name must be 3–63 lowercase letters, digits or hyphens.';
  }
  if (!s.accessKeyId || s.accessKeyId.trim().length < 16) return 'Access Key ID is missing.';
  if (!s.secretAccessKey || s.secretAccessKey.trim().length < 16) return 'Secret Access Key is missing.';
  return null;
}

/** Prefix inside the bucket: lowercase path segments, no leading/trailing slash. */
export function normalizePrefix(prefix: string | null | undefined): string {
  const clean = (prefix || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!clean) return 'ipo-manager';
  if (!/^[A-Za-z0-9._\-/]+$/.test(clean) || clean.split('/').some(seg => !seg || seg === '.' || seg === '..')) {
    throw new Error('Folder inside the bucket may only use letters, digits, ".", "_", "-" and "/".');
  }
  return clean;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decodeXml(m[1]) : null;
}

/** Parse one ListObjectsV2 response page. Exported for tests. */
export function parseListObjectsV2(xml: string): { objects: StoredObject[]; nextToken: string | null } {
  const objects: StoredObject[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = tag(m[1], 'Key');
    if (key === null) continue;
    const lm = Date.parse(tag(m[1], 'LastModified') || '');
    objects.push({ key, size: Number(tag(m[1], 'Size') || 0), lastModified: Number.isFinite(lm) ? lm : 0 });
  }
  const truncated = tag(xml, 'IsTruncated') === 'true';
  return { objects, nextToken: truncated ? tag(xml, 'NextContinuationToken') : null };
}

async function describeFailure(res: Response, what: string): Promise<Error> {
  let code = '';
  try { code = tag(await res.text(), 'Code') || ''; } catch { /* */ }
  const hint = what.startsWith('Deleting') && res.status === 403
    ? ' — refused, most likely by the bucket lock (expected until it expires)'
    : res.status === 403
    ? ' — check the API token has Object Read & Write on this bucket'
    : res.status === 404 && code === 'NoSuchBucket' ? ' — bucket not found' : '';
  return new Error(`${what} failed (HTTP ${res.status}${code ? ` ${code}` : ''})${hint}`);
}

export interface R2StoreOptions {
  smallTimeoutMs?: number;
  transferTimeoutMs?: number;
  retries?: number;
}

export class R2Store implements ObjectStore {
  private readonly client: AwsClient;
  private readonly base: string;
  private readonly smallTimeout: number;
  private readonly transferTimeout: number;

  /** `opts` lets the unlock path use short timeouts so a bad network can't stall unlocking. */
  constructor(settings: R2Settings, opts: R2StoreOptions = {}) {
    const problem = validateR2Settings(settings);
    if (problem) throw new Error(problem);
    this.client = new AwsClient({
      accessKeyId: settings.accessKeyId.trim(),
      secretAccessKey: settings.secretAccessKey.trim(),
      service: 's3',
      region: 'auto',
      retries: opts.retries ?? 3,
    });
    this.smallTimeout = opts.smallTimeoutMs ?? SMALL_REQUEST_TIMEOUT_MS;
    this.transferTimeout = opts.transferTimeoutMs ?? TRANSFER_TIMEOUT_MS;
    this.base = `https://${settings.accountId}.r2.cloudflarestorage.com/${settings.bucket}`;
  }

  private url(key: string): string {
    return `${this.base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const out: StoredObject[] = [];
    let token: string | null = null;
    do {
      const q = new URLSearchParams({ 'list-type': '2', prefix });
      if (token) q.set('continuation-token', token);
      const res = await this.client.fetch(`${this.base}?${q.toString()}`, {
        signal: AbortSignal.timeout(this.smallTimeout),
      });
      if (!res.ok) throw await describeFailure(res, 'Listing the bucket');
      const page = parseListObjectsV2(await res.text());
      out.push(...page.objects);
      token = page.nextToken;
    } while (token);
    return out;
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.fetch(this.url(key), { signal: AbortSignal.timeout(this.transferTimeout) });
    if (!res.ok) throw await describeFailure(res, `Downloading ${key}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async put(key: string, body: Buffer): Promise<void> {
    const res = await this.client.fetch(this.url(key), {
      method: 'PUT',
      body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength) as unknown as BodyInit,
      headers: { 'content-type': 'application/octet-stream' },
      signal: AbortSignal.timeout(this.transferTimeout),
    });
    if (!res.ok) throw await describeFailure(res, `Uploading ${key}`);
  }

  async delete(key: string): Promise<void> {
    const res = await this.client.fetch(this.url(key), {
      method: 'DELETE',
      signal: AbortSignal.timeout(this.smallTimeout),
    });
    if (!res.ok && res.status !== 404) throw await describeFailure(res, `Deleting ${key}`);
  }
}

/**
 * Round-trip a small object to prove the credentials can list, write and read.
 * A refused delete is reported as a note, not a failure: an R2 bucket lock
 * (recommended — it stops anyone wiping recent backups) refuses deletes.
 */
export async function testObjectStore(store: ObjectStore, prefix: string): Promise<{ ok: true; note?: string } | { ok: false; error: string }> {
  // A fresh key each time: a bucket lock also refuses overwrites.
  const key = `${prefix}/.connection-test-${Date.now()}`;
  const body = Buffer.from(`ipo-manager connection test ${new Date().toISOString()}`);
  try {
    await store.list(`${prefix}/`);
    await store.put(key, body);
    const back = await store.get(key);
    if (!back.equals(body)) return { ok: false, error: 'Read-back did not match what was written.' };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
  try {
    await store.delete(key);
    return { ok: true };
  } catch {
    return { ok: true, note: 'Delete was refused (a bucket lock is active). Old snapshots will expire with the lock instead.' };
  }
}
