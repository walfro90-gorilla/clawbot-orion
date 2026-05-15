/**
 * cookie-server.js — Remote browser session manager
 *
 * Hardened production-grade implementation:
 *  - One session per accountId (atomic)
 *  - Stable cookie detection (2s window to avoid capturing transient cookies)
 *  - Browser/page crash handlers → auto-cleanup
 *  - Idle timeout (12 min)
 *  - Health endpoint
 *  - Cookie validation in a clean context (separate browser) before final commit
 */
import 'dotenv/config'
import express       from 'express'
import { execSync }  from 'child_process'
import { chromium }  from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { generateFingerprint, contextOptionsFromFingerprint } from './lib/browser.js'

chromium.use(StealthPlugin())

// ── Startup: kill orphaned chromium from previous crashed runs ────────────────
// PM2 SIGKILL can leave chromium subprocesses orphaned. They each hold 100-300MB
// of RAM, eventually OOM-killing new browsers. Sweep them on every startup.
try {
  execSync('pkill -9 -f "chrome-headless-shell" 2>/dev/null', { stdio: 'ignore' })
  console.log('[cookie-server] Cleaned up any orphan chromium processes')
} catch {}

const PORT   = parseInt(process.env.COOKIE_SERVER_PORT ?? '3001')
const SECRET = process.env.COOKIE_SERVER_SECRET ?? ''
if (!SECRET) {
  console.error('[cookie-server] FATAL: COOKIE_SERVER_SECRET not set')
  process.exit(1)
}

const STABLE_WINDOW_MS = 2_000   // require li_at to be present for this long before declaring stable
const IDLE_TIMEOUT_MS  = 12 * 60_000
const SESSION_TTL_MS   = 15 * 60_000  // hard kill after 15 min regardless

const app = express()
app.use(express.json({ limit: '256kb' }))

// sessionId → Session
const sessions = new Map()
// accountId → sessionId  (atomic: one per account)
const accountLocks = new Map()

// ── Auth middleware ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  // health is public-ish (only requires localhost binding)
  if (req.path === '/health') return next()
  if (req.headers['x-secret'] !== SECRET) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  next()
})

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseProxy(proxyUrl) {
  if (!proxyUrl) return undefined
  try {
    const u = new URL(proxyUrl)
    return {
      server:   `${u.protocol}//${u.host}`,
      username: u.username || undefined,
      password: u.password || undefined,
    }
  } catch { return undefined }
}

async function destroySession(sessionId, reason = 'manual') {
  const s = sessions.get(sessionId)
  if (!s) return
  s.intervals.forEach(clearInterval)
  if (accountLocks.get(s.accountId) === sessionId) {
    accountLocks.delete(s.accountId)
  }
  try { await s.browser.close() } catch {}
  sessions.delete(sessionId)
  console.log(`[cookie-server] Session ${sessionId.slice(0,8)}… closed (reason=${reason})`)
}

// Detect what page state we are on (informational for the UI)
function classifyUrl(url) {
  if (!url) return 'unknown'
  if (url.includes('/feed') || url.includes('/mynetwork')) return 'authenticated'
  if (url.includes('/checkpoint/challenge'))               return 'verification'
  if (url.includes('/checkpoint/two-factor'))              return 'two_factor'
  if (url.includes('/checkpoint'))                          return 'checkpoint'
  if (url.includes('/login') || url.includes('/uas/login')) return 'login'
  return 'other'
}

// ── GET /health ───────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok:       true,
    sessions: sessions.size,
    accounts: accountLocks.size,
    uptime:   Math.round(process.uptime()),
  })
})

// ── POST /session ─────────────────────────────────────────────────────────────
app.post('/session', async (req, res) => {
  const { sessionId, proxyUrl, accountId, flow, fingerprint: incomingFp } = req.body
  if (!sessionId || !accountId) {
    return res.status(400).json({ error: 'sessionId and accountId are required' })
  }
  // Use the account's stored fingerprint when available; otherwise mint a fresh
  // one. The fingerprint is reported back via /status so Orion can persist it
  // alongside the cookie — the cookie-fingerprint pair must stay 1:1.
  const fingerprint = (incomingFp && incomingFp.userAgent)
    ? incomingFp
    : generateFingerprint()
  if (sessions.has(sessionId)) {
    return res.status(409).json({ error: 'session already exists' })
  }

  // Atomic: one session per account. Kill the existing one before spawning a new one.
  const existingSid = accountLocks.get(accountId)
  if (existingSid && sessions.has(existingSid)) {
    console.log(`[cookie-server] Replacing stale session for account ${accountId.slice(0,8)}…`)
    await destroySession(existingSid, 'superseded')
  }

  console.log(`[cookie-server] Starting session ${sessionId.slice(0,8)}… proxy=${proxyUrl ? 'yes' : 'none'}`)

  let browser, ctx, page
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    })

    ctx = await browser.newContext(
      contextOptionsFromFingerprint(fingerprint, parseProxy(proxyUrl))
    )

    page = await ctx.newPage()

    // ── Resource blocking: speeds up LinkedIn login page ~3x ─────────────────
    await page.route('**/*', route => {
      const url  = route.request().url()
      const type = route.request().resourceType()

      if (type === 'font')  return route.abort()
      if (type === 'media') return route.abort()

      const ALLOWED = ['linkedin.com', 'licdn.com']
      const host    = (() => { try { return new URL(url).hostname } catch { return '' } })()
      const isLinkedIn = ALLOWED.some(d => host.endsWith(d))
      if (!isLinkedIn) return route.abort()

      route.continue()
    })
  } catch (err) {
    console.error(`[cookie-server] Launch failed:`, err.message)
    try { await browser?.close() } catch {}
    return res.status(500).json({
      error: err.message.includes('proxy') ? 'proxy_error' : 'browser_launch_failed',
      detail: err.message.slice(0, 200),
    })
  }

  // Respond immediately so the modal can start polling — goto runs in the
  // background. The first frame appears once the page partially loads.
  res.json({ ok: true })

  const session = {
    browser, ctx, page,
    accountId,
    fingerprint,                    // ← captured WITH cookie; Orion persists it
    createdAt:    Date.now(),
    status:       'active',         // active | cookie_pending | cookie_stable | error
    cookie:       null,
    pendingSince: null,             // when li_at was first detected
    currentUrl:   page.url(),
    pageState:    classifyUrl(page.url()),
    error:        null,
    screenshot:   null,
    lastPollAt:   Date.now(),
    intervals:    [],
  }

  // Browser/page crash handlers
  browser.on('disconnected', () => {
    if (session.status !== 'cookie_stable') {
      session.status = 'error'
      session.error  = 'browser_disconnected'
    }
    console.warn(`[cookie-server] Browser disconnected for session ${sessionId.slice(0,8)}…`)
    destroySession(sessionId, 'browser_disconnected').catch(() => {})
  })
  page.on('crash',  () => {
    session.status = 'error'
    session.error  = 'page_crashed'
    console.warn(`[cookie-server] Page crashed for session ${sessionId.slice(0,8)}…`)
  })
  page.on('framenavigated', () => {
    try {
      session.currentUrl = page.url()
      session.pageState  = classifyUrl(page.url())
    } catch {}
  })

  // Screenshot loop — 120ms target, with hard timeout so a hung page can't
  // deadlock the loop and leave the user staring at a black frame forever.
  let screenshotBusy = false
  let screenshotStuckSince = null
  const screenshotLoop = setInterval(async () => {
    if (page.isClosed()) return
    if (screenshotBusy) {
      // Detect if the previous screenshot has been hanging too long → recover
      if (screenshotStuckSince && Date.now() - screenshotStuckSince > 8_000) {
        console.warn(`[cookie-server] Screenshot stuck >8s for ${sessionId.slice(0,8)}… — marking error`)
        session.status = 'error'
        session.error  = 'screenshot_hung'
        screenshotBusy = false
        screenshotStuckSince = null
      }
      return
    }
    screenshotBusy = true
    screenshotStuckSince = Date.now()
    try {
      // Race with timeout: page.screenshot can hang silently on heavy pages
      session.screenshot = await Promise.race([
        page.screenshot({ type: 'jpeg', quality: 55 }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('screenshot_timeout')), 5_000)),
      ])
    } catch {}
    screenshotBusy = false
    screenshotStuckSince = null
  }, 120)

  // Cookie detection — STABLE WINDOW: li_at must persist for STABLE_WINDOW_MS
  const cookieLoop = setInterval(async () => {
    try {
      if (session.status === 'cookie_stable' || session.status === 'error') return
      if (page.isClosed()) return

      const cookies = await ctx.cookies('https://www.linkedin.com')
      const liAt    = cookies.find(c => c.name === 'li_at')
      const onAuthd = ['authenticated'].includes(session.pageState)

      if (liAt && onAuthd) {
        if (session.status !== 'cookie_pending') {
          session.status       = 'cookie_pending'
          session.pendingSince = Date.now()
          session.cookie       = liAt.value
          console.log(`[cookie-server] Cookie pending stabilization for ${sessionId.slice(0,8)}…`)
        } else if (Date.now() - session.pendingSince >= STABLE_WINDOW_MS) {
          // Re-check it's still the same cookie and still on authenticated page
          if (liAt.value === session.cookie && onAuthd) {
            session.status = 'cookie_stable'
            console.log(`[cookie-server] Cookie STABLE for ${sessionId.slice(0,8)}… len=${liAt.value.length}`)
            clearInterval(cookieLoop)
            clearInterval(screenshotLoop)
          } else {
            // Cookie changed during window — reset
            session.cookie       = liAt.value
            session.pendingSince = Date.now()
          }
        }
      } else {
        // Lost authentication mid-flow → reset pending state
        if (session.status === 'cookie_pending') {
          session.status       = 'active'
          session.pendingSince = null
          session.cookie       = null
        }
      }
    } catch (err) {
      // Page may have closed — handled by disconnected event
    }
  }, 500)

  // Idle + TTL timeout
  const idleLoop = setInterval(async () => {
    const idleMs = Date.now() - session.lastPollAt
    const ageMs  = Date.now() - session.createdAt
    if (idleMs > IDLE_TIMEOUT_MS) {
      console.log(`[cookie-server] Session ${sessionId.slice(0,8)}… idle ${Math.round(idleMs/60000)}min — closing`)
      await destroySession(sessionId, 'idle_timeout')
    } else if (ageMs > SESSION_TTL_MS) {
      console.log(`[cookie-server] Session ${sessionId.slice(0,8)}… exceeded TTL — closing`)
      await destroySession(sessionId, 'ttl_exceeded')
    }
  }, 30_000)

  session.intervals = [screenshotLoop, cookieLoop, idleLoop]
  sessions.set(sessionId, session)
  accountLocks.set(accountId, sessionId)

  // Kick off navigation in the background — don't block the HTTP response
  ;(async () => {
    try {
      // Warmup hop sets bcookie/JSESSIONID so /login looks natural
      try {
        await page.goto('https://www.linkedin.com/', { waitUntil: 'domcontentloaded', timeout: 25_000 })
        await sleep(rand(700, 1400))
      } catch {}

      await page.goto('https://www.linkedin.com/login', {
        waitUntil: 'domcontentloaded',
        timeout:   45_000,
      })

      // Optional: pre-click "Continue with Google" so the user lands directly on
      // Google's login screen. Saves them ~5s and 1 click in the streaming view.
      if (flow === 'google') {
        await sleep(rand(600, 1200))
        // LinkedIn's Google button selectors — ordered by current likelihood.
        // Class names change occasionally; this list survives a few rotations.
        const candidates = [
          'button[aria-label*="Google" i]',
          'button[name="googleLogin"]',
          'button.sign-in-form__google-button',
          'a[data-tracking-control-name*="google" i]',
          'div[role="button"][aria-label*="Google" i]',
        ]
        let clicked = false
        for (const sel of candidates) {
          const el = await page.$(sel).catch(() => null)
          if (el) {
            await el.click().catch(() => {})
            clicked = true
            break
          }
        }
        if (!clicked) {
          console.warn(`[cookie-server] Google button not found for ${sessionId.slice(0,8)}…`)
        }
      }
    } catch (err) {
      console.error(`[cookie-server] goto failed for ${sessionId.slice(0,8)}…:`, err.message)
      session.status = 'error'
      session.error  = /timeout/i.test(err.message)
        ? 'goto_timeout'
        : /proxy|tunnel|ECONN/i.test(err.message)
          ? 'proxy_error'
          : 'goto_failed'
    }
  })()
})

// ── GET /session/:id/frame ────────────────────────────────────────────────────
app.get('/session/:id/frame', (req, res) => {
  const s = sessions.get(req.params.id)
  if (!s) return res.status(404).json({ error: 'not_found' })
  s.lastPollAt = Date.now()
  if (!s.screenshot) return res.status(204).end()
  res.set('Content-Type',  'image/jpeg')
  res.set('Cache-Control', 'no-store')
  res.send(s.screenshot)
})

// ── GET /session/:id/status ───────────────────────────────────────────────────
app.get('/session/:id/status', (req, res) => {
  const s = sessions.get(req.params.id)
  if (!s) return res.status(404).json({ error: 'not_found' })
  s.lastPollAt = Date.now()
  res.json({
    status:       s.status,
    pageState:    s.pageState,
    currentUrl:   s.currentUrl,
    error:        s.error,
    cookie:       s.status === 'cookie_stable' ? s.cookie : null,
    fingerprint:  s.status === 'cookie_stable' ? s.fingerprint : null,
  })
})

// ── POST /session/:id/input ───────────────────────────────────────────────────
app.post('/session/:id/input', async (req, res) => {
  const s = sessions.get(req.params.id)
  if (!s) return res.status(404).json({ error: 'not_found' })
  if (s.status === 'error' || s.page.isClosed()) {
    return res.status(409).json({ error: 'session_dead' })
  }

  const { type, x, y, text, key } = req.body
  s.lastPollAt = Date.now()
  try {
    if (type === 'click') {
      await s.page.mouse.click(Number(x), Number(y))
    } else if (type === 'type' && text) {
      // delay:0 → no per-character pause. Batched input from client arrives
      // in ~80ms windows; we type the whole batch at native speed.
      await s.page.keyboard.type(String(text), { delay: 0 })
    } else if (type === 'key' && key) {
      await s.page.keyboard.press(String(key))
    }
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message.slice(0, 200) })
  }
})

// ── DELETE /session/:id ───────────────────────────────────────────────────────
app.delete('/session/:id', async (req, res) => {
  await destroySession(req.params.id, 'client_close')
  res.json({ ok: true })
})

// ── POST /validate-cookie — fresh-context test of a cookie+proxy combo ────────
app.post('/validate-cookie', async (req, res) => {
  const { cookie, proxyUrl, fingerprint: incomingFp } = req.body
  if (!cookie || cookie.length < 50) {
    return res.json({ valid: false, reason: 'cookie_too_short' })
  }

  // Validation MUST use the same fingerprint that captured the cookie. Using a
  // different UA/viewport mid-handshake is exactly the bot signal we are
  // trying to avoid (cookie hijack pattern).
  const fingerprint = (incomingFp && incomingFp.userAgent) ? incomingFp : generateFingerprint()

  let browser
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    })
    const ctx = await browser.newContext(
      contextOptionsFromFingerprint(fingerprint, parseProxy(proxyUrl))
    )
    await ctx.addCookies([{
      name:   'li_at',
      value:  cookie,
      domain: '.linkedin.com',
      path:   '/',
      httpOnly: true,
      secure:   true,
      sameSite: 'None',
    }])
    const page = await ctx.newPage()
    await page.goto('https://www.linkedin.com/feed/', {
      waitUntil: 'domcontentloaded',
      timeout:   30_000,
    })
    const finalUrl = page.url()
    const state    = classifyUrl(finalUrl)
    await browser.close()

    if (state === 'authenticated') {
      return res.json({ valid: true, finalUrl, state })
    }
    return res.json({ valid: false, reason: 'not_authenticated', finalUrl, state })
  } catch (err) {
    try { await browser?.close() } catch {}
    const msg = err.message ?? 'unknown'
    if (/ERR_TOO_MANY_REDIRECTS/i.test(msg)) {
      return res.json({ valid: false, reason: 'redirect_loop' })
    }
    return res.json({ valid: false, reason: 'error', detail: msg.slice(0, 200) })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-LOGIN endpoint — programmatic LinkedIn auth (much faster than streaming)
//
// Flow:
//   1. Launch browser with proxy
//   2. Goto /login (kept lightweight — no UI rendering for the user)
//   3. Fill #username + #password
//   4. Click submit
//   5. Wait for navigation, classify outcome:
//      - URL = /feed              → SUCCESS, capture li_at
//      - URL = /checkpoint/...    → 2FA needed (await /submit-2fa)
//      - URL = /uas/login w/error → bad credentials
//      - Captcha element present  → caller should switch to streaming mode
//
// Session reuses the same store as /session, so /status, /frame, /input,
// /submit-2fa all work uniformly.
// ─────────────────────────────────────────────────────────────────────────────
// Humanized helpers — LinkedIn fingerprints typing speed and inter-action timing.
// Bot signal #1 is "form filled in <500ms". Real users take 5-15s on a login form.
const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1))
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function humanizedLogin(page, email, password, statusCb = () => {}) {
  // 1. Warmup hop — visit homepage so the session has bcookie/JSESSIONID context.
  //    Direct hits to /login from a cold proxy are suspicious to LinkedIn's anti-bot.
  statusCb('navigating')
  try {
    await page.goto('https://www.linkedin.com/', { waitUntil: 'domcontentloaded', timeout: 25_000 })
    await sleep(rand(700, 1400))
  } catch {
    // Homepage might fail through some proxies — proceed to /login anyway
  }

  // 2. Navigate to /login
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await sleep(rand(500, 1200))

  statusCb('filling')

  // 3. Form ready
  await page.waitForSelector('#username', { timeout: 15_000 })
  await sleep(rand(300, 700))

  // 4. Focus email like a person clicking on the field
  await page.click('#username')
  await sleep(rand(150, 400))

  // 5. Type email with human-like per-character delay (~6 chars/sec average)
  await page.type('#username', email, { delay: rand(90, 160) })

  // 6. Move to password field — humans pause to find it
  await sleep(rand(400, 900))
  await page.click('#password')
  await sleep(rand(150, 350))

  // 7. Type password
  await page.type('#password', password, { delay: rand(90, 160) })

  // 8. "Review" pause before submit — this is the signal LinkedIn weights heaviest
  await sleep(rand(800, 1500))

  // 9. Submit
  await page.click('button[type="submit"]')
}

function classifyAuthOutcome(page) {
  const url = page.url()
  if (/\/feed|\/mynetwork|\/in\//i.test(url)) return 'success'
  if (/\/checkpoint\/challengesV2|\/checkpoint\/lg\/login-submit/i.test(url)) return 'twofa'
  if (/\/checkpoint\/challenge\/AgE|\/checkpoint\/challenge\?/i.test(url))    return 'twofa'
  if (/\/uas\/login|\/login/i.test(url))                                       return 'bad_credentials'
  if (/\/checkpoint/i.test(url))                                               return 'checkpoint'
  return 'unknown'
}

app.post('/auto-login', async (req, res) => {
  const { sessionId, accountId, proxyUrl, email, password, fingerprint: incomingFp } = req.body
  if (!sessionId || !accountId || !email || !password) {
    return res.status(400).json({ error: 'sessionId, accountId, email, password required' })
  }
  const fingerprint = (incomingFp && incomingFp.userAgent) ? incomingFp : generateFingerprint()
  if (sessions.has(sessionId)) {
    return res.status(409).json({ error: 'session already exists' })
  }

  // Atomic per-account: kill stale session
  const existingSid = accountLocks.get(accountId)
  if (existingSid && sessions.has(existingSid)) {
    await destroySession(existingSid, 'superseded')
  }

  console.log(`[cookie-server] auto-login session ${sessionId.slice(0,8)}…`)

  let browser, ctx, page
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    })
    ctx = await browser.newContext(
      contextOptionsFromFingerprint(fingerprint, parseProxy(proxyUrl))
    )
    page = await ctx.newPage()

    // Same resource blocking as streaming session — speeds up load
    await page.route('**/*', route => {
      const type = route.request().resourceType()
      if (type === 'font' || type === 'media') return route.abort()
      const host = (() => { try { return new URL(route.request().url()).hostname } catch { return '' } })()
      if (!['linkedin.com', 'licdn.com'].some(d => host.endsWith(d))) return route.abort()
      route.continue()
    })
  } catch (err) {
    try { await browser?.close() } catch {}
    return res.status(500).json({ error: 'browser_launch_failed', detail: err.message.slice(0, 200) })
  }

  const session = {
    browser, ctx, page,
    accountId,
    fingerprint,                          // captured WITH cookie
    createdAt:  Date.now(),
    mode:       'auto',                   // distinguishes from streaming sessions
    status:     'authenticating',
    cookie:     null,
    pendingSince: null,
    currentUrl: page.url(),
    pageState:  classifyUrl(page.url()),
    error:      null,
    screenshot: null,
    lastPollAt: Date.now(),
    intervals:  [],
  }

  browser.on('disconnected', () => {
    if (session.status !== 'cookie_stable' && session.status !== 'success') {
      session.status = 'error'
      session.error  = 'browser_disconnected'
    }
    destroySession(sessionId, 'browser_disconnected').catch(() => {})
  })
  page.on('framenavigated', () => {
    try {
      session.currentUrl = page.url()
      session.pageState  = classifyUrl(page.url())
    } catch {}
  })

  // Idle/TTL cleanup (auto-login can also be polled by the client)
  const idleLoop = setInterval(async () => {
    const idleMs = Date.now() - session.lastPollAt
    const ageMs  = Date.now() - session.createdAt
    if (idleMs > IDLE_TIMEOUT_MS || ageMs > SESSION_TTL_MS) {
      await destroySession(sessionId, idleMs > IDLE_TIMEOUT_MS ? 'idle_timeout' : 'ttl_exceeded')
    }
  }, 30_000)
  session.intervals = [idleLoop]
  sessions.set(sessionId, session)
  accountLocks.set(accountId, sessionId)

  // Respond immediately — client will poll status
  res.json({ ok: true })

  // Drive the flow asynchronously
  ;(async () => {
    try {
      // humanizedLogin handles: homepage warmup → /login → paced typing → submit.
      // We update status inline so the UI shows realistic progress while we throttle for anti-ban.
      session.status = 'navigating'
      await humanizedLogin(page, email, password, (newStatus) => { session.status = newStatus })

      session.status = 'authenticating'
      // Wait for navigation away from /login (success, 2FA, or error)
      try {
        await page.waitForURL(url => !url.pathname.includes('/login') || url.pathname.includes('/checkpoint'),
          { timeout: 25_000 })
      } catch {
        // Timed out — check current URL anyway
      }

      const outcome = classifyAuthOutcome(page)
      console.log(`[cookie-server] auto-login outcome=${outcome} url=${page.url()}`)

      if (outcome === 'success') {
        // Capture cookie immediately
        const cookies = await ctx.cookies('https://www.linkedin.com')
        const liAt    = cookies.find(c => c.name === 'li_at')
        if (liAt) {
          session.cookie = liAt.value
          session.status = 'cookie_stable'   // ready for the standard /status validation flow
        } else {
          session.status = 'error'
          session.error  = 'no_cookie_after_success'
        }
      } else if (outcome === 'twofa' || outcome === 'checkpoint') {
        // Two flavors of 2FA:
        //   - PIN-based: input[name="pin"] present → user types 6 digits in modal
        //   - Device approval: notification pushed to LinkedIn mobile app, no input,
        //     page auto-redirects when user taps "Yes" in the app
        const hasPinInput = await page.$('input[name="pin"]').catch(() => null)

        if (hasPinInput) {
          session.status = 'awaiting_2fa'
        } else {
          // Device approval — kick off a poll loop so the user just waits
          session.status = 'awaiting_device_approval'
          const deadline = Date.now() + 5 * 60_000  // 5 min for user to find phone
          const approvalLoop = setInterval(async () => {
            try {
              if (page.isClosed() || Date.now() > deadline) {
                clearInterval(approvalLoop)
                if (session.status === 'awaiting_device_approval') {
                  session.status = 'error'
                  session.error  = 'device_approval_timeout'
                }
                return
              }
              if (session.status !== 'awaiting_device_approval') {
                clearInterval(approvalLoop)
                return
              }
              const cookies = await ctx.cookies('https://www.linkedin.com')
              const liAt    = cookies.find(c => c.name === 'li_at')
              const url     = page.url()
              const onAuthd = /\/feed|\/mynetwork|\/in\//.test(url)
              if (liAt && onAuthd) {
                session.cookie = liAt.value
                session.status = 'cookie_stable'
                clearInterval(approvalLoop)
              }
            } catch {}
          }, 1_500)
          session.intervals.push(approvalLoop)
        }
      } else if (outcome === 'bad_credentials') {
        session.status = 'error'
        session.error  = 'bad_credentials'
      } else {
        // Unknown — try to start a screenshot loop so the user can fall back to streaming
        session.status = 'error'
        session.error  = 'unknown_state'
      }
    } catch (err) {
      console.error(`[cookie-server] auto-login error:`, err.message)
      session.status = 'error'
      session.error  = /timeout/i.test(err.message) ? 'timeout'
                     : /proxy|tunnel|ECONN/i.test(err.message) ? 'proxy_error'
                     : 'auth_failed'
    }
  })()
})

// ─────────────────────────────────────────────────────────────────────────────
// /submit-2fa — completes the 2FA challenge after auto-login.
// Body: { code }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/session/:id/submit-2fa', async (req, res) => {
  const s = sessions.get(req.params.id)
  if (!s) return res.status(404).json({ error: 'not_found' })
  if (s.status !== 'awaiting_2fa') {
    return res.status(409).json({ error: 'not_awaiting_2fa', current: s.status })
  }
  const { code } = req.body
  if (!code || !/^\d{4,8}$/.test(String(code))) {
    return res.status(400).json({ error: 'invalid_code' })
  }

  res.json({ ok: true })
  s.status = 'verifying_2fa'

  ;(async () => {
    try {
      // LinkedIn's 2FA input is consistently input[name="pin"]
      await s.page.waitForSelector('input[name="pin"]', { timeout: 8_000 })
      // Humanized typing: click input → 200-500ms hesitation → type digits with
      // 110-220ms per char (humans look at their phone, then type each digit).
      // Replacing .fill() here was a P0 anti-ban fix — instant input on 2FA is
      // one of LinkedIn's strongest bot signals.
      await s.page.click('input[name="pin"]').catch(() => {})
      await sleep(rand(200, 500))
      const digits = String(code)
      for (const ch of digits) {
        await s.page.keyboard.type(ch, { delay: 0 })
        await sleep(rand(110, 220))
      }
      await sleep(rand(400, 900))         // "review" pause before submit
      // The submit button's selector varies; try the common ones in order
      const clicked = await Promise.race([
        s.page.click('button[type="submit"]').then(() => true).catch(() => false),
        s.page.click('#two-step-submit-button').then(() => true).catch(() => false),
      ])
      if (!clicked) await s.page.keyboard.press('Enter')

      try {
        await s.page.waitForURL(url => /\/feed|\/mynetwork|\/in\//i.test(url.toString()), { timeout: 20_000 })
      } catch {}

      const outcome = classifyAuthOutcome(s.page)
      if (outcome === 'success') {
        const cookies = await s.ctx.cookies('https://www.linkedin.com')
        const liAt    = cookies.find(c => c.name === 'li_at')
        if (liAt) {
          s.cookie = liAt.value
          s.status = 'cookie_stable'
        } else {
          s.status = 'error'; s.error = 'no_cookie_after_2fa'
        }
      } else {
        s.status = 'error'
        s.error  = 'invalid_2fa_code'
      }
    } catch (err) {
      s.status = 'error'
      s.error  = /timeout/i.test(err.message) ? 'timeout' : '2fa_failed'
    }
  })()
})

// ── Graceful shutdown — kill all sessions ─────────────────────────────────────
async function shutdown() {
  console.log(`[cookie-server] Shutting down — closing ${sessions.size} sessions`)
  await Promise.all([...sessions.keys()].map(sid => destroySession(sid, 'shutdown')))
  process.exit(0)
}
process.on('SIGINT',  shutdown)
process.on('SIGTERM', shutdown)

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[cookie-server] Listening on localhost:${PORT}`)
})
