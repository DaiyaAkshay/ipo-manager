import { LoginAdapter } from './browser';
import { auBankAdapter }  from './auBank';
import { sbiBankAdapter } from './sbiBank';
import { yesBankAdapter } from './yesBank';
import { kotakAdapter }   from './kotakBank';
import { iciciBankAdapter } from './iciciBank';
import { bobBankAdapter }   from './bobBank';
import { pnbBankAdapter }   from './pnbBank';
import { hdfcBankAdapter }  from './hdfcBank';
import { axisBankAdapter }  from './axisBank';
import { zerodhaAdapter } from './zerodha';
import { dhanAdapter }    from './dhan';
import { angelAdapter }   from './angel';
import { miraeAdapter }   from './mirae';
import { shoonyaAdapter } from './shoonya';
import { fyersAdapter }   from './fyers';
import { growwAdapter }   from './groww';
import { OTP_PRESETS }    from '../email/gmail';

const BANK_ADAPTERS: Record<string, LoginAdapter> = {
  AU:    auBankAdapter,
  YES:   yesBankAdapter,
  SBI:   sbiBankAdapter,
  KOTAK: kotakAdapter,
  ICICI: iciciBankAdapter,
  BOB:   bobBankAdapter,
  PNB:   pnbBankAdapter,
  HDFC:  hdfcBankAdapter,
  AXIS:  axisBankAdapter,
};

const BROKER_ADAPTERS: Record<string, LoginAdapter> = {
  ZERODHA: zerodhaAdapter,
  DHAN:    dhanAdapter,
  ANGEL:   angelAdapter,
  MIRAE:   miraeAdapter,
  SHOONYA: shoonyaAdapter,
  FYERS:   fyersAdapter,
  FYRES:   fyersAdapter,
  GROWW:   growwAdapter,
};

const OTP_PRESET_BY_CODE: Record<string, { query: string; otpRegex: RegExp }> = {
  AU:      OTP_PRESETS.AU_BANK,
  YES:     OTP_PRESETS.YES_BANK,
  SBI:     OTP_PRESETS.SBI,
  KOTAK:   OTP_PRESETS.KOTAK,
  ZERODHA: OTP_PRESETS.ZERODHA,
  DHAN:    OTP_PRESETS.DHAN,
  ANGEL:   OTP_PRESETS.ANGEL,
  MIRAE:   OTP_PRESETS.MIRAE,
};

export function getBankAdapter(code: string): LoginAdapter | null {
  return BANK_ADAPTERS[code] || null;
}

export function getBrokerAdapter(code: string): LoginAdapter | null {
  return BROKER_ADAPTERS[code] || null;
}

export function getOtpPreset(code: string): { query: string; otpRegex: RegExp } | null {
  return OTP_PRESET_BY_CODE[code] || null;
}
