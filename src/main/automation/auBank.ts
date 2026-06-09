import { createHash } from 'node:crypto';
import { Page, Frame, Locator } from 'playwright';
import { PNG } from 'pngjs';
import {
  LoginAdapter,
  LoginCredentials,
  IpoBidDraft,
  PreparedIpoBidResult,
  SubmittedIpoBidResult
} from './browser';
import { solveCaptchaText } from '../ai/captcha';
import { recordCaptchaFeedback, type CaptchaFeedbackRecordInput } from '../ai/captchaFeedback';
import { appendAutomationLog, writeAutomationArtifact } from '../logging';

const LOGIN_URL = 'https://netbanking.au.bank.in/drb/';
const INR = '\u20B9';

function makeAutomationArtifactStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

type AuCaptchaLearningContext = CaptchaFeedbackRecordInput & {
  recorded?: boolean;
  lastFilledText?: string;
};

function setAuCaptchaLearningContext(page: Page, context: AuCaptchaLearningContext): void {
  (page as any).__auCaptchaLearning = context;
}

function getAuCaptchaLearningContext(page: Page): AuCaptchaLearningContext | null {
  return ((page as any).__auCaptchaLearning || null) as AuCaptchaLearningContext | null;
}

async function recordAuCaptchaLearning(page: Page, outcome: 'success' | 'failure', finalText?: string): Promise<void> {
  const context = getAuCaptchaLearningContext(page);
  if (!context || context.recorded) return;
  context.recorded = true;
  recordCaptchaFeedback({
    ...context,
    outcome,
    finalText: finalText || context.lastFilledText || context.primaryGuess,
  });
}

function cropCaptchaTextCell(imageBytes: Buffer): Buffer {
  try {
    const source = PNG.sync.read(imageBytes);
    const targetWidth = Math.max(80, Math.min(source.width, Math.floor(source.width * 0.78)));
    const target = new PNG({
      width: targetWidth,
      height: source.height,
      colorType: 2,
    });

    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < targetWidth; x += 1) {
        const sourceIndex = (source.width * y + x) << 2;
        const targetIndex = (target.width * y + x) << 2;
        target.data[targetIndex] = source.data[sourceIndex];
        target.data[targetIndex + 1] = source.data[sourceIndex + 1];
        target.data[targetIndex + 2] = source.data[sourceIndex + 2];
        target.data[targetIndex + 3] = source.data[sourceIndex + 3];
      }
    }

    return PNG.sync.write(target);
  } catch {
    return imageBytes;
  }
}

function upscalePng2x(imageBytes: Buffer): Buffer {
  try {
    const source = PNG.sync.read(imageBytes);
    const target = new PNG({
      width: source.width * 2,
      height: source.height * 2,
      colorType: 2,
    });
    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        const sIdx = (source.width * y + x) << 2;
        const r = source.data[sIdx];
        const g = source.data[sIdx + 1];
        const b = source.data[sIdx + 2];
        const a = source.data[sIdx + 3];
        for (let dy = 0; dy < 2; dy += 1) {
          for (let dx = 0; dx < 2; dx += 1) {
            const tIdx = (target.width * (y * 2 + dy) + (x * 2 + dx)) << 2;
            target.data[tIdx] = r;
            target.data[tIdx + 1] = g;
            target.data[tIdx + 2] = b;
            target.data[tIdx + 3] = a;
          }
        }
      }
    }
    return PNG.sync.write(target);
  } catch {
    return imageBytes;
  }
}

/**
 * Keep the AU Bank session alive while the user prepares an IPO application.
 *
 * AU's dashboard auto-logs-out on inactivity (~3–5 min by default). This
 * heartbeat dispatches synthetic user-activity events into the page every
 * 45 s so AU's inactivity counter keeps resetting. The events are JS-level
 * only — they do NOT move the cursor or steal focus from the user, so they
 * don't interfere with real interaction.
 *
 * Safe to call multiple times on the same page — a guard flag prevents
 * duplicate timers. Cleans itself up automatically when the page closes.
 */
/**
 * Inject a fixed-position "APPLY" button into the AU bid page so the user
 * doesn't have to scroll all the way down to find the real Apply / Submit
 * button. The injected button:
 *   - Sits bottom-right with position: fixed, always visible regardless of scroll.
 *   - On click, scans the page for a visible button matching apply/submit/place-bid
 *     labels, scrolls it into view, highlights it briefly, then clicks it.
 *   - Self-heals: a MutationObserver re-adds the button if AU's React rerender
 *     ever removes it.
 * Idempotent — calling more than once is safe (existing button is replaced).
 */
async function injectFloatingApplyButton(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      const BUTTON_ID = '__ipo_manager_floating_apply__';

      function buildButton(): HTMLButtonElement {
        const existing = document.getElementById(BUTTON_ID);
        if (existing) existing.remove();

        const btn = document.createElement('button');
        btn.id = BUTTON_ID;
        btn.type = 'button';
        btn.textContent = '⚡  APPLY  ⚡';
        btn.title = 'Find and click the real Apply / Submit button on this page';

        Object.assign(btn.style, {
          position: 'fixed',
          bottom: '28px',
          right: '28px',
          zIndex: '2147483647',                    // top of stacking context
          padding: '16px 32px',
          fontSize: '17px',
          fontWeight: '700',
          letterSpacing: '0.1em',
          color: '#1a1a1a',
          background: 'linear-gradient(135deg, #f0c98c, #d4a574)',
          border: '2px solid #9c6d3f',
          borderRadius: '10px',
          cursor: 'pointer',
          boxShadow: '0 8px 24px rgba(0,0,0,0.4), 0 2px 6px rgba(0,0,0,0.2)',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          transition: 'transform 120ms, box-shadow 120ms, filter 120ms',
          userSelect: 'none',
        } as Partial<CSSStyleDeclaration>);

        btn.addEventListener('mouseenter', () => {
          btn.style.transform = 'translateY(-2px) scale(1.03)';
          btn.style.boxShadow = '0 12px 32px rgba(0,0,0,0.5), 0 3px 8px rgba(0,0,0,0.25)';
        });
        btn.addEventListener('mouseleave', () => {
          btn.style.transform = '';
          btn.style.boxShadow = '0 8px 24px rgba(0,0,0,0.4), 0 2px 6px rgba(0,0,0,0.2)';
        });

        btn.addEventListener('click', () => {
          // Build candidate list of clickable elements
          const sel = 'button, input[type="submit"], input[type="button"], a[role="button"], [role="button"]';
          const all = Array.from(document.querySelectorAll<HTMLElement>(sel))
            .filter(el => el.id !== BUTTON_ID);

          const visible = (el: HTMLElement) => {
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return r.width > 4 && r.height > 4
              && s.display !== 'none'
              && s.visibility !== 'hidden'
              && s.opacity !== '0';
          };

          const enabled = (el: HTMLElement) =>
            !(el as HTMLButtonElement).disabled
            && el.getAttribute('aria-disabled') !== 'true'
            && !el.classList.contains('disabled');

          // Score each candidate by label match. Exact wins; partial second; disabled penalty.
          const labels = ['apply', 'submit bid', 'submit', 'place bid', 'place order', 'confirm bid', 'confirm'];
          let best: HTMLElement | null = null;
          let bestScore = -1;

          for (const c of all) {
            if (!visible(c)) continue;
            const raw = ((c as HTMLInputElement).value || c.innerText || c.textContent || '')
              .toLowerCase().replace(/\s+/g, ' ').trim();
            if (!raw) continue;
            let score = 0;
            for (let i = 0; i < labels.length; i += 1) {
              const lbl = labels[i];
              if (raw === lbl) { score = 1000 - i * 10; break; }
              if (raw.includes(lbl)) score = Math.max(score, 500 - i * 10);
            }
            if (score === 0) continue;
            if (!enabled(c)) score -= 200;
            if (score > bestScore) { bestScore = score; best = c; }
          }

          if (!best) {
            // Soft toast
            btn.style.background = 'linear-gradient(135deg, #e89090, #c46060)';
            btn.textContent = '✗ No Apply found — scroll & click manually';
            setTimeout(() => {
              btn.style.background = 'linear-gradient(135deg, #f0c98c, #d4a574)';
              btn.textContent = '⚡  APPLY  ⚡';
            }, 2500);
            return;
          }

          // Scroll into view, brief highlight, then click.
          best.scrollIntoView({ block: 'center', behavior: 'smooth' });
          const origOutline = best.style.outline;
          const origOutlineOffset = best.style.outlineOffset;
          best.style.outline = '3px solid #d4a574';
          best.style.outlineOffset = '3px';
          setTimeout(() => {
            best!.style.outline = origOutline;
            best!.style.outlineOffset = origOutlineOffset;
            best!.click();
          }, 280);
        });

        document.body.appendChild(btn);
        return btn;
      }

      buildButton();

      // Self-heal: if AU's React rerender removes our button, re-add it.
      if (!(window as any).__ipoManagerApplyObserver) {
        const observer = new MutationObserver(() => {
          if (!document.getElementById(BUTTON_ID)) {
            try { buildButton(); } catch { /* */ }
          }
        });
        observer.observe(document.body, { childList: true, subtree: false });
        (window as any).__ipoManagerApplyObserver = observer;
      }
    });
    console.log('[AU Bank] Floating APPLY button injected.');
  } catch (e) {
    console.warn('[AU Bank] Could not inject floating Apply button:', (e as Error).message);
  }
}

/**
 * Handle the AU IPO portal (iposmart.au.bank.in) authentication gate.
 *
 * The IPO subdomain uses the SAME Angular-Material login form as the main
 * netbanking site — same username field, same password field, same CAPTCHA
 * widget — but it's a completely independent session.  Even after a
 * successful netbanking.au.bank.in login the IPO portal can demand a fresh
 * login with CAPTCHA.
 *
 * Strategy (reuses the proven trySolveAuCaptcha pipeline):
 *   1. If the IPO listing is already visible → nothing to do.
 *   2. If a username field is visible → fill username + password.
 *   3. Call trySolveAuCaptcha (finds CAPTCHA input by proximity/scoring,
 *      screenshots the region, sends to Claude, fills + clicks Login).
 *   4. Wait up to 15 s for the IPO listing to appear.
 */
async function handleAuIpoPortalAuth(page: Page, draft: IpoBidDraft): Promise<void> {
  try {
    // Already on the IPO listing — nothing to do.
    if (await isAuIpoListingPage(page)) return;

    // Give the page a moment to settle in case it was just opened.
    await page.waitForTimeout(1_500);
    if (await isAuIpoListingPage(page)) return;

    appendAutomationLog('AU_CAPTCHA', 'IPO portal login gate detected — attempting auth.');

    // ── Fill username ──────────────────────────────────────────────────────
    let passwordFieldRef: Locator | null = null;
    if (draft.username) {
      try {
        const userInput = page.locator('input[type="text"]').first();
        if (await userInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await userInput.fill(draft.username);
          console.log('[AU Bank][ipo-auth] Filled username on IPO portal.');
        }
      } catch { /* field might not be present if only CAPTCHA is needed */ }
    }

    // ── Fill password ──────────────────────────────────────────────────────
    if (draft.password) {
      try {
        const passField = page.locator('input[type="password"], input.mat-input-element[class*="passwordMa"]').first();
        if (await passField.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await passField.fill(draft.password);
          passwordFieldRef = passField;
          console.log('[AU Bank][ipo-auth] Filled password on IPO portal.');
        }
      } catch { /* field might not be present */ }
    }

    // ── Solve CAPTCHA using the same robust pipeline as the main login ─────
    const captchaSolved = await trySolveAuCaptcha(page, draft.username || '', passwordFieldRef);
    if (captchaSolved) {
      console.log('[AU Bank][ipo-auth] CAPTCHA solved on IPO portal — waiting for listing.');
    } else {
      console.warn('[AU Bank][ipo-auth] CAPTCHA not auto-solved on IPO portal — showing manual overlay.');
      // Show banner and give the user 2 minutes to solve it themselves before
      // proceeding. The listing-page poll below will pick up successful manual
      // completion automatically.
      const captchaInput = await findAuCaptchaInput(page, draft.username || '', passwordFieldRef);
      if (captchaInput) {
        await showAuCaptchaManualOverlay(
          page,
          'Please type the CAPTCHA shown above and click Login. The app will continue automatically once you submit.',
        );
        await waitForManualCaptchaSubmit(page, captchaInput, 120_000);
      }
    }

    // ── Wait for the listing page to load (up to 20 s) ────────────────────
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1_200);
      if (await isAuIpoListingPage(page)) {
        console.log('[AU Bank][ipo-auth] IPO listing page loaded after auth.');
        return;
      }
    }
    console.warn('[AU Bank][ipo-auth] IPO listing did not appear within 20 s after login attempt.');
  } catch (e) {
    console.warn('[AU Bank][ipo-auth] Error during IPO portal auth:', (e as Error).message);
  }
}

/**
 * Returns true ONLY when the page is showing the actual IPO issue listing
 * table (not the login form, not an error page, not a captcha gate).
 *
 * "asba" and "bid" alone are NOT enough — the portal login page carries
 * those words in its branding/title. We require the actual table column
 * headers ("issue name" + a data-column word) that only appear on the
 * listing screen.
 */
async function isAuIpoListingPage(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const text = (document.body as HTMLElement | null)?.innerText?.toLowerCase() || '';
    return text.includes('issue name')
      && (text.includes('quantity') || text.includes('cut off') || text.includes('depository') || text.includes('bid price'));
  }).catch(() => false);
}

/**
 * Dump a snapshot of the AU IPO listing page when our auto-click fails —
 * lists every visible button/link with its text + class so we can later
 * fix the row selector. Writes to automation.log.
 */
async function dumpAuListingDiagnostics(page: Page): Promise<void> {
  try {
    const info = await page.evaluate(() => {
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el as HTMLElement);
        return r.width > 8 && r.height > 8 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const buttons = Array.from(document.querySelectorAll(
        'button, a, [role="button"], input[type="button"], input[type="submit"], .btn, .mat-button, .mat-mdc-button'
      )).filter(visible).slice(0, 40).map(el => {
        const e = el as HTMLElement;
        const txt = (e.innerText || (e as HTMLInputElement).value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        const cls = (typeof e.className === 'string' ? e.className : '').slice(0, 60);
        return `<${e.tagName.toLowerCase()} class="${cls}"> ${txt}`;
      });
      return { url: location.href, buttons };
    });
    console.log(`[AU Bank][diagnostics] url=${info.url}`);
    console.log(`[AU Bank][diagnostics] visible buttons/links (${info.buttons.length}):`);
    info.buttons.forEach(b => console.log('  ' + b));
  } catch (e) {
    console.warn('[AU Bank][diagnostics] dump failed:', (e as Error).message);
  }
}

function startAuKeepAlive(page: Page): void {
  if ((page as any).__auKeepAlive) return;
  (page as any).__auKeepAlive = true;

  const timer = setInterval(async () => {
    try {
      if (page.isClosed()) { clearInterval(timer); return; }

      // Check if we've been redirected to login (session already died)
      const url = page.url();
      let hostname = '';
      try {
        hostname = new URL(url).hostname.toLowerCase();
      } catch {}
      const isAuHost =
        hostname === 'netbanking.au.bank.in'
        || hostname === 'iposmart.au.bank.in';
      if (!isAuHost || /login|signin|auth/i.test(url)) {
        console.warn('[AU Bank] keep-alive: session appears logged out, stopping.');
        clearInterval(timer);
        return;
      }

      // Dispatch benign activity events so AU's idle detector resets
      await page.evaluate(() => {
        for (const type of ['mousemove', 'keydown', 'scroll', 'mousedown', 'touchstart']) {
          document.dispatchEvent(new Event(type, { bubbles: true }));
          window.dispatchEvent(new Event(type));
        }
        // Many SPAs refresh a last-activity timestamp in storage
        try { sessionStorage.setItem('lastActivity', String(Date.now())); } catch {}
        try { localStorage.setItem('lastActivity', String(Date.now())); } catch {}
      }).catch(() => {});
    } catch {
      clearInterval(timer);
    }
  }, 45_000);

  page.on('close', () => clearInterval(timer));
  page.context().on('close', () => clearInterval(timer));
}

function normalizeAmount(raw: string): string | null {
  const cleaned = raw.replace(/[^0-9.,]/g, '').trim();
  if (!cleaned) return null;
  return cleaned;
}

async function firstVisibleLocator(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 12); i += 1) {
      const candidate = locator.nth(i);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      if (!(await candidate.isEnabled().catch(() => true))) continue;
      return candidate;
    }
  }
  return null;
}

async function findAuCaptchaInput(page: Page, username: string, passwordField?: Locator | null): Promise<Locator | null> {
  const passwordBox = passwordField ? await passwordField.boundingBox().catch(() => null) : null;
  const loginButton = page.locator('button:has-text("Login"), input[type="submit"][value*="Login" i], input[type="button"][value*="Login" i]').first();
  const loginBox = await loginButton.boundingBox().catch(() => null);
  const specific = await firstVisibleLocator(page, [
    'xpath=//*[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "captcha")]/ancestor::*[contains(@class, "mat-form-field") or self::mat-form-field][1]//input',
    'xpath=//*[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "captcha")]/following::input[1]',
    'mat-form-field:has-text("Captcha") input',
    '.mat-form-field:has-text("Captcha") input',
    'input[placeholder*="captcha" i]',
    'input[name*="captcha" i]',
    'input[id*="captcha" i]',
    'input[aria-label*="captcha" i]',
    'input[placeholder*="security" i]',
    'input[name*="security" i]',
    'input[id*="security" i]',
  ]);
  if (specific) {
    if (!passwordBox) return specific;
    const box = await specific.boundingBox().catch(() => null);
      if (box && box.y >= passwordBox.y - 12) return specific;
  }

  const generic = page.locator('input, textarea');
  const count = await generic.count().catch(() => 0);
  let fallback: { locator: Locator; score: number } | null = null;
  for (let i = 0; i < Math.min(count, 40); i += 1) {
    const candidate = generic.nth(i);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    if (!(await candidate.isEnabled().catch(() => true))) continue;
    const type = ((await candidate.getAttribute('type').catch(() => '')) || '').toLowerCase();
    if (['hidden', 'password', 'checkbox', 'radio', 'button', 'submit'].includes(type)) continue;
    const value = await candidate.inputValue().catch(() => '');
    const name = await candidate.getAttribute('name').catch(() => '');
    const id = await candidate.getAttribute('id').catch(() => '');
    const placeholder = await candidate.getAttribute('placeholder').catch(() => '');
    const aria = await candidate.getAttribute('aria-label').catch(() => '');
    const className = await candidate.getAttribute('class').catch(() => '');
    const contextText = await candidate.evaluate((el: Element) => {
      const chunks: string[] = [];
      let node: Element | null = el;
      for (let depth = 0; depth < 5 && node; depth += 1) {
        const text = (node as HTMLElement).innerText || node.textContent || '';
        if (text) chunks.push(text);
        node = node.parentElement;
      }
      return chunks.join(' ');
    }).catch(() => '');
    const marker = `${placeholder || ''} ${value || ''} ${name || ''} ${id || ''} ${aria || ''} ${className || ''} ${contextText || ''}`.toLowerCase();
    if (marker.includes('user') || marker.includes('login') || marker.includes('customer')) continue;
    if (value && value.trim() === username.trim()) continue;
    const box = await candidate.boundingBox().catch(() => null);
    if (!box) continue;

    let score = 0;
    if (!value.trim()) score += 5;
    if (marker.includes('captcha')) score += 500;
    if (marker.includes('enter captcha code')) score += 700;
    if (marker.includes('security')) score += 100;
    if (marker.includes('verification') || marker.includes('verify')) score += 25;
    if (className.toLowerCase().includes('mat-input')) score += 8;
    if (type === 'text' || type === 'tel' || type === 'number' || !type) score += 6;
    if (box.width >= 180) score += 8;
    if (box.height >= 18) score += 4;

    if (passwordBox) {
      const distance = box.y - (passwordBox.y + passwordBox.height);
      if (distance >= -8 && distance <= 260) score += 30;
      if (distance < -12) score -= 50;
    }

    if (loginBox) {
      const gapToLogin = loginBox.y - (box.y + box.height);
      if (gapToLogin >= -10 && gapToLogin <= 180) score += 20;
      if (gapToLogin < -20) score -= 20;
    }

    if (!fallback || score > fallback.score) {
      fallback = { locator: candidate, score };
    }
  }
  if (fallback) {
    const selectedBox = await fallback.locator.boundingBox().catch(() => null);
    appendAutomationLog('AU_CAPTCHA', `Selected CAPTCHA input candidate with score ${Math.round(fallback.score)} box=${selectedBox ? `${Math.round(selectedBox.x)},${Math.round(selectedBox.y)},${Math.round(selectedBox.width)},${Math.round(selectedBox.height)}` : 'none'}.`);
  }
  return fallback?.locator ?? null;
}

async function clickAuLoginSubmit(page: Page): Promise<boolean> {
  const clicked = await clickFirstVisible(page, [
    'button:has-text("Login")',
    'button:has-text("Sign In")',
    '[role="button"]:has-text("Login")',
    'input[type="submit"][value*="Login" i]',
    'input[type="button"][value*="Login" i]',
  ]) || await clickFirstText(page, ['Login', 'Sign In', 'Submit']);
  return clicked;
}

async function findAuCaptchaLabelBox(page: Page): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return page.evaluate(() => {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1366;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 900;
    const matches: Array<{ x: number; y: number; width: number; height: number; score: number; source: string }> = [];
    const target = 'enter captcha code';

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let textNode = walker.nextNode();
    while (textNode) {
      const raw = textNode.textContent || '';
      const normalized = raw.replace(/\s+/g, ' ').trim().toLowerCase();
      const index = normalized.indexOf(target);
      if (index >= 0) {
        const owner = textNode.parentElement;
        const style = owner ? window.getComputedStyle(owner) : null;
        if (!style || (style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') !== 0)) {
          const originalLower = raw.toLowerCase();
          const originalIndex = originalLower.indexOf('enter');
          const range = document.createRange();
          range.setStart(textNode, Math.max(0, originalIndex >= 0 ? originalIndex : 0));
          range.setEnd(textNode, raw.length);
          const rect = range.getBoundingClientRect();
          range.detach();
          if (rect.width && rect.height && rect.bottom >= 0 && rect.top <= viewportHeight && rect.right >= 0 && rect.left <= viewportWidth) {
            matches.push({
              x: rect.left,
              y: rect.top,
              width: rect.width,
              height: rect.height,
              score: 500 - Math.abs(rect.left - 70) / 8 - Math.abs(rect.width - 120) / 4,
              source: 'text-range',
            });
          }
        }
      }
      textNode = walker.nextNode();
    }

    for (const el of Array.from(document.querySelectorAll('label, mat-label, span, div, p'))) {
      const text = ((el as HTMLElement).innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!text.includes('enter captcha code')) continue;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (rect.bottom < 0 || rect.top > viewportHeight || rect.right < 0 || rect.left > viewportWidth) continue;
      const style = window.getComputedStyle(el as HTMLElement);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') === 0) continue;

      const areaPenalty = Math.min(rect.width * rect.height / 100, 80);
      const score = 200 - areaPenalty - Math.abs(rect.left - 70) / 10;
      matches.push({ x: rect.left, y: rect.top, width: rect.width, height: rect.height, score, source: 'element' });
    }

    matches.sort((a, b) => b.score - a.score);
    const best = matches[0];
    return best ? { x: best.x, y: best.y, width: best.width, height: best.height, source: best.source } : null;
  }).catch(() => null);
}

async function captureAuCaptchaDomElement(page: Page, captchaInput: Locator): Promise<Buffer | null> {
  const stamp = `au-captcha-target-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const result = await captchaInput.evaluate((input: Element, marker: string) => {
    const inputRect = input.getBoundingClientRect();
    const candidates: Array<{ element: Element; score: number; rect: { x: number; y: number; width: number; height: number }; text: string }> = [];
    const badText = /(dashboard|take me directly|username|password|enter captcha|captcha code|virtual keypad|login|forgot|apply now|offers|videos|fastag|branch|refresh)/i;

    for (const element of Array.from(document.querySelectorAll('body *'))) {
      if (element === input || element.contains(input)) continue;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (rect.width < 120 || rect.width > 520 || rect.height < 28 || rect.height > 115) continue;
      if (rect.bottom > inputRect.top - 10) continue;
      if (rect.bottom < inputRect.top - 230) continue;
      if (rect.left < inputRect.left - 140 || rect.left > inputRect.left + 120) continue;

      const style = window.getComputedStyle(element as HTMLElement);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') === 0) continue;
      const text = ((element as HTMLElement).innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
      if (badText.test(text)) continue;

      const borderWidth =
        parseFloat(style.borderTopWidth || '0')
        + parseFloat(style.borderRightWidth || '0')
        + parseFloat(style.borderBottomWidth || '0')
        + parseFloat(style.borderLeftWidth || '0');
      const hasBorder = borderWidth >= 2;
      const hasMedia = !!element.querySelector('img, canvas, svg');
      const distanceAboveInput = inputRect.top - rect.bottom;
      const leftDistance = Math.abs(rect.left - inputRect.left);
      const usefulSize = rect.width >= 150 && rect.height >= 36;

      let score = 0;
      if (hasBorder) score += 160;
      if (hasMedia) score += 45;
      if (!text) score += 30;
      if (usefulSize) score += 40;
      score += Math.max(0, 90 - Math.abs(distanceAboveInput - 45) * 2);
      score += Math.max(0, 80 - leftDistance);
      if (rect.width > 360) score -= 40;
      if (rect.height > 85) score -= 30;

      candidates.push({
        element,
        score,
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        text,
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best || best.score < 120) return null;
    best.element.setAttribute('data-au-captcha-target', marker);
    return { score: best.score, rect: best.rect, text: best.text.slice(0, 80) };
  }, stamp).catch(() => null);

  if (!result) return null;

  const locator = page.locator(`[data-au-captcha-target="${stamp}"]`).first();
  const screenshot = await locator.screenshot({ type: 'png' }).catch(() => null);
  await locator.evaluate((element) => element.removeAttribute('data-au-captcha-target')).catch(() => {});
  if (!screenshot) return null;

  appendAutomationLog(
    'AU_CAPTCHA',
    `Captured AU CAPTCHA DOM candidate score=${Math.round(result.score)} rect=${Math.round(result.rect.x)},${Math.round(result.rect.y)},${Math.round(result.rect.width)},${Math.round(result.rect.height)} text="${result.text}"`,
  );
  return cropCaptchaTextCell(screenshot);
}

async function captureAuCaptchaRegion(page: Page, captchaInput: Locator): Promise<Buffer | null> {
  try {
    await captchaInput.scrollIntoViewIfNeeded().catch(() => {});
    const box = await captchaInput.boundingBox();
    if (!box) return null;
    const viewport = page.viewportSize() || { width: 1366, height: 900 };

    const labelBox = await findAuCaptchaLabelBox(page);
    if (labelBox) {
      // The captcha visual sits ~50–95px above the "Enter Captcha Code" label
      // top, left-aligned with the label, ~170px wide × ~45px tall. The wider
      // row also contains a speaker icon and a "Refresh" link to the right of
      // the captcha — including those (or the "Dashboard" dropdown sitting
      // above) makes the AI hallucinate or misread characters.
      const x = Math.max(0, Math.floor(labelBox.x));
      const y = Math.max(0, Math.floor(labelBox.y - 95));
      const width = Math.min(viewport.width - x, 180);
      const height = Math.min(viewport.height - y, 55);
      appendAutomationLog('AU_CAPTCHA', `Captured AU CAPTCHA using label anchor (${(labelBox as any).source || 'unknown'}) at label=${Math.round(labelBox.x)},${Math.round(labelBox.y)},${Math.round(labelBox.width)},${Math.round(labelBox.height)} clip=${x},${y},${width},${height}.`);
      return page.screenshot({
        type: 'png',
        clip: { x, y, width, height },
      });
    }

    const domElementImage = await captureAuCaptchaDomElement(page, captchaInput);
    if (domElementImage) return domElementImage;

    const captchaVisuals = page.locator('img, canvas');
    const visualCount = await captchaVisuals.count().catch(() => 0);
    let bestVisual: { x: number; y: number; width: number; height: number; score: number } | null = null;
    for (let i = 0; i < Math.min(visualCount, 20); i += 1) {
      const candidate = captchaVisuals.nth(i);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const candidateBox = await candidate.boundingBox().catch(() => null);
      if (!candidateBox) continue;
      if (candidateBox.width < 90 || candidateBox.height < 25) continue;
      const candidateContext = await candidate.evaluate((el: Element) => {
        const chunks: string[] = [];
        let node: Element | null = el;
        for (let depth = 0; depth < 5 && node; depth += 1) {
          const text = (node as HTMLElement).innerText || node.textContent || '';
          if (text) chunks.push(text);
          const aria = node.getAttribute('aria-label') || '';
          const title = node.getAttribute('title') || '';
          const alt = node.getAttribute('alt') || '';
          if (aria || title || alt) chunks.push(`${aria} ${title} ${alt}`);
          node = node.parentElement;
        }
        return chunks.join(' ').toLowerCase();
      }).catch(() => '');
      if (/virtual\s*keypad|keyboard|use\s*virtual/i.test(candidateContext)) continue;

      const aboveInput = candidateBox.y + candidateBox.height < box.y;
      const nearInput = candidateBox.y + candidateBox.height > box.y - 170;
      const horizontalMatch = candidateBox.x > box.x - 80 && candidateBox.x < box.x + 160;
      if (!aboveInput || !nearInput || !horizontalMatch) continue;

      const gap = box.y - (candidateBox.y + candidateBox.height);
      const captchaContextBoost = /captcha|refresh|security|code/.test(candidateContext) ? 90 : 0;
      const leftSideBoost = candidateBox.x <= box.x + 45 ? 80 : -80;
      const compactBoost = candidateBox.width <= 260 && candidateBox.height <= 90 ? 35 : -35;
      const score = candidateBox.width * 2 + candidateBox.height + captchaContextBoost + leftSideBoost + compactBoost - Math.abs(gap - 45) * 3 - Math.abs(candidateBox.x - box.x);
      if (!bestVisual || score > bestVisual.score) {
        bestVisual = { ...candidateBox, score };
      }
    }

    if (bestVisual) {
      const x = Math.max(0, Math.floor(bestVisual.x - 8));
      const y = Math.max(0, Math.floor(bestVisual.y - 8));
      const width = Math.min(viewport.width - x, Math.ceil(bestVisual.width + 16));
      const height = Math.min(viewport.height - y, Math.ceil(bestVisual.height + 16));
      appendAutomationLog('AU_CAPTCHA', `Captured AU CAPTCHA image element at ${Math.round(bestVisual.x)},${Math.round(bestVisual.y)},${Math.round(bestVisual.width)},${Math.round(bestVisual.height)}.`);
      return page.screenshot({
        type: 'png',
        clip: { x, y, width, height },
      });
    }

    const x = Math.max(0, Math.floor(box.x - 2));
    const y = Math.max(0, Math.floor(box.y - 84));
    const width = Math.min(viewport.width - x, 235);
    const height = Math.min(viewport.height - y, 64);
    appendAutomationLog('AU_CAPTCHA', `Captured strict AU CAPTCHA text fallback above input at ${x},${y},${width},${height}.`);
    return page.screenshot({
      type: 'png',
      clip: { x, y, width, height },
    });
  } catch (e: any) {
    console.warn('[AU Bank] CAPTCHA screenshot failed:', e?.message ?? e);
    return null;
  }
}

async function readLatestAuCaptchaInput(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const value = (window as any).__auLatestCaptchaInput;
    return typeof value === 'string' ? value : null;
  }).catch(() => null);
}

async function installAuCaptchaInputTracker(captchaInput: Locator): Promise<void> {
  await captchaInput.evaluate((input: Element) => {
    const target = input as HTMLInputElement | HTMLTextAreaElement;
    const update = () => { (window as any).__auLatestCaptchaInput = target.value || ''; };
    target.addEventListener('input', update);
    target.addEventListener('change', update);
    update();
  }).catch(() => {});
}

/**
 * Inject a high-z-index banner into the bank page when auto-CAPTCHA fails.
 * Tells the user exactly what to do — solve it manually and click Login.
 *
 * This is the visible-handoff that stops the user from staring at a stuck
 * browser. Best-effort; if injection fails (CSP, page already navigated),
 * we silently swallow.
 */
async function showAuCaptchaManualOverlay(page: Page, reason: string): Promise<void> {
  try {
    await page.evaluate((msg) => {
      const ID = 'ipo-manager-captcha-overlay';
      const prior = document.getElementById(ID);
      if (prior) prior.remove();
      const div = document.createElement('div');
      div.id = ID;
      div.style.cssText = [
        'position:fixed',
        'top:0',
        'left:0',
        'right:0',
        'background:linear-gradient(90deg,#b45309,#f59e0b)',
        'color:#fff',
        'padding:14px 24px',
        'z-index:2147483647',
        'font-family:-apple-system,BlinkMacSystemFont,sans-serif',
        'font-size:14px',
        'box-shadow:0 4px 16px rgba(0,0,0,0.45)',
        'display:flex',
        'align-items:center',
        'gap:14px',
      ].join(';');
      div.innerHTML =
        '<div style="font-size:24px;line-height:1">⚠️</div>' +
        '<div>' +
        '<div style="font-weight:700;font-size:15px">Auto-CAPTCHA failed</div>' +
        '<div style="opacity:0.95;margin-top:2px">' + msg + '</div>' +
        '</div>';
      document.body.appendChild(div);
    }, reason);
  } catch {
    // Overlay is best-effort.
  }
}

/**
 * Wait up to `timeoutMs` for the user to manually solve the CAPTCHA and submit.
 * Returns true if progress was detected (URL changed or CAPTCHA input disappeared),
 * false if we timed out. The browser window stays open either way so the user
 * can still complete the flow themselves after this returns.
 */
async function waitForManualCaptchaSubmit(
  page: Page,
  captchaInput: Locator,
  timeoutMs = 120_000,
): Promise<boolean> {
  const startUrl = page.url();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (page.isClosed()) return false;
    if (page.url() !== startUrl) {
      appendAutomationLog('AU_CAPTCHA', 'Manual CAPTCHA: detected URL change — proceeding.');
      return true;
    }
    const stillVisible = await captchaInput.isVisible().catch(() => false);
    if (!stillVisible) {
      appendAutomationLog('AU_CAPTCHA', 'Manual CAPTCHA: CAPTCHA input no longer visible — proceeding.');
      return true;
    }
    await page.waitForTimeout(800);
  }
  appendAutomationLog('AU_CAPTCHA', `Manual CAPTCHA: timed out after ${Math.round(timeoutMs / 1000)}s waiting for user.`);
  return false;
}

async function clickAuCaptchaRefresh(page: Page): Promise<boolean> {
  const selectors = [
    'a:has-text("Refresh")',
    'button:has-text("Refresh")',
    'span:has-text("Refresh")',
    '[aria-label*="refresh" i]',
    '[title*="refresh" i]',
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (!(await locator.isVisible().catch(() => false))) continue;
    await locator.click({ timeout: 2_000 }).catch(() => {});
    appendAutomationLog('AU_CAPTCHA', `Clicked CAPTCHA refresh via selector "${selector}".`);
    return true;
  }
  appendAutomationLog('AU_CAPTCHA', 'Could not find a Refresh control to re-roll the CAPTCHA.');
  return false;
}

async function trySolveAuCaptcha(page: Page, username: string, passwordField?: Locator | null): Promise<boolean> {
  const captchaInput = await findAuCaptchaInput(page, username, passwordField);
  if (!captchaInput) {
    console.log('[AU Bank] CAPTCHA input was not detected for Claude solve.');
    appendAutomationLog('AU_CAPTCHA', 'CAPTCHA input was not detected on AU page.');
    const snapshot = await page.screenshot({ type: 'png', fullPage: true }).catch(() => null);
    if (snapshot) {
      const artifactPath = writeAutomationArtifact('au-captcha-miss.png', snapshot);
      if (artifactPath) appendAutomationLog('AU_CAPTCHA', `Saved AU full-page screenshot for detection failure to ${artifactPath}`);
    }
    // The CAPTCHA input couldn't be located — the page may have changed.
    // Show a banner so the user knows to look around themselves.
    await showAuCaptchaManualOverlay(
      page,
      'The CAPTCHA field could not be located automatically. Please enter the CAPTCHA below and click Login.',
    );
    return false;
  }

  const inputMeta = await Promise.all([
    captchaInput.getAttribute('name').catch(() => ''),
    captchaInput.getAttribute('id').catch(() => ''),
    captchaInput.getAttribute('placeholder').catch(() => ''),
    captchaInput.getAttribute('aria-label').catch(() => ''),
  ]);
  const captchaBox = await captchaInput.boundingBox().catch(() => null);
  appendAutomationLog('AU_CAPTCHA', `Detected CAPTCHA input meta: name="${inputMeta[0] || ''}" id="${inputMeta[1] || ''}" placeholder="${inputMeta[2] || ''}" aria="${inputMeta[3] || ''}" box=${captchaBox ? `${Math.round(captchaBox.x)},${Math.round(captchaBox.y)},${Math.round(captchaBox.width)},${Math.round(captchaBox.height)}` : 'none'}`);
  await installAuCaptchaInputTracker(captchaInput);

  const otpProbe = page.locator('input.mx-rw-input-otp').first();
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const attemptStamp = makeAutomationArtifactStamp();
    const pageSnapshot = await page.screenshot({ type: 'png', fullPage: false }).catch(() => null);
    let pageHash: string | null = null;
    if (pageSnapshot) {
      pageHash = createHash('sha256').update(pageSnapshot).digest('hex').slice(0, 16);
      const pageArtifactPath = writeAutomationArtifact(`au-captcha-page-${attemptStamp}-${pageHash}.png`, pageSnapshot);
      if (pageArtifactPath) appendAutomationLog('AU_CAPTCHA', `Saved AU CAPTCHA page screenshot to ${pageArtifactPath} sha256=${pageHash}`);
    }

    const rawCrop = await captureAuCaptchaRegion(page, captchaInput);
    if (!rawCrop) {
      appendAutomationLog('AU_CAPTCHA', `Attempt ${attempt}: failed to capture AU CAPTCHA screenshot region.`);
      return false;
    }
    const image = upscalePng2x(rawCrop);
    const imageHash = createHash('sha256').update(image).digest('hex').slice(0, 16);
    const artifactName = `au-captcha-${attemptStamp}-${imageHash}.png`;
    const artifactPath = writeAutomationArtifact(artifactName, image);
    const latestArtifactPath = writeAutomationArtifact('au-captcha-last.png', image);
    if (artifactPath) appendAutomationLog('AU_CAPTCHA', `Attempt ${attempt}: saved AU CAPTCHA screenshot (2x upscaled) to ${artifactPath} sha256=${imageHash}`);
    if (latestArtifactPath) appendAutomationLog('AU_CAPTCHA', `Attempt ${attempt}: updated AU CAPTCHA latest screenshot to ${latestArtifactPath} sha256=${imageHash}`);

    try {
      appendAutomationLog('AU_CAPTCHA', `Attempt ${attempt}/${MAX_ATTEMPTS}: sending 2x upscaled crop (${image.length} bytes) sha256=${imageHash} to solver.`);
      const solutionResult = await solveCaptchaText(image, 'image/png');
      if (!solutionResult) {
        console.log('[AU Bank] CAPTCHA solver returned no usable text.');
        appendAutomationLog('AU_CAPTCHA', `Attempt ${attempt}: CAPTCHA solver returned no usable text.`);
        if (attempt < MAX_ATTEMPTS && await clickAuCaptchaRefresh(page)) {
          await page.waitForTimeout(1_200);
          continue;
        }
        return false;
      }
      const solution = solutionResult.text;
      setAuCaptchaLearningContext(page, {
        bankCode: 'AU',
        provider: solutionResult.provider,
        imageHash,
        primaryGuess: solution,
        confidence: solutionResult.confidence,
        alternates: solutionResult.alternates,
        outcome: 'failure',
        inputSource: 'auto',
        lastFilledText: solution,
      });

      await captchaInput.click({ timeout: 4_000 }).catch(() => {});
      await captchaInput.fill('', { timeout: 2_000 }).catch(() => {});
      await captchaInput.fill(solution, { timeout: 4_000 }).catch(() => {});
      let accepted = await captchaInput.inputValue().then(v => v.trim()).catch(() => '');
      if (!accepted) {
        await captchaInput.click({ clickCount: 3, timeout: 2_000 }).catch(() => {});
        await page.keyboard.type(solution, { delay: 25 }).catch(() => {});
        accepted = await captchaInput.inputValue().then(v => v.trim()).catch(() => '');
      }
      await captchaInput.dispatchEvent('input').catch(() => {});
      await captchaInput.dispatchEvent('change').catch(() => {});
      await captchaInput.dispatchEvent('blur').catch(() => {});
      if (!accepted) {
        console.warn('[AU Bank] CAPTCHA field did not accept autofill.');
        appendAutomationLog('AU_CAPTCHA', `Attempt ${attempt}: CAPTCHA field rejected autofill value "${solution}".`);
        return false;
      }

      console.log(`[AU Bank] CAPTCHA solved attempt ${attempt} (${solution.length} chars)`);
      appendAutomationLog(
        'AU_CAPTCHA',
        `Attempt ${attempt}: CAPTCHA autofill accepted value of length ${solution.length} from ${solutionResult.provider}${typeof solutionResult.confidence === 'number' ? ` confidence=${Math.round(solutionResult.confidence)}` : ''}.`,
      );

      if (!solutionResult.shouldSubmit) {
        appendAutomationLog('AU_CAPTCHA', 'CAPTCHA solver marked this value as fill-only; skipped automatic login click.');
        return false;
      }

      await page.waitForTimeout(1_200);
      const finalValue = await captchaInput.inputValue().then(v => v.trim()).catch(() => '');
      appendAutomationLog('AU_CAPTCHA', `Attempt ${attempt}: CAPTCHA field value before submit: "${finalValue}" (expected "${solution}").`);
      if (finalValue.toLowerCase() !== solution.toLowerCase()) {
        console.warn('[AU Bank] CAPTCHA value changed before submit; skipping auto-submit.');
        appendAutomationLog('AU_CAPTCHA', `Attempt ${attempt}: CAPTCHA value changed before submit; skipped automatic login click.`);
        await recordAuCaptchaLearning(page, 'failure', finalValue || solution);
        return false;
      }

      await captchaInput.press('Tab').catch(() => {});
      await page.waitForTimeout(500);

      const clicked = await clickAuLoginSubmit(page);
      if (!clicked) {
        await captchaInput.press('Enter').catch(() => {});
        appendAutomationLog('AU_CAPTCHA', `Attempt ${attempt}: submitted AU login with Enter after CAPTCHA fill.`);
      } else {
        appendAutomationLog('AU_CAPTCHA', `Attempt ${attempt}: submitted AU login using login button after CAPTCHA fill.`);
      }

      if (attempt === MAX_ATTEMPTS) {
        appendAutomationLog('AU_CAPTCHA', `Attempt ${attempt}: last allowed try; deferring success/failure detection to outer OTP wait.`);
        return true;
      }

      const accepted2 = await otpProbe.waitFor({ state: 'visible', timeout: 6_000 }).then(() => true).catch(() => false);
      if (accepted2) {
        appendAutomationLog('AU_CAPTCHA', `Attempt ${attempt}: OTP screen appeared — CAPTCHA accepted.`);
        return true;
      }

      const stillVisible = await captchaInput.isVisible().catch(() => false);
      if (!stillVisible) {
        appendAutomationLog('AU_CAPTCHA', `Attempt ${attempt}: CAPTCHA input no longer visible after submit; treating as accepted.`);
        return true;
      }

      appendAutomationLog('AU_CAPTCHA', `Attempt ${attempt}: still on CAPTCHA page after submit — assuming rejection, refreshing for retry.`);
      await recordAuCaptchaLearning(page, 'failure', solution);
      const refreshed = await clickAuCaptchaRefresh(page);
      if (!refreshed) {
        appendAutomationLog('AU_CAPTCHA', `Attempt ${attempt}: Refresh control not found; bailing out of retry loop.`);
        return false;
      }
      await page.waitForTimeout(1_500);
    } catch (e: any) {
      console.warn('[AU Bank] CAPTCHA solve failed:', e?.message ?? e);
      appendAutomationLog('AU_CAPTCHA', `Attempt ${attempt}: CAPTCHA solve failed: ${e?.message ?? e}`);
      return false;
    }
  }

  return false;
}

async function readBalanceFromPage(page: Page): Promise<string | null> {
  return page.evaluate(({ inr }) => {
    const findInText = (text: string): string | null => {
      const patterns: RegExp[] = [
        /Available\s+Balance[\s\S]{0,60}?(?:\u20B9|INR|Rs\.?)\s*([\d,]+(?:\.\d{1,2})?)/i,
        /Avail(?:able)?\.?\s*Bal(?:ance)?\.?[\s\S]{0,60}?(?:\u20B9|INR|Rs\.?)\s*([\d,]+(?:\.\d{1,2})?)/i,
        /(?:\u20B9|INR|Rs\.?)\s*([\d,]+(?:\.\d{1,2})?)/i,
      ];
      for (const re of patterns) {
        const m = text.match(re);
        if (m?.[1]) return m[1];
      }
      return null;
    };

    const bodyText = (document.body as HTMLElement | null)?.innerText || '';
    const bodyHit = findInText(bodyText);
    if (bodyHit) return `${inr}${bodyHit}`;

    return null;
  }, { inr: INR });
}

async function waitForAuPostLogin(page: Page, timeoutMs = 180_000): Promise<void> {
  await page.waitForFunction(() => {
    const href = window.location.href;
    const text = (document.body as HTMLElement | null)?.innerText?.toLowerCase() || '';
    const stillOtp = !!document.querySelector('input.mx-rw-input-otp');
    const hasAccountText =
      text.includes('available balance') ||
      text.includes('account summary') ||
      text.includes('savings account') ||
      text.includes('dashboard') ||
      text.includes('accounts');

    return (!stillOtp && hasAccountText) || (!href.includes('/drb/') && hasAccountText);
  }, { timeout: timeoutMs });
}

async function isAuLoggedIn(page: Page): Promise<boolean> {
  if (!page.url().includes('au.bank.in')) return false;
  return page.evaluate(() => {
    const href = window.location.href.toLowerCase();
    const text = (document.body as HTMLElement | null)?.innerText?.toLowerCase() || '';
    if (href.includes('iposmart.au.bank.in/ipo-onnet-aub')) {
      return text.includes('ipo')
        || text.includes('issue')
        || text.includes('bid')
        || text.includes('asba');
    }
    return text.includes('available balance')
      || text.includes('account summary')
      || text.includes('dashboard')
      || text.includes('logout')
      || text.includes('investments')
      || text.includes('accounts');
  }).catch(() => false);
}

async function isAuIpoPage(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const href = window.location.href.toLowerCase();
    const hostname = window.location.hostname.toLowerCase();
    const text = (document.body as HTMLElement | null)?.innerText?.toLowerCase() || '';
    if (hostname === 'iposmart.au.bank.in' && href.includes('/ipo-onnet-aub/')) {
      return !href.includes('/error-view');
    }
    return text.includes('issue name')
      && (text.includes('quantity') || text.includes('cut off') || text.includes('depository') || text.includes('bid'));
  }).catch(() => false);
}

async function findOpenAuIpoPage(page: Page): Promise<Page | null> {
  const pages = [...page.context().pages()].reverse();
  for (const candidate of pages) {
    if (candidate.isClosed()) continue;
    if (await isAuIpoPage(candidate)) return candidate;
  }
  return null;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function issueRegex(issueName: string): RegExp {
  const parts = issueName
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length >= 3)
    .slice(0, 4)
    .map(escapeRegex);
  if (!parts.length) return new RegExp(escapeRegex(issueName), 'i');
  return new RegExp(parts.join('.*'), 'i');
}

function normalizeLoose(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function preferredInvestorCategoryOptions(draft: IpoBidDraft): string[] {
  if (draft.investorCategory) return [draft.investorCategory];
  if (draft.blockedAmount > 200000) {
    return [
      'Individual Investors, NRI, HUF - HNI applications above 2 Lakhs',
      'Individual Investors, NRI, HUF - HNI application above 2 Lakhs',
      'HNI applications above 2 Lakhs',
      'HNI',
    ];
  }
  return [
    'Individual Investors, NRI, HUF - Retail applications up to 2 Lakhs',
    'Individual Investors, NRI, HUF - Retail application up to 2 Lakhs',
    'Retail applications up to 2 Lakhs',
    'Retail',
  ];
}

async function clickFirstVisible(page: Page, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.click({ timeout: 5_000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function clickFirstText(page: Page, labels: string[]): Promise<boolean> {
  for (const label of labels) {
    const locator = page.getByText(new RegExp(escapeRegex(label).replace(/\s+/g, '\\s+'), 'i')).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.click({ timeout: 5_000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function clickVisibleContainingText(page: Page, texts: string[]): Promise<boolean> {
  const hit = await page.evaluate((rawTexts) => {
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
    const wanted = rawTexts.map(normalize).filter(Boolean);
    const isVisible = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 10
        && rect.height > 10
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && el.offsetParent !== null;
    };

    const matches = Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter(el => isVisible(el))
      .map(el => ({ el, text: normalize(el.innerText || '') }))
      .filter(item => item.text && wanted.some(needle => item.text.includes(needle)))
      .sort((a, b) => a.text.length - b.text.length);

    for (const match of matches) {
      const rect = match.el.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) continue;
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        text: match.text,
      };
    }
    return null;
  }, texts).catch(() => null);

  if (!hit) return false;

  await page.mouse.move(hit.x, hit.y);
  await page.mouse.click(hit.x, hit.y);
  console.log(`[AU Bank] Clicked visible text containing "${hit.text}"`);
  return true;
}

async function clickEnabledActionText(page: Page, labels: string[]): Promise<boolean> {
  const hit = await page.evaluate((rawLabels) => {
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
    const wanted = rawLabels.map(normalize).filter(Boolean);
    const isVisible = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 10
        && rect.height > 10
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && el.offsetParent !== null;
    };
    const isDisabled = (el: HTMLElement) => {
      const control = el as HTMLButtonElement | HTMLInputElement;
      const ariaDisabled = (el.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
      const className = typeof el.className === 'string' ? el.className.toLowerCase() : '';
      const style = window.getComputedStyle(el);
      return !!control.disabled
        || ariaDisabled
        || className.includes('disabled')
        || style.pointerEvents === 'none';
    };
    const readText = (el: HTMLElement) => {
      if (el instanceof HTMLInputElement) return normalize(el.value || '');
      return normalize(el.innerText || '');
    };

    const matches = Array.from(document.querySelectorAll<HTMLElement>('button, a, input[type="button"], input[type="submit"], [role="button"]'))
      .filter(el => isVisible(el))
      .filter(el => !isDisabled(el))
      .map(el => ({ el, text: readText(el) }))
      .filter(item => item.text && wanted.some(label => item.text === label || item.text.includes(label)))
      .sort((a, b) => a.text.length - b.text.length);

    const match = matches[0];
    if (!match) return null;
    const rect = match.el.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      text: match.text,
    };
  }, labels).catch(() => null);

  if (!hit) return false;

  await page.mouse.move(hit.x, hit.y);
  await page.mouse.click(hit.x, hit.y);
  console.log(`[AU Bank] Clicked enabled action "${hit.text}"`);
  return true;
}

async function clickVisibleLabeledTile(page: Page, labels: string[]): Promise<boolean> {
  const hit = await page.evaluate((rawLabels) => {
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
    const wanted = rawLabels.map(normalize);
    const area = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      return rect.width * rect.height;
    };
    const isVisible = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 16
        && rect.height > 12
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && el.offsetParent !== null;
    };
    const chooseTarget = (start: HTMLElement): HTMLElement | null => {
      let node: HTMLElement | null = start;
      let fallback: HTMLElement | null = start;
      while (node && node !== document.body) {
        if (isVisible(node) && area(node) >= 2_500) fallback = node;
        const role = (node.getAttribute('role') || '').toLowerCase();
        const className = typeof node.className === 'string' ? node.className.toLowerCase() : '';
        const tag = node.tagName.toLowerCase();
        if (
          tag === 'button'
          || tag === 'a'
          || role === 'button'
          || className.includes('tile')
          || className.includes('card')
          || className.includes('menu')
          || className.includes('item')
          || typeof (node as any).onclick === 'function'
        ) {
          return node;
        }
        node = node.parentElement;
      }
      return fallback;
    };

    const matches = Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter(el => isVisible(el))
      .map(el => ({ el, text: normalize(el.innerText || '') }))
      .filter(item => item.text && wanted.some(label => item.text === label || item.text.includes(label)))
      .sort((a, b) => a.text.length - b.text.length || area(a.el) - area(b.el));

    for (const match of matches) {
      const target = chooseTarget(match.el);
      if (!target || !isVisible(target)) continue;
      target.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = target.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 20) continue;
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        label: match.text,
        targetTag: target.tagName.toLowerCase(),
      };
    }

    return null;
  }, labels).catch(() => null);

  if (!hit) return false;

  await page.mouse.move(hit.x, hit.y);
  await page.mouse.click(hit.x, hit.y);
  console.log(`[AU Bank] Clicked labeled tile "${hit.label}" via ${hit.targetTag}`);
  return true;
}

async function clickAuIssueApply(page: Page, issueName: string): Promise<boolean> {
  // Tokens >= 3 chars (e.g. "Recode Studios Limited" → ["recode", "studios", "limited"]).
  // Don't include short filler tokens that match everywhere.
  const issueTokens = issueName
    .toLowerCase()
    .split(/\s+/)
    .map(token => token.replace(/[^a-z0-9]/g, '').trim())
    .filter(token => token.length >= 3);

  // First, try to scroll the issue row into view in case it's below the fold
  // or virtualized off-screen. We scroll through the page in steps and re-try
  // the locate on each step.
  for (let scrollStep = 0; scrollStep < 6; scrollStep += 1) {
    const hit = await page.evaluate((tokens) => {
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
      const isVisible = (el: HTMLElement) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 16
          && rect.height > 12
          && style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.opacity !== '0'
          && el.offsetParent !== null;
      };

      // Broaden the labels matched on the row-level button. AU sometimes uses
      // "Apply", "Apply Now", "APPLY", "BID NOW", "Place Bid", "+ Apply", etc.
      const APPLY_LABELS = [
        'apply', 'apply now', 'bid', 'bid now', 'place bid', '+ apply',
        '+apply', 'apply →', 'submit', 'go',
      ];
      const isApplyLabel = (text: string) => {
        const t = normalize(text);
        if (!t) return false;
        for (const lbl of APPLY_LABELS) {
          if (t === lbl) return 1.0;
          if (t.startsWith(lbl + ' ')) return 0.95;
          if (t.endsWith(' ' + lbl)) return 0.9;
          if (t.includes(lbl)) return 0.7;
        }
        return 0;
      };

      const scoreText = (text: string) => tokens.reduce((score, token) =>
        score + (text.includes(token) ? 1 : 0), 0);

      // Wider container selector — also covers Angular Material rows and modern
      // card/list layouts.
      const containers = Array.from(document.querySelectorAll<HTMLElement>(
        'tr, tbody tr, .mat-row, .mat-mdc-row, mat-row, .mat-card, .card, ' +
        '.table-row, .row, li, section, article, div[role="row"], ' +
        '.list-item, .grid-row, .item-row, .product-row, .ipo-row'
      )).filter(el => isVisible(el));

      let best: {
        container: HTMLElement;
        apply: HTMLElement;
        rowScore: number;
        applyScore: number;
        textLength: number;
      } | null = null;

      for (const container of containers) {
        const text = normalize(container.innerText || '');
        if (!text) continue;
        const rowScore = scoreText(text);
        if (rowScore === 0) continue;
        // Skip giant containers that engulf the whole page
        if (text.length > 2000) continue;

        // Look for any clickable element with apply-like text inside this row
        const applyCandidates = Array.from(container.querySelectorAll<HTMLElement>(
          'button, a, [role="button"], input[type="button"], input[type="submit"], ' +
          '.btn, mat-icon-button, .mat-button, .mat-mdc-button, span[onclick], div[onclick]'
        )).filter(el => isVisible(el));

        let bestApply: HTMLElement | null = null;
        let bestApplyScore = 0;
        for (const cand of applyCandidates) {
          const candText =
            (cand as HTMLInputElement).value
            || cand.innerText
            || cand.getAttribute('aria-label')
            || cand.getAttribute('title')
            || '';
          const score = isApplyLabel(candText);
          if (score > bestApplyScore) {
            bestApplyScore = score;
            bestApply = cand;
          }
        }
        if (!bestApply || bestApplyScore === 0) continue;

        const textLength = text.length;
        const better =
          !best
          || rowScore > best.rowScore
          || (rowScore === best.rowScore && bestApplyScore > best.applyScore)
          || (rowScore === best.rowScore && bestApplyScore === best.applyScore && textLength < best.textLength);
        if (better) {
          best = { container, apply: bestApply, rowScore, applyScore: bestApplyScore, textLength };
        }
      }

      if (!best) return null;

      best.apply.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = best.apply.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return null;

      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        rowText: normalize(best.container.innerText || '').slice(0, 200),
        rowScore: best.rowScore,
        applyScore: best.applyScore,
        buttonText: normalize(best.apply.innerText || ''),
      };
    }, issueTokens).catch(() => null);

    if (hit) {
      await page.mouse.move(hit.x, hit.y);
      await page.mouse.click(hit.x, hit.y);
      console.log(`[AU Bank] Clicked Apply for matching issue row (row score ${hit.rowScore}, button "${hit.buttonText}", scroll step ${scrollStep}).`);
      await page.waitForTimeout(1_200);
      return true;
    }

    // Not found yet — scroll down to load more rows (virtualized lists need this)
    await page.evaluate(() => {
      window.scrollBy({ top: window.innerHeight * 0.75, behavior: 'instant' as ScrollBehavior });
    });
    await page.waitForTimeout(400);
  }

  // Reset scroll to top for the next steps
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })).catch(() => {});
  return false;
}

/**
 * Wait for the AU bid form to appear — used after a failed auto-click as a
 * graceful pause so the user can click Apply manually (via the floating
 * APPLY button or the real one). Returns true if the form shows up within
 * the timeout.
 */
async function waitForAuBidFormManual(page: Page, timeoutMs: number): Promise<boolean> {
  try {
    await page.waitForFunction(() => {
      const text = (document.body as HTMLElement | null)?.innerText || '';
      // The bid form has these landmarks: investor category, debit account,
      // demat account, quantity field, price/cut-off.
      const hits = [
        /investor\s+category/i,
        /debit\s+account/i,
        /demat\s+account/i,
        /(quantity|lots?)\b/i,
        /(cut[-\s]?off|bid\s+price)/i,
      ].reduce((acc, re) => acc + (re.test(text) ? 1 : 0), 0);
      return hits >= 3;     // need at least 3 of 5 landmarks visible
    }, { timeout: timeoutMs, polling: 500 });
    return true;
  } catch {
    return false;
  }
}

async function selectAuOptionByLabel(page: Page, labels: RegExp[], optionTexts: string[]): Promise<boolean> {
  const result = await page.evaluate(({ labelSources, optionValues }) => {
    const patterns = labelSources.map((source: string) => new RegExp(source, 'i'));
    const desired = optionValues
      .map((value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase())
      .filter(Boolean);
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
    const isVisible = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 12
        && rect.height > 12
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && el.offsetParent !== null;
    };
    const findNativeSelect = (scope: HTMLElement) =>
      Array.from(scope.querySelectorAll<HTMLSelectElement>('select'))
        .find(select => isVisible(select));
    const findControl = (labelEl: HTMLElement) => {
      const labelRect = labelEl.getBoundingClientRect();
      const scopes = [
        labelEl.parentElement,
        labelEl.parentElement?.parentElement,
        labelEl.closest('form'),
        labelEl.closest('section'),
        labelEl.closest('table'),
      ].filter(Boolean) as HTMLElement[];

      for (const scope of scopes) {
        const nativeSelect = findNativeSelect(scope);
        if (nativeSelect) return { nativeSelect };

        const candidates = Array.from(scope.querySelectorAll<HTMLElement>('div, span, button, a, input, [role="combobox"], [role="button"]'))
          .filter(el => el !== labelEl && isVisible(el))
          .filter(el => {
            const rect = el.getBoundingClientRect();
            const text = normalize(el.innerText || '');
            return rect.left >= labelRect.left
              && Math.abs(rect.top - labelRect.top) < 90
              && (text.includes('select') || text.length > 0 || el.tagName.toLowerCase() === 'input');
          })
          .sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return (ar.left - labelRect.left) - (br.left - labelRect.left);
          });
        if (candidates[0]) return { clickable: candidates[0] };
      }
      return null;
    };

    const labelEls = Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter(el => isVisible(el))
      .filter(el => patterns.some(re => re.test((el.innerText || '').trim())))
      .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);

    for (const labelEl of labelEls) {
      const control = findControl(labelEl);
      if (!control) continue;

      if (control.nativeSelect) {
        const option = Array.from(control.nativeSelect.options).find(opt => {
          const text = normalize(opt.textContent || '');
          return desired.some(needle => text.includes(needle));
        });
        if (option) {
          control.nativeSelect.value = option.value;
          control.nativeSelect.dispatchEvent(new Event('input', { bubbles: true }));
          control.nativeSelect.dispatchEvent(new Event('change', { bubbles: true }));
          return { mode: 'native', value: option.textContent || option.value };
        }
      }

      if (control.clickable) {
        const rect = control.clickable.getBoundingClientRect();
        return {
          mode: 'click',
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
      }
    }

    return null;
  }, {
    labelSources: labels.map(label => label.source),
    optionValues: optionTexts,
  }).catch(() => null);

  if (!result) return false;
  if (result.mode === 'native') {
    console.log(`[AU Bank] Selected native dropdown option "${result.value}"`);
    await page.waitForTimeout(500);
    return true;
  }
  if (result.mode !== 'click' || typeof result.x !== 'number' || typeof result.y !== 'number') {
    return false;
  }

  await page.mouse.move(result.x, result.y);
  await page.mouse.click(result.x, result.y);
  await page.waitForTimeout(500);

  const optionClicked =
    await clickVisibleContainingText(page, optionTexts)
    || await clickFirstText(page, optionTexts);

  if (optionClicked) {
    await page.waitForTimeout(500);
  }
  return optionClicked;
}

async function tickAuCutOff(page: Page): Promise<boolean> {
  const hit = await page.evaluate(() => {
    const rowMode = 'draft' as const;
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
    const isVisible = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8
        && rect.height > 8
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && el.offsetParent !== null;
    };
    const scoreRow = (text: string) => {
      const hasAdd = text.includes(' add');
      const hasDelete = text.includes(' delete');
      if (rowMode === 'draft') return hasAdd ? 2 : hasDelete ? 1 : 0;
      if (rowMode === 'committed') return hasDelete ? 2 : hasAdd ? 1 : 0;
      return hasAdd || hasDelete ? 1 : 0;
    };

    const rows = Array.from(document.querySelectorAll<HTMLElement>('tr, .mat-row, .table-row, .row, div'))
      .filter(el => isVisible(el))
      .map(el => ({ el, text: normalize(el.innerText || '') }))
      .map(item => ({ ...item, score: scoreRow(item.text) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || a.text.length - b.text.length);

    for (const row of rows) {
      const rowRect = row.el.getBoundingClientRect();
      const native = Array.from(row.el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
        .find(el => isVisible(el));
      if (native) {
        const rect = native.getBoundingClientRect();
        return {
          mode: 'native',
          checked: native.checked,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          rowText: row.text,
        };
      }

      const header = Array.from(document.querySelectorAll<HTMLElement>('body *'))
        .find(el => isVisible(el) && normalize(el.innerText || '') === 'cut off price');
      if (!header) continue;
      const headerRect = header.getBoundingClientRect();

      const candidates = Array.from(row.el.querySelectorAll<HTMLElement>('span, div, label, button'))
        .filter(el => isVisible(el))
        .map(el => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || '') }))
        .filter(item =>
          item.rect.left >= headerRect.left - 80
          && item.rect.right <= headerRect.right + 120
          && item.rect.top >= rowRect.top - 10
          && item.rect.bottom <= rowRect.bottom + 10
          && item.rect.width <= 80
          && item.rect.height <= 80
          && !item.text.includes('cut off price')
        )
        .sort((a, b) => a.rect.left - b.rect.left);
      const target = candidates[0];
      if (!target) continue;
      return {
        mode: 'click',
        x: target.rect.left + target.rect.width / 2,
        y: target.rect.top + target.rect.height / 2,
        rowText: row.text,
      };
    }

    return null;
  }).catch(() => null);

  if (!hit) return false;
  if (hit.mode === 'native' && hit.checked) {
    console.log(`[AU Bank] Cut off checkbox was already ticked for row "${hit.rowText}"`);
    return true;
  }

  await page.mouse.move(hit.x, hit.y);
  await page.mouse.click(hit.x, hit.y);
  console.log(hit.mode === 'native'
    ? `[AU Bank] Ticked cut off checkbox via targeted native checkbox for row "${hit.rowText}"`
    : `[AU Bank] Ticked cut off checkbox via positioned click for row "${hit.rowText}"`);
  await page.waitForTimeout(400);
  return true;
}

async function ensureAuCommittedCutOff(page: Page): Promise<boolean> {
  const hit = await page.evaluate(() => {
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
    const isVisible = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 10
        && rect.height > 10
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && el.offsetParent !== null;
    };
    const rows = Array.from(document.querySelectorAll<HTMLElement>('tr, .mat-row, .table-row, .row, div'))
      .filter(el => isVisible(el))
      .map(el => ({ el, text: normalize(el.innerText || '') }))
      .filter(item => item.text.includes(' delete'))
      .sort((a, b) => a.text.length - b.text.length);

    for (const row of rows) {
      const native = Array.from(row.el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
        .find(el => isVisible(el));
      if (native) {
        const rect = native.getBoundingClientRect();
        return {
          checked: native.checked,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          rowText: row.text,
        };
      }
    }
    return null;
  }).catch(() => null);

  if (!hit) return false;
  if (hit.checked) {
    console.log(`[AU Bank] Committed AU bid row already has cut off selected for "${hit.rowText}"`);
    return true;
  }
  await page.mouse.move(hit.x, hit.y);
  await page.mouse.click(hit.x, hit.y);
  console.log(`[AU Bank] Ticked cut off checkbox on committed AU bid row "${hit.rowText}"`);
  await page.waitForTimeout(400);
  return true;
}

async function addAuBidLine(page: Page): Promise<boolean> {
  const alreadyAdded = await page.evaluate(() => {
    const text = (document.body as HTMLElement | null)?.innerText?.toLowerCase() || '';
    return text.includes(' delete') && !text.includes(' please enter bid price as per the ipo price range.');
  }).catch(() => false);
  if (alreadyAdded) {
    console.log('[AU Bank] AU bid line already appears committed; skipping Add');
    return true;
  }

  const added =
    await clickFirstVisible(page, [
      'button:has-text("Add")',
      '[role="button"]:has-text("Add")',
      'a:has-text("Add")',
    ]) || await clickVisibleContainingText(page, ['Add'])
      || await clickFirstText(page, ['Add']);

  if (added) {
    console.log('[AU Bank] Clicked Add for AU bid line');
    await page.waitForTimeout(1_000);
  }
  return added;
}

async function waitForAuSingleBidReady(page: Page): Promise<boolean> {
  const ready = await page.waitForFunction(() => {
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
    const isVisible = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 10
        && rect.height > 10
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && el.offsetParent !== null;
    };
    const candidateRows = Array.from(document.querySelectorAll<HTMLElement>('tr, .mat-row, .table-row, .row, div'))
      .filter(el => isVisible(el))
      .map(el => normalize(el.innerText || ''))
      .filter(text => text.includes(' add') || text.includes(' delete'));

    if (!candidateRows.length) return false;

    const hasExtraInvalidDraftRow =
      candidateRows.some(text => text.includes(' delete'))
      && candidateRows.some(text => text.includes(' add') && text.includes('please enter bid price as per the ipo price range'));
    if (hasExtraInvalidDraftRow) return false;

    return candidateRows.some(text => {
      if (text.includes('please enter bid price as per the ipo price range')) return false;
      const positiveAmount = Array.from(text.matchAll(/(?:₹|inr|rs\.?)\s*([0-9][\d,]*(?:\.\d{1,2})?)/gi))
        .some(match => Number((match[1] || '0').replace(/,/g, '')) > 0);
      return positiveAmount;
    });
  }, { timeout: 5_000, polling: 200 }).then(() => true).catch(() => false);

  if (ready) {
    console.log('[AU Bank] AU bid row looks ready without adding another row');
  }
  return ready;
}

async function isAuProceedEnabled(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
    const isVisible = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 10
        && rect.height > 10
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && el.offsetParent !== null;
    };
    const isDisabled = (el: HTMLElement) => {
      const control = el as HTMLButtonElement | HTMLInputElement;
      const ariaDisabled = (el.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
      const className = typeof el.className === 'string' ? el.className.toLowerCase() : '';
      const style = window.getComputedStyle(el);
      return !!control.disabled
        || ariaDisabled
        || className.includes('disabled')
        || style.pointerEvents === 'none';
    };
    const readText = (el: HTMLElement) => {
      if (el instanceof HTMLInputElement) return normalize(el.value || '');
      return normalize(el.innerText || '');
    };

    return Array.from(document.querySelectorAll<HTMLElement>('button, a, input[type="button"], input[type="submit"], [role="button"]'))
      .filter(el => isVisible(el))
      .some(el => {
        const text = readText(el);
        return (text.includes('proceed') || text.includes('review') || text.includes('continue') || text.includes('next'))
          && !isDisabled(el);
      });
  }).catch(() => false);
}

async function isAuTermsAccepted(page: Page): Promise<boolean> {
  const checked = await page.evaluate(() => {
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
    const isVisible = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 10
        && rect.height > 10
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && el.offsetParent !== null;
    };
    const labelMatches = Array.from(document.querySelectorAll<HTMLElement>('label, span, div, p'))
      .filter(el => isVisible(el))
      .map(el => ({ el, text: normalize(el.innerText || '') }))
      .filter(item =>
        item.text.includes('terms & conditions')
        || item.text.includes('terms and conditions')
        || item.text.includes('i have read the disclaimer'))
      .sort((a, b) => a.text.length - b.text.length);

    const findAssociatedCheckbox = (labelEl: HTMLElement): HTMLInputElement | null => {
      if (labelEl instanceof HTMLLabelElement) {
        const nested = labelEl.querySelector<HTMLInputElement>('input[type="checkbox"]');
        if (nested) return nested;
        if (labelEl.htmlFor) {
          const linked = document.getElementById(labelEl.htmlFor);
          if (linked instanceof HTMLInputElement && linked.type === 'checkbox') return linked;
        }
      }

      const scopes = [
        labelEl.closest('label'),
        labelEl.parentElement,
        labelEl.parentElement?.parentElement,
        labelEl.closest('div'),
        labelEl.closest('section'),
        labelEl.closest('form'),
      ].filter(Boolean) as HTMLElement[];

      for (const scope of scopes) {
        const nested = scope.querySelector<HTMLInputElement>('input[type="checkbox"]');
        if (nested) return nested;
      }

      const labelRect = labelEl.getBoundingClientRect();
      const nearby = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
        .map(input => ({ input, rect: input.getBoundingClientRect() }))
        .filter(item =>
          Math.abs((item.rect.top + item.rect.bottom) / 2 - (labelRect.top + labelRect.bottom) / 2) < 36
          && item.rect.right <= labelRect.left + 48)
        .sort((a, b) =>
          Math.abs(a.rect.right - labelRect.left) - Math.abs(b.rect.right - labelRect.left));
      return nearby[0]?.input || null;
    };

    for (const match of labelMatches) {
      const checkbox = findAssociatedCheckbox(match.el);
      if (checkbox?.checked) {
        return true;
      }

      const labelRect = match.el.getBoundingClientRect();
      const ariaChecked = Array.from(document.querySelectorAll<HTMLElement>('[role="checkbox"]'))
        .filter(el => isVisible(el))
        .find(el => {
          const rect = el.getBoundingClientRect();
          return rect.right <= labelRect.left + 48
            && Math.abs((rect.top + rect.bottom) / 2 - (labelRect.top + labelRect.bottom) / 2) < 36
            && (el.getAttribute('aria-checked') || '').toLowerCase() === 'true';
        });
      if (ariaChecked) {
        return true;
      }
    }

    return false;
  }).catch(() => false);

  if (checked) return true;
  return isAuProceedEnabled(page);
}

async function findAuTermsTargets(page: Page): Promise<Array<{ x: number; y: number; source: string; label: string }>> {
  return page.evaluate(() => {
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
    const isVisible = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 6
        && rect.height > 6
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && el.offsetParent !== null;
    };
    const dedupe = new Set<string>();
    const points: Array<{ x: number; y: number; source: string; label: string }> = [];
    const pushPoint = (x: number, y: number, source: string, label: string) => {
      const key = `${Math.round(x)}:${Math.round(y)}:${source}`;
      if (dedupe.has(key)) return;
      dedupe.add(key);
      points.push({ x, y, source, label });
    };
    const labelMatches = Array.from(document.querySelectorAll<HTMLElement>('label, span, div, p'))
      .filter(el => isVisible(el))
      .map(el => ({ el, text: normalize(el.innerText || '') }))
      .filter(item =>
        item.text.includes('terms & conditions')
        || item.text.includes('terms and conditions')
        || item.text.includes('i have read the disclaimer'))
      .sort((a, b) => a.text.length - b.text.length);

    for (const match of labelMatches) {
      match.el.scrollIntoView({ block: 'center', inline: 'nearest' });
      const labelRect = match.el.getBoundingClientRect();

      const nativeInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
        .filter(el => isVisible(el))
        .map(el => ({ el, rect: el.getBoundingClientRect() }))
        .filter(item =>
          item.rect.right <= labelRect.left + 56
          && Math.abs((item.rect.top + item.rect.bottom) / 2 - (labelRect.top + labelRect.bottom) / 2) < 40)
        .sort((a, b) =>
          Math.abs(a.rect.right - labelRect.left) - Math.abs(b.rect.right - labelRect.left));
      for (const item of nativeInputs) {
        pushPoint(item.rect.left + item.rect.width / 2, item.rect.top + item.rect.height / 2, 'native-checkbox', match.text);
      }

      const visualBoxes = Array.from(document.querySelectorAll<HTMLElement>('[role="checkbox"], span, div, i, svg'))
        .filter(el => isVisible(el))
        .map(el => ({ el, rect: el.getBoundingClientRect() }))
        .filter(item => {
          const width = item.rect.width;
          const height = item.rect.height;
          const ratio = Math.max(width, height) / Math.max(1, Math.min(width, height));
          return width <= 40
            && height <= 40
            && ratio <= 1.8
            && item.rect.right <= labelRect.left + 56
            && Math.abs((item.rect.top + item.rect.bottom) / 2 - (labelRect.top + labelRect.bottom) / 2) < 40;
        })
        .sort((a, b) =>
          Math.abs(a.rect.right - labelRect.left) - Math.abs(b.rect.right - labelRect.left)
          || (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
      for (const item of visualBoxes.slice(0, 4)) {
        pushPoint(item.rect.left + item.rect.width / 2, item.rect.top + item.rect.height / 2, 'visual-checkbox', match.text);
      }

      pushPoint(Math.max(12, labelRect.left - 18), labelRect.top + labelRect.height / 2, 'label-left', match.text);
      pushPoint(Math.max(12, labelRect.left - 28), labelRect.top + labelRect.height / 2, 'label-left-wide', match.text);
      pushPoint(labelRect.left + 6, labelRect.top + labelRect.height / 2, 'label-edge', match.text);
    }

    return points;
  }).catch(() => []);
}

async function acceptAuTerms(page: Page): Promise<boolean> {
  if (await isAuTermsAccepted(page)) {
    console.log('[AU Bank] Disclaimer/terms already appears accepted');
    return true;
  }

  const targets = await findAuTermsTargets(page);
  for (const target of targets) {
    await page.mouse.move(target.x, target.y);
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(350);
    if (await isAuTermsAccepted(page)) {
      console.log(`[AU Bank] Accepted AU disclaimer/terms via ${target.source} "${target.label}"`);
      return true;
    }
  }

  const labelClicked =
    await clickVisibleContainingText(page, ['Terms & Conditions', 'Terms and Conditions', 'Disclaimer'])
    || await clickFirstText(page, ['Terms & Conditions', 'Terms and Conditions', 'Disclaimer']);
  if (labelClicked) {
    await page.waitForTimeout(400);
    if (await isAuTermsAccepted(page)) {
      console.log('[AU Bank] Accepted AU disclaimer/terms via label click');
      return true;
    }
  }

  return false;
}

async function waitForAuIssueForm(page: Page): Promise<boolean> {
  return page.waitForFunction(() => {
    const text = (document.body as HTMLElement | null)?.innerText?.toLowerCase() || '';
    const hasInputs = !!document.querySelector('input, select, textarea');
    return hasInputs && (
      text.includes('quantity')
      || text.includes('cut off')
      || text.includes('bid price')
      || text.includes('depository')
      || text.includes('client id')
      || text.includes('demat')
    );
  }, { timeout: 10_000 }).then(() => true).catch(() => false);
}

async function fillVisibleInput(page: Page, selectors: string[], value: string): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.fill('');
      await locator.fill(value);
      return true;
    }
  }
  return false;
}

async function fillByLabel(page: Page, labels: RegExp[], value: string): Promise<boolean> {
  for (const label of labels) {
    const locator = page.getByLabel(label).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.fill('');
      await locator.fill(value);
      return true;
    }
  }
  return false;
}

async function selectContaining(page: Page, searchText: string): Promise<boolean> {
  const selects = page.locator('select');
  const count = await selects.count().catch(() => 0);
  const wanted = searchText.toLowerCase();
  for (let i = 0; i < count; i += 1) {
    const ok = await selects.nth(i).evaluate((el, search) => {
      if (!(el instanceof HTMLSelectElement)) return false;
      const option = Array.from(el.options).find(opt =>
        (opt.textContent || '').toLowerCase().includes(search)
      );
      if (!option) return false;
      el.value = option.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, wanted).catch(() => false);
    if (ok) return true;
  }
  return false;
}

async function clickForAuIpoPage(page: Page, clickAction: () => Promise<boolean>): Promise<Page | null> {
  const popupPromise = page.context()
    .waitForEvent('page', { timeout: 10_000 })
    .then(async popup => {
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      await popup.waitForTimeout(1_500).catch(() => {});
      return popup;
    })
    .catch(() => null);

  const clicked = await clickAction();
  if (!clicked) return null;

  const popup = await popupPromise;
  if (popup && !popup.isClosed()) return popup;

  await page.waitForTimeout(1_500);
  return findOpenAuIpoPage(page);
}

async function continueAuIpoRedirect(page: Page): Promise<boolean> {
  const continueClicked =
    await clickFirstVisible(page, [
      'button:has-text("Continue")',
      '[role="button"]:has-text("Continue")',
      'input[type="button"][value*="Continue" i]',
      'input[type="submit"][value*="Continue" i]',
    ]) || await clickVisibleLabeledTile(page, ['Continue'])
      || await clickFirstText(page, ['Continue']);

  if (continueClicked) {
    console.log('[AU Bank] Clicked AU IPO redirect continue button');
    await page.waitForTimeout(800);
  }
  return continueClicked;
}

async function openAuIpoArea(page: Page, warnings: string[]): Promise<Page | null> {
  if (await isAuIpoPage(page)) {
    await page.bringToFront().catch(() => {});
    return page;
  }

  const alreadyOpen = await findOpenAuIpoPage(page);
  if (alreadyOpen) {
    await alreadyOpen.bringToFront().catch(() => {});
    return alreadyOpen;
  }

  const investmentClicked =
    await clickFirstVisible(page, [
      'a:has-text("Investments")',
      'button:has-text("Investments")',
      '[role="button"]:has-text("Investments")',
      'a:has-text("Investment")',
      'button:has-text("Investment")'
    ]) || await clickVisibleLabeledTile(page, ['Investments', 'Investment'])
      || await clickFirstText(page, ['Investments', 'Investment']);

  if (!investmentClicked) {
    console.warn('[AU Bank] Investments tile was not found on the dashboard.');
  }

  if (investmentClicked) await page.waitForTimeout(1_200);

  if (await isAuIpoPage(page)) {
    await page.bringToFront().catch(() => {});
    return page;
  }

  const asbaClicked =
    await clickFirstVisible(page, [
      'a:has-text("ASBA")',
      'button:has-text("ASBA")',
      '[role="button"]:has-text("ASBA")',
      'a:has-text("IPO")',
      'button:has-text("IPO")',
      '[role="button"]:has-text("IPO")'
    ]) || await clickVisibleLabeledTile(page, ['IPO (ASBA)', 'ASBA', 'IPO', 'Initial Public Offering'])
      || await clickFirstText(page, ['IPO (ASBA)', 'ASBA', 'IPO', 'Initial Public Offering']);

  if (!asbaClicked) {
    warnings.push('AU IPO / ASBA tile was not found after opening Investments.');
    return null;
  }

  await page.waitForTimeout(1_000);

  const openedPage = await clickForAuIpoPage(page, async () => {
    if (await continueAuIpoRedirect(page)) return true;
    return false;
  });

  if (openedPage) {
    if (await isAuIpoPage(openedPage)) {
      await openedPage.bringToFront().catch(() => {});
      console.log('[AU Bank] Opened AU IPO page via dashboard handoff:', openedPage.url());
      return openedPage;
    }

    if (openedPage.url().includes('/error-view')) {
      warnings.push('AU IPO Smart opened an error page. The dashboard handoff token may not have completed.');
    }
  }

  if (await isAuIpoPage(page)) {
    await page.bringToFront().catch(() => {});
    return page;
  }

  const maybeOpen = await findOpenAuIpoPage(page);
  if (maybeOpen) {
    await maybeOpen.bringToFront().catch(() => {});
    return maybeOpen;
  }

  warnings.push('AU IPO / ASBA section could not be opened automatically from the dashboard. The AU session is open for manual navigation.');
  return null;
}

async function captureAuBidSummary(page: Page, draft: IpoBidDraft) {
  return page.evaluate(({ issueName, dematAccount, blockedAmount }) => {
    const text = (document.body as HTMLElement | null)?.innerText || '';
    const amountMatch = text.match(/(?:₹|INR|Rs\.?)\s*([\d,]+(?:\.\d{1,2})?)/i);
    const dematText = (dematAccount || '').toLowerCase().trim();
    return {
      text,
      amount: amountMatch?.[1] ? `₹${amountMatch[1]}` : null,
      dematSeen: dematText ? text.toLowerCase().includes(dematText) : null,
      blockedAmountSeen: text.includes(blockedAmount.toLocaleString('en-IN')),
      issueSeen: new RegExp(issueName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text),
    };
  }, {
    issueName: draft.issueName,
    dematAccount: draft.dematAccount || '',
    blockedAmount: draft.blockedAmount
  }).catch(() => ({
    text: '',
    amount: null,
    dematSeen: null,
    blockedAmountSeen: false,
    issueSeen: false,
  }));
}

async function moveToAuReview(page: Page): Promise<boolean> {
  await acceptAuTerms(page).catch(() => {});
  await page.waitForTimeout(500);
  const moved = await clickEnabledActionText(page, ['Proceed', 'Review', 'Continue', 'Next'])
    || await clickFirstVisible(page, [
      'button:has-text("Proceed")',
      'button:has-text("Review")',
      'button:has-text("Continue")',
      'button:has-text("Next")'
    ]) || await clickFirstText(page, ['Proceed', 'Review', 'Continue', 'Next']);

  if (moved) {
    await page.waitForTimeout(1_500);
    return true;
  }

  const proceedDisabled = await page.evaluate(() => {
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
    const readText = (el: HTMLElement) => {
      if (el instanceof HTMLInputElement) return normalize(el.value || '');
      return normalize(el.innerText || '');
    };
    const isDisabled = (el: HTMLElement) => {
      const control = el as HTMLButtonElement | HTMLInputElement;
      const ariaDisabled = (el.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
      const className = typeof el.className === 'string' ? el.className.toLowerCase() : '';
      return !!control.disabled || ariaDisabled || className.includes('disabled');
    };
    return Array.from(document.querySelectorAll<HTMLElement>('button, a, input[type="button"], input[type="submit"], [role="button"]'))
      .some(el => readText(el).includes('proceed') && isDisabled(el));
  }).catch(() => false);
  if (proceedDisabled) {
    console.warn('[AU Bank] Proceed button is still disabled after filling the AU form.');
  }
  return moved;
}

async function submitAuPreparedBid(page: Page): Promise<boolean> {
  const clicked = await clickFirstVisible(page, [
    'button:has-text("Submit")',
    'button:has-text("Confirm")',
    'button:has-text("Apply")',
    'button:has-text("Place Bid")',
    'input[type="submit"]'
  ]) || await clickFirstText(page, ['Submit', 'Confirm', 'Apply', 'Place Bid']);

  if (clicked) await page.waitForTimeout(1_500);
  return clicked;
}

export const auBankAdapter: LoginAdapter = {
  code: 'AU',
  displayName: 'AU Small Finance Bank',

  async login(page: Page, creds: LoginCredentials, fetchOtp: () => Promise<string>): Promise<void> {
    if (await isAuLoggedIn(page)) {
      console.log('[AU Bank] Already logged in (session cached).');
      startAuKeepAlive(page);
      return;
    }

    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(2_000);

    try {
      await page.waitForSelector('input[type="text"]', { timeout: 15_000 });
      await page.fill('input[type="text"]', creds.username);
      console.log('[AU Bank] Filled username');
    } catch {
      console.error('[AU Bank] Could not find username field.');
    }

    let passwordFieldRef: Locator | null = null;
    try {
      const passwordField = page.locator('input.mat-input-element[class*="passwordMa"]').first();
      await passwordField.waitFor({ state: 'visible', timeout: 15_000 });
      await passwordField.fill(creds.password);
      passwordFieldRef = passwordField;
      console.log('[AU Bank] Filled password');
    } catch {
      console.error('[AU Bank] Could not find password field.');
    }

    const captchaAutoSubmitted = await trySolveAuCaptcha(page, creds.username, passwordFieldRef);
    if (!captchaAutoSubmitted) {
      console.log('[AU Bank] Type the CAPTCHA and click Login in the browser.');
      // Show overlay + wait so the user gets a visible cue instead of a stuck
      // browser. The OTP-screen wait below will still kick in once the user
      // submits successfully.
      const captchaInput = await findAuCaptchaInput(page, creds.username, passwordFieldRef);
      if (captchaInput) {
        await showAuCaptchaManualOverlay(
          page,
          'Please type the CAPTCHA shown above and click Login. The app will continue automatically once you submit.',
        );
        await waitForManualCaptchaSubmit(page, captchaInput, 120_000);
      }
    }

    const otpBoxes = page.locator('input.mx-rw-input-otp');
    let otpVisible = false;
    try {
      await otpBoxes.first().waitFor({ state: 'visible', timeout: captchaAutoSubmitted ? 25_000 : 120_000 });
      otpVisible = true;
    } catch {
      if (captchaAutoSubmitted) {
        console.log('[AU Bank] OTP boxes not found after Claude CAPTCHA submit. Complete CAPTCHA/login manually if needed.');
        await recordAuCaptchaLearning(page, 'failure', await readLatestAuCaptchaInput(page) || undefined);
      } else {
        console.log('[AU Bank] OTP boxes not found within 2 minutes. Continue manually if needed.');
      }
    }

    if (otpVisible) {
      const finalCaptchaInput = await readLatestAuCaptchaInput(page);
      const learningCtx = getAuCaptchaLearningContext(page);
      const aiGuess = (learningCtx?.primaryGuess || '').toLowerCase();
      const submitted = (finalCaptchaInput || '').toLowerCase();
      const aiActuallyWon = !!aiGuess && !!submitted && aiGuess === submitted;
      if (!aiActuallyWon) {
        appendAutomationLog(
          'AU_CAPTCHA',
          `OTP appeared, but AI guess "${aiGuess}" != submitted value "${submitted}" — login succeeded via manual retry, recording AI attempt as failure to avoid poisoning learning data.`,
        );
      }
      await recordAuCaptchaLearning(page, aiActuallyWon ? 'success' : 'failure', finalCaptchaInput || undefined);
    }

    const boxCount = await otpBoxes.count();
    if (boxCount > 0 && boxCount !== 6) {
      console.log(`[AU Bank] Expected 6 OTP boxes, found ${boxCount}. Continuing with available boxes.`);
    }

    console.log('[AU Bank] Attempting OTP autofill when possible.');
    try {
      if (boxCount > 0) {
        const otp = await fetchOtp();
        console.log('[AU Bank] Got OTP:', otp);
        await otpBoxes.first().click();
        await page.keyboard.type(otp.slice(0, boxCount), { delay: 0 });
        console.log('[AU Bank] Filled OTP digits');
      } else {
        console.log('[AU Bank] OTP UI not auto-detected; complete OTP manually.');
      }

      const verifyBtn = page.locator(
        'button:has-text("Verify"), button:has-text("Submit"), button:has-text("Continue"), input[type="submit"]'
      ).first();
      if (await verifyBtn.isVisible().catch(() => false)) {
        await verifyBtn.click();
        console.log('[AU Bank] Clicked verify.');
      }
    } catch (e) {
      console.error('[AU Bank] OTP fetch or fill failed:', e);
    }

    try {
      await waitForAuPostLogin(page, 180_000);
      console.log('[AU Bank] Post-login dashboard detected.');
    } catch {
      console.log('[AU Bank] Dashboard not detected automatically. If logged in manually, balance fetch may still work.');
    }

    // Start session heartbeat so AU's inactivity timer doesn't kick the user
    // out while they prepare an IPO application.
    startAuKeepAlive(page);

    console.log('[AU Bank] Browser remains open for IPO application.');
  },

  async fetchBalance(page: Page): Promise<string | null> {
    const t0 = Date.now();
    try {
      // ── Step 1: Ensure we are on AU Bank app ─────────────────────────────
      if (!page.url().includes('netbanking.au.bank.in')) {
        await page.goto('https://netbanking.au.bank.in/drb/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
      }

      // Wait until the dashboard's reveal links exist (fast path — no networkidle).
      // If a.view never appears, maybe we're already on an unmasked session; fall through.
      await page.locator('a.view').first()
        .waitFor({ state: 'attached', timeout: 15_000 })
        .catch(() => {});

      // ── Step 2: Check if any balance is already rendered (e.g. from a prior unmask) ─
      const alreadyRevealed = await page.evaluate(() => {
        return Array.from(document.querySelectorAll<HTMLElement>('.accountInfo'))
          .some(el => /\u20B9\s*[\d,]+\.\d{2}/.test(el.innerText || ''));
      }).catch(() => false);

      if (!alreadyRevealed) {
        // ── Step 3+4: Reveal every visible tile, re-scanning the DOM each pass
        //
        // Naive approaches that fail:
        //   - Cache (cx, cy) of every a.view upfront, then click by coords:
        //     first click shifts layout below it, making later cached coords
        //     stale or off-screen.
        //   - Cache DOM indices of every a.view upfront, then click by nth():
        //     AU REMOVES the a.view from a tile once it unmasks, so indices
        //     after the first reveal no longer refer to the same element.
        //
        // Working approach: on each pass, scan for the first visible
        // .accountInfo tile that (a) still has a <a.view> link AND (b) hasn't
        // rendered an ₹-amount yet. Click it. Re-scan. Repeat until none remain
        // or we hit the safety bound.
        const INITIAL_VISIBLE = await page.evaluate(() => {
          return Array.from(document.querySelectorAll<HTMLElement>('.accountInfo'))
            .filter(el => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && el.offsetParent !== null;
            })
            .filter(el => !!el.querySelector('a.view'))
            .length;
        });

        if (INITIAL_VISIBLE === 0) {
          console.warn('[AU Bank] No visible tiles with a.view found');
          return null;
        }

        const MAX_PASSES = INITIAL_VISIBLE + 2; // safety bound
        let clickCount = 0;
        for (let pass = 0; pass < MAX_PASSES; pass++) {
          // Find the next un-revealed visible tile (fresh DOM lookup each pass).
          const targetTileIdx: number = await page.evaluate(() => {
            const tiles = Array.from(document.querySelectorAll<HTMLElement>('.accountInfo'));
            for (let i = 0; i < tiles.length; i++) {
              const el = tiles[i];
              const r = el.getBoundingClientRect();
              const visible = r.width > 0 && r.height > 0 && el.offsetParent !== null;
              if (!visible) continue;
              const hasView = !!el.querySelector('a.view');
              const hasAmount = /\u20B9\s*[\d,]+\.\d{2}/.test(el.innerText || '');
              if (hasView && !hasAmount) return i;
            }
            return -1;
          });
          if (targetTileIdx < 0) break; // nothing left to reveal

          // Click the a.view INSIDE this specific tile. Scoping to the tile
          // means we don't depend on the global a.view index, which changes
          // as tiles unmask.
          const viewLink = page
            .locator('.accountInfo')
            .nth(targetTileIdx)
            .locator('a.view')
            .first();
          try {
            await viewLink.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
            await viewLink.click({ timeout: 3_000 });
            clickCount++;
            // Let AU's reveal XHR complete before we scan for the next tile,
            // otherwise the just-clicked tile will still match hasView && !hasAmount
            // and we'll click it again.
            await page.waitForTimeout(400);
          } catch (e: any) {
            console.warn(`[AU Bank] reveal click on tile[${targetTileIdx}] failed: ${e?.message ?? e}`);
            break;
          }
        }
        console.log(`[AU Bank] clicked ${clickCount}/${INITIAL_VISIBLE} reveal link(s) in ${Date.now() - t0}ms`);

        // ── Step 5: Poll until EVERY clicked tile has rendered its amount ────
        // AU renders unmasked ₹ amounts into .accountInfo after the backend
        // call returns. Each reveal link's tile resolves independently — the
        // Deposit tile may lag the Savings tile by 100-500ms.
        //
        // IMPORTANT: AU uses a slick-carousel that keeps HIDDEN CLONES of each
        // tile in the DOM. We must apply the same visibility filter here as in
        // Step 6, otherwise the poll can satisfy `hits >= N` from clones and
        // exit before the real (visible) tiles have finished rendering.
        const expected = INITIAL_VISIBLE;
        const revealed = await page.waitForFunction((n: number) => {
          const hits = Array.from(document.querySelectorAll<HTMLElement>('.accountInfo'))
            .filter(el => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && el.offsetParent !== null;
            })
            .filter(el => /\u20B9\s*[\d,]+\.\d{2}/.test(el.innerText || ''))
            .length;
          return hits >= n;
        }, expected, { timeout: 20_000, polling: 200 }).then(() => true).catch(() => false);

        if (!revealed) {
          // Diagnostic: dump the innerText of every visible tile so we can see
          // what AU actually rendered. Helps distinguish:
          //   - "tile shows a decimal-less amount"  (e.g. ₹2,00,000)
          //   - "tile shows zero / dash / na"       (inactive FD)
          //   - "tile still masked"                 (click didn't trigger unmask)
          //   - "member only has 1 revealable tile" (genuine)
          const diag = await page.evaluate(() => {
            const all = Array.from(document.querySelectorAll<HTMLElement>('.accountInfo'));
            const visible = all.filter(el => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && el.offsetParent !== null;
            });
            return {
              total: all.length,
              visible: visible.length,
              tiles: visible.map(el => (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200)),
            };
          }).catch(() => null);
          console.warn(`[AU Bank] Not all tiles unmasked within 20s — parsing what's available`, diag);
          // fall through to parse whatever did render
        }
      }

      // ── Step 6: Parse amounts from each visible .accountInfo tile ──────────
      // Label-agnostic: AU uses different markup for Savings vs FD tiles
      // (Savings uses <p>, Deposit/FD often uses <h5> or <span>). Instead of
      // relying on a specific tag, we take the tile's innerText, pull out the
      // amount, and derive the label from whatever leading text precedes the ₹.
      const tiles = await page.evaluate(() => {
        return Array.from(document.querySelectorAll<HTMLElement>('.accountInfo'))
          .filter(n => {
            const r = n.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && n.offsetParent !== null;
          })
          .map(n => {
            const raw = (n.innerText || '').replace(/\s+/g, ' ').trim();
            const amtMatch = raw.match(/([\d,]+\.\d{2})/);
            if (!amtMatch) return { label: '', amount: null, raw };
            const amount = amtMatch[1];

            // Prefer explicit label tags in order of specificity
            const tagLabel =
              (n.querySelector('p')?.textContent ||
                n.querySelector('h5')?.textContent ||
                n.querySelector('h6')?.textContent ||
                n.querySelector('span')?.textContent ||
                '').trim();

            // Fallback: strip ₹/amount/"View" from innerText and take the rest
            let label = tagLabel;
            if (!label) {
              label = raw
                .replace(/\u20B9/g, '')
                .replace(amount, '')
                .replace(/\bView\b/gi, '')
                .replace(/\s+/g, ' ')
                .trim();
            }
            return { label: label || 'Account', amount, raw };
          })
          .filter(t => t.amount);
      });

      // Log anything skipped or unlabelled for debugging
      const skipped = tiles.filter(t => !t.label || t.label === 'Account');
      if (skipped.length > 0) {
        console.log('[AU Bank] tiles w/ weak labels:', JSON.stringify(skipped));
      }

      if (tiles.length === 0) {
        console.warn('[AU Bank] No balances parsed from tiles');
        return null;
      }

      const parts = tiles.map(t => {
        // Normalize common AU labels:
        //   "Deposit Account Balance" → "Deposit"
        //   "Savings Account Balance" → "Savings"
        //   "FD Sweep-in Balance"     → "FD Sweep-in"
        const short = t.label
          .replace(/\s*Account\s*Balance\s*/i, '')
          .replace(/\s*Balance\s*$/i, '')
          .trim() || t.label;
        return `${short}: ${INR}${t.amount}`;
      });
      const out = parts.join(' | ');
      console.log(`[AU Bank] ✓ Balance (${Date.now() - t0}ms):`, out);

      // Keep the AU session alive while the user prepares the IPO application.
      // Safe to call after login() already started it — guard flag prevents
      // duplicate timers.
      startAuKeepAlive(page);

      return out;

    } catch (e: any) {
      console.warn('[AU Bank] Balance fetch error:', e?.message ?? e);
      return null;
    }
  },

  async prepareIpoBid(page: Page, draft: IpoBidDraft): Promise<PreparedIpoBidResult> {
    const warnings: string[] = [];
    startAuKeepAlive(page);

    const ipoPage = await openAuIpoArea(page, warnings);
    if (!ipoPage) {
      return {
        pageUrl: page.url(),
        readyToSubmit: false,
        blockedAmount: draft.blockedAmount,
        warnings,
        detectedIssueName: null,
        detectedDemat: null,
        detectedAmount: null,
      };
    }
    startAuKeepAlive(ipoPage);

    // The AU IPO subdomain (iposmart.au.bank.in) runs its own independent
    // session and may demand a fresh login (username + password + CAPTCHA)
    // even when the main netbanking session is already active.
    // handleAuIpoPortalAuth reuses the proven trySolveAuCaptcha pipeline
    // that works on the main login page — same Angular-Material form.
    await handleAuIpoPortalAuth(ipoPage, draft).catch(() => {});

    const issueRe = issueRegex(draft.issueName);

    let issueSelected = await clickAuIssueApply(ipoPage, draft.issueName);
    if (issueSelected) {
      const formReady = await waitForAuIssueForm(ipoPage);
      if (!formReady) {
        warnings.push('Apply was clicked for the IPO row, but the bid form did not appear quickly.');
      }
    } else {
      // Auto-click missed the row. Try a few alternate strategies — but more
      // importantly, fall back to waiting for the user to click Apply manually
      // via the floating APPLY button (or any Apply button on the page). This
      // turns a hard failure into a graceful "you click, we resume".
      console.log('[AU Bank] Auto Apply click failed. Floating APPLY button is on the page — waiting up to 90s for the user to click Apply manually.');
      await dumpAuListingDiagnostics(ipoPage).catch(() => {});

      const fellBack =
        await selectContaining(ipoPage, draft.issueName)
        || await fillByLabel(ipoPage, [/issue/i, /ipo/i], draft.issueName)
        || await fillVisibleInput(ipoPage, [
          'input[placeholder*="issue" i]',
          'input[placeholder*="ipo" i]',
          'input[name*="issue" i]',
          'input[id*="issue" i]',
          '[role="combobox"] input'
        ], draft.issueName)
        || await clickFirstText(ipoPage, [draft.issueName]);

      if (fellBack) {
        issueSelected = true;
      } else {
        // Wait for the bid form to appear — user clicks Apply on the page.
        const manualOk = await waitForAuBidFormManual(ipoPage, 90_000);
        if (manualOk) {
          console.log('[AU Bank] Bid form detected — user clicked Apply manually. Resuming auto-fill.');
          issueSelected = true;
        } else {
          warnings.push('Could not auto-select the IPO issue, and no bid form appeared within 90 seconds. ' +
            'Click "Apply" next to the right IPO row on the AU page, then run "Open AU & Prepare" again.');
        }
      }
    }
    if (!issueSelected) warnings.push('Could not auto-select the IPO issue name.');
    else await ipoPage.waitForTimeout(600);

    const investorCategorySelected = await selectAuOptionByLabel(
      ipoPage,
      [/investor category/i],
      preferredInvestorCategoryOptions(draft),
    );
    if (!investorCategorySelected) {
      warnings.push('Could not select the investor category.');
    }

    let debitAccountSelected = true;
    if (draft.debitAccountLast4) {
      debitAccountSelected = await selectAuOptionByLabel(
        ipoPage,
        [/debit account number/i],
        [draft.debitAccountLast4],
      );
      if (!debitAccountSelected) {
        warnings.push(`Could not select the debit account ending in ${draft.debitAccountLast4}.`);
      }
    }

    let dematSelected = true;
    if (draft.dematAccount) {
      dematSelected =
        await selectContaining(ipoPage, draft.dematAccount)
        || await fillByLabel(ipoPage, [/demat/i, /depository/i, /dp id/i, /bo id/i, /client id/i], draft.dematAccount)
        || await fillVisibleInput(ipoPage, [
          'input[placeholder*="demat" i]',
          'input[placeholder*="depository" i]',
          'input[placeholder*="client id" i]',
          'input[placeholder*="bo id" i]',
          'input[name*="demat" i]',
          'input[id*="demat" i]'
        ], draft.dematAccount);
      if (!dematSelected) warnings.push('Could not auto-fill the demat / beneficiary account.');
    }

    const quantityFilled =
      await fillByLabel(ipoPage, [/quantity/i, /lot/i, /shares/i], String(draft.quantity))
      || await fillVisibleInput(ipoPage, [
        'input[placeholder*="quantity" i]',
        'input[placeholder*="lot" i]',
        'input[placeholder*="shares" i]',
        'input[name*="quantity" i]',
        'input[id*="quantity" i]',
        'input[name*="lot" i]',
        'input[id*="lot" i]'
      ], String(draft.quantity));
    if (!quantityFilled) warnings.push('Could not auto-fill the bid quantity.');

    let pricingReady = false;
    if (draft.bidType === 'CUTOFF') {
      pricingReady =
        await tickAuCutOff(ipoPage)
        || await clickFirstVisible(ipoPage, [
          'label:has-text("Cut-Off")',
          'label:has-text("Cut off")',
          'label:has-text("Cutoff")',
          'button:has-text("Cut-Off")',
          'button:has-text("Cut off")',
          '[role="radio"]:has-text("Cut-Off")'
        ]) || await clickFirstText(ipoPage, ['Cut-Off', 'Cut off', 'Cutoff']);
      if (!pricingReady) warnings.push('Could not auto-select the cut-off price option.');
    } else {
      pricingReady =
        await fillByLabel(ipoPage, [/price/i, /bid price/i], String(draft.enteredPrice ?? draft.effectivePrice))
        || await fillVisibleInput(ipoPage, [
          'input[placeholder*="price" i]',
          'input[name*="price" i]',
          'input[id*="price" i]'
        ], String(draft.enteredPrice ?? draft.effectivePrice));
      if (!pricingReady) warnings.push('Could not auto-fill the bid price.');
    }

    const bidRowReady = await waitForAuSingleBidReady(ipoPage);
    if (!bidRowReady) {
      warnings.push('The AU bid row did not settle into a valid single-row state.');
    }

    const reviewOpened = await moveToAuReview(ipoPage);
    if (!reviewOpened) warnings.push('Could not automatically move the AU flow to the review step.');

    const summary = await captureAuBidSummary(ipoPage, draft);
    if (!summary.issueSeen && !issueRe.test(summary.text)) {
      warnings.push('The requested IPO name was not clearly visible on the AU page after preparation.');
    }
    if (draft.dematAccount && !summary.dematSeen) {
      warnings.push('The selected demat account was not clearly visible on the AU page after preparation.');
    }

    const readyToSubmit =
      issueSelected
      && investorCategorySelected
      && debitAccountSelected
      && dematSelected
      && quantityFilled
      && pricingReady
      && bidRowReady
      && reviewOpened;
    console.log(`[AU Bank] IPO bid prepared for ${draft.issueName}. Ready to submit: ${readyToSubmit ? 'yes' : 'no'}`);

    return {
      pageUrl: ipoPage.url(),
      readyToSubmit,
      blockedAmount: draft.blockedAmount,
      warnings,
      detectedIssueName: summary.issueSeen || issueRe.test(summary.text) ? draft.issueName : null,
      detectedDemat: summary.dematSeen ? (draft.dematAccount || null) : null,
      detectedAmount: summary.amount,
    };
  },

  async submitPreparedIpoBid(page: Page, draft: IpoBidDraft): Promise<SubmittedIpoBidResult> {
    const warnings: string[] = [];
    const ipoPage = await findOpenAuIpoPage(page);
    if (!ipoPage) {
      throw new Error('AU IPO page is not open anymore. Re-open the prepared AU IPO page and try again.');
    }
    await ipoPage.bringToFront().catch(() => {});
    startAuKeepAlive(ipoPage);

    const summary = await captureAuBidSummary(ipoPage, draft);
    if (!summary.issueSeen) warnings.push('IPO issue name was not clearly visible at submit time.');
    if (draft.dematAccount && !summary.dematSeen) warnings.push('Demat account was not clearly visible at submit time.');

    let clicked = await submitAuPreparedBid(ipoPage);
    if (!clicked) {
      await moveToAuReview(ipoPage).catch(() => {});
      clicked = await submitAuPreparedBid(ipoPage);
    }
    if (!clicked) throw new Error('AU final submit button was not found.');

    const confirmationText = await ipoPage.waitForFunction(() => {
      const text = (document.body as HTMLElement | null)?.innerText || '';
      return /application|reference|request id|submitted|success/i.test(text) ? text : null;
    }, { timeout: 25_000 }).then(h => h.jsonValue() as Promise<string | null>).catch(() => null);

    const confirmation = confirmationText || '';
    const refMatch = confirmation.match(/\b(?:application|reference|request)\s*(?:number|no\.?|id)?\s*[:#-]?\s*([A-Z0-9-]{5,})/i)
      || confirmation.match(/\b([A-Z0-9]{8,})\b/);
    const bankReference = refMatch?.[1] || null;

    if (!confirmationText) {
      warnings.push('AU did not show a clear confirmation message within 25 seconds.');
    }

    return {
      pageUrl: ipoPage.url(),
      bankReference,
      confirmationText: confirmationText ? confirmationText.slice(0, 500) : null,
      warnings,
    };
  }
};
