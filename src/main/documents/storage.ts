import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join, basename } from 'node:path';
import { homedir } from 'node:os';
import type Database from 'better-sqlite3-multiple-ciphers';
import { getDataDir } from '../db/connection';
import { getOrCreateFieldKey } from '../crypto/field';

export const MEMBER_DOCUMENT_TYPES = ['PAN', 'AADHAAR', 'BIRTH_CERTIFICATE', 'CHEQUE'] as const;
export type MemberDocumentType = typeof MEMBER_DOCUMENT_TYPES[number];

export interface MemberDocumentRecord {
  id: number;
  member_id: number;
  doc_type: MemberDocumentType;
  original_name: string | null;
  mime_type: string | null;
  file_size: number | null;
  file_uuid: string;
  sha256: string | null;
  uploaded_at: string;
}

export interface PickedMemberDocument {
  selectedPath: string;
  originalName: string;
  mimeType: string;
  fileSize: number;
}

export interface MemberDocumentSummary {
  docType: MemberDocumentType;
  hasFile: boolean;
  originalName: string | null;
  mimeType: string | null;
  fileSize: number | null;
  uploadedAt: string | null;
}

export type MemberDocumentSummaryMap = Record<MemberDocumentType, MemberDocumentSummary>;

export interface MemberDocumentDraft {
  selectedPath?: string | null;
  originalName?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  remove?: boolean;
}

const ALGO = 'aes-256-gcm';
const DEFAULT_MIME = 'application/octet-stream';
const EXTENSION_TO_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};
const MIME_TO_EXTENSION: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
};

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim();
}

function uniquePath(dir: string, fileName: string): string {
  const safeName = sanitizeFileName(fileName) || 'document';
  const ext = extname(safeName);
  const base = ext ? safeName.slice(0, -ext.length) : safeName;
  let candidate = join(dir, safeName);
  let counter = 1;
  while (existsSync(candidate)) {
    candidate = join(dir, `${base} (${counter})${ext}`);
    counter += 1;
  }
  return candidate;
}

function getUserDownloadsDir(): string {
  if (process.env.IPO_REPORTS_DIR) return ensureDir(process.env.IPO_REPORTS_DIR);

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    const downloadsDir = app?.getPath?.('downloads');
    if (downloadsDir) return ensureDir(downloadsDir);
  } catch {
    // Fall back to the conventional Downloads folder.
  }

  return ensureDir(join(homedir(), 'Downloads'));
}

function getDocumentsBaseDir(): string {
  return ensureDir(join(getDataDir(), 'documents'));
}

export function getEncryptedDocumentPath(fileUuid: string): string {
  return join(getDocumentsBaseDir(), `${fileUuid}.enc`);
}

function getDownloadDocumentDir(_memberName?: string | null): string {
  return getUserDownloadsDir();
}

function buildDefaultDownloadName(docType: MemberDocumentType, mimeType: string | null): string {
  const ext = MIME_TO_EXTENSION[mimeType || ''] || '.pdf';
  const label = docType === 'BIRTH_CERTIFICATE'
    ? 'birth-certificate'
    : docType.toLowerCase();
  return `${label}${ext}`;
}

async function encryptBuffer(plain: Buffer): Promise<Buffer> {
  const key = await getOrCreateFieldKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

async function decryptBuffer(blob: Buffer): Promise<Buffer> {
  if (!blob || blob.length < 28) throw new Error('Stored document is invalid');
  const key = await getOrCreateFieldKey();
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const enc = blob.subarray(28);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

function normalizePickedDocument(picked: PickedMemberDocument): PickedMemberDocument {
  const originalName = sanitizeFileName(picked.originalName || basename(picked.selectedPath));
  const ext = extname(originalName || picked.selectedPath).toLowerCase();
  const mimeType = EXTENSION_TO_MIME[ext] || picked.mimeType || DEFAULT_MIME;
  if (!EXTENSION_TO_MIME[ext]) {
    throw new Error('Only PDF and JPEG files are supported');
  }
  return {
    selectedPath: picked.selectedPath,
    originalName,
    mimeType,
    fileSize: picked.fileSize,
  };
}

function toSummary(docType: MemberDocumentType, row?: MemberDocumentRecord): MemberDocumentSummary {
  return {
    docType,
    hasFile: !!row,
    originalName: row?.original_name || null,
    mimeType: row?.mime_type || null,
    fileSize: row?.file_size ?? null,
    uploadedAt: row?.uploaded_at || null,
  };
}

export function emptyDocumentSummaryMap(): MemberDocumentSummaryMap {
  return MEMBER_DOCUMENT_TYPES.reduce((acc, docType) => {
    acc[docType] = toSummary(docType);
    return acc;
  }, {} as MemberDocumentSummaryMap);
}

export function getMemberDocumentRecords(db: Database.Database, memberId: number): MemberDocumentRecord[] {
  return db.prepare(`
    SELECT id, member_id, doc_type, original_name, mime_type, file_size, file_uuid, sha256, uploaded_at
    FROM documents
    WHERE member_id = ?
    ORDER BY uploaded_at DESC, id DESC
  `).all(memberId) as MemberDocumentRecord[];
}

export function getMemberDocumentSummaryMap(db: Database.Database, memberId: number): MemberDocumentSummaryMap {
  const summary = emptyDocumentSummaryMap();
  for (const row of getMemberDocumentRecords(db, memberId)) {
    if (!MEMBER_DOCUMENT_TYPES.includes(row.doc_type)) continue;
    if (!summary[row.doc_type].hasFile) {
      summary[row.doc_type] = toSummary(row.doc_type, row);
    }
  }
  return summary;
}

function getMemberDocumentRecord(db: Database.Database, memberId: number, docType: MemberDocumentType): MemberDocumentRecord | null {
  const row = db.prepare(`
    SELECT id, member_id, doc_type, original_name, mime_type, file_size, file_uuid, sha256, uploaded_at
    FROM documents
    WHERE member_id = ? AND doc_type = ?
    ORDER BY uploaded_at DESC, id DESC
    LIMIT 1
  `).get(memberId, docType) as MemberDocumentRecord | undefined;
  return row || null;
}

function deleteDocumentFile(fileUuid: string | null | undefined): void {
  if (!fileUuid) return;
  const path = getEncryptedDocumentPath(fileUuid);
  if (existsSync(path)) unlinkSync(path);
}

function deleteDocumentRows(db: Database.Database, memberId: number, docType: MemberDocumentType): MemberDocumentRecord[] {
  const rows = db.prepare(`
    SELECT id, member_id, doc_type, original_name, mime_type, file_size, file_uuid, sha256, uploaded_at
    FROM documents
    WHERE member_id = ? AND doc_type = ?
    ORDER BY uploaded_at DESC, id DESC
  `).all(memberId, docType) as MemberDocumentRecord[];
  db.prepare('DELETE FROM documents WHERE member_id = ? AND doc_type = ?').run(memberId, docType);
  return rows;
}

export function removeMemberDocument(db: Database.Database, memberId: number, docType: MemberDocumentType): void {
  const removedRows = deleteDocumentRows(db, memberId, docType);
  for (const row of removedRows) deleteDocumentFile(row.file_uuid);
}

export function removeAllMemberDocuments(db: Database.Database, memberId: number): void {
  const rows = getMemberDocumentRecords(db, memberId);
  db.prepare('DELETE FROM documents WHERE member_id = ?').run(memberId);
  for (const row of rows) deleteDocumentFile(row.file_uuid);
}

export async function saveMemberDocument(
  db: Database.Database,
  memberId: number,
  docType: MemberDocumentType,
  picked: PickedMemberDocument,
): Promise<void> {
  const normalized = normalizePickedDocument(picked);
  const plain = readFileSync(normalized.selectedPath);
  const encrypted = await encryptBuffer(plain);
  const fileUuid = randomUUID();
  const encryptedPath = getEncryptedDocumentPath(fileUuid);
  const sha256 = createHash('sha256').update(plain).digest('hex');
  writeFileSync(encryptedPath, encrypted);

  try {
    const removedRows = deleteDocumentRows(db, memberId, docType);
    db.prepare(`
      INSERT INTO documents (member_id, doc_type, original_name, mime_type, file_size, file_uuid, sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      memberId,
      docType,
      normalized.originalName,
      normalized.mimeType,
      normalized.fileSize || plain.length,
      fileUuid,
      sha256,
    );
    for (const row of removedRows) deleteDocumentFile(row.file_uuid);
  } catch (error) {
    deleteDocumentFile(fileUuid);
    throw error;
  }
}

export async function applyMemberDocumentDrafts(
  db: Database.Database,
  memberId: number,
  drafts: Partial<Record<MemberDocumentType, MemberDocumentDraft>> | null | undefined,
): Promise<void> {
  if (!drafts) return;
  for (const docType of MEMBER_DOCUMENT_TYPES) {
    const draft = drafts[docType];
    if (!draft) continue;
    if (draft.remove) {
      removeMemberDocument(db, memberId, docType);
      continue;
    }
    if (draft.selectedPath) {
      await saveMemberDocument(db, memberId, docType, {
        selectedPath: draft.selectedPath,
        originalName: draft.originalName || basename(draft.selectedPath),
        mimeType: draft.mimeType || DEFAULT_MIME,
        fileSize: draft.fileSize || 0,
      });
    }
  }
}

export async function downloadMemberDocumentToDownloads(
  db: Database.Database,
  memberId: number,
  docType: MemberDocumentType,
  memberName?: string | null,
): Promise<{ filePath: string; fileName: string }> {
  const row = getMemberDocumentRecord(db, memberId, docType);
  if (!row) throw new Error(`${docType.replace(/_/g, ' ')} document is not uploaded`);

  const encryptedPath = getEncryptedDocumentPath(row.file_uuid);
  if (!existsSync(encryptedPath)) throw new Error('Stored document file is missing');

  const plain = await decryptBuffer(readFileSync(encryptedPath));
  const downloadDir = getDownloadDocumentDir(memberName);
  const fileName = row.original_name || buildDefaultDownloadName(docType, row.mime_type);
  const targetPath = uniquePath(downloadDir, fileName);
  writeFileSync(targetPath, plain);
  return { filePath: targetPath, fileName: basename(targetPath) };
}
