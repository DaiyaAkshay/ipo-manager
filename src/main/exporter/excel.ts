import * as XLSX from 'xlsx';
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDb } from '../db/connection';
import { decryptField } from '../crypto/field';

interface ExportSummary {
  familiesExported: number;
  membersExported: number;
  banksExported: number;
  brokersExported: number;
}

async function decryptSafe(value: unknown): Promise<string | null> {
  return decryptField(value as Buffer | null).catch(() => null);
}

function appendSheet(workbook: XLSX.WorkBook, name: string, rows: Record<string, unknown>[]): void {
  const safeName = name.slice(0, 31);
  const sheet = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, safeName);
}

function runPowerShellEncoded(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encoded,
    ], { windowsHide: true });

    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
    });
  });
}

async function passwordProtectWorkbook(sourcePath: string, finalPath: string, password: string): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('Password-protected Excel export is currently available only on Windows.');
  }

  const payload = Buffer.from(JSON.stringify({ sourcePath, finalPath, password }), 'utf8').toString('base64');
  const script = `
$ErrorActionPreference = 'Stop'
$payload = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$excel = $null
$workbook = $null
try {
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $workbook = $excel.Workbooks.Open($payload.sourcePath)
  if (Test-Path -LiteralPath $payload.finalPath) {
    Remove-Item -LiteralPath $payload.finalPath -Force
  }
  $workbook.SaveAs($payload.finalPath, 51, $payload.password)
} finally {
  if ($workbook -ne $null) { $workbook.Close($false) | Out-Null }
  if ($excel -ne $null) { $excel.Quit() | Out-Null }
  [System.GC]::Collect()
  [System.GC]::WaitForPendingFinalizers()
}
`;
  await runPowerShellEncoded(script);
}

export async function exportExcel(filePath: string, password: string): Promise<ExportSummary> {
  if (!password) throw new Error('Master password is required for locked Excel export.');
  const db = getDb();

  const families = db.prepare(`
    SELECT id, family_name, display_order, notes, created_at, updated_at
    FROM families
    ORDER BY display_order, family_name
  `).all() as any[];

  const membersRaw = db.prepare(`
    SELECT m.*, f.family_name
    FROM members m
    JOIN families f ON f.id = m.family_id
    ORDER BY f.display_order, m.display_order, m.full_name
  `).all() as any[];

  const banksRaw = db.prepare(`
    SELECT b.*, m.full_name, f.family_name
    FROM bank_accounts b
    JOIN members m ON m.id = b.member_id
    JOIN families f ON f.id = m.family_id
    ORDER BY f.display_order, m.display_order, b.bank_code
  `).all() as any[];

  const brokersRaw = db.prepare(`
    SELECT b.*, m.full_name, f.family_name
    FROM broker_accounts b
    JOIN members m ON m.id = b.member_id
    JOIN families f ON f.id = m.family_id
    ORDER BY f.display_order, m.display_order, b.broker_code
  `).all() as any[];

  const members = await Promise.all(membersRaw.map(async (m) => ({
    family_name: m.family_name,
    full_name: m.full_name,
    member_type: m.member_type,
    dob: m.dob,
    mobile: m.mobile,
    email: m.email,
    pan: await decryptSafe(m.pan_enc),
    aadhaar: await decryptSafe(m.aadhaar_enc),
    notes: m.notes,
    created_at: m.created_at,
    updated_at: m.updated_at,
  })));

  const banks = await Promise.all(banksRaw.map(async (b) => ({
    family_name: b.family_name,
    member_name: b.full_name,
    bank_code: b.bank_code,
    account_number: await decryptSafe(b.account_number_enc),
    account_last4: b.account_last4,
    ifsc: b.ifsc,
    customer_id: await decryptSafe(b.customer_id_enc),
    user_id: await decryptSafe(b.user_id_enc),
    password: await decryptSafe(b.password_enc),
    debit_card: await decryptSafe(b.debit_card_enc),
    debit_card_pin: await decryptSafe(b.debit_card_pin_enc),
    debit_card_cvv: await decryptSafe(b.debit_card_cvv_enc),
    debit_card_valid_thru: b.debit_card_valid_thru,
    digilocker_pin: await decryptSafe(b.digilocker_pin_enc),
    balance: b.balance,
    balance_fetched_at: b.balance_fetched_at,
    notes: b.notes,
    created_at: b.created_at,
    updated_at: b.updated_at,
  })));

  const brokers = await Promise.all(brokersRaw.map(async (b) => ({
    family_name: b.family_name,
    member_name: b.full_name,
    broker_code: b.broker_code,
    client_id: await decryptSafe(b.client_id_enc),
    account_number: await decryptSafe(b.account_number_enc),
    user_id: await decryptSafe(b.user_id_enc),
    password: await decryptSafe(b.password_enc),
    totp_secret: await decryptSafe(b.totp_secret_enc),
    broker_mobile: b.broker_mobile,
    broker_email: b.broker_email,
    notes: b.notes,
    created_at: b.created_at,
    updated_at: b.updated_at,
  })));

  const workbook = XLSX.utils.book_new();

  appendSheet(workbook, 'Families', families.map((f) => ({
    family_name: f.family_name,
    display_order: f.display_order,
    notes: f.notes,
    created_at: f.created_at,
    updated_at: f.updated_at,
  })));
  appendSheet(workbook, 'Members', members);
  appendSheet(workbook, 'BankAccounts', banks);
  appendSheet(workbook, 'BrokerAccounts', brokers);

  const tempPath = join(dirname(filePath), `.~ipo-export-${Date.now()}.xlsx`);
  try {
    XLSX.writeFile(workbook, tempPath, { compression: true });
    await passwordProtectWorkbook(tempPath, filePath, password);
  } finally {
    if (existsSync(tempPath)) {
      try { unlinkSync(tempPath); } catch {}
    }
  }

  return {
    familiesExported: families.length,
    membersExported: members.length,
    banksExported: banks.length,
    brokersExported: brokers.length,
  };
}
