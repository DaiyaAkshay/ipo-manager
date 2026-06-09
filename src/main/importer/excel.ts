/**
 * Importer for the existing Demat_Sheet.xlsx layout.
 *
 * Layout assumptions (validated against actual file structure):
 *   - One sheet per family (e.g., "CP Daiya", "Naval Solanki")
 *   - First column = field labels (Name, Aadhar No., PAN No., DOB, ...)
 *   - Each subsequent column = one person
 *   - Second occurrences of "Mobile No." and "Email ID" within a sheet are
 *     the demat contact (different from the bank/main contact)
 *
 * IMPORTANT: This runs locally on the user's machine. The decrypted Excel
 * never leaves the device. Once import succeeds, the user should shred the
 * source xlsx (the README explains how on Windows).
 *
 * Two-phase design (because better-sqlite3 transactions are sync but our
 * encryption is async):
 *   Phase 1 (async): parse + encrypt every value into in-memory records
 *   Phase 2 (sync transaction): insert everything atomically
 */

import * as XLSX from 'xlsx';
import { readFileSync } from 'node:fs';
import { getDb } from '../db/connection';
import { encryptField, lastN } from '../crypto/field';

const FIELD_MAP: Record<string, string> = {
  'name': 'name',
  'aadhar no.': 'aadhaar',
  'aadhaar no.': 'aadhaar',
  'pan no.': 'pan',
  'dob': 'dob',
  'mobile no.': 'mobile',
  'email id': 'email',
  'customer id': 'customer_id',
  'bank': 'bank_name',
  'bank name': 'bank_name',
  'bank provider': 'bank_name',
  'bank account no.': 'bank_account',
  'bank user id': 'bank_user_id',
  'bank password': 'bank_password',
  'ifsc code': 'ifsc',
  'debit card': 'debit_card',
  'debitcard pass': 'debit_pin',
  'digilocker pin': 'digilocker_pin',
  'security code': 'debit_cvv',
  'vaild thru': 'debit_valid_thru',
  'valid thru': 'debit_valid_thru',
  'demat provider': 'demat_provider',
  'demat account no.': 'demat_account',
  'demat user id': 'demat_user_id',
  'demat password': 'demat_password'
};

const BROKER_CODE_MAP: Record<string, string> = {
  'zerodha': 'ZERODHA',
  'dhan': 'DHAN',
  'angel': 'ANGEL', 'angel one': 'ANGEL', 'angel broking': 'ANGEL',
  'mirae': 'MIRAE', 'mstock': 'MIRAE', 'm.stock': 'MIRAE', 'mirae asset': 'MIRAE',
  'shoonya': 'SHOONYA',
  'fyers': 'FYERS', 'fyres': 'FYERS',
  'groww': 'GROWW'
};

const BANK_CODE_MAP: Record<string, string> = {
  'au': 'AU',
  'au small finance': 'AU',
  'yes': 'YES',
  'yes bank': 'YES',
  'sbi': 'SBI',
  'state bank': 'SBI',
  'state bank of india': 'SBI',
  'kotak': 'KOTAK',
  'kotak mahindra': 'KOTAK',
  'icici': 'ICICI',
  'icici bank': 'ICICI',
  'bank of baroda': 'BOB',
  'baroda': 'BOB',
  'bob': 'BOB',
  'punjab national': 'PNB',
  'pnb': 'PNB',
  'hdfc': 'HDFC',
  'hdfc bank': 'HDFC',
  'axis': 'AXIS',
  'axis bank': 'AXIS',
};

const BANK_CODE_BY_IFSC_PREFIX: Record<string, string> = {
  AUBL: 'AU',
  YESB: 'YES',
  SBIN: 'SBI',
  KKBK: 'KOTAK',
  ICIC: 'ICICI',
  BARB: 'BOB',
  PUNB: 'PNB',
  HDFC: 'HDFC',
  UTIB: 'AXIS',
};

function brokerCode(provider: string | null | undefined): string {
  if (!provider) return 'UNKNOWN';
  const k = provider.toLowerCase().trim();
  for (const [needle, code] of Object.entries(BROKER_CODE_MAP)) {
    if (k.includes(needle)) return code;
  }
  return 'UNKNOWN';
}

function bankCode(bankName: string | null | undefined, ifsc: string | null | undefined): string {
  const name = (bankName || '').toLowerCase().trim();
  for (const [needle, code] of Object.entries(BANK_CODE_MAP)) {
    if (name.includes(needle)) return code;
  }

  const prefix = (ifsc || '').trim().toUpperCase().slice(0, 4);
  return BANK_CODE_BY_IFSC_PREFIX[prefix] || 'AU';
}

function readPersonColumn(
  sheet: XLSX.WorkSheet,
  colIdx: number,
  fieldRows: { label: string; row: number }[]
): Record<string, string> {
  const data: Record<string, string> = {};
  const seenLabels = new Map<string, number>();

  for (const { label, row } of fieldRows) {
    const cellRef = XLSX.utils.encode_cell({ c: colIdx, r: row });
    const cell = sheet[cellRef];
    if (!cell) continue;
    const value = String(cell.v ?? '').trim();
    if (!value) continue;

    const labelKey = label.toLowerCase().trim();
    const occurrence = (seenLabels.get(labelKey) ?? 0) + 1;
    seenLabels.set(labelKey, occurrence);

    let canonical = FIELD_MAP[labelKey];
    if (!canonical) continue;

    if (occurrence === 2) {
      if (canonical === 'mobile') canonical = 'demat_mobile';
      if (canonical === 'email') canonical = 'demat_email';
    }
    data[canonical] = value;
  }
  return data;
}

interface PreparedBank {
  bankCode: string;
  accountNumberEnc: Buffer | null;
  ifsc: string | null;
  customerIdEnc: Buffer | null;
  userIdEnc: Buffer | null;
  passwordEnc: Buffer | null;
  debitCardEnc: Buffer | null;
  debitPinEnc: Buffer | null;
  debitCvvEnc: Buffer | null;
  debitValidThru: string | null;
  digilockerPinEnc: Buffer | null;
  accountLast4: string | null;
}

interface PreparedBroker {
  brokerCode: string;
  accountNumberEnc: Buffer | null;
  userIdEnc: Buffer | null;
  passwordEnc: Buffer | null;
  brokerMobile: string | null;
  brokerEmail: string | null;
}

interface PreparedMember {
  familyName: string;
  familyOrder: number;
  fullName: string;
  memberType: 'INDIVIDUAL' | 'HUF';
  dob: string | null;
  mobile: string | null;
  email: string | null;
  panEnc: Buffer | null;
  aadhaarEnc: Buffer | null;
  panLast4: string | null;
  aadhaarLast4: string | null;
  bank?: PreparedBank;
  broker?: PreparedBroker;
}

export async function importExcel(
  filePath: string
): Promise<{ familiesImported: number; membersImported: number }> {
  const buf = readFileSync(filePath);
  const wb = XLSX.read(buf, { type: 'buffer' });

  // ===== Phase 1: parse + encrypt everything (async, in memory) =====
  const prepared: PreparedMember[] = [];

  for (let order = 0; order < wb.SheetNames.length; order++) {
    const sheetName = wb.SheetNames[order];
    if (sheetName.toLowerCase().trim() === 'sheet1') continue;

    const sheet = wb.Sheets[sheetName];
    if (!sheet['!ref']) continue;
    const range = XLSX.utils.decode_range(sheet['!ref']);

    const fieldRows: { label: string; row: number }[] = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const cell = sheet[XLSX.utils.encode_cell({ c: 0, r })];
      if (cell && cell.v) {
        fieldRows.push({ label: String(cell.v), row: r });
      }
    }

    const nameRow = fieldRows.find(f => f.label.toLowerCase().trim() === 'name');
    if (!nameRow) continue;

    const familyName = sheetName.trim();

    for (let c = 1; c <= range.e.c; c++) {
      const data = readPersonColumn(sheet, c, fieldRows);
      let finalName = data.name;
      if (!finalName) {
        const headerCell = sheet[XLSX.utils.encode_cell({ c, r: 0 })];
        if (headerCell?.v) finalName = String(headerCell.v).trim();
      }
      if (!finalName) continue;

      const memberType: 'INDIVIDUAL' | 'HUF' = /\bHUF\b/i.test(finalName) ? 'HUF' : 'INDIVIDUAL';

      const member: PreparedMember = {
        familyName,
        familyOrder: order,
        fullName: finalName,
        memberType,
        dob: data.dob || null,
        mobile: data.mobile || null,
        email: data.email || null,
        panEnc: await encryptField(data.pan),
        aadhaarEnc: await encryptField(data.aadhaar),
        panLast4: lastN(data.pan, 4),
        aadhaarLast4: lastN(data.aadhaar, 4)
      };

      if (data.bank_account || data.bank_user_id || data.bank_password) {
        member.bank = {
          bankCode: bankCode(data.bank_name, data.ifsc),
          accountNumberEnc: await encryptField(data.bank_account),
          ifsc: data.ifsc || null,
          customerIdEnc: await encryptField(data.customer_id),
          userIdEnc: await encryptField(data.bank_user_id),
          passwordEnc: await encryptField(data.bank_password),
          debitCardEnc: await encryptField(data.debit_card),
          debitPinEnc: await encryptField(data.debit_pin),
          debitCvvEnc: await encryptField(data.debit_cvv),
          debitValidThru: data.debit_valid_thru || null,
          digilockerPinEnc: await encryptField(data.digilocker_pin),
          accountLast4: lastN(data.bank_account, 4)
        };
      }

      if (data.demat_account || data.demat_user_id || data.demat_password) {
        member.broker = {
          brokerCode: brokerCode(data.demat_provider),
          accountNumberEnc: await encryptField(data.demat_account),
          userIdEnc: await encryptField(data.demat_user_id),
          passwordEnc: await encryptField(data.demat_password),
          brokerMobile: data.demat_mobile || null,
          brokerEmail: data.demat_email || null
        };
      }

      prepared.push(member);
    }
  }

  // ===== Phase 2: write to DB in a single sync transaction =====
  const db = getDb();
  const insertFamily = db.prepare(
    'INSERT OR IGNORE INTO families (family_name, display_order) VALUES (?, ?)'
  );
  const findFamily = db.prepare('SELECT id FROM families WHERE family_name = ?');
  const insertMember = db.prepare(`
    INSERT INTO members
      (family_id, full_name, member_type, dob, mobile, email,
       pan_enc, aadhaar_enc, pan_last4, aadhaar_last4)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertBank = db.prepare(`
    INSERT INTO bank_accounts
      (member_id, bank_code, account_number_enc, ifsc, customer_id_enc,
       user_id_enc, password_enc, debit_card_enc, debit_card_pin_enc,
       debit_card_cvv_enc, debit_card_valid_thru, digilocker_pin_enc,
       account_last4)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertBroker = db.prepare(`
    INSERT INTO broker_accounts
      (member_id, broker_code, account_number_enc, user_id_enc, password_enc,
       broker_mobile, broker_email)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const familyNames = new Set<string>();

  const txn = db.transaction((members: PreparedMember[]) => {
    for (const m of members) {
      insertFamily.run(m.familyName, m.familyOrder);
      familyNames.add(m.familyName);
      const fam = findFamily.get(m.familyName) as { id: number };

      const memberId = insertMember.run(
        fam.id, m.fullName, m.memberType,
        m.dob, m.mobile, m.email,
        m.panEnc, m.aadhaarEnc,
        m.panLast4, m.aadhaarLast4
      ).lastInsertRowid as number;

      if (m.bank) {
        const b = m.bank;
        insertBank.run(
          memberId, b.bankCode, b.accountNumberEnc, b.ifsc,
          b.customerIdEnc, b.userIdEnc, b.passwordEnc,
          b.debitCardEnc, b.debitPinEnc, b.debitCvvEnc,
          b.debitValidThru, b.digilockerPinEnc, b.accountLast4
        );
      }

      if (m.broker) {
        const br = m.broker;
        insertBroker.run(
          memberId, br.brokerCode, br.accountNumberEnc,
          br.userIdEnc, br.passwordEnc,
          br.brokerMobile, br.brokerEmail
        );
      }
    }
  });

  txn(prepared);

  return {
    familiesImported: familyNames.size,
    membersImported: prepared.length
  };
}
