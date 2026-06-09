import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { TOTP } from 'totp-generator';
import auLogo from '../assets/logos/au.png';
import yesLogo from '../assets/logos/yes.png';
import sbiLogo from '../assets/logos/sbi.png';
import kotakLogo from '../assets/logos/kotak.png';
import iciciLogo from '../assets/logos/icici.png';
import bobLogo from '../assets/logos/bob.png';
import pnbLogo from '../assets/logos/pnb.png';
import hdfcLogo from '../assets/logos/hdfc.svg';
import axisLogo from '../assets/logos/axis.svg';
import zerodhaLogo from '../assets/logos/zerodha.png';
import dhanLogo from '../assets/logos/dhan.png';
import angelLogo from '../assets/logos/angel.png';
import miraeLogo from '../assets/logos/mirae.png';
import shoonyaLogo from '../assets/logos/shoonya.png';
import fyersLogo from '../assets/logos/fyers.png';
import growwLogo from '../assets/logos/groww.png';

// â"€â"€ Types â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

interface Family { id: number; family_name: string; notes?: string; member_count: number; display_order: number; min_balance: number; }
interface BankRow {
  id: number;
  bank_code: string;
  account_last4: string | null;
  balance: string | null;
  balance_fetched_at: string | null;
  has_password: number;
}
interface BrokerRow {
  id: number;
  broker_code: string;
  has_password: number;
  balance: string | null;
  balance_fetched_at: string | null;
  portfolio_value?: number | null;
  portfolio_fetched_at?: string | null;
}
type MemberDocumentType = 'PAN' | 'AADHAAR' | 'BIRTH_CERTIFICATE' | 'CHEQUE';
interface MemberDocumentSummary {
  docType: MemberDocumentType;
  hasFile: boolean;
  originalName: string | null;
  mimeType: string | null;
  fileSize: number | null;
  uploadedAt: string | null;
}
type MemberDocumentSummaryMap = Record<MemberDocumentType, MemberDocumentSummary>;
interface MemberDocumentDraft extends MemberDocumentSummary {
  selectedPath: string | null;
  remove: boolean;
  existingHasFile: boolean;
  existingOriginalName: string | null;
  existingMimeType: string | null;
  existingFileSize: number | null;
  existingUploadedAt: string | null;
}
type MemberDocumentDraftMap = Record<MemberDocumentType, MemberDocumentDraft>;
interface Member {
  id: number;
  full_name: string;
  member_type: 'INDIVIDUAL' | 'HUF';
  mobile?: string | null;
  email?: string | null;
  pan: string | null;
  aadhaar: string | null;
  pan_last4: string | null;
  aadhaar_last4: string | null;
  documents: MemberDocumentSummaryMap;
  banks: BankRow[];
  brokers: BrokerRow[];
}
interface Toast { id: number; kind: 'success' | 'error' | 'info'; text: string; }
interface GmailStatus {
  state: 'connected' | 'not_connected' | 'needs_reauth' | 'missing_credentials' | 'error';
  configured: boolean;
  hasRefreshToken: boolean;
  label: string;
  detail?: string;
}
type CaptchaAiProvider = 'anthropic';
interface CaptchaProviderStatus {
  provider: CaptchaAiProvider;
  displayName: string;
  state: 'connected' | 'not_connected' | 'error';
  configured: boolean;
  label: string;
  detail?: string;
  model: string;
  source: 'environment' | 'keychain' | null;
}
interface CaptchaAiStatus {
  state: 'connected' | 'not_connected' | 'error';
  configured: boolean;
  label: string;
  detail?: string;
  activeProvider: CaptchaAiProvider;
  configuredProviders: CaptchaAiProvider[];
  providers: Record<CaptchaAiProvider, CaptchaProviderStatus>;
}
interface BrokerPortfolioSummary {
  sheet_name: string;
  asset_scope: 'EQUITY' | 'MUTUAL_FUNDS' | 'COMBINED';
  client_id: string | null;
  statement_title: string | null;
  as_of_date: string | null;
  invested_value: number | null;
  present_value: number | null;
  unrealized_pnl: number | null;
  unrealized_pnl_pct: number | null;
}
interface BrokerPortfolioHolding {
  sheet_name: string;
  asset_scope: 'EQUITY' | 'MUTUAL_FUNDS' | 'COMBINED';
  is_combined_view: number;
  row_order: number;
  symbol: string;
  isin: string | null;
  sector: string | null;
  instrument_type: string | null;
  quantity_available: number | null;
  quantity_discrepant: number | null;
  quantity_long_term: number | null;
  quantity_pledged_margin: number | null;
  quantity_pledged_loan: number | null;
  average_price: number | null;
  previous_closing_price: number | null;
  unrealized_pnl: number | null;
  unrealized_pnl_pct: number | null;
}
interface BrokerPortfolioReport {
  reportId: number;
  brokerCode: string;
  reportKind: string;
  asOfDate: string | null;
  fileName: string | null;
  filePath: string;
  downloadedAt: string;
  summaries: BrokerPortfolioSummary[];
  holdings: BrokerPortfolioHolding[];
}

interface IpoBidHistoryEntry {
  id: number;
  bankCode: string;
  brokerCode: string | null;
  issueName: string;
  bidType: 'CUTOFF' | 'LIMIT';
  quantity: number;
  lotSize: number | null;
  enteredPrice: number | null;
  effectivePrice: number;
  blockedAmount: number;
  dematAccountLast4: string | null;
  panLast4: string | null;
  readyToSubmit: boolean;
  status: string;
  bankReference: string | null;
  pageUrl: string | null;
  warnings: string[];
  preparedAt: string | null;
  submittedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AuBidDraftOptions {
  member: { id: number; fullName: string; panLast4: string | null; };
  banks: { id: number; bank_code: string; }[];
  history: IpoBidHistoryEntry[];
}

interface IpoCatalogIssue {
  issueName: string;
  symbol: string | null;
  exchangePlatform: string | null;
  issueType: string | null;
  status: 'LIVE' | 'FORTHCOMING' | 'UNKNOWN';
  openDate: string | null;
  closeDate: string | null;
  priceMin: number | null;
  priceMax: number | null;
  lotSize: number | null;
  minimumBidQuantity: number | null;
  faceValue: number | null;
  detailUrl: string | null;
  fetchedAt?: string | null;
}

interface AuBidForm {
  bankId: number | null;
  issueName: string;
  lots: string;
  lotSize: string;
  bidType: 'CUTOFF' | 'LIMIT';
  bidPrice: string;
}

interface PreparedAuBid {
  id: number;
  memberId: number;
  memberName: string;
  bankId: number;
  bankCode: string;
  brokerId: number | null;
  brokerCode: string | null;
  issueName: string;
  bidType: 'CUTOFF' | 'LIMIT';
  quantity: number;
  lotSize: number | null;
  enteredPrice: number | null;
  effectivePrice: number;
  blockedAmount: number;
  dematAccountLast4: string | null;
  panLast4: string | null;
  readyToSubmit: boolean;
  warnings: string[];
  pageUrl: string;
  detectedIssueName: string | null;
  detectedDemat: string | null;
  detectedAmount: string | null;
  preparedAt: string;
}

const BANKS = ['AU', 'YES', 'SBI', 'KOTAK', 'ICICI', 'BOB', 'PNB', 'HDFC', 'AXIS'];
const BROKERS = ['ZERODHA', 'DHAN', 'ANGEL', 'MIRAE', 'SHOONYA', 'FYERS', 'GROWW'];
const MEMBER_DOCUMENT_TYPES: MemberDocumentType[] = ['PAN', 'AADHAAR', 'BIRTH_CERTIFICATE', 'CHEQUE'];

const BANK_THUMB: Record<string, string> = {
  AU: 'AU',
  YES: 'YB',
  SBI: 'SB',
  KOTAK: 'KT',
  ICICI: 'IC',
  BOB: 'BO',
  PNB: 'PN',
  HDFC: 'HD',
  AXIS: 'AX',
};

const BROKER_THUMB: Record<string, string> = {
  ZERODHA: 'ZE',
  DHAN: 'DH',
  ANGEL: 'AN',
  MIRAE: 'MS',
  SHOONYA: 'SH',
  FYERS: 'FY',
  FYRES: 'FY',
  GROWW: 'GW',
};

const BANK_LOGO_SRC: Record<string, string> = {
  AU: auLogo,
  YES: yesLogo,
  SBI: sbiLogo,
  KOTAK: kotakLogo,
  ICICI: iciciLogo,
  BOB: bobLogo,
  PNB: pnbLogo,
  HDFC: hdfcLogo,
  AXIS: axisLogo,
};

const BROKER_LOGO_SRC: Record<string, string> = {
  ZERODHA: zerodhaLogo,
  DHAN: dhanLogo,
  ANGEL: angelLogo,
  MIRAE: miraeLogo,
  SHOONYA: shoonyaLogo,
  FYERS: fyersLogo,
  FYRES: fyersLogo,
  GROWW: growwLogo,
};

const blankBank   = (code: string) => ({ bank_code: code, user_id: '', password: '', account_number: '', customer_id: '', ifsc: '' });
const blankBroker = (code: string) => ({ broker_code: code, user_id: '', password: '', client_id: '', totp_secret: '', broker_mobile: '', broker_email: '' });

function documentLabel(docType: MemberDocumentType): string {
  switch (docType) {
    case 'PAN': return 'PAN';
    case 'AADHAAR': return 'Aadhaar';
    case 'BIRTH_CERTIFICATE': return 'Birth Certificate';
    case 'CHEQUE': return 'Cheque';
    default: return docType;
  }
}

function createDocumentSummary(docType: MemberDocumentType, summary?: Partial<MemberDocumentSummary>): MemberDocumentSummary {
  return {
    docType,
    hasFile: !!summary?.hasFile,
    originalName: summary?.originalName || null,
    mimeType: summary?.mimeType || null,
    fileSize: summary?.fileSize ?? null,
    uploadedAt: summary?.uploadedAt || null,
  };
}

function emptyMemberDocuments(): MemberDocumentSummaryMap {
  return MEMBER_DOCUMENT_TYPES.reduce((acc, docType) => {
    acc[docType] = createDocumentSummary(docType);
    return acc;
  }, {} as MemberDocumentSummaryMap);
}

function createDocumentDraft(docType: MemberDocumentType, summary?: Partial<MemberDocumentSummary>): MemberDocumentDraft {
  const base = createDocumentSummary(docType, summary);
  return {
    ...base,
    selectedPath: null,
    remove: false,
    existingHasFile: base.hasFile,
    existingOriginalName: base.originalName,
    existingMimeType: base.mimeType,
    existingFileSize: base.fileSize,
    existingUploadedAt: base.uploadedAt,
  };
}

function createDocumentDrafts(summaries?: Partial<MemberDocumentSummaryMap>): MemberDocumentDraftMap {
  return MEMBER_DOCUMENT_TYPES.reduce((acc, docType) => {
    acc[docType] = createDocumentDraft(docType, summaries?.[docType]);
    return acc;
  }, {} as MemberDocumentDraftMap);
}

interface MemberForm {
  full_name: string; member_type: 'INDIVIDUAL' | 'HUF'; dob: string;
  mobile: string; email: string; email_password: string;
  pan: string; aadhaar: string;
  documents: MemberDocumentDraftMap;
  banks:   { bank_code: string; user_id: string; password: string; account_number: string; customer_id: string; ifsc: string; }[];
  brokers: { broker_code: string; user_id: string; password: string; client_id: string; totp_secret: string; broker_mobile: string; broker_email: string; }[];
}

const emptyMemberForm = (): MemberForm => ({
  full_name: '', member_type: 'INDIVIDUAL', dob: '', mobile: '', email: '', email_password: '',
  pan: '', aadhaar: '',
  documents: createDocumentDrafts(),
  banks: [], brokers: [],
});

const emptyAuBidForm = (): AuBidForm => ({
  bankId: null,
  issueName: '',
  lots: '',
  lotSize: '',
  bidType: 'CUTOFF',
  bidPrice: '',
});

function formatAge(iso: string | null): string {
  if (!iso) return '';
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso)
    ? iso.replace(' ', 'T') + 'Z'
    : iso;
  const parsed = new Date(normalized).getTime();
  if (!Number.isFinite(parsed)) return '';
  const diff = Date.now() - parsed;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function describeDocumentDraft(doc: MemberDocumentDraft): string {
  if (doc.remove) return 'Will be removed when you save this member.';
  if (doc.selectedPath) {
    const size = formatFileSize(doc.fileSize);
    return `${doc.originalName || 'Selected file'}${size ? ` · ${size}` : ''} · save member to store it.`;
  }
  if (doc.hasFile) {
    const age = formatAge(doc.uploadedAt);
    return `${doc.originalName || 'Saved document'}${age ? ` · uploaded ${age}` : ''}`;
  }
  return 'No softcopy uploaded yet.';
}

interface BalanceParts { savings: number; deposit: number; }

/**
 * Split a bank balance string into savings (liquid) and deposit (FD) amounts.
 *
 * Recognised formats:
 *   "Savings: ₹8,141.37 | Deposit: ₹2,00,000.00"            → AU Bank
 *   "Withdrawable: ₹2,74,571.80 | Savings: ₹74,571.80 | FD Sweep-in: ₹2,00,000.00"  → Kotak
 *   "₹74,571.80"                                              → SBI / YES (all savings)
 *
 * "Deposit" label  → deposit bucket (FD, Deposit Account Balance, FD Sweep-in)
 * "Savings" label  → savings bucket (Savings Account Balance, Account Balance)
 * Plain ₹X or Withdrawable only → savings bucket (no FD component)
 */
function parseBalanceParts(balance: string | null): BalanceParts {
  if (!balance) return { savings: 0, deposit: 0 };

  const amt = (s: string) => parseFloat(s.replace(/,/g, ''));

  // Named-component extraction helpers
  const find = (re: RegExp) => { const m = balance.match(re); return m ? amt(m[1]) : 0; };

  const deposit = find(/(?:FD\s*Sweep[\s-]?in|Deposit(?:\s+Account\s+Balance)?)\s*[^|₹]*:\s*₹\s*([\d,]+\.\d{2})/i);
  const savings = find(/(?:Savings(?:\s+Account\s+Balance)?|Account\s+Balance)\s*[^|₹]*:\s*₹\s*([\d,]+\.\d{2})/i);

  // If we found at least one named component, trust those values
  if (savings > 0 || deposit > 0) return { savings, deposit };

  // Fallback: if only "Withdrawable" or a bare ₹X.XX, treat entire amount as savings
  const withdrawable = find(/Withdrawable[^|₹]*:\s*₹\s*([\d,]+\.\d{2})/i);
  if (withdrawable > 0) return { savings: withdrawable, deposit: 0 };

  const plain = balance.match(/₹\s*([\d,]+\.\d{2})/);
  return { savings: plain ? amt(plain[1]) : 0, deposit: 0 };
}

interface BrokerBalanceParts { funds: number | null; portfolio: number | null; positions: number | null; }

/**
 * Split a broker balance string into funds / portfolio / positions amounts.
 *
 * Recognised formats:
 *   "Funds: ₹1,23,456.78 | Portfolio: ₹4,56,789.00 | Positions: ₹0.00"
 *   "Funds: ₹1,23,456.78"
 *   "₹1,23,456.78"   (legacy single-value broker balance, treated as funds)
 *
 * `null` = the label wasn't in the string. `0` = label present, value is zero.
 * The UI uses this distinction to render zero-value chips (so the user can
 * tell the data was fetched) while hiding chips for unfetched categories.
 */
function parseBrokerBalance(balance: string | null): BrokerBalanceParts {
  if (!balance) return { funds: null, portfolio: null, positions: null };
  const amt = (s: string) => parseFloat(s.replace(/,/g, ''));
  // Match label + signed amount. Sign can sit before OR after ₹
  // ("Positions: -₹500.00" or "Positions: ₹-500.00") — both forms occur.
  const findSigned = (label: string): number | null => {
    const re = new RegExp(`${label}\\s*:\\s*(-?)₹\\s*(-?)([\\d,]+(?:\\.\\d{1,2})?)`, 'i');
    const m = balance.match(re);
    if (!m) return null;
    const sign = (m[1] === '-' || m[2] === '-') ? -1 : 1;
    return sign * amt(m[3]);
  };

  const funds     = findSigned('Funds');
  const portfolio = findSigned('Portfolio');
  const positions = findSigned('Positions');

  if (funds !== null || portfolio !== null || positions !== null) {
    return { funds, portfolio, positions };
  }

  // Fallback: bare "₹X" (legacy broker balance format) → treat as funds
  const plain = balance.match(/₹\s*([\d,]+(?:\.\d{1,2})?)/);
  return { funds: plain ? amt(plain[1]) : null, portfolio: null, positions: null };
}

/** Aggregate savings + deposit totals across all members of a family. */
function computeFamilyParts(memberList: Member[]): BalanceParts {
  return memberList.reduce((acc, m) => {
    m.banks.forEach(b => {
      const p = parseBalanceParts(b.balance);
      acc.savings += p.savings;
      acc.deposit += p.deposit;
    });
    return acc;
  }, { savings: 0, deposit: 0 });
}

/** Format a number in Indian Rupee notation: ₹2,08,141.37 */
function formatINR(amount: number): string {
  if (amount <= 0) return '';
  return formatINRRaw(amount);
}

/** Like formatINR but renders ₹0.00 instead of an empty string. */
function formatINRRaw(amount: number): string {
  const [intPart, dec] = Math.abs(amount).toFixed(2).split('.');
  const lastThree = intPart.slice(-3);
  const rest = intPart.slice(0, -3);
  const grouped = rest
    ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + lastThree
    : lastThree;
  return `${amount < 0 ? '-' : ''}₹${grouped}.${dec}`;
}

function formatTableAmount(amount: number): string {
  if (!Number.isFinite(amount)) return '—';
  const rounded = Math.round(amount);
  const raw = String(Math.abs(rounded));
  const lastThree = raw.slice(-3);
  const rest = raw.slice(0, -3);
  const grouped = rest
    ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + lastThree
    : lastThree;
  return `${rounded < 0 ? '-' : ''}${grouped}`;
}

function formatTableAmountText(value: string): string {
  const match = value.match(/(-?)\s*(?:₹|INR|Rs\.?)?\s*(-?)\s*([\d,]+(?:\.\d+)?)/i);
  if (!match) return value.replace(/₹|INR|Rs\.?/gi, '').trim();
  const sign = match[1] === '-' || match[2] === '-' ? -1 : 1;
  const amount = Number((match[3] || '').replace(/,/g, '')) * sign;
  return Number.isFinite(amount) ? formatTableAmount(amount) : value.replace(/₹|INR|Rs\.?/gi, '').trim();
}

function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function formatNullableNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (digits === 0) return String(Math.round(value));
  return value.toFixed(digits);
}

function formatIpoDate(value: string | null | undefined): string {
  if (!value) return '—';
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function formatIpoPriceBand(issue: IpoCatalogIssue | null): string {
  if (!issue) return '—';
  if (issue.priceMin !== null && issue.priceMax !== null) {
    if (issue.priceMin === issue.priceMax) return formatINRRaw(issue.priceMax);
    return `${formatINRRaw(issue.priceMin)} – ${formatINRRaw(issue.priceMax)}`;
  }
  if (issue.priceMax !== null) return formatINRRaw(issue.priceMax);
  if (issue.priceMin !== null) return formatINRRaw(issue.priceMin);
  return '—';
}

function holdingTotalQuantity(holding: BrokerPortfolioHolding): number {
  return (holding.quantity_available || 0)
    + (holding.quantity_discrepant || 0)
    + (holding.quantity_pledged_margin || 0)
    + (holding.quantity_pledged_loan || 0);
}

function holdingDerivedMetrics(holding: BrokerPortfolioHolding) {
  const quantity = holdingTotalQuantity(holding);
  const invested = quantity > 0 && holding.average_price !== null ? quantity * holding.average_price : 0;
  const present = quantity > 0 && holding.previous_closing_price !== null ? quantity * holding.previous_closing_price : 0;
  const pnl = present - invested;
  const pnlPct = invested > 0 ? (pnl / invested) * 100 : present > 0 ? 100 : 0;
  return { quantity, invested, present, pnl, pnlPct };
}

type Modal =
  | { type: 'none' }
  | { type: 'add-family' }
  | { type: 'edit-family'; family: Family }
  | { type: 'add-member'; familyId: number }
  | { type: 'edit-member'; memberId: number; familyId: number }
  | { type: 'view-portfolio'; memberId: number; brokerId: number; brokerCode: string; memberName: string }
  | { type: 'prepare-au-bid'; memberId: number; familyId: number; memberName: string }
  | { type: 'review-au-bid'; memberId: number; familyId: number; memberName: string }
  | { type: 'service-config'; service: 'gmail' | 'captcha-anthropic' }
  | { type: 'change-master-password' }
  | { type: 'backup-settings' }
  | { type: 'restore-backup' }
  | { type: 'member-card'; memberId: number; memberName: string };

// 'all' = View All, 'recharge' = SIM recharge tracker, 'totp' = Zerodha TOTP, number = specific family id
type SelectedView = 'all' | 'recharge' | 'totp' | number;

// â"€â"€ Dashboard â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

interface UpdaterState {
  kind: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error' | 'up-to-date';
  version?: string;
  percent?: number;
  message?: string;
}

export default function Dashboard() {
  const [families,      setFamilies]      = useState<Family[]>([]);
  const [selectedView,  setSelectedView]  = useState<SelectedView>('all');
  const [updater,       setUpdater]       = useState<UpdaterState>({ kind: 'idle' });
  const [installing,    setInstalling]    = useState(false);
  const [appVersion,    setAppVersion]    = useState<string>('');
  const [members,       setMembers]       = useState<Record<number, Member[]>>({});
  const [busy,          setBusy]          = useState<string | null>(null);
  const [bulkBusy,      setBulkBusy]      = useState<string | null>(null);
  const [toasts,        setToasts]        = useState<Toast[]>([]);
  const [modal,         setModal]         = useState<Modal>({ type: 'none' });
  const [familyName,      setFamilyName]      = useState('');
  const [familyMinBalance, setFamilyMinBalance] = useState('');
  const [memberForm,    setMemberForm]    = useState<MemberForm>(emptyMemberForm());
  const [saving,        setSaving]        = useState(false);
  const [bankToAdd,     setBankToAdd]     = useState('');
  const [brokerToAdd,   setBrokerToAdd]   = useState('');
  const [totpCode,      setTotpCode]      = useState<{ broker_code: string; code: string } | null>(null);
  const [otpRequest,    setOtpRequest]    = useState<{ label: string } | null>(null);
  const [otpValue,      setOtpValue]      = useState('');
  const [otpSubmitting, setOtpSubmitting] = useState(false);
  const [gmailStatus,   setGmailStatus]   = useState<GmailStatus | null>(null);
  const [captchaAiStatus, setCaptchaAiStatus] = useState<CaptchaAiStatus | null>(null);
  const [backupInfo, setBackupInfo] = useState<{
    config: { enabled: boolean; folder: string | null; vaultId: string };
    state: { lastBackupAt: string | null; lastBackupError: string | null; lastSnapshotId: string | null; inProgress: boolean };
  } | null>(null);
  const [captchaUsage, setCaptchaUsage] = useState<{
    date: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cap: number;
    consented: boolean;
    totalCalls: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  } | null>(null);
  const [memberDetail, setMemberDetail] = useState<any | null>(null);
  const [memberDetailLoading, setMemberDetailLoading] = useState(false);
  const [backupSnapshots, setBackupSnapshots] = useState<Array<{
    id: string; timestamp: string; dbBytes: number; documentCount: number; totalBlobBytes: number;
    band: 'last-24h' | 'last-7d' | 'last-30d' | 'last-6mo' | 'older';
  }>>([]);
  const [restoreSourceFolder, setRestoreSourceFolder] = useState<string | null>(null);
  const [serviceConfigValue, setServiceConfigValue] = useState('');
  const [passwordChangeForm, setPasswordChangeForm] = useState({ current: '', next: '', confirm: '' });
  const [portfolioReport, setPortfolioReport] = useState<BrokerPortfolioReport | null>(null);
  const [portfolioAssetScope, setPortfolioAssetScope] = useState<'EQUITY' | 'MUTUAL_FUNDS' | 'COMBINED'>('EQUITY');
  const [auBidOptions, setAuBidOptions] = useState<AuBidDraftOptions | null>(null);
  const [ipoCatalog, setIpoCatalog] = useState<IpoCatalogIssue[]>([]);
  const [ipoCategory, setIpoCategory] = useState<'mainboard' | 'sme'>('mainboard');
  const [auBidForm, setAuBidForm] = useState<AuBidForm>(emptyAuBidForm());
  const [auBidHistory, setAuBidHistory] = useState<IpoBidHistoryEntry[]>([]);
  const [preparedAuBid, setPreparedAuBid] = useState<PreparedAuBid | null>(null);
  const [auIpoDropdownOpen, setAuIpoDropdownOpen] = useState(false);
  const [auIpoSelectedIds, setAuIpoSelectedIds] = useState<Set<number>>(new Set());
  const [auIpoMemberQueue, setAuIpoMemberQueue] = useState<Array<{member: Member; family: Family}>>([]);
  const [auIpoQueueIndex, setAuIpoQueueIndex] = useState(0);
  const [expandedFamilies, setExpandedFamilies] = useState<Set<number>>(new Set());
  const [editMode, setEditMode] = useState(false);
  const dragFamilyId   = useRef<number | null>(null);
  const dragMemberData = useRef<{ id: number; familyId: number } | null>(null);
  const bulkCancelRequested = useRef(false);
  const auIpoDropdownRef = useRef<HTMLDivElement>(null);
  // Refs so the window-close auto-advance listener always sees current values
  // even though it is registered once (avoids stale closure over state).
  const auIpoQueueRef      = useRef<Array<{member: Member; family: Family}>>([]);
  const auIpoQueueIndexRef = useRef(0);
  // â"€â"€ Data loading â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

  const showToast = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t, { id, kind, text }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4000);
  }, []);

  const copyText = useCallback(async (label: string, value: string | null | undefined) => {
    if (!value) {
      showToast('error', `${label} not available`);
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      showToast('success', `${label} copied`);
    } catch {
      showToast('error', `Could not copy ${label}`);
    }
  }, [showToast]);

  function beginBulkActivity(key: string) {
    bulkCancelRequested.current = false;
    setBulkBusy(key);
  }

  function bulkWasStopped(): boolean {
    return bulkCancelRequested.current;
  }

  async function stopCurrentActivity() {
    if (!bulkBusy && !loginBusy) return;
    bulkCancelRequested.current = true;
    showToast('info', 'Stopping current activity...');
    const result: any = await window.api.automation.cancelCurrent();
    if (!result?.ok) showToast('error', result?.error || 'Could not stop current activity');
  }

  function openChangeMasterPassword() {
    setPasswordChangeForm({ current: '', next: '', confirm: '' });
    setModal({ type: 'change-master-password' });
  }

  async function lockVault() {
    try {
      await window.api.vault.lock();
      // The main process broadcasts vault:locked → App.tsx flips to unlock screen.
    } catch (e: any) {
      showToast('error', `Could not lock: ${e?.message || String(e)}`);
    }
  }

  async function changeMasterPassword() {
    const current = passwordChangeForm.current;
    const next = passwordChangeForm.next;
    const confirm = passwordChangeForm.confirm;
    if (!current || !next || !confirm) {
      showToast('error', 'Fill all password fields');
      return;
    }
    if (next !== confirm) {
      showToast('error', 'New passwords do not match');
      return;
    }
    setBusy('change-master-password');
    try {
      const result: any = await window.api.vault.changePassword(current, next);
      if (result?.ok) {
        showToast('success', 'Master password changed');
        setPasswordChangeForm({ current: '', next: '', confirm: '' });
        setModal({ type: 'none' });
      } else if (Array.isArray(result?.issues) && result.issues.length) {
        showToast('error', result.issues.join(' '));
      } else {
        showToast('error', result?.error || 'Could not change master password');
      }
    } finally {
      setBusy(null);
    }
  }

  const loadFamilies = useCallback(async () => {
    const list = await window.api.families.list();
    setFamilies(list as Family[]);
  }, []);

  const loadGmailStatus = useCallback(async () => {
    try {
      const status = await window.api.gmail.status();
      setGmailStatus(status as GmailStatus);
    } catch (e: any) {
      setGmailStatus({
        state: 'error',
        configured: false,
        hasRefreshToken: false,
        label: 'Gmail status error',
        detail: e?.message || String(e)
      });
    }
  }, []);

  const loadCaptchaAiStatus = useCallback(async () => {
    try {
      const status = await window.api.captchaAi.status();
      setCaptchaAiStatus(status as CaptchaAiStatus);
    } catch (e: any) {
      setCaptchaAiStatus({
        state: 'error',
        configured: false,
        label: 'CAPTCHA AI error',
        detail: e?.message || String(e),
        activeProvider: 'anthropic',
        configuredProviders: [],
        providers: {
          anthropic: {
            provider: 'anthropic',
            displayName: 'Claude',
            state: 'error',
            configured: false,
            label: 'Claude CAPTCHA error',
            detail: e?.message || String(e),
            model: 'unknown',
            source: null,
          },
        },
      });
    }
  }, []);

  const loadMembers = useCallback(async (familyId: number): Promise<Member[]> => {
    const list = await window.api.families.members(familyId);
    const typed = (list as any[]).map(member => ({
      ...member,
      documents: MEMBER_DOCUMENT_TYPES.reduce((acc, docType) => {
        acc[docType] = createDocumentSummary(docType, member?.documents?.[docType]);
        return acc;
      }, emptyMemberDocuments()),
    })) as Member[];
    setMembers(m => ({ ...m, [familyId]: typed }));
    return typed;
  }, []);

  const loadBackupStatus = useCallback(async () => {
    try {
      const info: any = await window.api.backup.status();
      setBackupInfo(info);
    } catch (e: any) {
      setBackupInfo(null);
    }
  }, []);

  // Initial load
  useEffect(() => { loadFamilies(); loadGmailStatus(); loadCaptchaAiStatus(); loadBackupStatus(); loadCaptchaUsage(); }, []);

  // Auto-sync notification — fires when main process silently restored a newer snapshot on unlock.
  useEffect(() => {
    const unsub = window.api.events.onAutoSynced((data: { snapshotTimestamp: string }) => {
      const when = new Date(data.snapshotTimestamp);
      const diffMin = Math.round((Date.now() - when.getTime()) / 60000);
      const ago = diffMin < 2 ? 'just now' : diffMin < 60 ? `${diffMin}m ago` : `${Math.round(diffMin / 60)}h ago`;
      showToast('info', `Auto-synced from backup (${ago}). Data is up to date.`);
      loadFamilies();
    });
    return () => { if (typeof unsub === 'function') unsub(); };
  }, []);

  // Auto-updater — listen for update lifecycle events from main process.
  // We also fetch the app version and the last known status on mount so we
  // never miss events that fired before this component subscribed (the
  // updater caches its last status in main and we pull it synchronously here).
  useEffect(() => {
    // Fetch the running app version once and display it in the sidebar.
    window.api.updater.currentVersion().then((v: string) => {
      if (v) setAppVersion(v);
    }).catch(() => {});

    // Catch up: if the update check already ran before we subscribed, pull
    // the cached status so the banner/toast shows immediately.
    window.api.updater.getStatus().then((s: any) => {
      if (s && s.kind !== 'idle') {
        setUpdater(s as UpdaterState);
        // Show the toast only for the most actionable states.
        if (s.kind === 'available') {
          showToast('info', `Update available: v${s.version}. Downloading…`);
        } else if (s.kind === 'downloaded') {
          showToast('success', `Update v${s.version} ready. Click "Restart now" in the banner.`);
        }
      }
    }).catch(() => {});

    // Subscribe to live events for everything that happens after mount.
    const unsub = window.api.updater.onStatus((s) => {
      setUpdater(s as UpdaterState);
      if (s.kind === 'available') {
        showToast('info', `Update available: v${s.version}. Downloading…`);
      } else if (s.kind === 'downloaded') {
        showToast('success', `Update v${s.version} ready. Click "Restart now" in the banner.`);
      } else if (s.kind === 'error') {
        // Silent — don't nag the user when GitHub is unreachable.
        console.warn('[Updater]', s.message);
      }
    });
    return () => { if (typeof unsub === 'function') unsub(); };
  }, []);

  async function installUpdateNow() {
    setInstalling(true);
    await window.api.updater.installNow();
    // App will quit and restart — nothing more to do here.
  }

  // Refresh CAPTCHA usage + status periodically — shows today's call count and
  // surfaces auth errors (e.g. invalid API key returning 401) in the pill.
  useEffect(() => {
    const t = setInterval(() => { void loadCaptchaUsage(); void loadCaptchaAiStatus(); }, 60_000);
    return () => clearInterval(t);
  }, []);

  // Ctrl+L (or Cmd+L on mac) → lock the vault immediately.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        void lockVault();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Poll backup status every 30s — picks up auto-backup completions
  useEffect(() => {
    const t = setInterval(loadBackupStatus, 30_000);
    return () => clearInterval(t);
  }, [loadBackupStatus]);

  // Pre-load ALL family members so balance status pills are always visible
  useEffect(() => {
    families.forEach(f => { if (!members[f.id]) loadMembers(f.id); });
  }, [families]);

  // When switching to a single-family view, ensure that family is loaded
  useEffect(() => {
    if (typeof selectedView === 'number' && !members[selectedView]) {
      loadMembers(selectedView);
    }
  }, [selectedView]);

  // OTP dialog - listen for requests from main process
  useEffect(() => {
    window.api.otp.onNeeded(data => { setOtpValue(''); setOtpRequest(data); });
    window.api.otp.onDismiss(() => { setOtpRequest(null); setOtpValue(''); });
  }, []);

  // Close AU IPO dropdown when clicking outside
  useEffect(() => {
    if (!auIpoDropdownOpen) return undefined;
    function handleClickOutside(e: MouseEvent) {
      if (auIpoDropdownRef.current && !auIpoDropdownRef.current.contains(e.target as Node)) {
        setAuIpoDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [auIpoDropdownOpen]);

  // Keep refs in sync so the auto-advance listener always reads current values
  // even between effect re-registrations.
  useEffect(() => { auIpoQueueRef.current = auIpoMemberQueue; }, [auIpoMemberQueue]);
  useEffect(() => { auIpoQueueIndexRef.current = auIpoQueueIndex; }, [auIpoQueueIndex]);

  // Auto-advance: when the user closes a Chromium IPO window (whether the bid
  // was placed or not), automatically open the next queued member's bid window.
  // Re-registered on queue/index change so advanceToNextQueueMember always
  // captures the correct, non-stale auIpoMemberQueue value.
  useEffect(() => {
    if (!auIpoMemberQueue.length) return;
    return window.api.ipo.onWindowClosed(({ memberId }) => {
      const current = auIpoMemberQueue[auIpoQueueIndex];
      if (!current || current.member.id !== memberId) return;  // already advanced past this member

      const nextIdx = auIpoQueueIndex + 1;
      if (nextIdx < auIpoMemberQueue.length) {
        advanceToNextQueueMember(nextIdx);
      } else {
        // Last member's window closed — clean up the whole batch
        setAuIpoMemberQueue([]);
        setAuIpoQueueIndex(0);
        setModal({ type: 'none' });
        setPreparedAuBid(null);
        showToast('info', 'AU IPO batch complete — all windows processed.');
      }
    });
  }, [auIpoMemberQueue, auIpoQueueIndex]); // re-register so closure is always fresh

  async function submitOtp() {
    if (!otpValue.trim()) return;
    setOtpSubmitting(true);
    await window.api.otp.provide(otpValue.trim());
    setOtpRequest(null); setOtpValue(''); setOtpSubmitting(false);
  }
  async function cancelOtp() {
    await window.api.otp.cancel();
    setOtpRequest(null); setOtpValue('');
  }

  // â"€â"€ View selection â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

  function selectAll() { setSelectedView('all'); }

  async function selectFamily(id: number) {
    setSelectedView(id);
    if (!members[id]) await loadMembers(id);
  }

  /** Toggle a family open/closed in the bird's-eye accordion view. */
  function toggleFamily(id: number) {
    setExpandedFamilies(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        if (!members[id]) loadMembers(id);
      }
      return next;
    });
  }


  // â"€â"€ Family DnD (sidebar) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

  function onFamilyDragStart(e: React.DragEvent, id: number) {
    dragFamilyId.current = id;
    e.dataTransfer.effectAllowed = 'move';
  }
  function onFamilyDragOver(e: React.DragEvent) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
  async function onFamilyDrop(e: React.DragEvent, targetId: number) {
    e.preventDefault();
    const srcId = dragFamilyId.current;
    if (!srcId || srcId === targetId) return;
    dragFamilyId.current = null;
    const reordered = [...families];
    const srcIdx = reordered.findIndex(f => f.id === srcId);
    const tgtIdx = reordered.findIndex(f => f.id === targetId);
    const [moved] = reordered.splice(srcIdx, 1);
    reordered.splice(tgtIdx, 0, moved);
    setFamilies(reordered);
    await window.api.families.reorder(reordered.map(f => f.id));
  }

  // â"€â"€ Member DnD â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

  function onMemberDragStart(e: React.DragEvent, memberId: number, familyId: number) {
    dragMemberData.current = { id: memberId, familyId };
    e.dataTransfer.effectAllowed = 'move';
    e.stopPropagation();
  }
  function onMemberDragOver(e: React.DragEvent) { e.preventDefault(); e.stopPropagation(); }
  async function onMemberDrop(e: React.DragEvent, targetMemberId: number, familyId: number) {
    e.preventDefault(); e.stopPropagation();
    const src = dragMemberData.current;
    if (!src || src.id === targetMemberId || src.familyId !== familyId) return;
    dragMemberData.current = null;
    const current = members[familyId] || [];
    const reordered = [...current];
    const srcIdx = reordered.findIndex(m => m.id === src.id);
    const tgtIdx = reordered.findIndex(m => m.id === targetMemberId);
    const [moved] = reordered.splice(srcIdx, 1);
    reordered.splice(tgtIdx, 0, moved);
    setMembers(m => ({ ...m, [familyId]: reordered }));
    await window.api.member.reorder(familyId, reordered.map(m => m.id));
  }

  // â"€â"€ Family CRUD â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

  function openAddFamily() { setFamilyName(''); setFamilyMinBalance(''); setModal({ type: 'add-family' }); }
  function openEditFamily(f: Family) {
    setFamilyName(f.family_name);
    setFamilyMinBalance(f.min_balance ? String(f.min_balance) : '');
    setModal({ type: 'edit-family', family: f });
  }

  async function saveFamily() {
    if (!familyName.trim()) return;
    setSaving(true);
    const minBal = parseInt(familyMinBalance.replace(/[^\d]/g, ''), 10) || 0;
    try {
      if (modal.type === 'add-family') {
        await window.api.families.create(familyName.trim(), minBal);
        showToast('success', 'Family added');
      } else if (modal.type === 'edit-family') {
        await window.api.families.update(modal.family.id, familyName.trim(), undefined, minBal);
        showToast('success', 'Family updated');
      }
      await loadFamilies();
      setModal({ type: 'none' });
    } catch (e: any) { showToast('error', e.message); }
    finally { setSaving(false); }
  }

  async function deleteFamily(id: number, name: string) {
    if (!confirm(`Delete "${name}" and ALL its members? This cannot be undone.`)) return;
    await window.api.families.delete(id);
    setFamilies(f => f.filter(x => x.id !== id));
    if (selectedView === id) setSelectedView('all');
    showToast('success', 'Family deleted');
  }

  // â"€â"€ Member CRUD â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

  function setMemberDocument(docType: MemberDocumentType, updater: (current: MemberDocumentDraft) => MemberDocumentDraft) {
    setMemberForm(form => ({
      ...form,
      documents: {
        ...form.documents,
        [docType]: updater(form.documents[docType]),
      },
    }));
  }

  function restoreExistingMemberDocument(doc: MemberDocumentDraft): MemberDocumentDraft {
    return {
      ...doc,
      hasFile: doc.existingHasFile,
      originalName: doc.existingOriginalName,
      mimeType: doc.existingMimeType,
      fileSize: doc.existingFileSize,
      uploadedAt: doc.existingUploadedAt,
      selectedPath: null,
      remove: false,
    };
  }

  async function pickMemberDocument(docType: MemberDocumentType) {
    const key = `doc-pick-${docType}`;
    setBusy(key);
    try {
      const result: any = await window.api.documents.pick(docType);
      if (result?.ok && result.file) {
        const file = result.file;
        setMemberDocument(docType, current => ({
          ...current,
          hasFile: true,
          originalName: file.originalName || current.originalName,
          mimeType: file.mimeType || current.mimeType,
          fileSize: typeof file.fileSize === 'number' ? file.fileSize : current.fileSize,
          uploadedAt: current.uploadedAt,
          selectedPath: file.selectedPath || null,
          remove: false,
        }));
        showToast('success', `${documentLabel(docType)} file selected`);
      } else if (!result?.cancelled) {
        showToast('error', result?.error || `Could not select ${documentLabel(docType)} file`);
      }
    } catch (e: any) {
      showToast('error', e?.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  function clearMemberDocument(docType: MemberDocumentType) {
    setMemberDocument(docType, current => {
      if (current.selectedPath) return restoreExistingMemberDocument(current);
      if (current.existingHasFile && !current.remove) {
        return {
          ...current,
          hasFile: false,
          originalName: null,
          mimeType: null,
          fileSize: null,
          uploadedAt: null,
          selectedPath: null,
          remove: true,
        };
      }
      if (current.remove) return restoreExistingMemberDocument(current);
      return {
        ...current,
        hasFile: false,
        originalName: null,
        mimeType: null,
        fileSize: null,
        uploadedAt: null,
        selectedPath: null,
        remove: false,
      };
    });
  }

  async function downloadStoredDocument(memberId: number, docType: MemberDocumentType) {
    const key = `doc-download-${memberId}-${docType}`;
    setBusy(key);
    showToast('info', `Downloading ${documentLabel(docType)} softcopy...`);
    try {
      const result: any = await window.api.documents.download(memberId, docType);
      if (result?.ok) {
        showToast('success', `${documentLabel(docType)} saved to Downloads as ${result.fileName || 'document'}`);
      } else {
        showToast('error', result?.error || `${documentLabel(docType)} download failed`);
      }
      return result;
    } catch (e: any) {
      const message = e?.message || String(e);
      showToast('error', message);
      return { ok: false, error: message };
    } finally {
      setBusy(null);
    }
  }

  function openAddMember(familyId: number) {
    setMemberForm(emptyMemberForm()); setBankToAdd(''); setBrokerToAdd('');
    setModal({ type: 'add-member', familyId });
  }

  async function openEditMember(memberId: number, familyId: number) {
    const detail: any = await window.api.member.fullDetail(memberId);
    if (!detail) return;
    const filledBanks = (detail.banks as any[])
      .filter(b => b.user_id || b.password || b.account_number || b.customer_id)
      .map(b => ({ bank_code: b.bank_code, user_id: b.user_id || '', password: b.password || '', account_number: b.account_number || '', customer_id: b.customer_id || '', ifsc: b.ifsc || '' }));
    const filledBrokers = (detail.brokers as any[])
      .filter(b => b.user_id || b.password || b.client_id)
      .map(b => ({ broker_code: b.broker_code, user_id: b.user_id || '', password: b.password || '', client_id: b.client_id || '', totp_secret: b.totp_secret || '', broker_mobile: b.broker_mobile || '', broker_email: b.broker_email || '' }));
    setMemberForm({
      full_name: detail.full_name || '', member_type: detail.member_type || 'INDIVIDUAL',
      dob: detail.dob || '', mobile: detail.mobile || '', email: detail.email || '',
      email_password: detail.email_password || '',
      pan: detail.pan || '', aadhaar: detail.aadhaar || '',
      documents: createDocumentDrafts(detail.documents || emptyMemberDocuments()),
      banks: filledBanks, brokers: filledBrokers,
    });
    setBankToAdd(''); setBrokerToAdd('');
    setModal({ type: 'edit-member', memberId, familyId });
  }

  async function saveMember() {
    if (!memberForm.full_name.trim()) return;
    setSaving(true);
    try {
      const familyId = modal.type === 'add-member' ? modal.familyId : (modal as any).familyId;
      const payloadDocuments = MEMBER_DOCUMENT_TYPES.reduce((acc, docType) => {
        const doc = memberForm.documents[docType];
        acc[docType] = {
          selectedPath: doc.selectedPath,
          originalName: doc.originalName,
          mimeType: doc.mimeType,
          fileSize: doc.fileSize,
          remove: doc.remove,
        };
        return acc;
      }, {} as Record<MemberDocumentType, {
        selectedPath: string | null;
        originalName: string | null;
        mimeType: string | null;
        fileSize: number | null;
        remove: boolean;
      }>);
      const payload  = { ...memberForm, documents: payloadDocuments, family_id: familyId };
      if (modal.type === 'add-member') {
        await window.api.member.create(payload);
        showToast('success', 'Member added');
      } else if (modal.type === 'edit-member') {
        await window.api.member.update({ ...payload, id: (modal as any).memberId });
        showToast('success', 'Member updated');
      }
      await loadMembers(familyId);
      await loadFamilies(); // refresh member_count
      setModal({ type: 'none' });
    } catch (e: any) { showToast('error', e.message); }
    finally { setSaving(false); }
  }

  async function deleteMember(memberId: number, familyId: number, name: string) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    await window.api.member.delete(memberId);
    setMembers(m => ({ ...m, [familyId]: (m[familyId] || []).filter(x => x.id !== memberId) }));
    setFamilies(f => f.map(x => x.id === familyId ? { ...x, member_count: x.member_count - 1 } : x));
    showToast('success', 'Member deleted');
  }

  function handleIdentityDocumentClick(member: Member, docType: MemberDocumentType) {
    const doc = member.documents?.[docType];
    if (!doc?.hasFile) {
      showToast('error', `${documentLabel(docType)} softcopy not uploaded`);
      return;
    }
    void downloadStoredDocument(member.id, docType);
  }

  // â"€â"€ Login â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

  function patchBankResult(memberId: number, bank: BankRow, familyId: number, result: any) {
    if (!result?.balance) return;
    setMembers(prev => {
      const list = prev[familyId] ?? [];
      return {
        ...prev,
        [familyId]: list.map(m => m.id !== memberId ? m : {
          ...m,
          banks: m.banks.map(b => b.id !== bank.id ? b : {
            ...b,
            balance: result.balance,
            balance_fetched_at: result.balanceFetchedAt
          })
        })
      };
    });
  }

  function patchBrokerResult(memberId: number, broker: BrokerRow, familyId: number, result: any) {
    if (!result?.balance) return;
    setMembers(prev => {
      const list = prev[familyId] ?? [];
      return {
        ...prev,
        [familyId]: list.map(m => m.id !== memberId ? m : {
          ...m,
          brokers: m.brokers.map(b => b.id !== broker.id ? b : {
            ...b,
            balance: result.balance,
            balance_fetched_at: result.balanceFetchedAt
          })
        })
      };
    });
  }

  async function loginBank(memberId: number, bank: BankRow, familyId: number, opts?: { silent?: boolean; closeAfterFetch?: boolean }) {
    const key = `bank-${bank.id}`;
    const silent = !!opts?.silent;
    const closeAfterFetch = !!opts?.closeAfterFetch;
    setBusy(key);
    if (!silent) showToast('info', `Opening ${bank.bank_code} login...`);
    try {
      const result: any = await window.api.login.bank(memberId, bank.id, { closeAfterFetch });
      if (result.ok) {
        if (!silent) showToast('success', `${bank.bank_code} - logged in${result.balance ? ` . ${result.balance}` : ''}`);
        patchBankResult(memberId, bank, familyId, result);
      } else if (!silent) {
        showToast('error', `${bank.bank_code}: ${result.error}`);
      }
      return result;
    } catch (e: any) {
      const message = e?.message || String(e);
      if (!silent) showToast('error', `${bank.bank_code}: ${message}`);
      return { ok: false, error: message };
    } finally {
      setBusy(null);
    }
  }

  async function loginBroker(memberId: number, broker: BrokerRow, familyId: number, opts?: { silent?: boolean; fetchBalance?: boolean; closeAfterFetch?: boolean }) {
    const key = `broker-${broker.id}`;
    const silent = !!opts?.silent;
    const fetchBalance = !!opts?.fetchBalance;
    const closeAfterFetch = !!opts?.closeAfterFetch;
    setBusy(key);
    if (!silent) showToast('info', fetchBalance
      ? `Refreshing ${broker.broker_code}...`
      : `Opening ${broker.broker_code} login...`);
    try {
      const result: any = await window.api.login.broker(memberId, broker.id, fetchBalance, { closeAfterFetch });
      if (result.ok) {
        if (!silent) showToast('success', fetchBalance
          ? `${broker.broker_code} refreshed${result.balance ? ` . ${result.balance}` : ''}`
          : `${broker.broker_code} - logged in`);
        patchBrokerResult(memberId, broker, familyId, result);
      } else if (!silent) {
        showToast('error', `${broker.broker_code}: ${result.error}`);
      }
      return result;
    } catch (e: any) {
      const message = e?.message || String(e);
      if (!silent) showToast('error', `${broker.broker_code}: ${message}`);
      return { ok: false, error: message };
    } finally {
      setBusy(null);
    }
  }

  function canDownloadBrokerPortfolio(brokerCode: string): boolean {
    return brokerCode === 'ZERODHA' || brokerCode === 'DHAN' || brokerCode === 'ANGEL';
  }

  async function downloadBrokerPortfolio(memberId: number, broker: BrokerRow, familyId: number) {
    const key = `report-${broker.id}`;
    setBusy(key);
    showToast('info', `Downloading ${broker.broker_code} portfolio report...`);
    try {
      const result: any = await window.api.reports.downloadBrokerPortfolio(memberId, broker.id);
      if (result?.ok) {
        const parsedNote = typeof result.parsedHoldingCount === 'number'
          ? ` . Parsed ${result.parsedHoldingCount} holdings`
          : '';
        showToast(
          'success',
          `${broker.broker_code} portfolio saved as ${result.fileName || 'portfolio-report'}${parsedNote}`
        );
        await loadMembers(familyId);
      } else {
        showToast('error', `${broker.broker_code}: ${result?.error || 'Portfolio download failed'}`);
      }
      return result;
    } catch (e: any) {
      const message = e?.message || String(e);
      showToast('error', `${broker.broker_code}: ${message}`);
      return { ok: false, error: message };
    } finally {
      setBusy(null);
    }
  }

  async function openBrokerPortfolioViewer(member: Member, broker: BrokerRow) {
    const key = `portfolio-view-${broker.id}`;
    setBusy(key);
    showToast('info', `Loading ${broker.broker_code} portfolio...`);
    try {
      const result: any = await window.api.reports.latestBrokerPortfolio(member.id, broker.id);
      if (!result?.ok || !result.report) {
        showToast('error', `${broker.broker_code}: ${result?.error || 'Portfolio not available'}`);
        return;
      }

      const report = result.report as BrokerPortfolioReport;
      const preferredScope =
        report.holdings.some(h => h.asset_scope === 'EQUITY' && !h.is_combined_view) ? 'EQUITY'
        : report.holdings.some(h => h.asset_scope === 'MUTUAL_FUNDS' && !h.is_combined_view) ? 'MUTUAL_FUNDS'
        : 'COMBINED';

      setPortfolioReport(report);
      setPortfolioAssetScope(preferredScope);
      setModal({
        type: 'view-portfolio',
        memberId: member.id,
        brokerId: broker.id,
        brokerCode: broker.broker_code,
        memberName: member.full_name,
      });
    } catch (e: any) {
      showToast('error', `${broker.broker_code}: ${e?.message || String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function openBrokerReportFolder(member: Member, broker: BrokerRow) {
    const key = `report-folder-${broker.id}`;
    setBusy(key);
    showToast('info', `Opening ${broker.broker_code} report folder...`);
    try {
      const result: any = await window.api.reports.openLatestBrokerPortfolioFolder(member.id, broker.id);
      if (result?.ok) {
        showToast('success', `${broker.broker_code} report folder opened`);
      } else {
        showToast('error', `${broker.broker_code}: ${result?.error || 'Report folder not available'}`);
      }
      return result;
    } catch (e: any) {
      const message = e?.message || String(e);
      showToast('error', `${broker.broker_code}: ${message}`);
      return { ok: false, error: message };
    } finally {
      setBusy(null);
    }
  }

  /** Returns true when an issue is an SME IPO (NSE Emerge / BSE SME). */
  function isSmeListing(issue: IpoCatalogIssue): boolean {
    const platform = (issue.exchangePlatform || '').toLowerCase();
    const type = (issue.issueType || '').toLowerCase();
    return platform === 'sme' || type.includes('sme');
  }

  function getDefaultIpoIssue(issues: IpoCatalogIssue[], preferredIssueName?: string | null): IpoCatalogIssue | null {
    if (preferredIssueName) {
      const matched = issues.find(issue => issue.issueName === preferredIssueName);
      if (matched) return matched;
    }
    // Default to a live mainboard issue first, then any live issue, then the first one.
    return issues.find(issue => issue.status === 'LIVE' && !isSmeListing(issue))
      ?? issues.find(issue => issue.status === 'LIVE')
      ?? issues[0]
      ?? null;
  }

  function buildAuBidFormForIssue(bankId: number | null, issue: IpoCatalogIssue | null): AuBidForm {
    const lotSize = issue?.lotSize ?? null;
    const minBidQty = issue?.minimumBidQuantity ?? null;
    const defaultLots = issue
      ? (lotSize && minBidQty ? Math.max(1, Math.round(minBidQty / lotSize)) : 1)
      : null;
    const defaultPrice = issue?.priceMax ?? issue?.priceMin ?? null;
    return {
      bankId,
      issueName: issue?.issueName || '',
      lots: defaultLots !== null ? String(defaultLots) : '',
      lotSize: lotSize ? String(lotSize) : '',
      bidType: 'CUTOFF',
      bidPrice: defaultPrice !== null ? String(defaultPrice) : '',
    };
  }

  function applyIpoSelectionToForm(issueName: string, bankId?: number | null) {
    const issue = ipoCatalog.find(entry => entry.issueName === issueName) ?? null;
    if (!issue) {
      setAuBidForm(f => ({
        ...f,
        bankId: bankId !== undefined ? bankId : f.bankId,
        issueName,
      }));
      return;
    }
    setAuBidForm(buildAuBidFormForIssue(bankId !== undefined ? bankId : auBidForm.bankId, issue));
  }

  async function loadIpoCatalog(forceRefresh = false, preferredIssueName?: string | null, bankId?: number | null) {
    const key = forceRefresh ? 'ipo-catalog-refresh' : 'ipo-catalog-load';
    setBusy(key);
    try {
      const result: any = forceRefresh
        ? await window.api.ipo.refreshCatalog()
        : await window.api.ipo.listCatalog();

      const issues = Array.isArray(result?.issues) ? result.issues as IpoCatalogIssue[] : [];
      setIpoCatalog(issues);

      if (issues.length) {
        const selected = getDefaultIpoIssue(issues, preferredIssueName ?? auBidForm.issueName);
        if (selected) {
          setAuBidForm(buildAuBidFormForIssue(bankId !== undefined ? bankId : auBidForm.bankId, selected));
        }
      } else if (forceRefresh) {
        showToast('info', result?.error || 'No IPO issues were available to refresh right now.');
      }

      return issues;
    } catch (e: any) {
      const message = e?.message || String(e);
      showToast('error', message);
      return [] as IpoCatalogIssue[];
    } finally {
      setBusy(null);
    }
  }

  async function openPrepareAuBid(member: Member, family: Family) {
    const key = `ipo-options-${member.id}`;
    setBusy(key);
    showToast('info', `Loading AU IPO options for ${member.full_name}...`);
    try {
      const result: any = await window.api.ipo.getMemberDraftOptions(member.id);
      if (!result?.ok) {
        showToast('error', result?.error || 'Could not load AU IPO options');
        return;
      }

      const options = result as AuBidDraftOptions & { ok: true };
      if (!(options.banks || []).length) {
        showToast('error', `${member.full_name} does not have an AU bank account with credentials.`);
        return;
      }

      setAuBidOptions({
        member: options.member,
        banks: options.banks,
        history: options.history || [],
      });
      setAuBidHistory(options.history || []);
      setPreparedAuBid(null);
      setIpoCatalog([]);
      setAuBidForm(buildAuBidFormForIssue(options.banks[0]?.id ?? null, null));
      setModal({
        type: 'prepare-au-bid',
        memberId: member.id,
        familyId: family.id,
        memberName: member.full_name,
      });
      const issues = await loadIpoCatalog(false, null, options.banks[0]?.id ?? null);
      if (!issues.length) {
        showToast('info', 'IPO list could not be prefetched right now. You can still type the issue name manually.');
      }
    } catch (e: any) {
      showToast('error', e?.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  async function prepareAuBid() {
    if (modal.type !== 'prepare-au-bid') return;
    const key = `ipo-prepare-${modal.memberId}`;
    const lots = parseInt(auBidForm.lots, 10);
    const lotSize = auBidForm.lotSize.trim() ? parseInt(auBidForm.lotSize, 10) : null;
    const quantity = lotSize && lots > 0 ? lots * lotSize : lots;
    const bidPrice = parseFloat(auBidForm.bidPrice);
    if (!auBidForm.bankId) {
      showToast('error', 'Select the AU bank account first.');
      return;
    }
    if (!auBidForm.issueName.trim()) {
      showToast('error', 'Enter the IPO issue name.');
      return;
    }
    if (!Number.isFinite(lots) || lots <= 0) {
      showToast('error', 'Enter number of lots (must be 1 or more).');
      return;
    }
    if (!Number.isFinite(bidPrice) || bidPrice <= 0) {
      showToast('error', 'Enter a valid price.');
      return;
    }
    const selectedIssue = ipoCatalog.find(issue => issue.issueName === auBidForm.issueName) ?? null;
    if (selectedIssue?.minimumBidQuantity && quantity < selectedIssue.minimumBidQuantity) {
      const minLots = lotSize ? Math.ceil(selectedIssue.minimumBidQuantity / lotSize) : selectedIssue.minimumBidQuantity;
      showToast('error', `Minimum is ${minLots} lot${minLots > 1 ? 's' : ''} (${selectedIssue.minimumBidQuantity} shares) for ${selectedIssue.issueName}.`);
      return;
    }
    if (selectedIssue && auBidForm.bidType === 'LIMIT') {
      if (selectedIssue.priceMin !== null && bidPrice < selectedIssue.priceMin) {
        showToast('error', `Bid price cannot be below ${formatINRRaw(selectedIssue.priceMin)}.`);
        return;
      }
      if (selectedIssue.priceMax !== null && bidPrice > selectedIssue.priceMax) {
        showToast('error', `Bid price cannot be above ${formatINRRaw(selectedIssue.priceMax)}.`);
        return;
      }
    }

    setBusy(key);
    showToast('info', `Preparing AU IPO bid for ${auBidForm.issueName.trim()}...`);
    try {
      const result: any = await window.api.ipo.prepareAuBid({
        memberId: modal.memberId,
        bankId: auBidForm.bankId,
        issueName: auBidForm.issueName.trim(),
        quantity,
        lotSize,
        bidType: auBidForm.bidType,
        bidPrice,
      });

      if (!result?.ok || !result.bidRun) {
        showToast('error', result?.error || 'AU IPO preparation failed');
        return;
      }

      const prepared = result.bidRun as PreparedAuBid;
      setPreparedAuBid(prepared);
      const refreshedHistory: any = await window.api.ipo.listMemberBids(modal.memberId);
      if (refreshedHistory?.ok) setAuBidHistory(refreshedHistory.history as IpoBidHistoryEntry[]);
      setModal({
        type: 'review-au-bid',
        memberId: modal.memberId,
        familyId: modal.familyId,
        memberName: modal.memberName,
      });
      showToast(
        prepared.readyToSubmit ? 'success' : 'info',
        prepared.readyToSubmit
          ? `AU bid prepared for ${prepared.issueName}. Review and confirm when ready.`
          : `AU session opened for ${prepared.issueName}. Review warnings before submitting.`
      );
    } catch (e: any) {
      showToast('error', e?.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  async function confirmAuBid() {
    if (modal.type !== 'review-au-bid' || !preparedAuBid) return;
    const key = `ipo-confirm-${preparedAuBid.id}`;
    setBusy(key);
    showToast('info', `Submitting AU IPO bid for ${preparedAuBid.issueName}...`);
    try {
      const result: any = await window.api.ipo.confirmAuBid(preparedAuBid.id);
      if (!result?.ok) {
        showToast('error', result?.error || 'AU IPO submission failed');
        return;
      }
      const refreshedHistory: any = await window.api.ipo.listMemberBids(modal.memberId);
      if (refreshedHistory?.ok) setAuBidHistory(refreshedHistory.history as IpoBidHistoryEntry[]);
      const successMsg = result.bankReference
        ? `AU bid submitted. Ref: ${result.bankReference}`
        : 'AU bid submitted. Check the AU window for the final acknowledgement.';
      showToast('success', successMsg);
      setModal({ type: 'none' });
      setPreparedAuBid(null);
      const nextIdx = auIpoQueueIndex + 1;
      if (nextIdx < auIpoMemberQueue.length) {
        await advanceToNextQueueMember(nextIdx);
      } else {
        setAuIpoMemberQueue([]);
        setAuIpoQueueIndex(0);
      }
    } catch (e: any) {
      showToast('error', e?.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  async function advanceToNextQueueMember(nextIdx: number) {
    const next = auIpoMemberQueue[nextIdx];
    if (!next) return;
    const savedIssueName = auBidForm.issueName;
    const savedLots      = auBidForm.lots;
    const savedLotSize   = auBidForm.lotSize;
    const savedBidType   = auBidForm.bidType;
    const savedBidPrice  = auBidForm.bidPrice;
    const key = `ipo-options-${next.member.id}`;
    setBusy(key);
    showToast('info', `Loading AU IPO options for ${next.member.full_name}...`);
    try {
      const result: any = await window.api.ipo.getMemberDraftOptions(next.member.id);
      if (!result?.ok) {
        showToast('error', result?.error || 'Could not load AU IPO options');
        return;
      }
      const options = result as AuBidDraftOptions & { ok: true };
      if (!(options.banks || []).length) {
        showToast('error', `${next.member.full_name} does not have an AU bank account with credentials.`);
        return;
      }
      setAuBidOptions({ member: options.member, banks: options.banks, history: options.history || [] });
      setAuBidHistory(options.history || []);
      setPreparedAuBid(null);
      setAuIpoQueueIndex(nextIdx);
      setAuBidForm({
        bankId: options.banks[0]?.id ?? null,
        issueName: savedIssueName,
        lots: savedLots,
        lotSize: savedLotSize,
        bidType: savedBidType,
        bidPrice: savedBidPrice,
      });
      setModal({
        type: 'prepare-au-bid',
        memberId: next.member.id,
        familyId: next.family.id,
        memberName: next.member.full_name,
      });
    } catch (e: any) {
      showToast('error', e?.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  /** Skip the current member in the batch and move to the next one (or close if last). */
  async function skipCurrentQueueMember() {
    const nextIdx = auIpoQueueIndex + 1;
    if (nextIdx < auIpoMemberQueue.length) {
      showToast('info', `Skipping — moving to ${auIpoMemberQueue[nextIdx].member.full_name}…`);
      await advanceToNextQueueMember(nextIdx);
    } else {
      setAuIpoMemberQueue([]);
      setAuIpoQueueIndex(0);
      setModal({ type: 'none' });
      setPreparedAuBid(null);
      showToast('info', 'AU IPO batch finished.');
    }
  }

  async function startAuIpoBatch() {
    if (auIpoSelectedIds.size === 0) {
      showToast('error', 'Select at least one member for AU IPO.');
      return;
    }
    const queue: Array<{member: Member; family: Family}> = [];
    for (const fam of families) {
      for (const member of (members[fam.id] || [])) {
        if (auIpoSelectedIds.has(member.id) && member.banks.some(b => b.has_password && b.bank_code === 'AU')) {
          queue.push({ member, family: fam });
        }
      }
    }
    if (queue.length === 0) {
      showToast('error', 'No valid AU bank members found in selection.');
      return;
    }
    setAuIpoMemberQueue(queue);
    setAuIpoQueueIndex(0);
    setAuIpoDropdownOpen(false);
    setAuIpoSelectedIds(new Set());
    await openPrepareAuBid(queue[0].member, queue[0].family);
  }

  async function runFamilyBankLogins(family: Family) {
    if (loginBusy) {
      showToast('info', 'Another bank or broker login is already in progress.');
      return;
    }

    const familyMembers = members[family.id] ?? await loadMembers(family.id);
    const targets = familyMembers.flatMap(member =>
      member.banks
        .filter(bank => bank.has_password)
        .map(bank => ({ member, bank }))
    );

    if (targets.length === 0) {
      showToast('info', `No bank accounts with credentials found in ${family.family_name}.`);
      return;
    }

    beginBulkActivity(`family-banks-${family.id}`);
    showToast('info', `Running bank logins for ${targets.length} account${targets.length === 1 ? '' : 's'} in ${family.family_name}...`);

    let successCount = 0;
    const failures: string[] = [];

    try {
      for (const { member, bank } of targets) {
        if (bulkWasStopped()) break;
        const result: any = await loginBank(member.id, bank, family.id, { silent: true });
        if (bulkWasStopped()) break;
        if (result?.ok) successCount += 1;
        else failures.push(`${member.full_name} (${bank.bank_code})${result?.error ? `: ${result.error}` : ''}`);
      }
    } finally {
      setBulkBusy(null);
      setBusy(null);
      await loadMembers(family.id);
    }

    if (bulkWasStopped()) {
      showToast('info', `Stopped bank login after ${successCount} account${successCount === 1 ? '' : 's'} in ${family.family_name}.`);
      return;
    }

    if (failures.length === 0) {
      showToast('success', `Completed bank login for ${successCount} account${successCount === 1 ? '' : 's'} in ${family.family_name}.`);
      return;
    }

    const preview = failures.slice(0, 2).join('; ');
    showToast('error', `Banks finished: ${successCount} success, ${failures.length} failed${preview ? `. ${preview}${failures.length > 2 ? '...' : ''}` : ''}`);
  }

  async function runFamilyAuBankRefresh(family: Family) {
    if (loginBusy) {
      showToast('info', 'Another bank or broker login is already in progress.');
      return;
    }

    const familyMembers = members[family.id] ?? await loadMembers(family.id);
    const targets = familyMembers.flatMap(member =>
      member.banks
        .filter(bank => bank.has_password && bank.bank_code === 'AU')
        .map(bank => ({ member, bank }))
    );

    if (targets.length === 0) {
      showToast('info', `No AU bank accounts with credentials found in ${family.family_name}.`);
      return;
    }

    beginBulkActivity(`family-au-banks-${family.id}`);
    showToast('info', `Refreshing AU balances for ${targets.length} account${targets.length === 1 ? '' : 's'} in ${family.family_name}...`);

    let successCount = 0;
    const failures: string[] = [];

    try {
      for (const { member, bank } of targets) {
        if (bulkWasStopped()) break;
        const result: any = await loginBank(member.id, bank, family.id, { silent: true, closeAfterFetch: true });
        if (bulkWasStopped()) break;
        if (result?.ok) successCount += 1;
        else failures.push(`${member.full_name} (${bank.bank_code})${result?.error ? `: ${result.error}` : ''}`);
      }
    } finally {
      setBulkBusy(null);
      setBusy(null);
      await loadMembers(family.id);
    }

    if (bulkWasStopped()) {
      showToast('info', `Stopped AU refresh after ${successCount} account${successCount === 1 ? '' : 's'} in ${family.family_name}.`);
      return;
    }

    if (failures.length === 0) {
      showToast('success', `Refreshed AU balances for ${successCount} account${successCount === 1 ? '' : 's'} in ${family.family_name}.`);
      return;
    }

    const preview = failures.slice(0, 2).join('; ');
    showToast('error', `AU refresh finished: ${successCount} success, ${failures.length} failed${preview ? `. ${preview}${failures.length > 2 ? '...' : ''}` : ''}`);
  }

  async function runFamilyBrokerLogins(family: Family) {
    if (loginBusy) {
      showToast('info', 'Another bank or broker login is already in progress.');
      return;
    }

    const familyMembers = members[family.id] ?? await loadMembers(family.id);
    const targets = familyMembers.flatMap(member =>
      member.brokers
        .filter(broker => broker.has_password)
        .map(broker => ({ member, broker }))
    );

    if (targets.length === 0) {
      showToast('info', `No broker accounts with credentials found in ${family.family_name}.`);
      return;
    }

    beginBulkActivity(`family-brokers-${family.id}`);
    showToast('info', `Running broker logins for ${targets.length} account${targets.length === 1 ? '' : 's'} in ${family.family_name}...`);

    let successCount = 0;
    const failures: string[] = [];

    try {
      for (const { member, broker } of targets) {
        if (bulkWasStopped()) break;
        const result: any = await loginBroker(member.id, broker, family.id, { silent: true, fetchBalance: true, closeAfterFetch: true });
        if (bulkWasStopped()) break;
        if (result?.ok) successCount += 1;
        else failures.push(`${member.full_name} (${broker.broker_code})${result?.error ? `: ${result.error}` : ''}`);
      }
    } finally {
      setBulkBusy(null);
      setBusy(null);
      await loadMembers(family.id);
    }

    if (bulkWasStopped()) {
      showToast('info', `Stopped broker refresh after ${successCount} account${successCount === 1 ? '' : 's'} in ${family.family_name}.`);
      return;
    }

    if (failures.length === 0) {
      showToast('success', `Completed broker login for ${successCount} account${successCount === 1 ? '' : 's'} in ${family.family_name}.`);
      return;
    }

    const preview = failures.slice(0, 2).join('; ');
    showToast('error', `Brokers finished: ${successCount} success, ${failures.length} failed${preview ? `. ${preview}${failures.length > 2 ? '...' : ''}` : ''}`);
  }

  async function runMemberBankLogins(member: Member, family: Family) {
    if (loginBusy) {
      showToast('info', 'Another bank or broker login is already in progress.');
      return;
    }

    const targets = member.banks.filter(bank => bank.has_password);
    if (targets.length === 0) {
      showToast('info', `No bank accounts with credentials found for ${member.full_name}.`);
      return;
    }

    beginBulkActivity(`member-banks-${member.id}`);
    showToast('info', `Running bank logins for ${member.full_name}...`);

    let successCount = 0;
    const failures: string[] = [];

    try {
      for (const bank of targets) {
        if (bulkWasStopped()) break;
        const result: any = await loginBank(member.id, bank, family.id, { silent: true });
        if (bulkWasStopped()) break;
        if (result?.ok) successCount += 1;
        else failures.push(`${bank.bank_code}${result?.error ? `: ${result.error}` : ''}`);
      }
    } finally {
      setBulkBusy(null);
      setBusy(null);
      await loadMembers(family.id);
    }

    if (bulkWasStopped()) {
      showToast('info', `Stopped bank login for ${member.full_name} after ${successCount} account${successCount === 1 ? '' : 's'}.`);
      return;
    }

    if (failures.length === 0) {
      showToast('success', `Completed bank login for ${member.full_name} (${successCount} account${successCount === 1 ? '' : 's'}).`);
      return;
    }

    showToast('error', `${member.full_name}: ${successCount} bank success, ${failures.length} failed. ${failures.slice(0, 2).join('; ')}${failures.length > 2 ? '...' : ''}`);
  }

  async function runAllAuBankRefresh() {
    if (loginBusy) {
      showToast('info', 'Another bank or broker login is already in progress.');
      return;
    }

    const familyEntries = await Promise.all(families.map(async family => ({
      family,
      members: members[family.id] ?? await loadMembers(family.id),
    })));

    const targets = familyEntries.flatMap(({ family, members: familyMembers }) =>
      familyMembers.flatMap(member =>
        member.banks
          .filter(bank => bank.has_password && bank.bank_code === 'AU')
          .map(bank => ({ family, member, bank }))
      )
    );

    if (targets.length === 0) {
      showToast('info', 'No AU bank accounts with credentials found across all families.');
      return;
    }

    beginBulkActivity('all-au-banks');
    showToast('info', `Refreshing AU balances for ${targets.length} account${targets.length === 1 ? '' : 's'} across all families...`);

    let successCount = 0;
    const failures: string[] = [];
    const touchedFamilyIds = new Set<number>();

    try {
      for (const { family, member, bank } of targets) {
        if (bulkWasStopped()) break;
        touchedFamilyIds.add(family.id);
        const result: any = await loginBank(member.id, bank, family.id, { silent: true, closeAfterFetch: true });
        if (bulkWasStopped()) break;
        if (result?.ok) successCount += 1;
        else failures.push(`${member.full_name} / ${family.family_name}${result?.error ? `: ${result.error}` : ''}`);
      }
    } finally {
      setBulkBusy(null);
      setBusy(null);
      await Promise.all(Array.from(touchedFamilyIds).map(id => loadMembers(id)));
    }

    if (bulkWasStopped()) {
      showToast('info', `Stopped AU refresh after ${successCount} account${successCount === 1 ? '' : 's'} across all families.`);
      return;
    }

    if (failures.length === 0) {
      showToast('success', `Refreshed AU balances for ${successCount} account${successCount === 1 ? '' : 's'} across all families.`);
      return;
    }

    const preview = failures.slice(0, 2).join('; ');
    showToast('error', `AU refresh finished: ${successCount} success, ${failures.length} failed${preview ? `. ${preview}${failures.length > 2 ? '...' : ''}` : ''}`);
  }

  async function runMemberBrokerLogins(member: Member, family: Family) {
    if (loginBusy) {
      showToast('info', 'Another bank or broker login is already in progress.');
      return;
    }

    const targets = member.brokers.filter(broker => broker.has_password);
    if (targets.length === 0) {
      showToast('info', `No broker accounts with credentials found for ${member.full_name}.`);
      return;
    }

    beginBulkActivity(`member-brokers-${member.id}`);
    showToast('info', `Running broker logins for ${member.full_name}...`);

    let successCount = 0;
    const failures: string[] = [];

    try {
      for (const broker of targets) {
        if (bulkWasStopped()) break;
        const result: any = await loginBroker(member.id, broker, family.id, { silent: true, fetchBalance: true, closeAfterFetch: true });
        if (bulkWasStopped()) break;
        if (result?.ok) successCount += 1;
        else failures.push(`${broker.broker_code}${result?.error ? `: ${result.error}` : ''}`);
      }
    } finally {
      setBulkBusy(null);
      setBusy(null);
      await loadMembers(family.id);
    }

    if (bulkWasStopped()) {
      showToast('info', `Stopped broker refresh for ${member.full_name} after ${successCount} account${successCount === 1 ? '' : 's'}.`);
      return;
    }

    if (failures.length === 0) {
      showToast('success', `Completed broker login for ${member.full_name} (${successCount} account${successCount === 1 ? '' : 's'}).`);
      return;
    }

    showToast('error', `${member.full_name}: ${successCount} broker success, ${failures.length} failed. ${failures.slice(0, 2).join('; ')}${failures.length > 2 ? '...' : ''}`);
  }

  async function runImport() {
    setBusy('import');
    const result: any = await window.api.importer.pickAndRun();
    setBusy(null);
    if (result.cancelled) return;
    result.ok
      ? (showToast('success', `Imported ${result.familiesImported} families, ${result.membersImported} members`), loadFamilies())
      : showToast('error', result.error || 'Import failed');
  }

  async function runExport() {
    setBusy('export');
    const result: any = await window.api.exporter.pickAndRun();
    setBusy(null);
    if (result.cancelled) return;
    result.ok
      ? showToast('success', `Exported ${result.membersExported} members (${result.banksExported} banks, ${result.brokersExported} brokers)`)
      : showToast('error', result.error || 'Export failed');
  }

  async function reconnectGmailStatus() {
    setBusy('gmail-connect');
    try {
      const result: any = await window.api.gmail.connect();
      if (result.ok && result.status) {
        setGmailStatus(result.status as GmailStatus);
        showToast('success', 'Gmail connected');
      } else {
        showToast('error', result.error || 'Gmail sign-in failed');
      }
    } finally {
      setBusy(null);
      await loadGmailStatus();
    }
  }

  function configureGmailCredentials() {
    setServiceConfigValue('');
    setModal({ type: 'service-config', service: 'gmail' });
  }

  async function clearGmailCredentials() {
    if (!window.confirm('Remove the saved Google OAuth JSON and Gmail sign-in from this app?')) return;
    setBusy('gmail-clear');
    try {
      const result: any = await window.api.gmail.clearCredentials();
      if (result.ok && result.status) {
        setGmailStatus(result.status as GmailStatus);
        showToast('success', 'Google OAuth setup removed');
      } else {
        showToast('error', result.error || 'Could not clear Google OAuth setup');
      }
    } finally {
      setBusy(null);
      await loadGmailStatus();
    }
  }

  function configureCaptchaProvider() {
    setServiceConfigValue('');
    setModal({ type: 'service-config', service: 'captcha-anthropic' });
    void loadCaptchaUsage();
  }

  async function loadCaptchaUsage() {
    try {
      const result: any = await window.api.captchaAi.getUsage();
      if (result?.ok) setCaptchaUsage(result.usage);
    } catch { /* ignore */ }
  }

  async function toggleCaptchaConsent(consented: boolean) {
    try {
      const result: any = await window.api.captchaAi.setConsent(consented);
      if (result?.ok) {
        setCaptchaUsage(result.usage);
        showToast('success', consented ? 'CAPTCHA upload consent recorded' : 'Consent revoked — no more uploads will be made');
      }
    } catch (e: any) {
      showToast('error', e?.message || String(e));
    }
  }

  async function setCaptchaCap(cap: number) {
    try {
      const result: any = await window.api.captchaAi.setCap(cap);
      if (result?.ok) setCaptchaUsage(result.usage);
    } catch (e: any) {
      showToast('error', e?.message || String(e));
    }
  }

  async function resetCaptchaCounter() {
    try {
      const result: any = await window.api.captchaAi.resetTodayCounter();
      if (result?.ok) {
        setCaptchaUsage(result.usage);
        showToast('success', "Today's counter reset to 0");
      }
    } catch (e: any) {
      showToast('error', e?.message || String(e));
    }
  }

  // ── Member detail card (click name → copyable credentials) ─────────────────
  async function openMemberCard(memberId: number, memberName: string) {
    setMemberDetailLoading(true);
    setMemberDetail(null);
    setModal({ type: 'member-card', memberId, memberName });
    try {
      const detail = await window.api.member.fullDetail(memberId);
      setMemberDetail(detail);
    } catch (e: any) {
      showToast('error', e?.message || 'Could not load member details');
    } finally {
      setMemberDetailLoading(false);
    }
  }

  // ── Backup helpers ──────────────────────────────────────────────────────────
  function backupTone(): 'good' | 'warn' | 'bad' | 'muted' {
    if (!backupInfo?.config.enabled || !backupInfo.config.folder) return 'muted';
    if (backupInfo.state.inProgress) return 'good';
    if (!backupInfo.state.lastBackupAt) return 'warn';
    const ageH = (Date.now() - new Date(backupInfo.state.lastBackupAt).getTime()) / 3_600_000;
    if (ageH < 24) return 'good';
    if (ageH < 72) return 'warn';
    return 'bad';
  }

  function backupLabel(): string {
    if (!backupInfo) return 'Backup: checking...';
    if (!backupInfo.config.enabled || !backupInfo.config.folder) return 'Backup: off';
    if (backupInfo.state.inProgress) return 'Backup: syncing...';
    if (!backupInfo.state.lastBackupAt) return 'Backup: pending';
    const age = formatAge(backupInfo.state.lastBackupAt);
    return `Backup: ${age}`;
  }

  function openBackupSettings() {
    void loadBackupStatus();
    setModal({ type: 'backup-settings' });
  }

  async function chooseBackupFolder() {
    try {
      const result: any = await window.api.backup.pickFolder();
      if (!result?.ok) return;
      await window.api.backup.setConfig({ folder: result.folder, enabled: true });
      await loadBackupStatus();
      showToast('success', 'Backup folder set');
    } catch (e: any) {
      showToast('error', e?.message || String(e));
    }
  }

  async function toggleBackupEnabled(enabled: boolean) {
    try {
      await window.api.backup.setConfig({ enabled });
      await loadBackupStatus();
    } catch (e: any) {
      showToast('error', e?.message || String(e));
    }
  }

  async function runBackupNow() {
    setBusy('backup-run');
    try {
      const result: any = await window.api.backup.runNow();
      if (result?.ok) {
        showToast('success',
          `Backup done · ${result.documentsCopied || 0} new docs · ${result.documentsReused || 0} reused · ${result.durationMs || 0}ms`);
      } else {
        showToast('error', result?.error || 'Backup failed');
      }
      await loadBackupStatus();
    } catch (e: any) {
      showToast('error', e?.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  async function openRestoreDialog() {
    setBusy('backup-list');
    try {
      const result: any = await window.api.backup.listSnapshots();
      if (result?.ok) {
        setBackupSnapshots(result.snapshots || []);
        setRestoreSourceFolder(null);
        setModal({ type: 'restore-backup' });
      } else {
        showToast('error', result?.error || 'Could not list backups');
      }
    } finally {
      setBusy(null);
    }
  }

  async function pickRestoreFolder() {
    setBusy('backup-list');
    try {
      const folderResult: any = await window.api.backup.pickFolder();
      if (!folderResult?.ok) return;
      const listResult: any = await window.api.backup.listSnapshotsFromFolder(folderResult.folder);
      if (listResult?.ok) {
        setBackupSnapshots(listResult.snapshots || []);
        setRestoreSourceFolder(folderResult.folder);
      } else {
        showToast('error', listResult?.error || 'Could not read snapshots in that folder');
      }
    } finally {
      setBusy(null);
    }
  }

  async function clearBrowserSessions() {
    if (!confirm('Clear all cached bank/broker browser sessions? You will need to log in to each bank/broker again on the next refresh.')) return;
    setBusy('clear-sessions');
    try {
      const result: any = await window.api.automation.clearBrowserSessions();
      if (result?.ok) {
        showToast('success',
          `Cleared ${result.profilesDeleted || 0} browser profile${result.profilesDeleted === 1 ? '' : 's'}` +
          (result.contextsClosed ? ` (closed ${result.contextsClosed} active session${result.contextsClosed === 1 ? '' : 's'})` : ''));
      } else {
        showToast('error', result?.error || 'Could not clear browser sessions');
      }
    } catch (e: any) {
      showToast('error', e?.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  async function resetVault() {
    const phrase = window.prompt(
      'This will permanently delete your vault, all credentials, all documents,\n' +
      'all logs, all browser sessions, the Gmail token, and the CAPTCHA AI key.\n\n' +
      'Your backup folder will NOT be touched — restore from there if you need\n' +
      'this data back later.\n\n' +
      'Type RESET (in capitals) to confirm:'
    );
    if (phrase !== 'RESET') {
      if (phrase !== null) showToast('error', 'Confirmation phrase did not match — nothing was deleted.');
      return;
    }
    // Require the current master password too — second factor protecting
    // against accidental confirmation OR a malicious script that knows the
    // RESET phrase but not the password.
    const password = window.prompt(
      'Enter your current master password to confirm reset:'
    );
    if (!password) {
      showToast('error', 'Password not entered — nothing was deleted.');
      return;
    }
    setBusy('vault-reset');
    try {
      const result: any = await window.api.vault.reset(phrase, password);
      if (result?.ok) {
        showToast('success', 'Vault reset — restart on the unlock screen now.');
      } else {
        showToast('error', result?.error || 'Reset failed');
      }
    } catch (e: any) {
      showToast('error', e?.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  async function restoreSelectedSnapshot(snapshotId: string) {
    if (!confirm(
      `Restore from snapshot ${snapshotId}?\n\n` +
      'This will REPLACE your current vault. A copy of the old vault will be ' +
      'saved next to vault.db as a .pre-restore-* file in case you need to roll back.'
    )) return;
    setBusy('backup-restore');
    try {
      const result: any = await window.api.backup.restore(snapshotId, restoreSourceFolder || undefined);
      if (result?.ok) {
        showToast('success', `Restored · ${result.documentsRestored || 0} documents`);
        setModal({ type: 'none' });
        // Reload everything from the restored DB
        await loadFamilies();
        await loadBackupStatus();
      } else {
        showToast('error', result?.error || 'Restore failed');
      }
    } finally {
      setBusy(null);
    }
  }

  async function clearCaptchaProvider() {
    if (!window.confirm('Remove the stored Anthropic API key from Windows Credential Manager?')) return;
    setBusy('captcha-clear-anthropic');
    try {
      const result: any = await window.api.captchaAi.clearKey();
      if (result.ok && result.status) {
        setCaptchaAiStatus(result.status as CaptchaAiStatus);
        showToast('success', 'Claude CAPTCHA key removed');
      } else {
        showToast('error', result.error || 'Could not clear Anthropic API key');
      }
    } finally {
      setBusy(null);
      await loadCaptchaAiStatus();
    }
  }

  async function saveServiceConfig() {
    if (modal.type !== 'service-config') return;
    const value = serviceConfigValue.trim();
    if (!value) return;

    if (modal.service === 'gmail') {
      setBusy('gmail-configure');
      try {
        const result: any = await window.api.gmail.setCredentials(value);
        if (result.ok && result.status) {
          setGmailStatus(result.status as GmailStatus);
          showToast('success', 'Google OAuth JSON saved');
          setModal({ type: 'none' });
          setServiceConfigValue('');
        } else {
          showToast('error', result.error || 'Could not save Google OAuth JSON');
        }
      } finally {
        setBusy(null);
        await loadGmailStatus();
      }
      return;
    }

    setBusy('captcha-connect-anthropic');
    try {
      const result: any = await window.api.captchaAi.setKey(value);
      if (result.ok && result.status) {
        setCaptchaAiStatus(result.status as CaptchaAiStatus);
        // Saving a paid API key is itself an act of consent — auto-flip the
        // flag so the user doesn't have to find a checkbox. They can revoke
        // any time from the same modal.
        try { await window.api.captchaAi.setConsent(true); } catch { /* */ }
        showToast('success', 'Claude CAPTCHA connected · uploads enabled');
        setModal({ type: 'none' });
        setServiceConfigValue('');
      } else {
        showToast('error', result.error || 'Could not save Anthropic API key');
      }
    } finally {
      setBusy(null);
      await loadCaptchaAiStatus();
      await loadCaptchaUsage();
    }
  }

  function gmailTone(state: GmailStatus['state'] | undefined): 'good' | 'warn' | 'bad' | 'muted' {
    if (state === 'connected') return 'good';
    if (state === 'not_connected' || state === 'needs_reauth') return 'warn';
    if (state === 'missing_credentials' || state === 'error') return 'bad';
    return 'muted';
  }

  function captchaAiTone(state: CaptchaAiStatus['state'] | CaptchaProviderStatus['state'] | undefined): 'good' | 'warn' | 'bad' | 'muted' {
    if (state === 'connected') return 'good';
    if (state === 'not_connected') return 'warn';
    if (state === 'error') return 'bad';
    return 'muted';
  }

  // â"€â"€ Member form helpers â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

  function setBank  (code: string, field: string, v: string) { setMemberForm(f => ({ ...f, banks:   f.banks.map(b   => b.bank_code   === code ? { ...b,   [field]: v } : b)   })); }
  function setBroker(code: string, field: string, v: string) { setMemberForm(f => ({ ...f, brokers: f.brokers.map(b => b.broker_code === code ? { ...b,   [field]: v } : b)   })); }
  function addBank(code: string) {
    if (!code || memberForm.banks.find(b => b.bank_code === code)) return;
    setMemberForm(f => ({ ...f, banks: [...f.banks, blankBank(code)] })); setBankToAdd('');
  }
  function removeBank(code: string)   { setMemberForm(f => ({ ...f, banks:   f.banks.filter(b   => b.bank_code   !== code) })); }
  function addBroker(code: string) {
    if (!code || memberForm.brokers.find(b => b.broker_code === code)) return;
    setMemberForm(f => ({ ...f, brokers: [...f.brokers, blankBroker(code)] })); setBrokerToAdd('');
  }
  function removeBroker(code: string) { setMemberForm(f => ({ ...f, brokers: f.brokers.filter(b => b.broker_code !== code) })); }

  // â"€â"€ Derived â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

  const totalMembers  = families.reduce((s, f) => s + f.member_count, 0);
  const hasAnyAuBanks = families.some(family =>
    (members[family.id] || []).some(member => member.banks.some(bank => bank.has_password && bank.bank_code === 'AU'))
  );
  const isModalOpen   = modal.type !== 'none';
  const isMemberModal = modal.type === 'add-member' || modal.type === 'edit-member';
  const isFamilyModal = modal.type === 'add-family' || modal.type === 'edit-family';
  const isPortfolioModal = modal.type === 'view-portfolio';
  const isAuBidModal = modal.type === 'prepare-au-bid' || modal.type === 'review-au-bid';
  const isServiceConfigModal = modal.type === 'service-config';
  const selectedFamily = selectedView !== 'all'
    ? families.find(f => f.id === selectedView) ?? null : null;
  const loginBusy = !!bulkBusy || !!busy && (
    busy.startsWith('bank-')
    || busy.startsWith('broker-')
    || busy.startsWith('report-')
    || busy.startsWith('ipo-')
  );
  const bulkStopLabel = bulkBusy
    ? bulkBusy === 'all-au-banks'
      ? 'Refreshing AU for all families'
      : bulkBusy.includes('brokers')
        ? 'Refreshing broker accounts'
        : bulkBusy.includes('au-banks')
          ? 'Refreshing AU accounts'
          : 'Running bank accounts'
    : null;
  const auBidLots = parseInt(auBidForm.lots || '0', 10);
  const auBidLotSizeNum = parseInt(auBidForm.lotSize || '0', 10);
  const auBidQuantity = auBidLots > 0 && auBidLotSizeNum > 0 ? auBidLots * auBidLotSizeNum : auBidLots;
  const auBidPrice = parseFloat(auBidForm.bidPrice || '0');
  const selectedIpoIssue = ipoCatalog.find(issue => issue.issueName === auBidForm.issueName) ?? null;
  const auBidBlockedAmount = Number.isFinite(auBidQuantity) && Number.isFinite(auBidPrice) && auBidQuantity > 0 && auBidPrice > 0
    ? auBidQuantity * auBidPrice
    : 0;

  /** Grand savings + deposit totals across all families (fetched balances only). */
  const grandParts = families.reduce<BalanceParts>((acc, f) => {
    const p = computeFamilyParts(members[f.id] || []);
    return { savings: acc.savings + p.savings, deposit: acc.deposit + p.deposit };
  }, { savings: 0, deposit: 0 });

  function LogoThumb({ kind, code }: { kind: 'bank' | 'broker'; code: string }) {
    const [failed, setFailed] = useState(false);
    const initials = kind === 'bank'
      ? (BANK_THUMB[code] || code.slice(0, 2))
      : (BROKER_THUMB[code] || code.slice(0, 2));
    const src = kind === 'bank' ? BANK_LOGO_SRC[code] : BROKER_LOGO_SRC[code];

    return (
      <span className={`thumb thumb-${kind} thumb-${code.toLowerCase()}`}>
        {!failed && src ? (
          <img
            className="thumb-logo"
            src={src}
            alt={`${code} logo`}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
          />
        ) : (
          <span className="thumb-fallback">{initials}</span>
        )}
      </span>
    );
  }

  function FamilyBulkButtons({ family, familyBanks, familyBrokers, compact = false, stopClicks = false }: {
    family: Family;
    familyBanks: string[];
    familyBrokers: string[];
    compact?: boolean;
    stopClicks?: boolean;
  }) {
    const bankBusyKey = `family-banks-${family.id}`;
    const auBusyKey = `family-au-banks-${family.id}`;
    const brokerBusyKey = `family-brokers-${family.id}`;
    const hasAuBank = familyBanks.includes('AU');

    const wrapClick = (runner: (family: Family) => Promise<void>) => async (e: React.MouseEvent) => {
      if (stopClicks) e.stopPropagation();
      await runner(family);
    };

    if (familyBanks.length === 0 && familyBrokers.length === 0) return null;

    return (
      <div className={`family-bulk-actions ${compact ? 'compact' : ''}`}>
        {familyBanks.length > 0 && (
          <button
            className="btn-bank btn-bulk"
            disabled={loginBusy}
            title="Log in and fetch balances for all bank accounts in this family"
            onClick={wrapClick(runFamilyBankLogins)}
          >
            {bulkBusy === bankBusyKey ? 'Running Banks...' : 'All Banks'}
          </button>
        )}
        {hasAuBank && (
          <button
            className="btn-bank btn-bulk"
            disabled={loginBusy}
            title="Refresh balances only for AU bank accounts in this family"
            onClick={wrapClick(runFamilyAuBankRefresh)}
          >
            {bulkBusy === auBusyKey ? 'Refreshing AU...' : 'Refresh AU'}
          </button>
        )}
        {familyBrokers.length > 0 && (
          <button
            className="btn-broker btn-bulk"
            disabled={loginBusy}
            title="Log in and fetch balances for all broker accounts in this family"
            onClick={wrapClick(runFamilyBrokerLogins)}
          >
            {bulkBusy === brokerBusyKey ? 'Refreshing...' : 'Refresh Brokers'}
          </button>
        )}
      </div>
    );
  }

  function MemberBulkButtons({ member, family, compact = false }: {
    member: Member;
    family: Family;
    compact?: boolean;
  }) {
    const memberBanks = member.banks.filter(bank => bank.has_password);
    const memberBrokers = member.brokers.filter(broker => broker.has_password);
    const bankBusyKey = `member-banks-${member.id}`;
    const brokerBusyKey = `member-brokers-${member.id}`;

    if (memberBanks.length === 0 && memberBrokers.length === 0) return null;

    return (
      <div className={`member-bulk-actions ${compact ? 'compact' : ''}`}>
        {memberBanks.length > 0 && (
          <button
            className="btn-bank btn-bulk"
            disabled={loginBusy}
            title="Log in and fetch balances for all bank accounts of this member"
            onClick={() => runMemberBankLogins(member, family)}
          >
            {bulkBusy === bankBusyKey ? 'Banks...' : 'All Banks'}
          </button>
        )}
        {memberBrokers.length > 0 && (
          <button
            className="btn-broker btn-bulk"
            disabled={loginBusy}
            title="Log in and fetch balances for all broker accounts of this member"
            onClick={() => runMemberBrokerLogins(member, family)}
          >
            {bulkBusy === brokerBusyKey ? 'Refreshing...' : 'Refresh Brokers'}
          </button>
        )}
      </div>
    );
  }

  // â"€â"€ Member row (shared between both views) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

  function MemberRow({ m, family, familyBanks, familyBrokers, showTableHeaders = true }: {
    m: Member; family: Family; familyBanks: string[]; familyBrokers: string[]; showTableHeaders?: boolean;
  }) {
    const visibleBanks = m.banks.filter(b => b.has_password);
    const visibleBrokers = m.brokers.filter(b => b.has_password);

    return (
      <div className="member"
        draggable
        onDragStart={e => onMemberDragStart(e, m.id, family.id)}
        onDragOver={onMemberDragOver}
        onDrop={e => onMemberDrop(e, m.id, family.id)}>

        <span className="drag-handle member-drag" title="Drag to reorder">::</span>

        <div className="member-info">
          <div className="member-name">
            <span
              className="member-title-text member-name-clickable"
              onClick={() => openMemberCard(m.id, m.full_name)}
              title="Click to view all saved credentials"
            >{m.full_name}</span>
            {m.member_type === 'HUF' && <span className="member-tag huf">HUF</span>}
            {(m.pan || m.pan_last4) && (
              <span
                className={`member-inline-id ${m.documents?.PAN?.hasFile ? 'click-copy member-inline-id-download' : 'member-inline-id-muted'}`}
                onClick={() => handleIdentityDocumentClick(m, 'PAN')}
                title={m.documents?.PAN?.hasFile ? 'Click to download PAN softcopy' : 'PAN softcopy not uploaded'}
              >
                PAN {m.pan || `****${m.pan_last4}`}
              </span>
            )}
            {(m.aadhaar || m.aadhaar_last4) && (
              <span
                className={`member-inline-id ${m.documents?.AADHAAR?.hasFile ? 'click-copy member-inline-id-download' : 'member-inline-id-muted'}`}
                onClick={() => handleIdentityDocumentClick(m, 'AADHAAR')}
                title={m.documents?.AADHAAR?.hasFile ? 'Click to download Aadhaar softcopy' : 'Aadhaar softcopy not uploaded'}
              >
                AADHAAR {m.aadhaar || `****${m.aadhaar_last4}`}
              </span>
            )}
          </div>
        </div>

        <div className="account-sections">
          <section className="account-section account-section-banks">
            <div className="account-table-wrap">
              <table className="account-table bank-table">
                <colgroup>
                  <col className="bank-col-name" />
                  <col className="bank-col-balance" />
                  <col className="bank-col-updated" />
                </colgroup>
                {showTableHeaders && (
                  <thead>
                    <tr>
                      <th>Bank</th>
                      <th>Balance Fetched</th>
                      <th>Updated</th>
                    </tr>
                  </thead>
                )}
                <tbody>
                  {visibleBanks.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="account-empty-cell">No bank accounts saved</td>
                    </tr>
                  ) : visibleBanks.map(bank => {
                    const parts = parseBalanceParts(bank.balance);
                    return (
                      <tr key={bank.id}>
                        <td>
                          <button
                            className="account-name-button bank-name-button"
                            disabled={loginBusy}
                            onClick={() => loginBank(m.id, bank, family.id)}
                          >
                            {busy === `bank-${bank.id}` ? (
                              <span>Fetching...</span>
                            ) : (
                              <>
                                <LogoThumb kind="bank" code={bank.bank_code} />
                                <span>{bank.bank_code}</span>
                              </>
                            )}
                          </button>
                        </td>
                        <td>
                          {bank.balance ? (
                            <div className="account-inline-metrics">
                              {parts.savings > 0 && (
                                <span className="account-inline-metric savings">
                                  <span>Sav</span>
                                  <strong>{formatTableAmount(parts.savings)}</strong>
                                </span>
                              )}
                              {parts.deposit > 0 && (
                                <span className="account-inline-metric deposit">
                                  <span>FD</span>
                                  <strong>{formatTableAmount(parts.deposit)}</strong>
                                </span>
                              )}
                              {parts.savings === 0 && parts.deposit === 0 && (
                                <span className="account-inline-metric savings">
                                  <span>Bal</span>
                                  <strong>{formatTableAmountText(bank.balance)}</strong>
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="account-empty-value">Not fetched</span>
                          )}
                        </td>
                        <td className="account-time-cell">{bank.balance_fetched_at ? formatAge(bank.balance_fetched_at) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="account-section account-section-brokers">
            <div className="account-table-wrap">
              <table className="account-table broker-table">
                <colgroup>
                  <col className="broker-col-name" />
                  <col className="broker-col-funds" />
                  <col className="broker-col-portfolio" />
                  <col className="broker-col-positions" />
                  <col className="broker-col-updated" />
                </colgroup>
                {showTableHeaders && (
                  <thead>
                    <tr>
                      <th>Broker</th>
                      <th>Funds</th>
                      <th>Portfolio</th>
                      <th>Positions</th>
                      <th>Updated</th>
                    </tr>
                  </thead>
                )}
                <tbody>
                  {visibleBrokers.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="account-empty-cell">No broker accounts saved</td>
                    </tr>
                  ) : visibleBrokers.map(broker => {
                    const bp = parseBrokerBalance(broker.balance);
                    const portfolioValue = bp.portfolio ?? broker.portfolio_value ?? null;
                    const brokerUpdatedAt = broker.balance_fetched_at || broker.portfolio_fetched_at || null;
                    return (
                      <tr key={broker.id}>
                        <td>
                          <button
                            className="account-name-button broker-name-button"
                            disabled={loginBusy}
                            onClick={() => loginBroker(m.id, broker, family.id, { fetchBalance: false })}
                          >
                            {busy === `broker-${broker.id}` ? (
                              <span>Opening...</span>
                            ) : (
                              <>
                                <LogoThumb kind="broker" code={broker.broker_code} />
                                <span>{broker.broker_code}</span>
                              </>
                            )}
                          </button>
                        </td>
                        <td className="account-number-cell funds">
                          {bp.funds !== null ? formatTableAmount(bp.funds) : '—'}
                        </td>
                        <td className="account-number-cell portfolio">
                          <div className="broker-portfolio-cell">
                            <span>{portfolioValue !== null ? formatTableAmount(portfolioValue) : '—'}</span>
                            {canDownloadBrokerPortfolio(broker.broker_code) && (
                              <span className="broker-table-actions">
                                <button
                                  className="btn-row broker-report-btn"
                                  disabled={loginBusy}
                                  title={`Save latest ${broker.broker_code} holdings report and open its folder`}
                                  onClick={() => downloadBrokerPortfolio(m.id, broker, family.id)}
                                >
                                  {busy === `report-${broker.id}` ? 'Saving...' : 'Save & Open'}
                                </button>
                                <button
                                  className="btn-row broker-report-btn broker-report-folder-btn"
                                  disabled={loginBusy}
                                  title={`Open saved ${broker.broker_code} report folder`}
                                  onClick={() => openBrokerReportFolder(m, broker)}
                                >
                                  {busy === `report-folder-${broker.id}` ? 'Opening...' : 'Folder'}
                                </button>
                                <button
                                  className="btn-row broker-report-btn broker-report-view-btn"
                                  disabled={loginBusy}
                                  title={`View latest parsed ${broker.broker_code} portfolio`}
                                  onClick={() => openBrokerPortfolioViewer(m, broker)}
                                >
                                  {busy === `portfolio-view-${broker.id}` ? 'Loading...' : 'View'}
                                </button>
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="account-number-cell positions">
                          {bp.positions !== null ? formatTableAmount(bp.positions) : '—'}
                        </td>
                        <td className="account-time-cell">{brokerUpdatedAt ? formatAge(brokerUpdatedAt) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <div className="member-row-actions">
          <MemberBulkButtons member={m} family={family} compact />
          {editMode && <button className="btn-row" onClick={() => openEditMember(m.id, family.id)} title="Edit">Edit</button>}
          {editMode && <button className="btn-row danger" onClick={() => deleteMember(m.id, family.id, m.full_name)} title="Delete">✕</button>}
        </div>
      </div>
    );
  }

  // â"€â"€ Render â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

  return (
    <div className="app">

      {/* â"€â"€ Sidebar â"€â"€ */}
      <aside className="sidebar">

        {/* Brand — always visible at top */}
        <div className="brand">
          <div className="brand-mark" style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            IPO Manager
            {appVersion && (
              <span style={{ fontSize: 11, fontWeight: 400, color: '#555', letterSpacing: 0 }}>
                v{appVersion}
              </span>
            )}
          </div>
          <div className="brand-sub">
            <span className="status-dot" />vault unlocked
            <button
              className="lock-now-btn"
              onClick={lockVault}
              title="Lock vault now (Ctrl+L)"
              aria-label="Lock vault"
            >🔒 Lock</button>
          </div>
          <div className="gmail-status-row">
            <button
              className={`gmail-status-pill ${gmailTone(gmailStatus?.state)}`}
              onClick={configureGmailCredentials}
              title={gmailStatus?.detail || 'Click to configure Gmail'}
            >
              <span className="status-dot" />
              {gmailStatus?.label || 'Checking Gmail...'}
            </button>
          </div>
          <div className="gmail-status-row">
            <button
              className={`gmail-status-pill ${captchaAiTone(captchaAiStatus?.state)}`}
              onClick={configureCaptchaProvider}
              title={
                captchaAiStatus?.detail
                  ? `${captchaAiStatus.detail}${captchaUsage ? ` · Today: ${captchaUsage.calls}${captchaUsage.cap > 0 ? '/' + captchaUsage.cap : ''}` : ''}`
                  : 'Click to configure CAPTCHA AI'
              }
            >
              <span className="status-dot" />
              {captchaAiStatus?.label || 'Checking CAPTCHA AI...'}
              {captchaUsage && captchaAiStatus?.configured && (
                <span style={{
                  marginLeft: 6, opacity: 0.7, fontSize: 9,
                  color: captchaUsage.cap > 0 && captchaUsage.calls >= captchaUsage.cap ? 'var(--danger)' : undefined,
                }}>
                  ({captchaUsage.calls}{captchaUsage.cap > 0 ? `/${captchaUsage.cap}` : ''})
                </span>
              )}
            </button>
          </div>
          <div className="gmail-status-row">
            <button
              className={`gmail-status-pill ${backupTone()}`}
              onClick={openBackupSettings}
              title={
                backupInfo?.state.lastBackupError
                  ? `Last error: ${backupInfo.state.lastBackupError}`
                  : backupInfo?.config.folder
                    ? `Backup folder: ${backupInfo.config.folder}`
                    : 'Click to configure backup'
              }
            >
              <span className="status-dot" />
              {backupLabel()}
            </button>
          </div>
        </div>

        {/* Scrollable nav area */}
        <div className="sidebar-nav">
          <div className="nav-section-row">
            <span className="nav-section-label">Families</span>
            <button className="btn-icon" title="Add family" onClick={openAddFamily}>+</button>
          </div>

          {/* View All */}
          <div
            className={`nav-item ${selectedView === 'all' ? 'active' : ''}`}
            onClick={selectAll}
          >
            <span className="nav-item-name">View All</span>
            <span className="nav-count">{totalMembers}</span>
          </div>


          {/* Individual families */}
          {families.map(f => (
            <div
              key={f.id}
              className={`nav-item ${selectedView === f.id ? 'active' : ''}`}
              draggable
              onDragStart={e => onFamilyDragStart(e, f.id)}
              onDragOver={onFamilyDragOver}
              onDrop={e => onFamilyDrop(e, f.id)}
            >
              <span className="drag-handle" title="Drag to reorder">::</span>
              <span className="nav-item-name" onClick={() => selectFamily(f.id)}>{f.family_name}</span>
              <span className="nav-count">{f.member_count}</span>
              <div className="nav-item-actions">
                <button className="btn-icon" title="Edit family"
                  onClick={e => { e.stopPropagation(); openEditFamily(f); }}>Edit</button>
                <button className="btn-icon btn-icon-danger" title="Delete family"
                  onClick={e => { e.stopPropagation(); deleteFamily(f.id, f.family_name); }}>X</button>
              </div>
            </div>
          ))}

          <div className="nav-section" style={{ marginTop: 24 }}>Tools</div>
          <div
            className={`nav-item ${selectedView === 'recharge' ? 'active' : ''}`}
            onClick={() => setSelectedView('recharge')}
          >
            <span className="nav-item-name">SIM Recharge Tracker</span>
          </div>
          <div
            className={`nav-item ${selectedView === 'totp' ? 'active' : ''}`}
            onClick={() => setSelectedView('totp')}
          >
            <span className="nav-item-name">Zerodha TOTP</span>
          </div>
          <div className="nav-item" onClick={runImport}>
            <span className="nav-item-name">Import Excel</span>
            {busy === 'import' && <span className="nav-count">...</span>}
          </div>
          <div className="nav-item" onClick={runExport}>
            <span className="nav-item-name">Export Excel</span>
            {busy === 'export' && <span className="nav-count">...</span>}
          </div>
          <div className="nav-item" onClick={openChangeMasterPassword}>
            <span className="nav-item-name">Change Master Password</span>
          </div>
        </div>

        {/* Developer credit — always visible at bottom */}
        <div className="dev-credit">
          <div className="dev-credit-label">Developed by</div>
          <div className="dev-credit-name">CA Akshay Daiya</div>
          <div className="dev-credit-links">
            <a href="mailto:akshaybkn@gmail.com" className="dev-credit-link">
              ✉ akshaybkn@gmail.com
            </a>
            <a
              href="https://wa.me/919929089598"
              target="_blank"
              rel="noreferrer"
              className="dev-credit-link"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
              </svg>
              +91 99290 89598
            </a>
          </div>
        </div>
      </aside>

      {/* â"€â"€ Main panel â"€â"€ */}
      <main className="main">
        {/* Auto-update banner — only shows when an update is available, downloading, or ready. */}
        {(updater.kind === 'available' || updater.kind === 'downloading' || updater.kind === 'downloaded') && (
          <div
            style={{
              background: updater.kind === 'downloaded' ? 'linear-gradient(90deg, #1e6e3e, #14532d)' : 'linear-gradient(90deg, #1e3a8a, #1e40af)',
              color: 'white',
              padding: '10px 20px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: 13,
              gap: 16,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 16 }}>{updater.kind === 'downloaded' ? '✓' : '⬇'}</span>
              <div>
                <strong>
                  {updater.kind === 'available' && `Update available: v${updater.version}`}
                  {updater.kind === 'downloading' && `Downloading update v${updater.version}…`}
                  {updater.kind === 'downloaded' && `Update v${updater.version} ready to install`}
                </strong>
                {updater.kind === 'downloading' && (
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 2 }}>{updater.percent ?? 0}% downloaded</div>
                )}
              </div>
            </div>
            {updater.kind === 'downloaded' && (
              <button
                onClick={installUpdateNow}
                disabled={installing}
                style={{
                  background: 'white',
                  color: '#1e40af',
                  border: 'none',
                  padding: '6px 14px',
                  borderRadius: 4,
                  fontWeight: 600,
                  cursor: installing ? 'wait' : 'pointer',
                }}
              >
                {installing ? 'Restarting…' : 'Restart and install'}
              </button>
            )}
          </div>
        )}
        {bulkStopLabel && (
          <div className="activity-stop-panel">
            <div>
              <div className="activity-stop-title">{bulkStopLabel}</div>
              <div className="activity-stop-sub">You can stop the batch now. The current browser window will be closed and remaining accounts will be skipped.</div>
            </div>
            <button className="btn btn-danger-ghost" onClick={stopCurrentActivity}>
              Stop
            </button>
          </div>
        )}

        {/* ── SIM Recharge Tracker ── */}
        {selectedView === 'recharge' && <RechargeTrackerPage />}

        {/* ── Zerodha TOTP ── */}
        {selectedView === 'totp' && <ZerodhaTotpPage />}


        {/* ── View All ── */}
        {selectedView === 'all' && (
          <>
            <div className="page-head">
              <div>
                <div className="page-title">All Members</div>
                <div className="page-meta" style={{ marginTop: 4 }}>
                  {families.length} {families.length === 1 ? 'family' : 'families'} · {totalMembers} members
                </div>
                <div className="grand-total-row" style={{ marginTop: 10 }}>
                  {grandParts.savings > 0 && (
                    <span className="grand-total-chip savings">
                      <span className="chip-label">Savings</span>
                      {formatTableAmount(grandParts.savings)}
                    </span>
                  )}
                  {grandParts.deposit > 0 && (
                    <span className="grand-total-chip deposit">
                      <span className="chip-label">FD</span>
                      {formatTableAmount(grandParts.deposit)}
                    </span>
                  )}
                  {grandParts.savings > 0 && grandParts.deposit > 0 && (
                    <span className="grand-total-chip total">
                      <span className="chip-label">Total</span>
                      {formatTableAmount(grandParts.savings + grandParts.deposit)}
                    </span>
                  )}
                  <button
                    className={`btn-row${editMode ? ' active-edit-mode' : ''}`}
                    title={editMode ? 'Exit edit mode' : 'Edit families and members'}
                    onClick={() => setEditMode(e => !e)}
                    style={editMode ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
                  >
                    {editMode ? 'Done' : 'Edit'}
                  </button>
                  <button
                    className="btn-bank btn-bulk"
                    title="Check upcoming IPOs on Chittorgarh"
                    onClick={() => window.api.shell.openExternal('https://www.chittorgarh.com/ipo/ipo_dashboard.asp')}
                  >
                    Chittorgarh
                  </button>
                  <button
                    className="btn-bank btn-bulk"
                    title="Check live IPO GMP on InvestorGain"
                    onClick={() => window.api.shell.openExternal('https://www.investorgain.com/report/ipo-gmp-live/331/ipo/')}
                  >
                    GMP
                  </button>
                  {hasAnyAuBanks && (
                    <>
                      <button
                        className="btn-bank btn-bulk"
                        disabled={loginBusy}
                        title="Refresh balances only for AU bank accounts across all families"
                        onClick={runAllAuBankRefresh}
                      >
                        {bulkBusy === 'all-au-banks' ? 'Refreshing...' : 'Refresh All AU'}
                      </button>
                      <div className="au-ipo-dropdown-wrap" ref={auIpoDropdownRef}>
                        <button
                          className="btn-bank btn-bulk"
                          disabled={loginBusy}
                          title="File AU IPO bids for multiple members"
                          onClick={() => setAuIpoDropdownOpen(o => !o)}
                        >
                          AU IPO {auIpoDropdownOpen ? '▲' : '▼'}
                        </button>
                        {auIpoDropdownOpen && (
                          <div className="au-ipo-member-dropdown">
                            {/* Scrollable member list — footer never scrolls away */}
                            <div className="au-ipo-dropdown-scroll">
                              {families.map(fam => {
                                const auMembers = (members[fam.id] || []).filter(m =>
                                  m.banks.some(b => b.has_password && b.bank_code === 'AU')
                                );
                                if (auMembers.length === 0) return null;
                                const allSelected = auMembers.length > 0 && auMembers.every(m => auIpoSelectedIds.has(m.id));
                                const someSelected = auMembers.some(m => auIpoSelectedIds.has(m.id));
                                const partial = someSelected && !allSelected;
                                return (
                                  <div key={fam.id}>
                                    <label className="au-ipo-dropdown-family au-ipo-dropdown-family-select">
                                      <input
                                        type="checkbox"
                                        checked={allSelected}
                                        ref={el => { if (el) el.indeterminate = partial; }}
                                        onChange={e => {
                                          setAuIpoSelectedIds(prev => {
                                            const next = new Set(prev);
                                            if (e.target.checked) auMembers.forEach(m => next.add(m.id));
                                            else auMembers.forEach(m => next.delete(m.id));
                                            return next;
                                          });
                                        }}
                                      />
                                      {fam.family_name}
                                    </label>
                                    {auMembers.map(m => (
                                      <label key={m.id} className="au-ipo-dropdown-member">
                                        <input
                                          type="checkbox"
                                          checked={auIpoSelectedIds.has(m.id)}
                                          onChange={e => {
                                            setAuIpoSelectedIds(prev => {
                                              const next = new Set(prev);
                                              if (e.target.checked) next.add(m.id);
                                              else next.delete(m.id);
                                              return next;
                                            });
                                          }}
                                        />
                                        {m.full_name}
                                      </label>
                                    ))}
                                  </div>
                                );
                              })}
                            </div>
                            {/* Footer always visible — outside the scroll container */}
                            <div className="au-ipo-dropdown-footer">
                              <button
                                className="btn"
                                disabled={auIpoSelectedIds.size === 0 || loginBusy}
                                onClick={startAuIpoBatch}
                              >
                                Start {auIpoSelectedIds.size > 0 ? `(${auIpoSelectedIds.size})` : ''}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
              <div className="page-meta">{new Date().toLocaleDateString('en-IN', {
                weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
              })}</div>
            </div>

            {families.length === 0 && (
              <div className="empty">
                <div className="empty-title">No families yet</div>
                <div className="empty-sub">Import your Demat_Sheet.xlsx or add a family manually.</div>
                <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
                  <button className="btn" onClick={openAddFamily}>Add Family</button>
                  <button className="btn btn-ghost" onClick={runImport} disabled={busy === 'import'}>
                    {busy === 'import' ? 'Importing...' : 'Import Excel'}
                  </button>
                </div>
              </div>
            )}

            {families.map(family => {
              const isExpanded    = expandedFamilies.has(family.id);
              const memberList    = members[family.id] || [];
              const loaded        = !!members[family.id];
              const fp            = computeFamilyParts(memberList);
              const hasBalances   = fp.savings > 0 || fp.deposit > 0;
              const familyBanks   = BANKS.filter(code => memberList.some(m => m.banks.some(b => b.has_password && b.bank_code === code)));
              const familyBrokers = BROKERS.filter(code => memberList.some(m => m.brokers.some(b => b.has_password && b.broker_code === code)));

              // ── Balance Management computations ─────────────────────────────
              const STALE_DAYS = 15;
              const OK_BUFFER  = 5_000;
              const minLimit   = family.min_balance || 0;

              type BmRow = { member: string; bank: string; savings: number; deposit: number; fetchedAt: string | null };
              const bmRows: BmRow[] = [];
              const missingBal: { member: string; bank: string }[] = [];

              memberList.forEach(m => {
                m.banks.forEach(b => {
                  if (!b.has_password) return;
                  if (b.balance !== null) {
                    const p = parseBalanceParts(b.balance);
                    bmRows.push({ member: m.full_name, bank: b.bank_code, savings: p.savings, deposit: p.deposit, fetchedAt: b.balance_fetched_at });
                  } else {
                    missingBal.push({ member: m.full_name, bank: b.bank_code });
                  }
                });
              });

              const totalSavings = bmRows.reduce((s, r) => s + r.savings, 0);
              const totalDeposit = bmRows.reduce((s, r) => s + r.deposit, 0);
              const hasBmData    = bmRows.length > 0;
              const diff         = (hasBmData && minLimit) ? totalSavings - minLimit : null;

              const bmStatus: 'ok' | 'attention' | 'nolimit' | 'nodata' | 'loading' =
                !loaded                                                                       ? 'loading'
                : !minLimit                                                                   ? 'nolimit'
                : !hasBmData                                                                  ? 'nodata'
                : totalSavings >= minLimit && totalSavings <= minLimit + OK_BUFFER ? 'ok'
                : 'attention';

              const staleRows = bmRows.filter(r => {
                if (!r.fetchedAt) return false;
                return (Date.now() - new Date(r.fetchedAt).getTime()) / 86_400_000 > STALE_DAYS;
              });

              const diffLabel = diff === null ? null
                : diff === 0 ? '0'
                : diff > 0   ? `+${formatTableAmount(diff)}`
                : `-${formatTableAmount(-diff)}`;

              return (
                <div key={family.id} className="family-accordion">
                  {/* ── Summary row (always visible) ── */}
                  <div
                    className={"family-summary-row" + (isExpanded ? " is-expanded" : "")}
                    onClick={() => toggleFamily(family.id)}
                  >
                    <span className={"family-chevron" + (isExpanded ? " open" : "")}>&#8250;</span>
                    <span className="family-summary-name">{family.family_name}</span>
                    <span className="family-summary-count">{family.member_count} {family.member_count === 1 ? "member" : "members"}</span>

                    {hasBalances && (
                      <span className="family-balance-group">
                        {fp.savings > 0 && (
                          <span className="family-bal-chip savings">
                            <span className="chip-label">Savings</span>
                            {formatTableAmount(fp.savings)}
                          </span>
                        )}
                        {fp.deposit > 0 && (
                          <span className="family-bal-chip deposit">
                            <span className="chip-label">FD</span>
                            {formatTableAmount(fp.deposit)}
                          </span>
                        )}
                      </span>
                    )}

                    {/* Balance status pill */}
                    {bmStatus === 'ok' && (
                      <span className="bm-pill bm-pill-ok">✓ OK{diffLabel ? ` · ${diffLabel}` : ''}</span>
                    )}
                    {bmStatus === 'attention' && (
                      <span className="bm-pill bm-pill-attention">
                        {diff !== null && diff < 0 ? `⚠ Short ${formatTableAmount(-diff)}` : `⚠ Over ${diffLabel}`}
                      </span>
                    )}
                    {bmStatus === 'nolimit' && (
                      <span className="bm-pill bm-pill-muted">No limit</span>
                    )}
                    {bmStatus === 'nodata' && (
                      <span className="bm-pill bm-pill-muted">No data</span>
                    )}
                    {staleRows.length > 0 && bmStatus !== 'loading' && (
                      <span className="bm-pill bm-pill-stale" title={`${staleRows.length} stale balance(s)`}>⏱ Stale</span>
                    )}

                    <div className="family-summary-actions" onClick={e => e.stopPropagation()}>
                      <FamilyBulkButtons
                        family={family}
                        familyBanks={familyBanks}
                        familyBrokers={familyBrokers}
                        compact
                        stopClicks
                      />
                      {editMode && <button className="btn-row" onClick={() => openAddMember(family.id)}>+ Member</button>}
                      {editMode && <button className="btn-row" onClick={() => openEditFamily(family)}>Edit</button>}
                      {editMode && <button className="btn-row danger" onClick={() => deleteFamily(family.id, family.family_name)}>✕</button>}
                    </div>
                  </div>

                  {/* ── Expanded panel ── */}
                  {isExpanded && (
                    <div className="family-members-panel">

                      {/* Balance strip */}
                      {loaded && (minLimit > 0 || hasBmData || missingBal.length > 0) && (
                        <div className={`bm-strip bm-strip-${bmStatus}`}>
                          <div className="bm-strip-metrics">
                            <div className="bm-strip-item">
                              <span className="bm-strip-label">Min Limit</span>
                              <span className="bm-strip-value">
                                {minLimit ? formatTableAmount(minLimit) : <span className="bm-strip-nil">Not set</span>}
                              </span>
                            </div>
                            <div className="bm-strip-sep" />
                            <div className="bm-strip-item">
                              <span className="bm-strip-label">Total Savings</span>
                              <span className="bm-strip-value">
                                {hasBmData ? formatTableAmount(totalSavings) : <span className="bm-strip-nil">No data</span>}
                              </span>
                            </div>
                            {totalDeposit > 0 && (
                              <>
                                <div className="bm-strip-sep" />
                                <div className="bm-strip-item">
                                  <span className="bm-strip-label">FD / Deposit</span>
                                  <span className="bm-strip-value bm-strip-fd">{formatTableAmount(totalDeposit)}</span>
                                </div>
                              </>
                            )}
                            {diff !== null && (
                              <>
                                <div className="bm-strip-sep" />
                                <div className="bm-strip-item">
                                  <span className="bm-strip-label">{diff >= 0 ? 'Excess' : 'Shortfall'}</span>
                                  <span className={`bm-strip-value ${bmStatus === 'ok' ? 'bm-strip-ok' : 'bm-strip-bad'}`}>
                                    {diffLabel}
                                  </span>
                                </div>
                              </>
                            )}
                            <div className="bm-strip-spacer" />
                            <button
                              className="btn-row"
                              style={{ flexShrink: 0 }}
                              onClick={e => { e.stopPropagation(); openEditFamily(family); }}
                            >
                              {minLimit ? 'Edit Limit' : 'Set Limit'}
                            </button>
                          </div>

                          {/* Inline warnings */}
                          {staleRows.length > 0 && (
                            <div className="bm-strip-warn stale">
                              <span>⏱</span>
                              <span>
                                Stale balance (over {STALE_DAYS}d):{' '}
                                {staleRows.map((r, i) => {
                                  const days = Math.floor((Date.now() - new Date(r.fetchedAt!).getTime()) / 86_400_000);
                                  return (
                                    <span key={i}>
                                      <strong>{r.member}</strong> ({r.bank}) — {days}d old{i < staleRows.length - 1 ? '; ' : ''}
                                    </span>
                                  );
                                })}
                                . Please log in to refresh.
                              </span>
                            </div>
                          )}
                          {missingBal.length > 0 && (
                            <div className="bm-strip-warn info">
                              <span>ℹ</span>
                              <span>
                                Balance not fetched:{' '}
                                {missingBal.map((e, i) => (
                                  <span key={i}><strong>{e.member}</strong> ({e.bank}){i < missingBal.length - 1 ? ', ' : ''}</span>
                                ))}
                                . Click the bank button below to log in.
                              </span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Member rows */}
                      {memberList.length === 0 ? (
                        <div className="family-section-empty">No members yet — click + Member to add one.</div>
                      ) : (
                        memberList.map((m, index) => (
                          <MemberRow
                            key={m.id}
                            m={m}
                            family={family}
                            familyBanks={familyBanks}
                            familyBrokers={familyBrokers}
                            showTableHeaders={index === 0}
                          />
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}

        {/* ── Single-family view ── */}
        {selectedFamily && (() => {
          const sfMembers     = members[selectedFamily.id] || [];
          const sfp           = computeFamilyParts(sfMembers);
          const familyBanks   = BANKS.filter(code => sfMembers.some(m => m.banks.some(b => b.has_password && b.bank_code === code)));
          const familyBrokers = BROKERS.filter(code => sfMembers.some(m => m.brokers.some(b => b.has_password && b.broker_code === code)));
          return (
            <>
              <div className="page-head">
                <div>
                  <div className="page-title">{selectedFamily.family_name}</div>
                  <div className="page-meta" style={{ marginTop: 4 }}>
                    {sfMembers.length} members
                  </div>
                  {(sfp.savings > 0 || sfp.deposit > 0) && (
                    <div className="grand-total-row">
                      {sfp.savings > 0 && (
                        <span className="grand-total-chip savings">
                          <span className="chip-label">Savings</span>
                          {formatTableAmount(sfp.savings)}
                        </span>
                      )}
                      {sfp.deposit > 0 && (
                        <span className="grand-total-chip deposit">
                          <span className="chip-label">FD</span>
                          {formatTableAmount(sfp.deposit)}
                        </span>
                      )}
                      {sfp.savings > 0 && sfp.deposit > 0 && (
                        <span className="grand-total-chip total">
                          <span className="chip-label">Total</span>
                          {formatTableAmount(sfp.savings + sfp.deposit)}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <div className="page-head-actions">
                  <FamilyBulkButtons
                    family={selectedFamily}
                    familyBanks={familyBanks}
                    familyBrokers={familyBrokers}
                  />
                  <button className="btn btn-ghost" onClick={() => openEditFamily(selectedFamily)}>Edit</button>
                  <button className="btn btn-ghost btn-danger-ghost"
                    onClick={() => deleteFamily(selectedFamily.id, selectedFamily.family_name)}>
                    Delete
                  </button>
                  <button className="btn" onClick={() => openAddMember(selectedFamily.id)}>+ Add Member</button>
                </div>
              </div>

              {sfMembers.length === 0 && (
                <div className="empty">
                  <div className="empty-title">No members yet</div>
                  <div className="empty-sub">Add the first member to {selectedFamily.family_name}.</div>
                  <button className="btn" onClick={() => openAddMember(selectedFamily.id)}>+ Add Member</button>
                </div>
              )}

              {sfMembers.map((m, index) =>
                <MemberRow
                  key={m.id}
                  m={m}
                  family={selectedFamily}
                  familyBanks={familyBanks}
                  familyBrokers={familyBrokers}
                  showTableHeaders={index === 0}
                />
              )}
            </>
          );
        })()}
      </main>

      {/* â"€â"€ Modals â"€â"€ */}
      {isModalOpen && (
        <div className="modal-overlay" onClick={() => setModal({ type: 'none' })}>
          <div className={`modal ${isPortfolioModal ? 'portfolio-modal' : ''} ${modal.type === 'member-card' ? 'member-card-modal' : ''}`} onClick={e => e.stopPropagation()}>

            {isPortfolioModal && (() => {
              const report = portfolioReport;
              const scopes = (report?.holdings ?? []).some(h => !h.is_combined_view)
                ? (['EQUITY', 'MUTUAL_FUNDS'] as const).filter(scope =>
                    report?.holdings.some(h => h.asset_scope === scope && !h.is_combined_view)
                  )
                : (['COMBINED'] as const);
              const visibleHoldings = (report?.holdings ?? []).filter(h =>
                portfolioAssetScope === 'COMBINED'
                  ? !!h.is_combined_view
                  : h.asset_scope === portfolioAssetScope && !h.is_combined_view
              );
              const visibleDerived = visibleHoldings.map(holding => ({
                holding,
                metrics: holdingDerivedMetrics(holding),
              }));
              const summaryTotals = visibleDerived.reduce((acc, item) => {
                acc.invested += item.metrics.invested;
                acc.present += item.metrics.present;
                acc.pnl += item.metrics.pnl;
                return acc;
              }, { invested: 0, present: 0, pnl: 0 });
              const summaryPnlPct = summaryTotals.invested > 0
                ? (summaryTotals.pnl / summaryTotals.invested) * 100
                : summaryTotals.present > 0 ? 100 : 0;
              const primarySummary = report?.summaries.find(s => s.asset_scope === portfolioAssetScope)
                ?? report?.summaries.find(s => s.asset_scope === 'COMBINED')
                ?? report?.summaries[0]
                ?? null;

              return (
                <>
                  <div className="modal-head">
                    {modal.memberName} · {modal.brokerCode} Portfolio
                  </div>
                  <div className="modal-body modal-body-scroll portfolio-body">
                    {!report ? (
                      <div className="empty">
                        <div className="empty-title">Portfolio not loaded</div>
                        <div className="empty-sub">Try downloading the latest broker portfolio first.</div>
                      </div>
                    ) : (
                      <>
                        <div className="portfolio-meta-row">
                          <span>Client {primarySummary?.client_id || '—'}</span>
                          <span>As of {report.asOfDate || primarySummary?.as_of_date || '—'}</span>
                          <span>{report.fileName || 'portfolio.xlsx'}</span>
                          <span>{formatAge(report.downloadedAt)}</span>
                        </div>

                        {primarySummary && (
                          <div className="portfolio-summary-grid">
                            <div className="portfolio-summary-card">
                              <div className="portfolio-summary-label">Invested</div>
                              <div className="portfolio-summary-value">
                                {formatINRRaw(summaryTotals.invested)}
                              </div>
                            </div>
                            <div className="portfolio-summary-card">
                              <div className="portfolio-summary-label">Present</div>
                              <div className="portfolio-summary-value">
                                {formatINRRaw(summaryTotals.present)}
                              </div>
                            </div>
                            <div className="portfolio-summary-card">
                              <div className="portfolio-summary-label">Unrealized P&L</div>
                              <div className={`portfolio-summary-value ${summaryTotals.pnl < 0 ? 'neg' : 'pos'}`}>
                                {formatINRRaw(summaryTotals.pnl)}
                              </div>
                            </div>
                            <div className="portfolio-summary-card">
                              <div className="portfolio-summary-label">P&L %</div>
                              <div className={`portfolio-summary-value ${summaryPnlPct < 0 ? 'neg' : 'pos'}`}>
                                {formatPct(summaryPnlPct)}
                              </div>
                            </div>
                          </div>
                        )}

                        {scopes.length > 1 && (
                          <div className="portfolio-scope-tabs">
                            {scopes.map(scope => (
                              <button
                                key={scope}
                                className={`btn-row portfolio-scope-tab ${portfolioAssetScope === scope ? 'active' : ''}`}
                                onClick={() => setPortfolioAssetScope(scope)}
                              >
                                {scope === 'EQUITY' ? 'Equity' : scope === 'MUTUAL_FUNDS' ? 'Mutual Funds' : 'Combined'}
                              </button>
                            ))}
                          </div>
                        )}

                        <div className="portfolio-table-wrap">
                          <table className="portfolio-table">
                            <thead>
                              <tr>
                                <th>Symbol</th>
                                <th>ISIN</th>
                                <th>{portfolioAssetScope === 'MUTUAL_FUNDS' ? 'Instrument' : 'Sector'}</th>
                                <th className="portfolio-col-r">Total Qty</th>
                                <th className="portfolio-col-r">Avg</th>
                                <th className="portfolio-col-r">Prev</th>
                                <th className="portfolio-col-r">Present</th>
                                <th className="portfolio-col-r">Unrealized</th>
                                <th className="portfolio-col-r">P&L %</th>
                              </tr>
                            </thead>
                            <tbody>
                              {visibleHoldings.length === 0 ? (
                                <tr>
                                  <td colSpan={9} className="portfolio-empty-cell">No holdings available for this view.</td>
                                </tr>
                              ) : visibleDerived.map(({ holding, metrics }) => (
                                <tr key={`${holding.sheet_name}-${holding.row_order}-${holding.symbol}`}>
                                  <td className="portfolio-symbol-cell">
                                    <strong>{holding.symbol}</strong>
                                  </td>
                                  <td>{holding.isin || '—'}</td>
                                  <td>{holding.instrument_type || holding.sector || '—'}</td>
                                  <td className="portfolio-col-r">{formatNullableNumber(metrics.quantity, 3)}</td>
                                  <td className="portfolio-col-r">{holding.average_price !== null && holding.average_price > 0 ? formatINRRaw(holding.average_price) : 'Nil'}</td>
                                  <td className="portfolio-col-r">{holding.previous_closing_price !== null ? formatINRRaw(holding.previous_closing_price) : '—'}</td>
                                  <td className="portfolio-col-r">
                                    {formatINRRaw(metrics.present)}
                                  </td>
                                  <td className={`portfolio-col-r ${metrics.pnl < 0 ? 'neg' : 'pos'}`}>
                                    {formatINRRaw(metrics.pnl)}
                                  </td>
                                  <td className={`portfolio-col-r ${metrics.pnlPct < 0 ? 'neg' : 'pos'}`}>
                                    {formatPct(metrics.pnlPct)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                  </div>
                  <div className="modal-foot">
                    <button className="btn btn-ghost" onClick={() => setModal({ type: 'none' })}>Close</button>
                  </div>
                </>
              );
            })()}

            {modal.type === 'prepare-au-bid' && (
              <>
                <div className="modal-head">
                  Prepare AU IPO Bid · {modal.memberName}
                </div>
                <div className="modal-body modal-body-scroll">
                  <div className="au-ipo-grid">
                    <div className="form-field form-field-span-2">
                      <label>AU Bank Account</label>
                      <select
                        value={auBidForm.bankId ?? ''}
                        onChange={e => setAuBidForm(f => ({ ...f, bankId: parseInt(e.target.value, 10) || null }))}
                      >
                        <option value="">Select AU account</option>
                        {(auBidOptions?.banks || []).map(bank => (
                          <option key={bank.id} value={bank.id}>{bank.bank_code} · #{bank.id}</option>
                        ))}
                      </select>
                    </div>
                    <div className="form-field form-field-span-2">
                      <div className="au-ipo-field-head">
                        <label>IPO Issue</label>
                        <button
                          type="button"
                          className="btn-row au-ipo-refresh-btn"
                          disabled={busy === 'ipo-catalog-refresh'}
                          onClick={() => loadIpoCatalog(true, auBidForm.issueName, auBidForm.bankId)}
                        >
                          {busy === 'ipo-catalog-refresh' ? 'Refreshing...' : 'Refresh List'}
                        </button>
                      </div>
                      {ipoCatalog.length > 0 ? (
                        <>
                          {/* Category tabs — Mainboard (default) / SME */}
                          {(() => {
                            const mainboardList = ipoCatalog.filter(i => !isSmeListing(i));
                            const smeList = ipoCatalog.filter(i => isSmeListing(i));
                            const activeList = ipoCategory === 'sme' ? smeList : mainboardList;
                            return (
                              <>
                                <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
                                  <button
                                    type="button"
                                    className={`btn-row${ipoCategory === 'mainboard' ? ' active' : ''}`}
                                    style={{
                                      padding: '3px 10px', fontSize: 12,
                                      background: ipoCategory === 'mainboard' ? '#3b82f6' : undefined,
                                      color: ipoCategory === 'mainboard' ? '#fff' : undefined,
                                    }}
                                    onClick={() => setIpoCategory('mainboard')}
                                  >
                                    Mainboard {mainboardList.length > 0 ? `(${mainboardList.length})` : ''}
                                  </button>
                                  <button
                                    type="button"
                                    className={`btn-row${ipoCategory === 'sme' ? ' active' : ''}`}
                                    style={{
                                      padding: '3px 10px', fontSize: 12,
                                      background: ipoCategory === 'sme' ? '#3b82f6' : undefined,
                                      color: ipoCategory === 'sme' ? '#fff' : undefined,
                                    }}
                                    onClick={() => setIpoCategory('sme')}
                                  >
                                    SME {smeList.length > 0 ? `(${smeList.length})` : ''}
                                  </button>
                                </div>
                                {activeList.length > 0 ? (
                                  <select
                                    autoFocus
                                    value={auBidForm.issueName}
                                    onChange={e => applyIpoSelectionToForm(e.target.value)}
                                  >
                                    <option value="">Select {ipoCategory === 'sme' ? 'SME' : 'mainboard'} IPO</option>
                                    {activeList.map(issue => (
                                      <option key={issue.issueName} value={issue.issueName}>
                                        {issue.issueName}{issue.status === 'LIVE' ? ' · Live' : issue.status === 'FORTHCOMING' ? ' · Forthcoming' : ''}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <div style={{ fontSize: 12, color: '#666', padding: '6px 0' }}>
                                    No {ipoCategory === 'sme' ? 'SME' : 'mainboard'} IPOs in the current list.
                                    {ipoCategory === 'sme'
                                      ? ' Switch to Mainboard or type the name manually below.'
                                      : ' Try refreshing or type the name manually below.'}
                                  </div>
                                )}
                                <input
                                  style={{ marginTop: 6 }}
                                  value={auBidForm.issueName}
                                  onChange={e => setAuBidForm(f => ({ ...f, issueName: e.target.value }))}
                                  placeholder="Or type issue name manually…"
                                />
                              </>
                            );
                          })()}
                        </>
                      ) : (
                        <input
                          autoFocus
                          value={auBidForm.issueName}
                          onChange={e => setAuBidForm(f => ({ ...f, issueName: e.target.value }))}
                          placeholder="Type IPO issue name manually"
                        />
                      )}
                    </div>
                    {selectedIpoIssue && (
                      <div className="au-ipo-prefill-grid form-field-span-2">
                        <div className="au-ipo-prefill-item">
                          <span>Status</span>
                          <strong>{selectedIpoIssue.status === 'LIVE' ? 'Live' : selectedIpoIssue.status === 'FORTHCOMING' ? 'Forthcoming' : 'Issue'}</strong>
                        </div>
                        <div className="au-ipo-prefill-item">
                          <span>Price Band</span>
                          <strong>{formatIpoPriceBand(selectedIpoIssue)}</strong>
                        </div>
                        <div className="au-ipo-prefill-item">
                          <span>Lot Size</span>
                          <strong>{selectedIpoIssue.lotSize || '—'}</strong>
                        </div>
                        <div className="au-ipo-prefill-item">
                          <span>Min Qty</span>
                          <strong>{selectedIpoIssue.minimumBidQuantity || selectedIpoIssue.lotSize || '—'}</strong>
                        </div>
                        <div className="au-ipo-prefill-item">
                          <span>Open</span>
                          <strong>{formatIpoDate(selectedIpoIssue.openDate)}</strong>
                        </div>
                        <div className="au-ipo-prefill-item">
                          <span>Close</span>
                          <strong>{formatIpoDate(selectedIpoIssue.closeDate)}</strong>
                        </div>
                      </div>
                    )}
                    {!selectedIpoIssue && ipoCatalog.length === 0 && (
                      <div className="au-ipo-catalog-note form-field-span-2">
                        Live IPO catalog could not be prefetched right now. You can still type the issue name manually and continue.
                      </div>
                    )}
                    <div className="form-field form-field-span-2">
                      <label>Lots</label>
                      <div className="lot-input-row">
                        <button
                          type="button"
                          className="lot-btn"
                          onClick={() => setAuBidForm(f => ({ ...f, lots: String(Math.max(1, parseInt(f.lots || '1', 10) - 1)) }))}
                        >−</button>
                        <input
                          className="au-lot-input"
                          type="number"
                          min="1"
                          value={auBidForm.lots}
                          onChange={e => setAuBidForm(f => ({ ...f, lots: e.target.value }))}
                          placeholder="1"
                        />
                        <button
                          type="button"
                          className="lot-btn"
                          onClick={() => setAuBidForm(f => ({ ...f, lots: String(parseInt(f.lots || '0', 10) + 1) }))}
                        >+</button>
                        {auBidLotSizeNum > 0 && auBidLots > 0 && (
                          <span className="lot-computed-qty">= {auBidQuantity} shares</span>
                        )}
                      </div>
                    </div>
                    <div className="form-field">
                      <label>Bid Type</label>
                      <select
                        value={auBidForm.bidType}
                        onChange={e => {
                          const newType = e.target.value as 'CUTOFF' | 'LIMIT';
                          const newPrice = newType === 'CUTOFF' && selectedIpoIssue?.priceMax
                            ? String(selectedIpoIssue.priceMax)
                            : auBidForm.bidPrice;
                          setAuBidForm(f => ({ ...f, bidType: newType, bidPrice: newPrice }));
                        }}
                      >
                        <option value="CUTOFF">Cut-Off</option>
                        <option value="LIMIT">Limit</option>
                      </select>
                    </div>
                    <div className="form-field">
                      <label>{auBidForm.bidType === 'CUTOFF' ? 'Cap Price (frozen)' : 'Bid Price'}</label>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={auBidForm.bidPrice}
                        readOnly={auBidForm.bidType === 'CUTOFF'}
                        disabled={auBidForm.bidType === 'CUTOFF'}
                        onChange={e => setAuBidForm(f => ({ ...f, bidPrice: e.target.value }))}
                        placeholder={auBidForm.bidType === 'CUTOFF' ? 'Auto from price band' : 'e.g. 321'}
                        style={auBidForm.bidType === 'CUTOFF' ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                      />
                    </div>
                  </div>

                  <div className="au-ipo-summary-card">
                    <div className="au-ipo-summary-row">
                      <span>Blocked amount</span>
                      <strong>{auBidBlockedAmount > 0 ? formatINRRaw(auBidBlockedAmount) : '—'}</strong>
                    </div>
                  </div>

                  {auBidHistory.length > 0 && (
                    <div className="au-ipo-history">
                      <div className="form-section">Recent AU IPO Runs</div>
                      <div className="au-ipo-history-list">
                        {auBidHistory.slice(0, 5).map(entry => (
                          <div key={entry.id} className="au-ipo-history-item">
                            <div>
                              <strong>{entry.issueName}</strong>
                              <span className={`au-ipo-status au-ipo-status-${entry.status.toLowerCase()}`}>{entry.status}</span>
                            </div>
                            <div className="au-ipo-history-meta">
                              <span>{entry.quantity} qty</span>
                              <span>{formatINRRaw(entry.blockedAmount)}</span>
                              <span>{entry.submittedAt ? formatAge(entry.submittedAt) : formatAge(entry.createdAt)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <div className="modal-foot">
                  <button className="btn btn-ghost" onClick={() => setModal({ type: 'none' })}>Cancel</button>
                  {auIpoMemberQueue.length > 1 && (
                    <span style={{ color: 'var(--text-2)', fontSize: 12, margin: '0 auto' }}>
                      {auIpoQueueIndex + 1} of {auIpoMemberQueue.length}
                    </span>
                  )}
                  {auIpoMemberQueue.length > 1 && (
                    <button className="btn btn-ghost" onClick={skipCurrentQueueMember} disabled={!!busy && busy.startsWith('ipo-')}>
                      Skip →
                    </button>
                  )}
                  <button className="btn" onClick={prepareAuBid} disabled={!!busy && busy.startsWith('ipo-')}>
                    {busy === `ipo-prepare-${modal.memberId}` ? 'Preparing...' : 'Open AU & Prepare'}
                  </button>
                </div>
              </>
            )}

            {modal.type === 'review-au-bid' && preparedAuBid && (
              <>
                <div className="modal-head">
                  Review AU IPO Bid · {preparedAuBid.memberName}
                </div>
                <div className="modal-body modal-body-scroll">
                  <div className="au-ipo-summary-card review">
                    <div className="au-ipo-review-grid">
                      <div><span className="au-ipo-label">Issue</span><strong>{preparedAuBid.issueName}</strong></div>
                      <div><span className="au-ipo-label">Bid Type</span><strong>{preparedAuBid.bidType}</strong></div>
                      <div><span className="au-ipo-label">Quantity</span><strong>{preparedAuBid.quantity}</strong></div>
                      <div><span className="au-ipo-label">Price</span><strong>{formatINRRaw(preparedAuBid.effectivePrice)}</strong></div>
                      <div className="form-field-span-2"><span className="au-ipo-label">Blocked</span><strong>{formatINRRaw(preparedAuBid.blockedAmount)}</strong></div>
                    </div>
                    <div className={`au-ipo-ready-banner ${preparedAuBid.readyToSubmit ? 'ready' : 'warn'}`}>
                      {preparedAuBid.readyToSubmit
                        ? 'AU page looks ready for final submission. Review the visible bank window, then confirm here.'
                        : 'AU preparation completed with warnings. Review the AU window carefully before attempting submission.'}
                    </div>
                    {preparedAuBid.detectedAmount && (
                      <div className="au-ipo-summary-row muted">
                        <span>Detected on AU page</span>
                        <span>{preparedAuBid.detectedAmount}</span>
                      </div>
                    )}
                    {preparedAuBid.pageUrl && (
                      <div className="au-ipo-summary-row muted">
                        <span>AU page</span>
                        <span className="truncate-text">{preparedAuBid.pageUrl}</span>
                      </div>
                    )}
                  </div>

                  {preparedAuBid.warnings.length > 0 && (
                    <div className="au-ipo-warning-box">
                      <div className="form-section">Warnings</div>
                      <ul className="au-ipo-warning-list">
                        {preparedAuBid.warnings.map((warning, idx) => (
                          <li key={idx}>{warning}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
                <div className="modal-foot">
                  <button className="btn btn-ghost" onClick={() => setModal({ type: 'prepare-au-bid', memberId: modal.memberId, familyId: modal.familyId, memberName: modal.memberName })}>
                    Back
                  </button>
                  {auIpoMemberQueue.length > 1 && (
                    <span style={{ color: 'var(--text-2)', fontSize: 12, margin: '0 auto' }}>
                      {auIpoQueueIndex + 1} of {auIpoMemberQueue.length}
                    </span>
                  )}
                  {auIpoMemberQueue.length > 1 && (
                    <button
                      className="btn btn-ghost"
                      onClick={skipCurrentQueueMember}
                      disabled={busy === `ipo-confirm-${preparedAuBid.id}`}
                    >
                      Skip →
                    </button>
                  )}
                  <button
                    className="btn"
                    onClick={confirmAuBid}
                    disabled={!preparedAuBid.readyToSubmit || busy === `ipo-confirm-${preparedAuBid.id}`}
                  >
                    {busy === `ipo-confirm-${preparedAuBid.id}`
                      ? 'Submitting...'
                      : auIpoQueueIndex + 1 < auIpoMemberQueue.length
                        ? 'Confirm & Next Member'
                        : 'Confirm Submit'}
                  </button>
                </div>
              </>
            )}

            {isServiceConfigModal && (
              <>
                <div className="modal-head">
                  {modal.service === 'gmail' ? 'Configure Gmail OAuth' : 'Configure Claude CAPTCHA'}
                </div>
                <div className="modal-body">
                  {modal.service === 'gmail' ? (
                    <>
                      <div className="form-field">
                        <label>Google OAuth Client JSON</label>
                        <textarea
                          autoFocus
                          rows={12}
                          value={serviceConfigValue}
                          onChange={e => setServiceConfigValue(e.target.value)}
                          onKeyDown={e => {
                            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') saveServiceConfig();
                          }}
                          placeholder={'Paste the Desktop App OAuth JSON downloaded from Google Cloud.\n\nIt should include installed.client_id and installed.client_secret.'}
                          style={{ width: '100%', resize: 'vertical', fontFamily: 'var(--mono)' }}
                        />
                      </div>
                      <div className="empty-sub">
                        The JSON is stored in the app data folder. Gmail sign-in still happens in your browser after this step.
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="form-field">
                        <label>Anthropic API Key</label>
                        <input
                          autoFocus
                          type="password"
                          value={serviceConfigValue}
                          onChange={e => setServiceConfigValue(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && saveServiceConfig()}
                          placeholder="sk-ant-..."
                          style={{ fontFamily: 'var(--mono)' }}
                        />
                      </div>
                      <div className="empty-sub">
                        This key is stored securely in Windows Credential Manager and used to solve AU Bank CAPTCHA automatically.
                      </div>

                      {/* Cost guardrails ─────────────────────────────────────────────── */}
                      <div className="form-section" style={{ marginTop: 18 }}>Cost guardrails</div>

                      <div className="form-field">
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <input
                            type="checkbox"
                            checked={!!captchaUsage?.consented}
                            onChange={e => toggleCaptchaConsent(e.target.checked)}
                          />
                          Allow uploading CAPTCHA images to api.anthropic.com
                        </label>
                        <div className="empty-sub" style={{ marginTop: 4 }}>
                          Each solve sends one screenshot to Anthropic for OCR.
                          Enabled automatically when an API key is configured.
                          Uncheck to stop all uploads without removing the key.
                        </div>
                      </div>

                      <div className="form-field">
                        <label>Daily call cap</label>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <input
                            type="number"
                            min={0}
                            value={captchaUsage?.cap ?? 100}
                            onChange={e => setCaptchaCap(Number(e.target.value))}
                            style={{ width: 120, fontFamily: 'var(--mono)' }}
                          />
                          <span className="empty-sub">0 = no cap (not recommended)</span>
                        </div>
                      </div>

                      <div className="form-field">
                        <label>Today's usage</label>
                        <div className="empty-sub">
                          {captchaUsage ? (
                            <>
                              <strong style={{
                                color: captchaUsage.cap > 0 && captchaUsage.calls >= captchaUsage.cap
                                  ? 'var(--danger)'
                                  : captchaUsage.cap > 0 && captchaUsage.calls >= captchaUsage.cap * 0.8
                                    ? 'var(--warn)'
                                    : 'var(--text-0)'
                              }}>
                                {captchaUsage.calls}{captchaUsage.cap > 0 ? ` / ${captchaUsage.cap}` : ''} calls
                              </strong>
                              {' · '}
                              {captchaUsage.inputTokens.toLocaleString()} in / {captchaUsage.outputTokens.toLocaleString()} out tokens
                              <br />
                              Lifetime: {captchaUsage.totalCalls} calls · {captchaUsage.totalInputTokens.toLocaleString()} in / {captchaUsage.totalOutputTokens.toLocaleString()} out tokens
                            </>
                          ) : 'Loading...'}
                        </div>
                        <button
                          className="btn-row"
                          style={{ marginTop: 6 }}
                          onClick={resetCaptchaCounter}
                          disabled={!captchaUsage || captchaUsage.calls === 0}
                        >
                          Reset today's counter
                        </button>
                      </div>
                    </>
                  )}
                </div>
                <div className="modal-foot">
                  {modal.service === 'gmail' && gmailStatus?.configured && (
                    <button
                      className="btn btn-ghost btn-danger-ghost"
                      onClick={clearGmailCredentials}
                      disabled={busy === 'gmail-clear'}
                      style={{ marginRight: 'auto' }}
                    >
                      {busy === 'gmail-clear' ? 'Removing...' : 'Clear Gmail'}
                    </button>
                  )}
                  {modal.service === 'captcha-anthropic' && captchaAiStatus?.providers?.anthropic?.source === 'keychain' && (
                    <button
                      className="btn btn-ghost btn-danger-ghost"
                      onClick={clearCaptchaProvider}
                      disabled={busy === 'captcha-clear-anthropic'}
                      style={{ marginRight: 'auto' }}
                    >
                      {busy === 'captcha-clear-anthropic' ? 'Removing...' : 'Clear Key'}
                    </button>
                  )}
                  {modal.service === 'gmail' && (gmailStatus?.state === 'not_connected' || gmailStatus?.state === 'needs_reauth') && (
                    <button
                      className="btn btn-ghost"
                      onClick={reconnectGmailStatus}
                      disabled={busy === 'gmail-connect'}
                    >
                      {busy === 'gmail-connect' ? 'Connecting...' : (gmailStatus?.state === 'needs_reauth' ? 'Reconnect' : 'Sign in')}
                    </button>
                  )}
                  <button
                    className="btn btn-ghost"
                    onClick={() => { setModal({ type: 'none' }); setServiceConfigValue(''); }}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn"
                    onClick={saveServiceConfig}
                    disabled={
                      !serviceConfigValue.trim()
                      || busy === 'gmail-configure'
                      || busy === 'captcha-connect-anthropic'
                    }
                  >
                    {busy === 'gmail-configure' || busy === 'captcha-connect-anthropic'
                      ? 'Saving...'
                      : 'Save'}
                  </button>
                </div>
              </>
            )}

            {modal.type === 'change-master-password' && (
              <>
                <div className="modal-head">Change Master Password</div>
                <div className="modal-body">
                  <div className="form-grid">
                    <div className="form-field">
                      <label>Current master password</label>
                      <input
                        autoFocus
                        type="password"
                        value={passwordChangeForm.current}
                        onChange={e => setPasswordChangeForm(prev => ({ ...prev, current: e.target.value }))}
                        autoComplete="current-password"
                      />
                    </div>
                    <div className="form-field">
                      <label>New master password</label>
                      <input
                        type="password"
                        value={passwordChangeForm.next}
                        onChange={e => setPasswordChangeForm(prev => ({ ...prev, next: e.target.value }))}
                        autoComplete="new-password"
                      />
                    </div>
                    <div className="form-field">
                      <label>Confirm new password</label>
                      <input
                        type="password"
                        value={passwordChangeForm.confirm}
                        onChange={e => setPasswordChangeForm(prev => ({ ...prev, confirm: e.target.value }))}
                        onKeyDown={e => e.key === 'Enter' && changeMasterPassword()}
                        autoComplete="new-password"
                      />
                    </div>
                  </div>
                  <div className="empty-sub">
                    Future exports will use the new master password. Old exported Excel files keep the password they were created with.
                  </div>
                </div>
                <div className="modal-foot">
                  <button
                    className="btn btn-ghost"
                    onClick={() => { setModal({ type: 'none' }); setPasswordChangeForm({ current: '', next: '', confirm: '' }); }}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn"
                    onClick={changeMasterPassword}
                    disabled={
                      busy === 'change-master-password'
                      || !passwordChangeForm.current
                      || !passwordChangeForm.next
                      || !passwordChangeForm.confirm
                    }
                  >
                    {busy === 'change-master-password' ? 'Changing...' : 'Change Password'}
                  </button>
                </div>
              </>
            )}

            {/* Backup settings modal */}
            {modal.type === 'backup-settings' && (
              <>
                <div className="modal-head">Backup Settings</div>
                <div className="modal-body">
                  <div className="form-field">
                    <label>Backup folder</label>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input
                        readOnly
                        value={backupInfo?.config.folder || ''}
                        placeholder="Not set — click Choose folder"
                        style={{ fontFamily: 'var(--mono)', flex: 1 }}
                      />
                      <button className="btn btn-ghost" onClick={chooseBackupFolder}>Choose folder...</button>
                    </div>
                    <div className="empty-sub" style={{ marginTop: 6 }}>
                      Tip: pick a folder inside OneDrive / Google Drive / Dropbox to sync backups across machines.
                      Documents are stored once and reused across snapshots (incremental).
                    </div>
                  </div>
                  <div className="form-field" style={{ marginTop: 14 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="checkbox"
                        checked={!!backupInfo?.config.enabled}
                        onChange={e => toggleBackupEnabled(e.target.checked)}
                      />
                      Enable automatic backup (runs every 6 hours after unlock)
                    </label>
                  </div>
                  <div className="form-field" style={{ marginTop: 14 }}>
                    <label>Status</label>
                    <div className="empty-sub">
                      Last backup: {backupInfo?.state.lastBackupAt
                        ? `${new Date(backupInfo.state.lastBackupAt).toLocaleString()} (${formatAge(backupInfo.state.lastBackupAt)})`
                        : 'never'}<br />
                      {backupInfo?.state.lastBackupError && (
                        <span style={{ color: 'var(--danger)' }}>Last error: {backupInfo.state.lastBackupError}</span>
                      )}
                    </div>
                  </div>
                  <div className="form-field" style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      className="btn"
                      onClick={runBackupNow}
                      disabled={busy === 'backup-run' || !backupInfo?.config.folder}
                    >
                      {busy === 'backup-run' ? 'Backing up...' : 'Backup Now'}
                    </button>
                    <button
                      className="btn btn-ghost"
                      onClick={openRestoreDialog}
                      disabled={busy === 'backup-list'}
                    >
                      Restore...
                    </button>
                  </div>

                  <div className="form-section" style={{ marginTop: 24, color: 'var(--danger)' }}>Danger zone</div>

                  <div className="empty-sub" style={{ marginBottom: 6 }}>
                    Clear cached bank/broker session cookies stored in the Playwright
                    browser profiles. This forces every adapter to log in from scratch
                    next time. Sessions also clear automatically on every lock.
                  </div>
                  <button
                    className="btn btn-ghost"
                    style={{ marginBottom: 18 }}
                    onClick={clearBrowserSessions}
                    disabled={busy === 'clear-sessions'}
                  >
                    {busy === 'clear-sessions' ? 'Clearing...' : 'Clear browser sessions'}
                  </button>

                  <div className="empty-sub" style={{ marginBottom: 10 }}>
                    Uninstalling the app does NOT delete your vault data (that's stored in
                    %APPDATA%\ipo-manager and survives reinstalls — by design, so you don't
                    lose data by accident). Use the button below to wipe everything: vault DB,
                    documents, browser sessions, Gmail token, and CAPTCHA AI key. This cannot
                    be undone — restore from a backup if you need this data later.
                  </div>
                  <button
                    className="btn btn-danger-ghost"
                    onClick={resetVault}
                    disabled={busy === 'vault-reset'}
                  >
                    {busy === 'vault-reset' ? 'Resetting...' : 'Reset everything…'}
                  </button>
                </div>
                <div className="modal-foot">
                  <button className="btn btn-ghost" onClick={() => setModal({ type: 'none' })}>Close</button>
                </div>
              </>
            )}

            {/* Restore backup modal */}
            {modal.type === 'restore-backup' && (
              <>
                <div className="modal-head">Restore from Backup</div>
                <div className="modal-body" style={{ maxHeight: '60vh', overflow: 'auto' }}>
                  <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div className="empty-sub">
                      {restoreSourceFolder
                        ? <>Browsing snapshots in <strong>{restoreSourceFolder}</strong></>
                        : <>Browsing snapshots in the configured backup folder.</>}
                    </div>
                    <button className="btn btn-ghost" onClick={pickRestoreFolder} disabled={busy === 'backup-list'}>
                      Restore from another machine...
                    </button>
                  </div>
                  {(['last-24h', 'last-7d', 'last-30d', 'last-6mo', 'older'] as const).map(band => {
                    const inBand = backupSnapshots.filter(s => s.band === band);
                    if (inBand.length === 0) return null;
                    const label = band === 'last-24h' ? 'Last 24 hours'
                      : band === 'last-7d' ? 'Last 7 days'
                      : band === 'last-30d' ? 'Last 30 days'
                      : band === 'last-6mo' ? 'Last 6 months'
                      : 'Older than 6 months';
                    return (
                      <div key={band} style={{ marginBottom: 16 }}>
                        <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-2)', marginBottom: 6 }}>
                          {label} ({inBand.length})
                        </div>
                        {inBand.map(snap => (
                          <div
                            key={snap.id}
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              padding: '8px 12px',
                              border: '1px solid var(--line)',
                              borderRadius: 6,
                              marginBottom: 6,
                            }}
                          >
                            <div>
                              <div style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                                {new Date(snap.timestamp).toLocaleString()}
                              </div>
                              <div className="empty-sub" style={{ fontSize: 11 }}>
                                {snap.documentCount} documents · {formatFileSize(snap.dbBytes)} vault · {formatFileSize(snap.totalBlobBytes)} files
                              </div>
                            </div>
                            <button
                              className="btn btn-ghost"
                              onClick={() => restoreSelectedSnapshot(snap.id)}
                              disabled={busy === 'backup-restore'}
                            >
                              {busy === 'backup-restore' ? 'Restoring...' : 'Restore'}
                            </button>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                  {backupSnapshots.length === 0 && (
                    <div className="empty">
                      <div className="empty-title">No snapshots found</div>
                      <div className="empty-sub">Run a backup first, or point to a folder that has one.</div>
                    </div>
                  )}
                </div>
                <div className="modal-foot">
                  <button className="btn btn-ghost" onClick={() => setModal({ type: 'backup-settings' })}>Back</button>
                </div>
              </>
            )}

            {/* Member detail card (click member name → copyable creds) */}
            {modal.type === 'member-card' && (
              <>
                <div className="modal-head">{(modal as any).memberName}</div>
                <div className="modal-body" style={{ maxHeight: '70vh', overflow: 'auto' }}>
                  {memberDetailLoading || !memberDetail ? (
                    <div className="empty"><div className="empty-title">Loading...</div></div>
                  ) : (
                    <MemberCardBody detail={memberDetail} onCopy={(label, value) => {
                      if (!value) { showToast('error', `${label} is empty`); return; }
                      navigator.clipboard.writeText(value).then(
                        () => showToast('success', `${label} copied`),
                        () => showToast('error', `Could not copy ${label}`),
                      );
                    }} />
                  )}
                </div>
                <div className="modal-foot">
                  <button className="btn btn-ghost" onClick={() => setModal({ type: 'none' })}>Close</button>
                </div>
              </>
            )}

            {/* Family modal */}
            {isFamilyModal && (
              <>
                <div className="modal-head">
                  {modal.type === 'add-family' ? 'Add Family' : 'Edit Family'}
                </div>
                <div className="modal-body">
                  <div className="form-field">
                    <label>Family Name</label>
                    <input autoFocus value={familyName}
                      onChange={e => setFamilyName(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && saveFamily()}
                      placeholder="e.g. Sharma Family" />
                  </div>
                  <div className="form-field" style={{ marginTop: 14 }}>
                    <label>Minimum Bank Balance (₹) — savings threshold for Balance Management</label>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input
                        type="number"
                        min="0"
                        step="5000"
                        value={familyMinBalance}
                        onChange={e => setFamilyMinBalance(e.target.value)}
                        placeholder="e.g. 100000  (leave blank = no limit)"
                        style={{ fontFamily: 'var(--mono)', flex: 1 }}
                      />
                      {familyMinBalance !== '' && (
                        <button
                          type="button"
                          className="btn-row"
                          title="Remove the minimum balance limit for this family"
                          onClick={() => setFamilyMinBalance('')}
                        >
                          Clear (nil)
                        </button>
                      )}
                    </div>
                    {familyMinBalance !== '' && parseInt(familyMinBalance) > 0 && (
                      <div style={{ marginTop: 5, fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text-2)' }}>
                        OK zone: {formatINR(parseInt(familyMinBalance))} – {formatINR(parseInt(familyMinBalance) + 5000)}
                      </div>
                    )}
                    {familyMinBalance === '' && (
                      <div style={{ marginTop: 5, fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text-3)' }}>
                        Blank or 0 = no minimum limit set
                      </div>
                    )}
                  </div>
                </div>
                <div className="modal-foot">
                  <button className="btn btn-ghost" onClick={() => setModal({ type: 'none' })}>Cancel</button>
                  <button className="btn" onClick={saveFamily} disabled={saving || !familyName.trim()}>
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </>
            )}

            {/* Member modal */}
            {isMemberModal && (
              <>
                <div className="modal-head">
                  {modal.type === 'add-member' ? 'Add Member' : 'Edit Member'}
                </div>
                <div className="modal-body modal-body-scroll">

                  <div className="form-section">Personal Details</div>
                  <div className="form-grid-2">
                    <div className="form-field">
                      <label>Full Name *</label>
                      <input value={memberForm.full_name} onChange={e => setMemberForm(f => ({ ...f, full_name: e.target.value }))} placeholder="Full legal name" />
                    </div>
                    <div className="form-field">
                      <label>Type</label>
                      <select value={memberForm.member_type} onChange={e => setMemberForm(f => ({ ...f, member_type: e.target.value as any }))}>
                        <option value="INDIVIDUAL">Individual</option>
                        <option value="HUF">HUF</option>
                      </select>
                    </div>
                    <div className="form-field">
                      <label>Date of Birth</label>
                      <input type="date" value={memberForm.dob} onChange={e => setMemberForm(f => ({ ...f, dob: e.target.value }))} />
                    </div>
                    <div className="form-field">
                      <label>Mobile</label>
                      <input value={memberForm.mobile} onChange={e => setMemberForm(f => ({ ...f, mobile: e.target.value }))} placeholder="10-digit number" />
                    </div>
                    <div className="form-field">
                      <label>Email</label>
                      <input type="email" value={memberForm.email} onChange={e => setMemberForm(f => ({ ...f, email: e.target.value }))} placeholder="email@example.com" />
                    </div>
                    <div className="form-field">
                      <label>Email Password</label>
                      <div className="copy-field">
                        <input className="plain-secret" type="text" value={memberForm.email_password}
                          onChange={e => setMemberForm(f => ({ ...f, email_password: e.target.value }))}
                          placeholder="Email password (encrypted)" />
                        <button className="btn-row copy-btn" type="button"
                          onClick={() => copyText('Email password', memberForm.email_password)}>Copy</button>
                      </div>
                    </div>
                    <div className="form-field">
                      <label>PAN</label>
                      <input value={memberForm.pan} onChange={e => setMemberForm(f => ({ ...f, pan: e.target.value.toUpperCase() }))} placeholder="ABCDE1234F" maxLength={10} style={{ fontFamily: 'var(--mono)' }} />
                    </div>
                    <div className="form-field">
                      <label>Aadhaar</label>
                      <input value={memberForm.aadhaar} onChange={e => setMemberForm(f => ({ ...f, aadhaar: e.target.value.replace(/\D/g, '') }))} placeholder="12-digit number" maxLength={12} style={{ fontFamily: 'var(--mono)' }} />
                    </div>
                  </div>

                  <div className="form-section">Document Softcopies (PDF/JPEG)</div>
                  <div className="document-row">
                    {MEMBER_DOCUMENT_TYPES.map(docType => {
                      const doc = memberForm.documents[docType];
                      const isDownloadable = modal.type === 'edit-member' && doc.existingHasFile && !doc.remove && !doc.selectedPath;
                      const isBusyPick = busy === `doc-pick-${docType}`;
                      const isBusyDownload = modal.type === 'edit-member' && busy === `doc-download-${modal.memberId}-${docType}`;
                      const hasAny = doc.hasFile || doc.selectedPath;
                      const dotClass = doc.remove ? 'removed' : doc.selectedPath ? 'pending' : hasAny ? 'present' : 'absent';
                      return (
                        <div key={docType}
                          className={`document-pill${doc.selectedPath ? ' pending' : ''}${doc.remove ? ' removed' : ''}`}
                          title={describeDocumentDraft(doc)}
                        >
                          <span className={`document-pill-dot ${dotClass}`} />
                          <span className="document-pill-name">{documentLabel(docType)}</span>
                          <div className="document-pill-actions">
                            <button className="btn-row" type="button" onClick={() => pickMemberDocument(docType)} disabled={isBusyPick}>
                              {isBusyPick ? '...' : (hasAny && !doc.remove ? '↻' : '+')}
                            </button>
                            {isDownloadable && (
                              <button className="btn-row" type="button"
                                onClick={() => modal.type === 'edit-member' && downloadStoredDocument(modal.memberId, docType)}
                                disabled={!!isBusyDownload}
                                title="Download stored softcopy"
                              >{isBusyDownload ? '...' : '↓'}</button>
                            )}
                            {(doc.hasFile || doc.selectedPath || doc.remove) && (
                              <button className="btn-row danger" type="button" onClick={() => clearMemberDocument(docType)}
                                title={doc.remove ? 'Undo remove' : doc.selectedPath ? 'Clear selection' : 'Remove'}
                              >{doc.remove ? '↶' : '✕'}</button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="form-section">Bank Accounts</div>
                  {memberForm.banks.map(bank => (
                    <div key={bank.bank_code} className="cred-block">
                      <div className="cred-block-title">
                        <span>{bank.bank_code} Bank</span>
                        <button className="btn-row danger" onClick={() => removeBank(bank.bank_code)}>Remove</button>
                      </div>
                      <div className="form-grid-2">
                        <div className="form-field"><label>User ID</label>
                          <input value={bank.user_id} onChange={e => setBank(bank.bank_code, 'user_id', e.target.value)} placeholder="Login username" /></div>
                        <div className="form-field"><label>Password</label>
                          <div className="copy-field">
                            <input className="plain-secret" type="text" value={bank.password} onChange={e => setBank(bank.bank_code, 'password', e.target.value)} placeholder="Password" />
                            <button className="btn-row copy-btn" type="button" onClick={() => copyText(`${bank.bank_code} password`, bank.password)}>Copy</button>
                          </div></div>
                        <div className="form-field"><label>Account Number</label>
                          <input value={bank.account_number} onChange={e => setBank(bank.bank_code, 'account_number', e.target.value)} placeholder="Account number" /></div>
                        <div className="form-field"><label>IFSC</label>
                          <input value={bank.ifsc} onChange={e => setBank(bank.bank_code, 'ifsc', e.target.value.toUpperCase())} placeholder="AUBL0002083" /></div>
                        <div className="form-field"><label>Customer ID</label>
                          <input value={bank.customer_id} onChange={e => setBank(bank.bank_code, 'customer_id', e.target.value)} placeholder="Customer ID (if different)" /></div>
                      </div>
                    </div>
                  ))}
                  {(() => {
                    const remaining = BANKS.filter(b => !memberForm.banks.find(x => x.bank_code === b));
                    if (!remaining.length) return null;
                    return (
                      <div className="add-account-row">
                        <select value={bankToAdd} onChange={e => setBankToAdd(e.target.value)}>
                          <option value="">Select bank...</option>
                          {remaining.map(b => <option key={b} value={b}>{b} Bank</option>)}
                        </select>
                        <button className="btn btn-ghost" onClick={() => addBank(bankToAdd)} disabled={!bankToAdd}>Add</button>
                      </div>
                    );
                  })()}

                  <div className="form-section">Broker / Demat Accounts</div>
                  {memberForm.brokers.map(broker => {
                    // Brokers whose user-id field is the registered mobile number
                    const isMobileLogin = ['DHAN', 'ANGEL', 'MIRAE'].includes(broker.broker_code);
                    // Brokers that use a numeric PIN/MPIN instead of a text password
                    const isPinLogin    = ['DHAN', 'ANGEL'].includes(broker.broker_code);
                    const userIdLabel       = isMobileLogin ? 'Mobile Number' : 'User ID';
                    const userIdPlaceholder = isMobileLogin ? '10-digit registered mobile' : 'Login username';
                    const passwordLabel       = isPinLogin ? 'PIN' : 'Password';
                    const passwordPlaceholder = isPinLogin ? 'Login PIN' : 'Password';
                    // TOTP is not used by the mobile-login brokers, but their demat number
                    // is still needed for AU IPO bidding.
                    const hideTotp = isMobileLogin;
                    return (
                    <div key={broker.broker_code} className="cred-block">
                      <div className="cred-block-title">
                        <span>{broker.broker_code}</span>
                        <button className="btn-row danger" onClick={() => removeBroker(broker.broker_code)}>Remove</button>
                      </div>
                      <div className="form-grid-2">
                        <div className="form-field"><label>{userIdLabel}</label>
                          <input value={broker.user_id} onChange={e => setBroker(broker.broker_code, 'user_id', e.target.value)} placeholder={userIdPlaceholder} /></div>
                        <div className="form-field"><label>{passwordLabel}</label>
                          <div className="copy-field">
                            <input className="plain-secret" type="text" value={broker.password} onChange={e => setBroker(broker.broker_code, 'password', e.target.value)} placeholder={passwordPlaceholder} />
                            <button className="btn-row copy-btn" type="button" onClick={() => copyText(`${broker.broker_code} ${passwordLabel.toLowerCase()}`, broker.password)}>Copy</button>
                          </div></div>
                        <div className="form-field"><label>Demat Account / Client ID</label>
                          <input value={broker.client_id} onChange={e => setBroker(broker.broker_code, 'client_id', e.target.value)} placeholder="Demat account number" /></div>
                        {!hideTotp && (
                          <div className="form-field"><label>TOTP Secret</label>
                            <div className="copy-field">
                              <input className="plain-secret" type="text" value={broker.totp_secret} onChange={e => { setBroker(broker.broker_code, 'totp_secret', e.target.value); setTotpCode(null); }} placeholder="Base32 key from authenticator setup" />
                              <button className="btn-row copy-btn" type="button" onClick={() => copyText(`${broker.broker_code} TOTP secret`, broker.totp_secret)}>Copy</button>
                            </div>
                            {broker.totp_secret && (
                              <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                                <button className="btn btn-ghost" type="button" onClick={async () => {
                                  const result = await TOTP.generate(broker.totp_secret.replace(/\s/g, ''));
                                  setTotpCode({ broker_code: broker.broker_code, code: result.otp });
                                }}>Generate Code</button>
                                {totpCode?.broker_code === broker.broker_code && (
                                  <>
                                    <span style={{ fontFamily: 'monospace', fontSize: '1.4em', letterSpacing: 4, fontWeight: 700 }}>{totpCode.code}</span>
                                    <button className="btn-row copy-btn" type="button" onClick={() => copyText('TOTP code', totpCode.code)}>Copy</button>
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                        <div className="form-field"><label>Registered Mobile</label>
                          <input value={broker.broker_mobile} onChange={e => setBroker(broker.broker_code, 'broker_mobile', e.target.value)} placeholder="Mobile for OTP" /></div>
                        <div className="form-field"><label>Registered Email</label>
                          <input value={broker.broker_email} onChange={e => setBroker(broker.broker_code, 'broker_email', e.target.value)} placeholder={isMobileLogin ? 'Email where broker OTP is sent' : 'Email for OTP'} /></div>
                      </div>
                    </div>
                    );
                  })}
                  {(() => {
                    const remaining = BROKERS.filter(b => !memberForm.brokers.find(x => x.broker_code === b));
                    if (!remaining.length) return null;
                    return (
                      <div className="add-account-row">
                        <select value={brokerToAdd} onChange={e => setBrokerToAdd(e.target.value)}>
                          <option value="">Select broker...</option>
                          {remaining.map(b => <option key={b} value={b}>{b}</option>)}
                        </select>
                        <button className="btn btn-ghost" onClick={() => addBroker(brokerToAdd)} disabled={!brokerToAdd}>Add</button>
                      </div>
                    );
                  })()}
                </div>

                <div className="modal-foot">
                  <button className="btn btn-ghost" onClick={() => setModal({ type: 'none' })}>Cancel</button>
                  <button className="btn" onClick={saveMember} disabled={saving || !memberForm.full_name.trim()}>
                    {saving ? 'Saving...' : 'Save Member'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* â"€â"€ OTP dialog â"€â"€ */}
      {otpRequest && (
        <div className="modal-overlay" onClick={cancelOtp}>
          <div className="modal otp-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">Enter OTP</div>
            <div className="modal-body">
              <p className="otp-label">{otpRequest.label}</p>
              <div className="otp-input-row">
                <input className="otp-input" type="text" inputMode="numeric" pattern="[0-9]*"
                  maxLength={8} autoFocus placeholder="......" value={otpValue}
                  onChange={e => setOtpValue(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={e => e.key === 'Enter' && submitOtp()} />
              </div>
              <p className="otp-hint">Check your registered mobile number for the OTP.</p>
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={cancelOtp} disabled={otpSubmitting}>Cancel</button>
              <button className="btn" onClick={submitOtp} disabled={otpSubmitting || otpValue.length < 4}>
                {otpSubmitting ? 'Submitting...' : 'Submit OTP'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* â"€â"€ Toasts â"€â"€ */}
      {toasts.map((t, i) => (
        <div key={t.id} className={`toast ${t.kind}`} style={{ bottom: 24 + i * 56 }}>{t.text}</div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Member detail card — click any row to copy that value
// ─────────────────────────────────────────────────────────────────────────────

function MemberCardBody({ detail, onCopy }: { detail: any; onCopy: (label: string, value: string) => void }) {
  // A copyable cell — click anywhere on it copies the raw value
  const Cell = ({ label, value }: { label: string; value: string | null | undefined }) => {
    const v = value || '';
    return (
      <td
        className={`mc-cell${v ? '' : ' empty'}`}
        onClick={() => onCopy(label, v)}
        title={v ? `Click to copy ${label}` : `${label} is empty`}
      >
        {v ? maskSecret(label, v) : '—'}
      </td>
    );
  };

  const banks = (detail.banks || []) as any[];
  const brokers = (detail.brokers || []) as any[];

  return (
    <div className="member-card">
      {/* ── Identity — two compact tables stacked, each auto-sized to content ── */}
      <div className="mc-section">Identity</div>
      <table className="mc-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>PAN</th>
            <th>Aadhaar</th>
            <th>DOB</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Cell label="Full name" value={detail.full_name} />
            <Cell label="PAN" value={detail.pan} />
            <Cell label="Aadhaar" value={detail.aadhaar} />
            <Cell label="DOB" value={detail.dob} />
          </tr>
        </tbody>
      </table>
      <table className="mc-table">
        <thead>
          <tr>
            <th>Mobile</th>
            <th>Email</th>
            <th>Email Password</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Cell label="Mobile" value={detail.mobile} />
            <Cell label="Email" value={detail.email} />
            <Cell label="Email password" value={detail.email_password} />
          </tr>
        </tbody>
      </table>

      {/* ── Banks table ── */}
      {banks.length > 0 && (
        <>
          <div className="mc-section">Banks</div>
          <table className="mc-table">
            <thead>
              <tr>
                <th>Bank</th>
                <th>User ID</th>
                <th>Password</th>
                <th>Customer ID</th>
                <th>Account No.</th>
                <th>IFSC</th>
              </tr>
            </thead>
            <tbody>
              {banks.map((b: any) => (
                <tr key={`bank-${b.bank_code}`}>
                  <td className="mc-code">{b.bank_code}</td>
                  <Cell label={`${b.bank_code} user id`} value={b.user_id} />
                  <Cell label={`${b.bank_code} password`} value={b.password} />
                  <Cell label={`${b.bank_code} customer id`} value={b.customer_id} />
                  <Cell label={`${b.bank_code} account no.`} value={b.account_number} />
                  <Cell label={`${b.bank_code} IFSC`} value={b.ifsc} />
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* ── Brokers table ── */}
      {brokers.length > 0 && (
        <>
          <div className="mc-section">Brokers</div>
          <table className="mc-table">
            <thead>
              <tr>
                <th>Broker</th>
                <th>User ID</th>
                <th>Password</th>
                <th>Client ID</th>
                <th>TOTP Secret</th>
                <th>Mobile</th>
                <th>Email</th>
              </tr>
            </thead>
            <tbody>
              {brokers.map((b: any) => (
                <tr key={`broker-${b.broker_code}`}>
                  <td className="mc-code">{b.broker_code}</td>
                  <Cell label={`${b.broker_code} user id`} value={b.user_id} />
                  <Cell label={`${b.broker_code} password`} value={b.password} />
                  <Cell label={`${b.broker_code} client id`} value={b.client_id} />
                  <Cell label={`${b.broker_code} TOTP secret`} value={b.totp_secret} />
                  <Cell label={`${b.broker_code} mobile`} value={b.broker_mobile} />
                  <Cell label={`${b.broker_code} email`} value={b.broker_email} />
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function maskSecret(label: string, value: string): string {
  // Display passwords/PINs/TOTP secrets as bullets in the card; the click-copy
  // still copies the real value to the clipboard.
  const isSecret = /password|pin|secret|totp/i.test(label);
  if (!isSecret) return value;
  return '•'.repeat(Math.min(value.length, 12));
}

// ─────────────────────────────────────────────────────────────────────────────
// Spreadsheet view — flat table of all members across all families
// Rows = members. Columns = identity + each bank/broker code with balances.
// ─────────────────────────────────────────────────────────────────────────────

interface SpreadsheetRow {
  memberId: number;
  memberName: string;
  familyName: string;
  mobile: string;
  email: string;
  banks: Record<string, { balance: string | null; parts: BalanceParts; hasAccount: boolean }>;
  brokers: Record<string, { balance: string | null; portfolio: number | null; hasAccount: boolean }>;
  totalSavings: number;
  totalDeposit: number;
}

// ── Zerodha TOTP ─────────────────────────────────────────────────────────────

interface ZerodhaMember {
  brokerAccountId: number;
  memberId: number;
  memberName: string;
}

function ZerodhaTotpPage() {
  const [members, setMembers] = useState<ZerodhaMember[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [otp, setOtp] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number>(30);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    window.api.totp.listZerodhaMembers().then((list: ZerodhaMember[]) => {
      setMembers(list);
      if (list.length === 1) setSelectedId(list[0].brokerAccountId);
    });
    return () => { if (refreshTimerRef.current) clearInterval(refreshTimerRef.current); };
  }, []);

  useEffect(() => {
    if (selectedId == null) return;
    void fetchTotp(selectedId);
    if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    refreshTimerRef.current = setInterval(() => {
      const nowSec = Math.floor(Date.now() / 1000);
      const remaining = 30 - (nowSec % 30);
      setSecondsLeft(remaining);
      if (remaining === 30) void fetchTotp(selectedId);
    }, 1000);
    return () => { if (refreshTimerRef.current) clearInterval(refreshTimerRef.current); };
  }, [selectedId]);

  async function fetchTotp(brokerAccountId: number) {
    setLoading(true);
    const res = await window.api.totp.generate(brokerAccountId) as any;
    setLoading(false);
    if (res?.ok) {
      setOtp(res.otp);
      setSecondsLeft(res.secondsRemaining);
    } else {
      setOtp(null);
    }
  }

  function copyOtp() {
    if (!otp) return;
    navigator.clipboard.writeText(otp);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const progressPct = (secondsLeft / 30) * 100;
  const progressColor = secondsLeft <= 5 ? '#ef4444' : secondsLeft <= 10 ? '#f59e0b' : '#22c55e';

  return (
    <div style={{ padding: '24px 28px', maxWidth: 480 }}>
      <h2 style={{ margin: '0 0 20px', fontSize: 18, fontWeight: 600 }}>Zerodha TOTP</h2>

      <div style={{ marginBottom: 20 }}>
        <label style={{ fontSize: 12, color: 'var(--text-muted, #888)', display: 'block', marginBottom: 6 }}>Select Member</label>
        {members.length === 0 ? (
          <div style={{ color: 'var(--text-muted, #888)', fontSize: 13 }}>
            No Zerodha accounts with TOTP secret found. Add the TOTP secret in the member's broker account.
          </div>
        ) : (
          <select
            className="form-input"
            value={selectedId ?? ''}
            onChange={e => setSelectedId(e.target.value ? Number(e.target.value) : null)}
            style={{ width: '100%' }}
          >
            <option value="">— choose a member —</option>
            {members.map(m => (
              <option key={m.brokerAccountId} value={m.brokerAccountId}>{m.memberName}</option>
            ))}
          </select>
        )}
      </div>

      {selectedId != null && (
        <div style={{ background: 'var(--surface-2, #23272e)', border: '1px solid var(--border, #333)', borderRadius: 12, padding: '24px 28px', textAlign: 'center' }}>
          {loading ? (
            <div style={{ color: 'var(--text-muted, #888)', fontSize: 14 }}>Generating…</div>
          ) : otp ? (
            <>
              <div
                onClick={copyOtp}
                title="Click to copy"
                style={{ fontSize: 44, fontWeight: 700, fontFamily: 'monospace', letterSpacing: 10, cursor: 'pointer', userSelect: 'none', color: progressColor }}
              >
                {otp}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted, #888)', marginTop: 6 }}>
                {copied ? '✓ Copied!' : 'Click code to copy'}
              </div>
              <div style={{ marginTop: 16 }}>
                <div style={{ height: 6, borderRadius: 3, background: 'var(--border, #333)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${progressPct}%`, background: progressColor, transition: 'width 1s linear, background 0.3s' }} />
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted, #888)', marginTop: 6 }}>
                  Expires in {secondsLeft}s
                </div>
              </div>
            </>
          ) : (
            <div style={{ color: '#ef4444', fontSize: 13 }}>Failed to generate TOTP. Check that the TOTP secret is set correctly.</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Recharge Tracker ─────────────────────────────────────────────────────────

interface RechargeEntry {
  id: number;
  name: string;
  mobile_number: string;
  mobile_model: string | null;
  recharge_date: string | null;
  validity_days: number | null;
  display_order: number;
  notes: string | null;
}

interface RechargeForm {
  name: string;
  mobile_number: string;
  mobile_model: string;
  recharge_date: string;
  validity_days: string;
  notes: string;
}

function formatDuration(absDays: number): string {
  if (absDays < 30) return `${absDays}d`;
  const months = Math.floor(absDays / 30);
  const days = absDays % 30;
  return days > 0 ? `${months}m ${days}d` : `${months}m`;
}

function computeRechargeStatus(recharge_date: string | null, validity_days: number | null): {
  expiryDate: string | null;
  daysLeft: number | null;
  status: 'expired' | 'expiring-soon' | 'active' | 'unknown';
  label: string;
} {
  if (!recharge_date || validity_days == null) {
    return { expiryDate: null, daysLeft: null, status: 'unknown', label: 'Unknown' };
  }
  const recharge = new Date(recharge_date);
  const expiry = new Date(recharge);
  expiry.setDate(expiry.getDate() + validity_days);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  expiry.setHours(0, 0, 0, 0);
  const diffMs = expiry.getTime() - today.getTime();
  const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  const expiryDate = expiry.toISOString().slice(0, 10);
  if (daysLeft < 0) {
    return { expiryDate, daysLeft, status: 'expired', label: `Expired ${formatDuration(Math.abs(daysLeft))} ago` };
  }
  if (daysLeft <= 7) {
    return { expiryDate, daysLeft, status: 'expiring-soon', label: `Expires in ${formatDuration(daysLeft)}` };
  }
  return { expiryDate, daysLeft, status: 'active', label: `${formatDuration(daysLeft)} left` };
}

function emptyRechargeForm(): RechargeForm {
  return { name: '', mobile_number: '', mobile_model: '', recharge_date: '', validity_days: '', notes: '' };
}

function RechargeTrackerPage() {
  const [entries, setEntries] = useState<RechargeEntry[]>([]);
  const [form, setForm] = useState<RechargeForm>(emptyRechargeForm());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const dragId = useRef<number | null>(null);

  async function load() {
    const rows = await window.api.recharge.list() as RechargeEntry[];
    setEntries(rows);
  }

  function onDragStart(e: React.DragEvent, id: number) {
    dragId.current = id;
    e.dataTransfer.effectAllowed = 'move';
  }
  function onDragOver(e: React.DragEvent) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
  async function onDrop(e: React.DragEvent, targetId: number) {
    e.preventDefault();
    const srcId = dragId.current;
    if (srcId == null || srcId === targetId) return;
    const reordered = [...entries];
    const srcIdx = reordered.findIndex(r => r.id === srcId);
    const tgtIdx = reordered.findIndex(r => r.id === targetId);
    const [moved] = reordered.splice(srcIdx, 1);
    reordered.splice(tgtIdx, 0, moved);
    setEntries(reordered);
    await window.api.recharge.reorder(reordered.map(r => r.id));
    dragId.current = null;
  }

  useEffect(() => { void load(); }, []);

  function openAdd() {
    setEditingId(null);
    setForm(emptyRechargeForm());
    setShowForm(true);
  }

  function openEdit(e: RechargeEntry) {
    setEditingId(e.id);
    setForm({
      name: e.name,
      mobile_number: e.mobile_number,
      mobile_model: e.mobile_model || '',
      recharge_date: e.recharge_date || '',
      validity_days: e.validity_days != null ? String(e.validity_days) : '',
      notes: e.notes || '',
    });
    setShowForm(true);
  }

  function cancelForm() {
    setShowForm(false);
    setEditingId(null);
    setForm(emptyRechargeForm());
  }

  async function saveForm() {
    if (!form.name.trim() || !form.mobile_number.trim()) return;
    setSaving(true);
    const payload = {
      name: form.name.trim(),
      mobile_number: form.mobile_number.trim(),
      mobile_model: form.mobile_model.trim() || undefined,
      recharge_date: form.recharge_date || undefined,
      validity_days: form.validity_days !== '' ? parseInt(form.validity_days, 10) : undefined,
      notes: form.notes || undefined,
    };
    if (editingId != null) {
      await window.api.recharge.update({ id: editingId, ...payload });
    } else {
      await window.api.recharge.create(payload);
    }
    setSaving(false);
    cancelForm();
    await load();
  }

  async function deleteEntry(id: number) {
    if (!confirm('Delete this entry?')) return;
    await window.api.recharge.delete(id);
    await load();
  }

  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>SIM Recharge Tracker</h2>
        <button className="btn btn-primary" onClick={openAdd}>+ Add Number</button>
      </div>

      {showForm && (
        <div style={{ background: 'var(--surface-2, #23272e)', border: '1px solid var(--border, #333)', borderRadius: 8, padding: '16px 20px', marginBottom: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px' }}>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-muted, #888)', display: 'block', marginBottom: 4 }}>Name / Label *</label>
              <input
                className="form-input"
                placeholder="e.g. Madan Gopal"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-muted, #888)', display: 'block', marginBottom: 4 }}>Mobile Number *</label>
              <input
                className="form-input"
                placeholder="e.g. 9876543210"
                value={form.mobile_number}
                onChange={e => setForm(f => ({ ...f, mobile_number: e.target.value }))}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-muted, #888)', display: 'block', marginBottom: 4 }}>Mobile Model</label>
              <input
                className="form-input"
                placeholder="e.g. Samsung Galaxy A54"
                value={form.mobile_model}
                onChange={e => setForm(f => ({ ...f, mobile_model: e.target.value }))}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-muted, #888)', display: 'block', marginBottom: 4 }}>Date of Recharge</label>
              <input
                className="form-input"
                type="date"
                value={form.recharge_date}
                onChange={e => setForm(f => ({ ...f, recharge_date: e.target.value }))}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-muted, #888)', display: 'block', marginBottom: 4 }}>Validity (days)</label>
              <input
                className="form-input"
                type="number"
                min={1}
                placeholder="e.g. 84"
                value={form.validity_days}
                onChange={e => setForm(f => ({ ...f, validity_days: e.target.value }))}
              />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted, #888)', display: 'block', marginBottom: 4 }}>Notes (optional)</label>
              <input
                className="form-input"
                placeholder="e.g. Jio 84-day plan"
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button className="btn btn-primary" onClick={saveForm} disabled={saving || !form.name.trim() || !form.mobile_number.trim()}>
              {saving ? 'Saving…' : editingId != null ? 'Update' : 'Add'}
            </button>
            <button className="btn btn-ghost" onClick={cancelForm}>Cancel</button>
          </div>
        </div>
      )}

      {entries.length === 0 && !showForm ? (
        <div style={{ textAlign: 'center', color: 'var(--text-muted, #888)', marginTop: 60, fontSize: 14 }}>
          No numbers added yet. Click <strong>+ Add Number</strong> to get started.
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border, #333)', textAlign: 'left' }}>
              <th style={{ padding: '8px 10px', width: 24 }}></th>
              <th style={{ padding: '8px 10px', fontWeight: 600, color: 'var(--text-muted, #888)' }}>Name</th>
              <th style={{ padding: '8px 10px', fontWeight: 600, color: 'var(--text-muted, #888)' }}>Mobile Number</th>
              <th style={{ padding: '8px 10px', fontWeight: 600, color: 'var(--text-muted, #888)' }}>Model</th>
              <th style={{ padding: '8px 10px', fontWeight: 600, color: 'var(--text-muted, #888)' }}>Recharge Date</th>
              <th style={{ padding: '8px 10px', fontWeight: 600, color: 'var(--text-muted, #888)' }}>Validity</th>
              <th style={{ padding: '8px 10px', fontWeight: 600, color: 'var(--text-muted, #888)' }}>Expiry Date</th>
              <th style={{ padding: '8px 10px', fontWeight: 600, color: 'var(--text-muted, #888)' }}>Status</th>
              <th style={{ padding: '8px 10px', fontWeight: 600, color: 'var(--text-muted, #888)' }}></th>
            </tr>
          </thead>
          <tbody>
            {entries.map(e => {
              const { expiryDate, status, label } = computeRechargeStatus(e.recharge_date, e.validity_days);
              const statusColor = status === 'expired' ? '#ef4444'
                : status === 'expiring-soon' ? '#f59e0b'
                : status === 'active' ? '#22c55e'
                : 'var(--text-muted, #888)';
              return (
                <tr
                  key={e.id}
                  draggable
                  onDragStart={ev => onDragStart(ev, e.id)}
                  onDragOver={onDragOver}
                  onDrop={ev => onDrop(ev, e.id)}
                  style={{ borderBottom: '1px solid var(--border, #333)', cursor: 'grab' }}
                >
                  <td style={{ padding: '9px 6px', color: 'var(--text-muted, #888)', userSelect: 'none' }}>::</td>
                  <td style={{ padding: '9px 10px', fontWeight: 500 }}>{e.name}</td>
                  <td style={{ padding: '9px 10px', fontFamily: 'monospace' }}>{e.mobile_number}</td>
                  <td style={{ padding: '9px 10px' }}>{e.mobile_model || '—'}</td>
                  <td style={{ padding: '9px 10px' }}>{e.recharge_date || '—'}</td>
                  <td style={{ padding: '9px 10px' }}>{e.validity_days != null ? `${e.validity_days}d` : '—'}</td>
                  <td style={{ padding: '9px 10px' }}>{expiryDate || '—'}</td>
                  <td style={{ padding: '9px 10px' }}>
                    <span style={{ color: statusColor, fontWeight: 500 }}>{label}</span>
                  </td>
                  <td style={{ padding: '9px 10px', whiteSpace: 'nowrap' }}>
                    <button className="btn-icon" style={{ marginRight: 6 }} onClick={() => openEdit(e)}>Edit</button>
                    <button className="btn-icon btn-icon-danger" title="Delete" onClick={() => deleteEntry(e.id)}>×</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SpreadsheetView({
  families,
  members,
  onMemberClick,
}: {
  families: Family[];
  members: Record<number, Member[]>;
  onMemberClick: (memberId: number, memberName: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const [familyFilter, setFamilyFilter] = useState<'all' | number>('all');
  const [sortBy, setSortBy] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'family', dir: 'asc' });

  // Determine column set — only banks/brokers that exist somewhere
  const allBankCodes = useMemo(() => {
    const codes = new Set<string>();
    for (const fam of families) {
      for (const m of members[fam.id] || []) {
        for (const b of m.banks) if (b.has_password) codes.add(b.bank_code);
      }
    }
    return BANKS.filter(code => codes.has(code));
  }, [families, members]);

  const allBrokerCodes = useMemo(() => {
    const codes = new Set<string>();
    for (const fam of families) {
      for (const m of members[fam.id] || []) {
        for (const b of m.brokers) if (b.has_password) codes.add(b.broker_code);
      }
    }
    return BROKERS.filter(code => codes.has(code));
  }, [families, members]);

  const rows: SpreadsheetRow[] = useMemo(() => {
    const out: SpreadsheetRow[] = [];
    for (const fam of families) {
      if (familyFilter !== 'all' && familyFilter !== fam.id) continue;
      for (const m of members[fam.id] || []) {
        const banks: SpreadsheetRow['banks'] = {};
        for (const code of allBankCodes) {
          const acc = m.banks.find(b => b.bank_code === code && b.has_password);
          banks[code] = {
            hasAccount: !!acc,
            balance: acc?.balance || null,
            parts: parseBalanceParts(acc?.balance || ''),
          };
        }
        const brokers: SpreadsheetRow['brokers'] = {};
        for (const code of allBrokerCodes) {
          const acc = m.brokers.find(b => b.broker_code === code && b.has_password);
          const bp = parseBrokerBalance(acc?.balance || '');
          brokers[code] = {
            hasAccount: !!acc,
            balance: acc?.balance || null,
            portfolio: bp.portfolio ?? acc?.portfolio_value ?? null,
          };
        }
        const totalSavings = Object.values(banks).reduce((acc, b) => acc + b.parts.savings, 0);
        const totalDeposit = Object.values(banks).reduce((acc, b) => acc + b.parts.deposit, 0);
        out.push({
          memberId: m.id,
          memberName: m.full_name,
          familyName: fam.family_name,
          mobile: m.mobile || '',
          email: m.email || '',
          banks, brokers, totalSavings, totalDeposit,
        });
      }
    }

    // Filter
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? out.filter(r => r.memberName.toLowerCase().includes(q)
          || r.familyName.toLowerCase().includes(q)
          || r.mobile.includes(q)
          || r.email.toLowerCase().includes(q))
      : out;

    // Sort
    const dir = sortBy.dir === 'asc' ? 1 : -1;
    const sorted = [...filtered].sort((a, b) => {
      if (sortBy.key === 'family') return dir * a.familyName.localeCompare(b.familyName);
      if (sortBy.key === 'name')   return dir * a.memberName.localeCompare(b.memberName);
      if (sortBy.key === 'mobile') return dir * a.mobile.localeCompare(b.mobile);
      if (sortBy.key === 'savings') return dir * (a.totalSavings - b.totalSavings);
      if (sortBy.key === 'deposit') return dir * (a.totalDeposit - b.totalDeposit);
      if (sortBy.key === 'total')   return dir * ((a.totalSavings + a.totalDeposit) - (b.totalSavings + b.totalDeposit));
      // Per-bank/broker column
      if (sortBy.key.startsWith('bank:')) {
        const c = sortBy.key.slice(5);
        return dir * ((a.banks[c]?.parts.savings || 0) - (b.banks[c]?.parts.savings || 0));
      }
      if (sortBy.key.startsWith('broker:')) {
        const c = sortBy.key.slice(7);
        return dir * ((a.brokers[c]?.portfolio || 0) - (b.brokers[c]?.portfolio || 0));
      }
      return 0;
    });
    return sorted;
  }, [families, members, allBankCodes, allBrokerCodes, filter, familyFilter, sortBy]);

  function toggleSort(key: string) {
    setSortBy(prev => prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'asc' });
  }

  const sortIndicator = (key: string) => sortBy.key === key ? (sortBy.dir === 'asc' ? ' ▲' : ' ▼') : '';

  const grandSavings = rows.reduce((s, r) => s + r.totalSavings, 0);
  const grandDeposit = rows.reduce((s, r) => s + r.totalDeposit, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-title">Spreadsheet</div>
          <div className="page-meta" style={{ marginTop: 4 }}>
            {rows.length} members · ₹{formatTableAmount(grandSavings)} savings · ₹{formatTableAmount(grandDeposit)} FD
          </div>
        </div>
        <div className="page-head-actions" style={{ gap: 8 }}>
          <input
            placeholder="Search name, family, mobile, email..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
            style={{ width: 280, padding: '6px 10px', background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 4, color: 'var(--text-0)', fontSize: 13 }}
          />
          <select value={familyFilter} onChange={e => setFamilyFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
            <option value="all">All families</option>
            {families.map(f => <option key={f.id} value={f.id}>{f.family_name}</option>)}
          </select>
        </div>
      </div>

      <div className="spreadsheet-wrap">
        <table className="spreadsheet">
          <thead>
            <tr>
              <th onClick={() => toggleSort('family')}>Family{sortIndicator('family')}</th>
              <th onClick={() => toggleSort('name')}>Member{sortIndicator('name')}</th>
              <th onClick={() => toggleSort('mobile')}>Mobile{sortIndicator('mobile')}</th>
              {allBankCodes.map(code => (
                <th key={`b-${code}`} onClick={() => toggleSort(`bank:${code}`)} title={`${code} bank balance`}>
                  {code}{sortIndicator(`bank:${code}`)}
                </th>
              ))}
              {allBrokerCodes.map(code => (
                <th key={`br-${code}`} onClick={() => toggleSort(`broker:${code}`)} title={`${code} broker portfolio`}>
                  {code}{sortIndicator(`broker:${code}`)}
                </th>
              ))}
              <th onClick={() => toggleSort('savings')} className="num">Savings{sortIndicator('savings')}</th>
              <th onClick={() => toggleSort('deposit')} className="num">FD{sortIndicator('deposit')}</th>
              <th onClick={() => toggleSort('total')} className="num">Total{sortIndicator('total')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.memberId}>
                <td className="family-cell">{r.familyName}</td>
                <td>
                  <span className="member-name-clickable" onClick={() => onMemberClick(r.memberId, r.memberName)}>
                    {r.memberName}
                  </span>
                </td>
                <td className="mono-cell">{r.mobile || '—'}</td>
                {allBankCodes.map(code => {
                  const cell = r.banks[code];
                  if (!cell.hasAccount) return <td key={`b-${code}`} className="muted-cell">—</td>;
                  const sum = cell.parts.savings + cell.parts.deposit;
                  return (
                    <td key={`b-${code}`} className="num mono-cell" title={cell.balance || 'No balance fetched'}>
                      {sum > 0 ? formatTableAmount(sum) : (cell.balance ? '·' : '—')}
                    </td>
                  );
                })}
                {allBrokerCodes.map(code => {
                  const cell = r.brokers[code];
                  if (!cell.hasAccount) return <td key={`br-${code}`} className="muted-cell">—</td>;
                  return (
                    <td key={`br-${code}`} className="num mono-cell" title={cell.balance || 'No balance fetched'}>
                      {cell.portfolio != null ? formatTableAmount(cell.portfolio) : (cell.balance ? '·' : '—')}
                    </td>
                  );
                })}
                <td className="num mono-cell"><strong>{r.totalSavings > 0 ? formatTableAmount(r.totalSavings) : '—'}</strong></td>
                <td className="num mono-cell"><strong>{r.totalDeposit > 0 ? formatTableAmount(r.totalDeposit) : '—'}</strong></td>
                <td className="num mono-cell">
                  <strong>{(r.totalSavings + r.totalDeposit) > 0 ? formatTableAmount(r.totalSavings + r.totalDeposit) : '—'}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="empty" style={{ marginTop: 24 }}>
            <div className="empty-title">No members match the current filter.</div>
          </div>
        )}
      </div>
    </>
  );
}

