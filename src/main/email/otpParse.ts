/**
 * OTP extraction from Gmail messages — pure functions (no Gmail API, keychain
 * or Electron), so the parsing rules can be unit-tested under plain Node.
 */

// Keywords that introduce an OTP. `code` is excluded when it's part of
// "PIN code" / "postal code" / "zip code" so a branch address can't win.
const OTP_KEYWORD = /(?:otp|one[\s-]*time|passcode|verification|(?<!pin\s?|postal\s|zip\s)code)/gi;

// How far from an OTP keyword a code may sit: "Your OTP is 482913" (after) is
// the common form; "482913 is your OTP" (before) is allowed over a shorter span.
const AFTER_KEYWORD_WINDOW = 80;
const BEFORE_KEYWORD_WINDOW = 30;

/**
 * Pick the OTP out of an email body. When the preset regex matches more than
 * one number (the OTP plus, say, a 6-digit branch PIN code in the footer),
 * prefer the candidate closest to an OTP keyword.
 */
export function pickOtp(text: string, otpRegex: RegExp): { otp: string; how: string } | null {
  const flags = otpRegex.flags.includes('g') ? otpRegex.flags : `${otpRegex.flags}g`;
  const candidates: Array<{ value: string; index: number }> = [];
  for (const m of text.matchAll(new RegExp(otpRegex.source, flags))) {
    const value = m[1] ?? m[0];
    if (value) {
      // With a capture group the code sits inside the match — find its offset.
      const offset = m[0].indexOf(value);
      candidates.push({ value, index: (m.index ?? 0) + Math.max(0, offset) });
    }
  }
  if (candidates.length === 1) return { otp: candidates[0].value, how: 'strict' };
  if (candidates.length > 1) {
    let best: { value: string; index: number } | null = null;
    let bestDistance = Infinity;
    for (const k of text.matchAll(OTP_KEYWORD)) {
      const keywordStart = k.index ?? 0;
      const keywordEnd = keywordStart + k[0].length;
      for (const c of candidates) {
        const after = c.index - keywordEnd;
        const before = keywordStart - (c.index + c.value.length);
        const distance = after >= 0 && after <= AFTER_KEYWORD_WINDOW
          ? after
          : before >= 0 && before <= BEFORE_KEYWORD_WINDOW ? before : Infinity;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = c;
        }
      }
    }
    return best ? { otp: best.value, how: 'keyword' } : { otp: candidates[0].value, how: 'first' };
  }

  // Loose fallback: HTML emails sometimes render each OTP digit in its own
  // <td>, so after tag stripping we get "4 2 6 8 6 5". Reconstruct the code.
  const loose = text.match(/\b\d(?:\s+\d){5}\b/);
  if (loose) return { otp: loose[0].replace(/\D/g, ''), how: 'loose-spaced' };
  // Split codes for readability ("426-865", "426 865") — only right after an
  // OTP keyword, so phone numbers like 1800-419-xxxx never match.
  const split = text.match(/(?:otp|one[\s-]*time|code)[^0-9]{0,40}\b(\d{3})[-.\s](\d{3})\b/i);
  return split ? { otp: split[1] + split[2], how: 'split' } : null;
}

/**
 * Extract searchable text from a Gmail message.
 *
 * Multipart emails commonly contain BOTH a text/plain and a text/html part
 * with the same content. The HTML part has lots of extra junk — image
 * dimensions like `height="600"`, tracking-pixel URLs with numeric IDs,
 * inline CSS with hex colors that look like digits, etc. — and a naive
 * concat of raw HTML + text/plain often makes the OTP regex pick up an
 * HTML attribute value instead of the real code.
 *
 * Strategy: prefer text/plain. If only text/html is present, strip
 * <style>/<script> blocks and tag attributes before scanning.
 */
export function extractText(msg: any): string {
  let plain = '';
  let html  = '';
  function walk(p: any): void {
    if (!p) return;
    if (p.body?.data) {
      const decoded = Buffer.from(p.body.data, 'base64').toString('utf8');
      const mime = (p.mimeType || '').toLowerCase();
      if (mime.includes('text/plain')) plain += '\n' + decoded;
      else if (mime.includes('text/html')) html += '\n' + decoded;
      else if (!plain && !html) plain += '\n' + decoded; // unknown type — keep
    }
    if (p.parts) p.parts.forEach(walk);
  }
  walk(msg.payload);

  // Strip HTML to leave only the visible body text, so attribute values
  // like `height="600"` don't pollute the regex search space.
  const stripped = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Order matters: plain text wins over stripped HTML wins over the
  // Gmail snippet preview. Candidates are ranked by position, so putting the
  // cleanest source first improves accuracy.
  return [plain, stripped, msg.snippet || ''].filter(Boolean).join('\n');
}
