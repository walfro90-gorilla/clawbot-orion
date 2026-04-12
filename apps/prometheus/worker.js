import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import dotenv from 'dotenv';
import { generateMessage } from './ai.js';
import { supabase, logActivity } from './lib/supabase.js';

dotenv.config();

chromium.use(StealthPlugin());

const LI_AT_COOKIE   = process.env.LI_AT           || 'PASTE_YOUR_LI_AT_COOKIE_HERE';
const TARGET_PROFILE = process.env.TARGET_PROFILE   || 'https://www.linkedin.com/in/williamhgates/';
const DRY_RUN        = process.env.DRY_RUN !== 'false'; // true by default — set DRY_RUN=false to send for real
const LIVE_SEND      = process.env.LIVE_SEND === 'true'; // false by default — set LIVE_SEND=true to actually click Send
const LEAD_ID        = process.env.LEAD_ID          || null;   // set by batch.js

// Parsea "http://user:pass@host:port" → { server, username, password }
// Chromium NO acepta credenciales en --proxy-server; deben ir en context.proxy
function parseProxy(proxyUrl) {
  if (!proxyUrl) return null
  try {
    const u = new URL(proxyUrl)
    return {
      server:   `${u.protocol}//${u.hostname}:${u.port}`,
      username: u.username || undefined,
      password: u.password || undefined,
    }
  } catch {
    return { server: proxyUrl }
  }
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Gradual human-like scroll — forces LinkedIn's lazy XHR sections to load
async function humanScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const step = () => {
        const step_px = Math.floor(Math.random() * 300) + 300;
        window.scrollBy(0, step_px);
        const remaining = document.body.scrollHeight - window.scrollY - window.innerHeight;
        if (remaining > 10) {
          setTimeout(step, Math.floor(Math.random() * 600) + 300);
        } else {
          resolve();
        }
      };
      step();
    });
  });
}


// Type text character-by-character with natural rhythm variance
async function humanType(page, text) {
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: 0 }); // dispatch immediately, delay manually
    let delay = randInt(55, 120);
    if ('.?,!¡¿'.includes(ch)) delay += randInt(100, 250); // pause at punctuation
    else if (ch === ' ' && Math.random() < 0.20) delay += randInt(0, 60); // word-boundary micro-pause
    if (Math.random() < 0.05) delay += randInt(300, 600); // occasional distraction pause (reduced freq)
    await new Promise(r => setTimeout(r, delay)); // use setTimeout, not waitForTimeout (more stable)
  }
}

// ── DOM Interaction ──────────────────────────────────────────────────────────


// Returns 'message' | 'connect' | null depending on which CTA is available.
// Strategy: anchor to the intro card (same DOM subtree as the profile h2),
// then classify visible buttons within it. This is position- and language-agnostic.
async function detectCTA(page, profileName) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(800);

  // ── Step 1: collect all visible buttons in the profile intro area ────────
  // Strategy: scan every button/link on the page, keep only those that are:
  //   - in the top portion of the page (absOffsetTop < 700px — below header)
  //   - not in the right sidebar (viewport x < 70%)
  //   - actually visible (non-zero size, not hidden)
  // This is layout- and language-agnostic: works regardless of where LinkedIn
  // places the buttons or what language is used.
  const introButtons = await page.evaluate(() => {
    const absOffsetTop = (el) => {
      let t = 0, e = el;
      while (e) { t += e.offsetTop || 0; e = e.offsetParent; }
      return t;
    };
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      // Check ancestors too
      let p = el.parentElement;
      for (let i = 0; i < 6 && p && p !== document.body; i++, p = p.parentElement) {
        const ps = window.getComputedStyle(p);
        if (ps.display === 'none' || ps.visibility === 'hidden') return false;
      }
      return true;
    };

    const vw = window.innerWidth || 1280;
    const all = Array.from(document.querySelectorAll('button, a[href]'));
    const candidates = all.filter(el => {
      const aot = absOffsetTop(el);
      if (aot < 100 || aot > 700) return false;           // only profile header zone
      const r = el.getBoundingClientRect();
      if (r.left > vw * 0.70) return false;               // skip right sidebar
      if (!isVisible(el)) return false;
      const text = (el.innerText || el.textContent || '').trim();
      const label = el.getAttribute('aria-label') || '';
      if (!text && !label) return false;                   // no label — skip
      return true;
    });

    return candidates.map(el => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        label: (el.getAttribute('aria-label') || '').trim(),
        text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60),
        x: r.left + r.width / 2,
        y: r.top  + r.height / 2,
      };
    });
  });

  if (!introButtons) {
    console.log('[CLAWBOT] Could not locate intro card buttons — falling back to global search.');
  } else {
    console.log(`[CLAWBOT] Intro card buttons: ${introButtons.map(b => `"${b.text||b.label}"`).join(', ')}`);
  }

  // ── Step 2: classify buttons from intro card ──────────────────────────────
  const makeClickFn = (btn) => async () => {
    const jx = btn.x + (Math.random() - 0.5) * 12;
    const jy = btn.y + (Math.random() - 0.5) * 12;
    await page.mouse.move(jx + randInt(-20, 20), jy + randInt(-10, 10));
    await page.waitForTimeout(randInt(120, 260));
    await page.mouse.move(jx, jy);
    await page.waitForTimeout(randInt(180, 400));
    await page.mouse.click(jx, jy);
  };

  if (introButtons) {
    // Prefer connect over message (connect is free; message may cost InMail credits)
    for (const priority of ['connect', 'message']) {
      const btn = introButtons.find(b => {
        const combined = (b.label + ' ' + b.text).toLowerCase();
        if (priority === 'connect') return /\b(connect|conectar|invite\b)/i.test(combined);
        if (priority === 'message') return /\b(message|mensaje|enviar\s+mensaje|inmail)\b/i.test(combined);
        return false;
      });
      if (btn) {
        console.log(`[CLAWBOT] CTA found in intro card: ${priority} — "${btn.text || btn.label}" @ (${Math.round(btn.x)},${Math.round(btn.y)})`);
        await page.screenshot({ path: 'stage2_cta_found.png', fullPage: false });
        return { type: priority, locator: null, clickFn: makeClickFn(btn) };
      }
    }

    // Check for overflow "···" button — Connect may be inside it
    const overflowBtn = introButtons.find(b => {
      const text = b.text;
      const label = b.label.toLowerCase();
      return /^[.…·]{2,4}$/.test(text) || /más acciones|more actions/i.test(label + ' ' + text);
    });

    if (overflowBtn) {
      console.log('[CLAWBOT] "···" overflow found in intro card — opening...');
      await makeClickFn(overflowBtn)();
      await page.waitForTimeout(randInt(700, 1100));
      await page.screenshot({ path: 'stage2_cta_found.png', fullPage: false });

      // Now find Connect inside the opened dropdown
      const dropdownConnect = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll(
          '[role="menuitem"], [role="option"], [role="menu"] button, [role="menu"] a'
        ));
        const item = items.find(el => {
          const t = (el.innerText || el.textContent || '').trim();
          return /^(connect|conectar)$/i.test(t);
        });
        if (!item) return null;
        item.scrollIntoView({ block: 'nearest' });
        const r = item.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: (item.innerText || '').trim() };
      });

      if (dropdownConnect) {
        console.log(`[CLAWBOT] "Conectar/Connect" found in dropdown — "${dropdownConnect.text}"`);
        const clickFn = async () => {
          // Re-open dropdown then click item (dropdown may close between detect and click)
          await makeClickFn(overflowBtn)();
          await page.waitForTimeout(randInt(700, 1100));
          const pos = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll(
              '[role="menuitem"], [role="option"], [role="menu"] button, [role="menu"] a'
            ));
            const item = items.find(el => /^(connect|conectar)$/i.test((el.innerText || el.textContent || '').trim()));
            if (!item) return null;
            item.scrollIntoView({ block: 'nearest' });
            const r = item.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          });
          if (pos) {
            await page.mouse.move(pos.x, pos.y);
            await page.waitForTimeout(randInt(150, 300));
            await page.mouse.click(pos.x, pos.y);
          }
        };
        return { type: 'connect', locator: null, clickFn };
      }

      // Nothing useful in dropdown — close it
      await page.keyboard.press('Escape');
      await page.waitForTimeout(randInt(300, 500));
    }
  }

  console.log(`[CLAWBOT] No CTA found for "${profileName}" (already connected / Follow-only / Creator)`);
  return { type: null, locator: null };
}

// Opens the compose area and returns the textarea locator
async function openComposeArea(page, cta) {
  // Helper: click via locator or via the evaluated clickFn (for span→a CTAs)
  const doClick = async () => {
    if (cta.clickFn) await cta.clickFn();
    else await cta.locator.click({ force: true });
  };

  if (cta.type === 'message') {
    await doClick();
    await page.waitForTimeout(randInt(1500, 2500));

    // Sales Navigator InMail: clicking "Mensaje" redirects to /sales/lead/...?msgType=inmail
    // This has a Subject field (required) + body textarea — different from regular messaging.
    const currentUrl = page.url();
    if (currentUrl.includes('/sales/') && currentUrl.includes('inmail')) {
      console.log('[CLAWBOT] Sales Navigator InMail page detected.');
      const subjectField = page.locator(
        'input[placeholder*="Asunto" i], input[placeholder*="Subject" i], input[name="subject"]'
      ).first();
      const bodyField = page.locator(
        'textarea[placeholder*="Escribe" i], textarea[placeholder*="Write" i], ' +
        'textarea[placeholder*="mensaje" i], div[contenteditable="true"]'
      ).first();
      await subjectField.waitFor({ state: 'visible', timeout: 10000 });
      await page.screenshot({ path: 'stage3_modal.png', fullPage: false });
      console.log('[CLAWBOT] stage3_modal.png saved (InMail compose open).');
      return { type: 'inmail', subjectLocator: subjectField, bodyLocator: bodyField };
    }

    // LinkedIn may show a Premium upsell modal in shadow DOM (can't target by CSS).
    // Press Escape to dismiss any overlay that appeared, then try to find the textarea.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(randInt(600, 1000));

    // If navigated to /messaging/ page, find textarea there
    if (page.url().includes('/messaging/')) {
      const textarea = page.locator('div[role="textbox"], [contenteditable="true"]').first();
      await textarea.waitFor({ state: 'visible', timeout: 10000 });
      return textarea;
    }

    // Messaging overlay drawer at bottom of profile page
    const textarea = page.locator(
      'div[role="textbox"], ' +
      'div[contenteditable="true"][aria-label], ' +
      '.msg-form__contenteditable, ' +
      '.msg-overlay-conversation-bubble--is-active [contenteditable="true"]'
    ).first();

    const hasTextarea = await textarea.isVisible({ timeout: 5000 }).catch(() => false);
    if (hasTextarea) {
      await page.screenshot({ path: 'stage3_modal.png', fullPage: false });
      console.log('[CLAWBOT] stage3_modal.png saved (message compose open).');
      return textarea;
    }

    // Premium gate closed the path — fall back to Connect flow if button is present
    console.log('[CLAWBOT] Message path blocked by Premium gate. Checking for Connect button...');
    return null;
  }

  if (cta.type === 'connect') {
    await doClick();
    await page.waitForTimeout(randInt(800, 1500));

    // Screenshot immediately after click — shows what LinkedIn displayed (modal vs quick-connect)
    await page.screenshot({ path: 'debug_post_connect_click.png', fullPage: false });

    // LinkedIn has two flows after clicking Connect:
    // A) Modal with "Add a note" button → click it → textarea appears
    // B) "Quick Connect" → request sent immediately, no modal
    // Try flow A first, fall back gracefully to flow B.

    // The modal is in shadow DOM — use getByRole which pierces it.
    // LinkedIn ES UI: "Añadir una nota" / EN UI: "Add a note"
    // Premium/Sales Navigator may show "Personalizar invitación" or similar variants
    const addNoteBtn = page.getByRole('button', {
      name: /add a note|añadir una nota|añadir nota|add a personalised note|personalizar/i,
    }).first();

    const hasModal = await addNoteBtn.isVisible({ timeout: 8000 }).catch(() => false);

    // Captcha/checkpoint detection after clicking CTA
    if (page.url().includes('/checkpoint') || page.url().includes('/challenge')) {
      console.error('[CLAWBOT] ⛔ CAPTCHA/CHECKPOINT detected after CTA click — aborting.');
      await page.screenshot({ path: 'debug_captcha.png', fullPage: false });
      return 'captcha';
    }
    const hasCaptcha = await page.evaluate(() => {
      return !!(
        document.querySelector('iframe[src*="captcha"], iframe[src*="challenge"]') ||
        document.querySelector('[data-testid*="captcha"], [class*="captcha"]')
      );
    });
    if (hasCaptcha) {
      console.error('[CLAWBOT] ⛔ Captcha iframe detected on page — aborting.');
      await page.screenshot({ path: 'debug_captcha.png', fullPage: false });
      return 'captcha';
    }

    if (!hasModal) {
      // Quick Connect fired — invitation may have already been sent without a note.
      // This happens when LinkedIn bypasses the modal (A/B test, Premium flow, repeat invite).
      console.warn('[CLAWBOT] ⚠️  Quick Connect detected — invitation sent WITHOUT note (no modal appeared).');
      console.warn('[CLAWBOT]    Check debug_post_connect_click.png to inspect LinkedIn state.');
      return 'quick-connect';
    }

    console.log('[CLAWBOT] Note modal detected — clicking "Añadir una nota"...');
    await addNoteBtn.click();
    await page.waitForTimeout(randInt(700, 1200));

    // The note textarea is inside LinkedIn's interop shadow DOM.
    // getByRole('textbox') matches the search bar first, and pointer events
    // are intercepted by the shadow host div — we can't click it normally.
    // Solution: traverse the shadow root in evaluate() to focus the textarea,
    // then type with page.keyboard (which doesn't need pointer events).
    const focused = await page.evaluate(() => {
      // LinkedIn wraps the new UI in a shadow root at #interop-outlet
      const host = document.querySelector('#interop-outlet, [data-testid="interop-shadowdom"]');
      const root = host?.shadowRoot;
      if (!root) return false;

      // Find the note textarea — it has a character counter nearby or specific attrs
      const textareas = Array.from(root.querySelectorAll('textarea'));
      const noteArea = textareas.find(t =>
        t.getAttribute('name') === 'message' ||
        t.id === 'custom-message' ||
        t.getAttribute('data-testid')?.includes('note') ||
        // fallback: any textarea that's not tiny (the note field is large)
        t.rows >= 2 || t.offsetHeight > 40
      ) ?? textareas[0];

      if (!noteArea) return false;
      noteArea.focus();
      noteArea.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    });

    if (!focused) {
      console.warn('[CLAWBOT] Could not find note textarea in shadow DOM.');
      return null;
    }

    console.log('[CLAWBOT] Note textarea focused via shadow DOM.');
    await page.screenshot({ path: 'stage3_modal.png', fullPage: false });
    console.log('[CLAWBOT] stage3_modal.png saved (connect note modal open).');
    // Return a sentinel — caller will use page.keyboard.type() directly
    return 'shadow-keyboard';
  }

  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  if (LI_AT_COOKIE === 'PASTE_YOUR_LI_AT_COOKIE_HERE') {
    console.error('[CLAWBOT] ERROR: Set LI_AT in .env before running.');
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log('[CLAWBOT] ⚠️  DRY RUN MODE — stops after CTA detection. Set DRY_RUN=false to continue.\n');
  } else if (!LIVE_SEND) {
    console.log('[CLAWBOT] ⚠️  STAGING MODE — types message & detects Send button, but does NOT send.');
    console.log('[CLAWBOT]    Set LIVE_SEND=true in .env when ready to send for real.\n');
  } else {
    console.log('[CLAWBOT] 🚀 LIVE MODE — DRY_RUN=false + LIVE_SEND=true. Will send for real.\n');
  }

  // ── Rotate User-Agent (realistic pool of Chrome versions on Win/Mac) ─────
  // User agents actualizados — Chrome 133/134/135 (2025). Usar versiones recientes
  // es clave: LinkedIn puede validar la versión contra TLS fingerprints.
  const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  ];
  const userAgent = USER_AGENTS[randInt(0, USER_AGENTS.length - 1)];

  // Slight viewport randomization — humans don't all use the same screen
  const vpWidth  = randInt(1260, 1440);
  const vpHeight = randInt(860, 920);

  const PROXY_URL = process.env.PROXY_URL || null;
  const proxy = parseProxy(PROXY_URL);

  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
  ];

  console.log('[CLAWBOT] Launching stealth browser...');
  if (proxy) console.log(`[CLAWBOT] Using proxy: ${proxy.server} (user=${proxy.username ?? 'none'})`);
  else       console.log('[CLAWBOT] ⚠️  No proxy configured — using direct IP (ban risk on datacenter IPs)');

  const browser = await chromium.launch({ headless: true, args: launchArgs });

  const context = await browser.newContext({
    userAgent,
    viewport: { width: vpWidth, height: vpHeight },
    locale: 'es-MX',
    timezoneId: 'America/Mexico_City',
    // Proxy con credenciales — Playwright lo pasa correctamente a Chromium
    ...(proxy ? { proxy } : {}),
  });

  await context.addCookies([{
    name: 'li_at',
    value: LI_AT_COOKIE,
    domain: '.linkedin.com',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'None',
  }]);

  const page = await context.newPage();

  // ── 1b. Session warmup — visit feed before going to profile ──────────────
  // A real user never opens LinkedIn and goes directly to a profile URL.
  // We simulate: land on feed → read a few seconds → maybe scroll → then navigate.
  console.log('[CLAWBOT] Warming up session on feed...');
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });

  const warmUrl = page.url();
  if (warmUrl.includes('/login') || warmUrl.includes('/authwall') || warmUrl.includes('/checkpoint')) {
    console.error('[CLAWBOT] ABORT: Cookie expired — redirected to auth page.');
    await page.screenshot({ path: 'debug_auth.png' });
    await browser.close();
    process.exit(1);
  }

  // Move mouse randomly on the feed (simulates reading)
  await page.mouse.move(randInt(300, 800), randInt(200, 500));
  await page.waitForTimeout(randInt(2500, 4500));
  // Scroll a bit as if reading posts
  await page.evaluate(() => window.scrollBy(0, Math.floor(Math.random() * 400) + 200));
  await page.waitForTimeout(randInt(1500, 3000));
  await page.evaluate(() => window.scrollBy(0, Math.floor(Math.random() * 300) + 100));
  await page.waitForTimeout(randInt(800, 1800));
  console.log('[CLAWBOT] Feed warmup done — navigating to profile.');

  // ── 2. Navigate to target profile ────────────────────────────────────────
  console.log(`[CLAWBOT] Navigating → ${TARGET_PROFILE}`);
  await page.goto(TARGET_PROFILE, { waitUntil: 'domcontentloaded', timeout: 40000 });

  const landedUrl = page.url();
  console.log(`[CLAWBOT] Landed on: ${landedUrl}`);

  if (landedUrl.includes('/login') || landedUrl.includes('/checkpoint') || landedUrl.includes('/authwall')) {
    console.error('[CLAWBOT] ABORT: Cookie expired or invalid — redirected to auth page.');
    await page.screenshot({ path: 'debug_auth.png' });
    await browser.close();
    process.exit(1);
  }

  const pageTitle = await page.title();
  console.log(`[CLAWBOT] Page title: "${pageTitle}"`);

  // LinkedIn renders the profile name in an h2, not h1.
  try {
    await page.waitForSelector('h2', { state: 'attached', timeout: 20000 });
  } catch {
    await page.screenshot({ path: 'debug_no_h2.png', fullPage: true });
    const bodySnippet = await page.evaluate(() => document.body?.innerText?.slice(0, 600) ?? '');
    console.error('[CLAWBOT] Profile heading not found. Body snippet:\n', bodySnippet);
    await browser.close();
    process.exit(1);
  }

  // Brief pause for CSS animations to settle + natural mouse drift on profile
  await page.waitForTimeout(randInt(1200, 2000));
  // Move mouse as if scanning the page — random drift across profile header area
  await page.mouse.move(randInt(200, 600), randInt(150, 350));
  await page.waitForTimeout(randInt(300, 700));
  await page.mouse.move(randInt(400, 900), randInt(300, 500));
  await page.waitForTimeout(randInt(400, 800));
  await page.screenshot({ path: 'stage1_profile.png', fullPage: false });
  console.log('[CLAWBOT] stage1_profile.png saved (intro card).');

  // ── 3. Scroll + extract intro card (name/headline/location) ─────────────
  await page.waitForTimeout(randInt(1800, 3200)); // simulate reading name/headline before scrolling
  console.log('[CLAWBOT] Scrolling page...');
  await humanScroll(page);
  await page.waitForTimeout(randInt(1000, 1500));

  // ── 4. Extract name/headline/location from intro card (always visible) ────
  const NOISE_RE = /^(·?\s*\d+(st|nd|rd|th|\+)?|\d{1,5}\+?\s*(connection|follower|seguidor|contact|contacto)s?|follow|seguir|message|mensaje|connect|conectar|open to work|disponible|more\.\.\.|ver más|show more|leer más|report this listing)$/i;

  const domExtracted = await page.evaluate((noisePattern) => {
    const NOISE_RE = new RegExp(noisePattern, 'i');
    const it = (el) => (el?.innerText || '').trim();

    const name = (document.title || '').split('|')[0].trim();
    const nameEls = Array.from(document.querySelectorAll('h1, h2')).filter(el => it(el) === name);

    let headline = null, location = null;
    const debug = [];
    const nameParts = new Set(name.split(/\s+/).map(w => w.toLowerCase()));

    const isAlias = (l) => {
      const words = l.trim().split(/\s+/);
      return words.length === 1 && nameParts.has(words[0].toLowerCase());
    };

    for (const nameEl of nameEls) {
      let ancestor = nameEl.parentElement;
      for (let i = 0; i < 12; i++) {
        if (!ancestor || ancestor === document.body) break;
        const lines = it(ancestor).split('\n').map(l => l.trim()).filter(l => l.length > 1);
        debug.push({ level: i, tag: ancestor.tagName, lineCount: lines.length, first5: lines.slice(0, 5) });
        if (lines.length >= 3) {
          const clean = lines.filter(l =>
            l !== name && !NOISE_RE.test(l) && !isAlias(l)
          );
          if (clean.length > 0) {
            headline = clean.find(l => l.length > 10) ?? clean[0] ?? null;
            location = clean.find(l => /,/.test(l) && l.length < 100 && !/http/.test(l))
              ?? clean.find(l =>
                l.length < 80 && l !== headline &&
                !/http/.test(l) && !/^\d/.test(l) && !/[|·]/.test(l) &&
                !/\bfollower|seguidor|contacto|connection\b/i.test(l)
              )
              ?? null;
            break; // only stop when we actually found something useful
          }
          // clean empty (all lines were name/noise/alias) — keep walking up for more context
        }
        ancestor = ancestor.parentElement;
      }
      if (headline) break;
    }
    return { name, headline, location, debug };
  }, NOISE_RE.source);

  if (!domExtracted.headline) {
    console.log('[DEBUG] Ancestor walk trace (headline not found):');
    for (const d of domExtracted.debug) {
      console.log(`  level ${d.level} <${d.tag}> lines=${d.lineCount} first5=${JSON.stringify(d.first5)}`);
    }
  }

  const profileBase = TARGET_PROFILE.replace(/\/$/, '');
  let about = null;
  let currentPosition = null;
  let currentCompany = null;

  // ── 5. About — /details/about/ (SSR, no headless issues) ─────────────────
  // Not all profiles have an About section — if the page 404s we keep null.
  try {
    console.log('[CLAWBOT] Fetching About section...');
    const aboutResp = await page.goto(`${profileBase}/details/about/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    if (aboutResp?.ok()) {
      await page.waitForTimeout(randInt(1200, 1800));
      about = await page.evaluate(() => {
        // innerText preserves newlines — take the longest visible paragraph
        const paras = document.body.innerText
          .split('\n')
          .map(l => l.trim())
          .filter(l => l.length > 40 && !/^(about|acerca|volver|back|inicio|home)/i.test(l));
        // The about text is the longest line that's not a nav label
        paras.sort((a, b) => b.length - a.length);
        return paras[0] ?? null;
      });
      if (about) console.log(`[CLAWBOT] about: "${about.slice(0, 80)}..."`);
    } else {
      console.log('[CLAWBOT] /details/about/ → no About section for this profile.');
    }
  } catch {
    console.log('[CLAWBOT] /details/about/ not available.');
  }

  // ── 6. Experience — /details/experience/ ─────────────────────────────────
  // innerText on this page gives clean lines:
  //   "Gerente de finanzas"          ← line A: position
  //   "FWS Logistics · Jornada..."   ← line B: company · type
  //   "ene. 2023 - actualidad..."    ← date (skip)
  try {
    console.log('[CLAWBOT] Fetching Experience section...');
    await page.goto(`${profileBase}/details/experience/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(randInt(1200, 1800));
    const exp = await page.evaluate(() => {
      const DATE_RE = /\d{4}|ene\b|feb\b|mar\b|abr\b|may\b|jun\b|jul\b|ago\b|sep\b|oct\b|nov\b|dic\b|jan\b|apr\b|aug\b|present|actualidad|jornada|full.time|part.time|presencial|remote|híbrido/i;

      const lines = document.body.innerText
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 1);

      // Anchor on the "Experiencia / Experience" section heading — everything
      // before it is nav chrome. Take the first non-date lines after the heading.
      const expIdx = lines.findIndex(l => /^(experiencia|experience)$/i.test(l));
      if (expIdx === -1) return { currentPosition: null, currentCompany: null };

      const afterExp = lines.slice(expIdx + 1);
      const pos = afterExp.find(l => !DATE_RE.test(l) && l.length > 2) ?? null;
      const posIdx = pos ? afterExp.indexOf(pos) : -1;
      // Company line: short (≤60 chars), not a date, not a skill listing,
      // not a long sentence. Skill lines look like "X, Y y N aptitudes más".
      const SKILL_RE = /aptitudes?\s*(más)?$|skills?\s*(more)?$/i;
      const SENTENCE_RE = /[.!?]$/;
      const coLine = posIdx >= 0
        ? afterExp.slice(posIdx + 1).find(l =>
            !DATE_RE.test(l) && !SKILL_RE.test(l) && !SENTENCE_RE.test(l) &&
            l.length > 1 && l.length <= 60
          )
        : null;
      const co = coLine ? coLine.split('·')[0].trim() : null;
      return { currentPosition: pos, currentCompany: co };
    });
    currentPosition = exp.currentPosition;
    currentCompany = exp.currentCompany;
    if (currentPosition) console.log(`[CLAWBOT] position: "${currentPosition}" @ "${currentCompany}"`);
  } catch {
    console.log('[CLAWBOT] /details/experience/ not available.');
  }

  // Navigate back to profile for CTA detection
  console.log('[CLAWBOT] Returning to profile for CTA detection...');
  await page.goto(TARGET_PROFILE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('h2', { state: 'attached', timeout: 15000 });
  await page.waitForTimeout(randInt(1500, 2000));

  const { name, headline, location } = domExtracted;

  // Pre-extraer empresa del headline para darle a Gemini un campo limpio.
  // Patrones: "Title en/at/@ Company", "Title | Company"
  // Se descarta si el candidato parece un título, ubicación o término genérico.
  function extractCompanyFromHeadline(h) {
    if (!h) return null;
    const LOCATION_RE = /^(méxico|mexico|cdmx|colombia|españa|estados unidos|monterrey|guadalajara|ciudad de méxico|área metropolitana|latin america|latam)/i;
    const JOBTITLE_RE = /^(director|manager|cfo|ceo|coo|cto|vp|chief|head|gerente|dirección|administración|finanzas|finance|managing|capacidad|análisis)/i;
    // Patrón amplio que incluye caracteres especiales internacionales (Ü, ö, etc.)
    const WORD = '[A-Za-z0-9\u00C0-\u024F&.\\s-]';
    const FIRST = '[A-Z\u00C0-\u024F]'; // primera letra mayúscula
    const STOP = `(?:\\s*[|·\\/]|(?:\\s+(?:MBA|MSc|Master|LLC|SA|SRL))|\\s*$)`;
    const candidates = [];
    // "... en/at Company ..." (palabra entera: no en dentro de "operaciones")
    const m1 = h.match(new RegExp(`(?:^|\\s)(?:en|at)\\s+(${FIRST}${WORD}{2,50}?)${STOP}`));
    if (m1) candidates.push(m1[1].trim());
    // "... @ Company ..."
    const m2 = h.match(new RegExp(`@\\s+(${FIRST}${WORD}{2,50}?)${STOP}`));
    if (m2) candidates.push(m2[1].trim());
    // "... | Company ..."  — lo que sigue a un pipe (excluir si parece título/descripción)
    const m3 = h.match(new RegExp(`[|]\\s*(${FIRST}${WORD}{2,50}?)${STOP}`));
    if (m3) candidates.push(m3[1].trim());
    // "Title Company / ..."  — empresa embebida antes de "/" (ej: "Finance Director Adium Mexico / MBA")
    const m4 = h.match(new RegExp(`${FIRST}${WORD}+?\\s+(${FIRST}${WORD}{3,40}?)\\s*\\/`));
    if (m4) candidates.push(m4[1].trim());
    // "... de Company ..." — segundo "de" como separador (ej: "Administración de Idealease de México")
    const allDe = [...h.matchAll(new RegExp(`(?:^|\\s)de\\s+(${FIRST}${WORD}{3,50}?)${STOP}`, 'g'))];
    for (const dm of allDe) candidates.push(dm[1].trim());

    for (const c of candidates) {
      if (c.length >= 3 && !LOCATION_RE.test(c) && !JOBTITLE_RE.test(c)) return c;
    }
    return null;
  }

  const headlineCompany = currentCompany ?? extractCompanyFromHeadline(headline);
  if (headlineCompany && !currentCompany) {
    console.log(`[CLAWBOT] headlineCompany extracted: "${headlineCompany}"`);
  } else if (!headlineCompany) {
    console.log(`[CLAWBOT] headlineCompany: null — headline has no extractable company`);
  }

  const extractedData = {
    profileUrl: TARGET_PROFILE,
    scrapedAt: new Date().toISOString(),
    name, headline, location, about, currentPosition,
    // headlineCompany: empresa extraída del headline (o currentCompany si existe).
    // Gemini debe usarla como "empresa" en el mensaje. Si es null, usar regla 4 (fallback por rol).
    headlineCompany,
  };

  console.log('\n[CLAWBOT] ── Extracted Data ──────────────────────────────────');
  console.log(JSON.stringify(extractedData, null, 2));
  console.log('[CLAWBOT] ──────────────────────────────────────────────────────\n');

  // ── 7. Load active message template for this campaign ────────────────────
  let messageTemplate = null;
  const campaignId = process.env.CAMPAIGN_ID || null;
  let titleBlacklist = [];
  if (campaignId) {
    const { data: tmpl } = await supabase
      .from('message_templates')
      .select('*')
      .eq('campaign_id', campaignId)
      .eq('is_active', true)
      .maybeSingle();
    if (tmpl) {
      messageTemplate = tmpl;
      console.log(`[CEREBRO] Template: "${tmpl.name}" (tone: ${tmpl.tone}, max: ${tmpl.max_chars} chars)`);
    }

    const { data: camp } = await supabase
      .from('campaigns')
      .select('title_blacklist')
      .eq('id', campaignId)
      .maybeSingle();
    titleBlacklist = camp?.title_blacklist || [];
    if (titleBlacklist.length > 0) {
      console.log(`[CEREBRO] Blacklist: ${titleBlacklist.length} puestos ignorados`);
    }
  }

  // ── 7b. Qualify + generate ────────────────────────────────────────────────
  console.log('[CEREBRO] Sending profile to Gemini for qualification...');
  const aiResponse = await generateMessage(extractedData, { template: messageTemplate, blacklist: titleBlacklist });

  console.log('\n[CEREBRO] ── AI Response ─────────────────────────────────────');
  console.log(JSON.stringify(aiResponse, null, 2));
  console.log('[CEREBRO] ──────────────────────────────────────────────────────\n');

  // ── Write AI results to Supabase (when called from batch.js) ─────────────
  if (LEAD_ID) {
    const leadUpdate = {
      ai_qualified:            aiResponse.isQualified,
      ai_subject:              aiResponse.generatedSubject   || null,
      ai_message:              aiResponse.generatedMessage   || null,
      disqualification_reason: aiResponse.disqualificationReason || null,
    };
    const { error: luErr } = await supabase.from('leads').update(leadUpdate).eq('id', LEAD_ID);
    if (luErr) console.warn('[CLAWBOT] Could not update lead AI fields:', luErr.message);
  }

  // ── 8. Disqualification gate ──────────────────────────────────────────────
  if (!aiResponse.isQualified) {
    console.warn(`[CEREBRO] DISQUALIFIED: ${aiResponse.disqualificationReason}`);
    console.log('[CLAWBOT] Skipping DOM interaction. Closing browser.');
    await browser.close();
    return;
  }

  const generatedCopy = aiResponse.generatedMessage;
  console.log(`[CEREBRO] Lead calificado. Mensaje (${generatedCopy.length} caracteres):\n${generatedCopy}\n`);

  // ── 7. Human "thinking" delay before touching the UI ─────────────────────
  const thinkDelay = randInt(2000, 4000);
  console.log(`[CLAWBOT] Simulating read-think pause (${thinkDelay}ms)...`);
  await page.waitForTimeout(thinkDelay);

  // ── 8. Detect and click the correct CTA button ───────────────────────────
  console.log('[CLAWBOT] Detecting CTA button (Message / Connect)...');
  const cta = await detectCTA(page, extractedData.name);

  if (!cta.type) {
    console.warn('[CLAWBOT] WARNING: No Message or Connect button found. Taking screenshot anyway.');
    await page.screenshot({ path: 'draft_proof.png', fullPage: false });
    console.log('[CLAWBOT] Screenshot saved → draft_proof.png');
    await browser.close();
    return;
  }

  // DRY RUN: stop here — take screenshot and exit without clicking anything
  if (DRY_RUN) {
    console.log('[CLAWBOT] DRY RUN — skipping CTA click. Taking stage2_cta_found.png...');
    await page.screenshot({ path: 'stage2_cta_found.png', fullPage: false });
    console.log('[CLAWBOT] Screenshot saved → stage2_cta_found.png');
    console.log(`[CLAWBOT] Would have clicked: "${cta.type}"`);
    if (aiResponse.generatedSubject) console.log(`[CLAWBOT] Subject: "${aiResponse.generatedSubject}"`);
    console.log(`[CLAWBOT] Would have typed:\n\n  ${generatedCopy}\n`);
    await browser.close();
    return;
  }

  console.log(`[CLAWBOT] CTA detected: "${cta.type}" — clicking...`);
  const textarea = await openComposeArea(page, cta);

  if (textarea === 'captcha') {
    // LinkedIn showed a captcha/checkpoint after clicking CTA — account may need manual review
    console.error('[CLAWBOT] CAPTCHA detected — stopping to protect account. Check debug_captcha.png.');
    if (LEAD_ID) {
      await supabase.from('leads').update({ status: 'pending' }).eq('id', LEAD_ID);
    }
    await browser.close();
    process.exit(2); // exit code 2 = captcha (batch.js can detect this)
  }

  if (textarea === 'quick-connect') {
    // Invitation was already sent by LinkedIn's Quick Connect flow (no note modal).
    await page.screenshot({ path: 'stage_quick_connect.png', fullPage: false });
    console.warn('[CLAWBOT] Quick Connect flow — invitation sent without note. stage_quick_connect.png saved.');
    // Update DB directly (batch.js also parses output, but this covers standalone runs)
    if (LEAD_ID) {
      await supabase.from('leads').update({
        status:  'invite_sent',
        sent_at: new Date().toISOString(),
      }).eq('id', LEAD_ID);
      await logActivity(null, LEAD_ID, 'invite_sent', 'success', {
        profile_url: TARGET_PROFILE,
        cta_type:    'quick-connect',
      });
    }
    await browser.close();
    return;
  }

  if (!textarea) {
    console.warn('[CLAWBOT] WARNING: Could not open compose area.');
    await page.screenshot({ path: 'debug_no_compose.png', fullPage: false });
    await browser.close();
    return;
  }

  // ── 9. Type message like a human ─────────────────────────────────────────

  // InMail flow: fill subject first, then body
  if (textarea?.type === 'inmail') {
    const subject = aiResponse.generatedSubject || 'Hola desde LinkedIn';
    console.log(`[CLAWBOT] InMail — typing subject (${subject.length} chars): "${subject}"`);
    await textarea.subjectLocator.click();
    await page.waitForTimeout(randInt(400, 800));
    await humanType(page, subject);
    await page.waitForTimeout(randInt(500, 900));
    await textarea.bodyLocator.click();
    await page.waitForTimeout(randInt(600, 1200));
    console.log('[CLAWBOT] InMail — typing message body...');
    await humanType(page, generatedCopy);
  } else {
    // Regular message or connect note
    // For shadow DOM textareas the focus was set via evaluate(); skip .click()
    if (textarea !== 'shadow-keyboard') {
      await textarea.click();
      await page.waitForTimeout(randInt(300, 600));
    }
    await page.waitForTimeout(randInt(600, 1400)); // re-read before typing
    console.log('[CLAWBOT] Typing message with human-like key delays...');
    await humanType(page, generatedCopy);
  }

  await page.waitForTimeout(randInt(500, 900));

  // ── 9. SAFEGUARD: screenshot the draft — DO NOT SEND ─────────────────────
  await page.screenshot({ path: 'stage4_draft.png', fullPage: false });
  console.log('[CLAWBOT] Draft screenshot saved → stage4_draft.png');

  // Verify Send button is detectable
  const isInmail = textarea?.type === 'inmail';
  const sendDetected = await page.evaluate((inmail) => {
    // InMail page: "Enviar" button is in the regular DOM
    if (inmail) {
      const btn = document.querySelector('button[data-control-name*="send" i], button.inmail-compose__submit-btn');
      // Fallback: any visible "Enviar" button not inside a nav
      const btns = Array.from(document.querySelectorAll('button'));
      const enviar = btns.find(b =>
        /^enviar$/i.test((b.textContent || '').trim()) &&
        b.getBoundingClientRect().height > 0
      );
      const found = btn || enviar;
      if (found) return { found: true, label: found.getAttribute('aria-label') || found.textContent?.trim() };
      return { found: false };
    }
    // Shadow DOM (connect note modal)
    const host = document.querySelector('#interop-outlet, [data-testid="interop-shadowdom"]');
    const root = host?.shadowRoot;
    if (root) {
      const btn = root.querySelector('button[aria-label*="Enviar" i], button[type="submit"]');
      if (btn) return { found: true, label: btn.getAttribute('aria-label') || btn.textContent?.trim() };
    }
    // Regular message compose
    const btn = document.querySelector(
      'button[aria-label*="Enviar" i], button[aria-label*="Send" i], ' +
      '.msg-form__send-button, button[data-control-name="send"]'
    );
    if (btn) return { found: true, label: btn.getAttribute('aria-label') || btn.textContent?.trim() };
    return { found: false };
  }, isInmail);

  if (sendDetected.found) {
    console.log(`[CLAWBOT] ✓ Send button DETECTED — label: "${sendDetected.label}"`);
  } else {
    console.warn('[CLAWBOT] ✗ Send button NOT found — check stage4_draft.png');
  }

  if (!LIVE_SEND) {
    console.log('[CLAWBOT] SAFEGUARD: LIVE_SEND not set — message NOT sent. Inspect stage4_draft.png.');
    await browser.close();
    console.log('[CLAWBOT] Done.');
    return;
  }

  if (!sendDetected.found) {
    console.error('[CLAWBOT] ABORT: LIVE_SEND=true but Send button not found — cannot send safely.');
    await browser.close();
    return;
  }

  // ── 10. LIVE SEND: click the send button ─────────────────────────────────
  console.log(`[CLAWBOT] LIVE_SEND — clicking "${sendDetected.label}"...`);
  await page.waitForTimeout(randInt(600, 1200)); // brief human pause before sending

  const sent = await page.evaluate(() => {
    const host = document.querySelector('#interop-outlet, [data-testid="interop-shadowdom"]');
    const root = host?.shadowRoot;
    if (root) {
      const btn = root.querySelector('button[aria-label*="Enviar" i], button[type="submit"]');
      if (btn) { btn.click(); return true; }
    }
    const btn = document.querySelector(
      'button[aria-label*="Enviar" i], button[aria-label*="Send" i], ' +
      '.msg-form__send-button, button[data-control-name="send"]'
    );
    if (btn) { btn.click(); return true; }
    return false;
  });

  if (!sent) {
    console.error('[CLAWBOT] ABORT: Could not click Send button.');
    await browser.close();
    return;
  }

  // Wait for confirmation: modal closes AND/OR toast appears
  // LinkedIn shows a toast like "Invitación enviada" or "Mensaje enviado"
  let confirmed = false;
  try {
    await page.waitForFunction(() => {
      // Toast notification
      const toast = document.querySelector(
        '[data-test-artdeco-toast-item], .artdeco-toast-item, ' +
        '[class*="toast"], [class*="notification"], [role="alert"]'
      );
      if (toast && toast.innerText?.trim().length > 0) return true;
      // Modal closed (connect note modal disappears after send)
      const modal = document.querySelector('[role="dialog"], .artdeco-modal');
      if (!modal) return true;
      return false;
    }, { timeout: 6000 });
    confirmed = true;
  } catch {
    // Timeout waiting for confirmation — take screenshot anyway
  }

  await page.waitForTimeout(randInt(800, 1200)); // let UI settle
  await page.screenshot({ path: 'stage5_sent.png', fullPage: false });

  if (confirmed) {
    console.log('[CLAWBOT] ✓ SENT — stage5_sent.png saved.');
    if (LEAD_ID) {
      await supabase.from('leads').update({ sent_at: new Date().toISOString() }).eq('id', LEAD_ID);
      await logActivity(null, LEAD_ID, 'invite_sent', 'success', {
        profile_url: TARGET_PROFILE,
        cta_type:    cta.type,
      });
    }
  } else {
    console.warn('[CLAWBOT] ⚠️  Could not confirm send — check stage5_sent.png manually.');
  }
  console.log('[CLAWBOT] Done.');

  await browser.close();
}

run().catch((err) => {
  console.error('[CLAWBOT] Fatal error:', err);
  process.exit(1);
});
