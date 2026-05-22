/**
 * lib/browser.js — Shared browser context factory
 *
 * Centralizes User-Agent rotation and browser context options
 * to avoid predictable fingerprinting across all Playwright scripts.
 */

// 20+ real Chrome UAs across Windows/Mac/Linux, Chrome 130-135.
// Pool size matters: small pool = predictable fingerprint.
const USER_AGENTS = [
  // Windows Chrome 135
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0',
  // Windows Chrome 134
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 OPR/120.0.0.0',
  // Windows Chrome 133
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  // Windows Chrome 132
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  // Windows Chrome 131
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  // Windows Chrome 130
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  // macOS Chrome 135
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  // macOS Chrome 134
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  // macOS Chrome 133
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  // macOS Chrome 132
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  // macOS Safari (legítimo en Mac)
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
  // Linux Chrome (común en devs)
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  // Windows 11 explicit
  'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
];

// Viewport sizes reflecting real usage distribution
const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1920, height: 1080 },  // double weight (most common)
  { width: 1440, height: 900  },
  { width: 1440, height: 900  },  // double weight
  { width: 1536, height: 864  },
  { width: 1366, height: 768  },
  { width: 1280, height: 800  },
  { width: 1280, height: 720  },
  { width: 1600, height: 900  },
];

// Slight locale variation — all Spanish but with different regional flavors.
// Keeps Accept-Language header varied while matching LinkedIn's ES user base.
const LOCALES = [
  { locale: 'es-MX', accept: 'es-MX,es;q=0.9,en;q=0.8' },
  { locale: 'es-MX', accept: 'es-MX,es;q=0.9,en-US;q=0.8,en;q=0.7' },
  { locale: 'es-419', accept: 'es-419,es;q=0.9,en;q=0.8' },
  { locale: 'es-MX', accept: 'es;q=0.9,es-MX;q=0.8,en-US;q=0.7' },
];

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generate a fresh random fingerprint (UA + viewport + locale).
 * Used at cookie capture time. After capture, the fingerprint is persisted
 * to `linkedin_accounts.fingerprint_json` and reused for all subsequent
 * sessions — so LinkedIn sees a STABLE fingerprint per cookie.
 *
 * Why stable: if cookie is captured with Mac Chrome 135 and then workers use
 * Windows Chrome 134, LinkedIn sees "same li_at, different browser" = bot.
 */
export function generateFingerprint() {
  const ua  = USER_AGENTS[randInt(0, USER_AGENTS.length - 1)];
  const vp  = VIEWPORTS[randInt(0, VIEWPORTS.length - 1)];
  const loc = LOCALES[randInt(0, LOCALES.length - 1)];
  return {
    userAgent: ua,
    viewport: {
      width:  vp.width  + randInt(-20, 20),
      height: vp.height + randInt(-10, 10),
    },
    locale:         loc.locale,
    acceptLanguage: loc.accept,
    timezoneId:     'America/Mexico_City',
  };
}

/**
 * Build Playwright newContext options from a fingerprint object.
 * Used by workers that load fingerprint_json from DB.
 */
export function contextOptionsFromFingerprint(fp, proxyConfig = null) {
  const opts = {
    userAgent:  fp.userAgent,
    viewport:   fp.viewport,
    locale:     fp.locale,
    timezoneId: fp.timezoneId ?? 'America/Mexico_City',
    extraHTTPHeaders: {
      'Accept-Language': fp.acceptLanguage,
    },
  };
  if (proxyConfig) opts.proxy = proxyConfig;
  return opts;
}

/**
 * Returns randomized browser context options.
 * LEGACY: prefer contextOptionsFromFingerprint(fp) bound to a stable per-account
 * fingerprint. Only use this for one-off scripts (search, scratch) that don't
 * use a logged-in cookie.
 */
export function randomContextOptions(proxyConfig = null) {
  return contextOptionsFromFingerprint(generateFingerprint(), proxyConfig);
}

/**
 * Lookup-or-create the fingerprint for an account. Workers that send messages
 * with a stored cookie MUST use this — never randomContextOptions — so the
 * fingerprint stays stable across the cookie's lifetime.
 *
 * @param {SupabaseClient} supabase
 * @param {string} accountId
 * @returns {Promise<object>} fingerprint_json (lazily seeded if missing)
 */
export async function getOrCreateAccountFingerprint(supabase, accountId) {
  const { data, error } = await supabase
    .from('linkedin_accounts')
    .select('fingerprint_json, fingerprint_locked_at')
    .eq('id', accountId)
    .maybeSingle();
  if (error) throw new Error(`fingerprint lookup failed: ${error.message}`);

  if (data?.fingerprint_json?.userAgent) return data.fingerprint_json;

  const fp = generateFingerprint();
  const { error: upErr } = await supabase
    .from('linkedin_accounts')
    .update({ fingerprint_json: fp, fingerprint_locked_at: new Date().toISOString() })
    .eq('id', accountId);
  if (upErr) console.warn(`[browser] could not persist fingerprint: ${upErr.message}`);
  return fp;
}

/**
 * Convenience: load (or create) fingerprint + build context opts in one call.
 */
export async function accountContextOptions(supabase, accountId, proxyConfig = null) {
  const fp = await getOrCreateAccountFingerprint(supabase, accountId);
  return contextOptionsFromFingerprint(fp, proxyConfig);
}

// ─────────────────────────────────────────────────────────────────────────────
// FASE 1.2 — Persistent browser context por cuenta
//
// Problema antes: cada run `chromium.launch().newContext()` creaba un Chrome
// "fresco sin historia". LinkedIn ve esto como bot signal — usuarios reales
// tienen cookies, localStorage, IndexedDB, cache, history acumulados a lo largo
// del tiempo.
//
// Solución: `chromium.launchPersistentContext(profileDir)` por cuenta:
//   - Cookies persisten entre runs
//   - LocalStorage persiste (LinkedIn guarda settings/UI state ahí)
//   - IndexedDB persiste (notificaciones leídas, conversation cache)
//   - Cache de imágenes/scripts persiste (faster loads, real-browser pattern)
//   - History persiste (LinkedIn ve "este Chrome ya visitó perfiles antes")
//
// Profile path: /var/lib/orion/profiles/<account_id>/
//
// Importante: este context ES el browser+context combinado. No se llama
// .newContext() después — el handle retornado es ya el context.
// ─────────────────────────────────────────────────────────────────────────────

import path from 'path'
import fs from 'fs'

const PROFILES_BASE = process.env.ORION_PROFILES_DIR || '/var/lib/orion/profiles'

export function profilePathForAccount(accountId) {
  if (!accountId) throw new Error('profilePathForAccount: accountId requerido')
  return path.join(PROFILES_BASE, accountId)
}

/**
 * Lanza un Chromium con context persistente por cuenta. Reemplaza el patrón
 * `chromium.launch().newContext()` + addCookies() en workers.
 *
 * El primer run para una cuenta crea el profile y la cookie li_at se añade
 * vía cookies. Runs subsiguientes ya tienen la cookie en el profile.
 *
 * @param {object} chromium       — playwright-extra chromium con stealth
 * @param {string} accountId
 * @param {object} contextOptions — viewport, UA, locale, proxy, etc.
 * @param {object} opts
 * @param {string[]} opts.args    — Chromium launch args
 * @param {string|null} opts.liAtCookie — si se pasa, se inyecta como cookie li_at
 *                                        (la primera vez o si la actual está vencida)
 * @returns {Promise<BrowserContext>}
 */
export async function launchPersistentBrowserContext(chromium, accountId, contextOptions = {}, opts = {}) {
  const profileDir = profilePathForAccount(accountId)
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true })
    console.log(`[browser] Profile creado: ${profileDir}`)
  }

  const args = opts.args ?? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']

  const context = await chromium.launchPersistentContext(profileDir, {
    ...contextOptions,
    headless: process.env.HEADLESS === 'true',
    args,
  })

  // Inyectar cookie li_at — si ya existe en el profile, se actualiza con la
  // versión más reciente (renovaciones via paste/extension). LinkedIn no se
  // queja de reemplazar la misma cookie con el mismo valor.
  if (opts.liAtCookie) {
    await context.addCookies([{
      name:     'li_at',
      value:    opts.liAtCookie,
      domain:   '.linkedin.com',
      path:     '/',
      httpOnly: true,
      secure:   true,
      sameSite: 'None',
    }])
  }

  return context
}

// ─────────────────────────────────────────────────────────────────────────────
// FASE 1.1 — Anti-detect launch options (Chrome headed + Xvfb)
//
// LinkedIn detecta `headless: true` vía múltiples vectores:
//   - navigator.webdriver
//   - chrome.app undefined
//   - permissions.query devuelve 'prompt' (vs 'denied' en real)
//   - missing real fonts/plugins
//   - "HeadlessChrome" en User-Agent (Stealth lo oculta pero hay más)
//
// Solución: correr Chrome HEADED dentro de Xvfb (display virtual :99).
// Esto bypassa todos los signals headless porque Chrome NO sabe que es headless —
// está renderizando a un display X11 normal, simplemente sin monitor físico.
//
// Override por env: HEADLESS=true → headless verdadero (útil para debug local).
// Default: headless: false (anti-detect mode).
//
// Requiere: Xvfb daemon corriendo en :99 (gestionado por PM2 process 'xvfb')
// y DISPLAY=:99 en el env del proceso que lanza Chromium.
// ─────────────────────────────────────────────────────────────────────────────
export function launchOptions(extraArgs = []) {
  const isHeadless = process.env.HEADLESS === 'true';
  return {
    headless: isHeadless,
    args: extraArgs,
  };
}
