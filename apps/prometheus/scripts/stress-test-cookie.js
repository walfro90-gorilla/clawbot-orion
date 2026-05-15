#!/usr/bin/env node
/**
 * Stress test for a freshly captured cookie.
 *
 * Verifies the cookie + proxy combo works for ALL the operations the real
 * automation performs — including the ones that previously failed:
 *
 *   T1  /feed                       → basic auth check
 *   T2  Search results              → search.js path
 *   T3  Profile pages (3 different) → followup.js / batch.js path  (THE failure mode)
 *   T4  /messaging                  → inbox.js path
 *   T5  Sustained nav (10 profiles) → real-batch behavior + rate-limit detection
 *   T6  Cookie freshness recheck    → ensure session didn't get invalidated mid-run
 *
 * Read-only — never sends invitations or messages.
 *
 * Usage: node scripts/stress-test-cookie.js [account-label]
 *   account-label defaults to "Josh"
 */
import 'dotenv/config'
import { chromium }     from 'playwright-extra'
import StealthPlugin    from 'puppeteer-extra-plugin-stealth'
import { createClient } from '@supabase/supabase-js'

chromium.use(StealthPlugin())

const ACCOUNT_LABEL = process.argv[2] ?? 'Josh'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1))

// ── Test framework ────────────────────────────────────────────────────────────
const results = []
async function step(name, fn) {
  const t0 = Date.now()
  process.stdout.write(`  ▸ ${name.padEnd(50, ' ')}`)
  try {
    const detail = await fn()
    const ms = Date.now() - t0
    console.log(`✓ ${ms}ms${detail ? '  ' + detail : ''}`)
    results.push({ name, ok: true, ms })
    return true
  } catch (err) {
    const ms = Date.now() - t0
    console.log(`✗ FAIL  ${err.message.slice(0, 100)}`)
    results.push({ name, ok: false, ms, err: err.message })
    return false
  }
}

// ── Sample profile URLs (public, low-engagement, won't trigger anti-bot) ──────
const SAMPLE_PROFILES = [
  'https://www.linkedin.com/in/satyanadella/',
  'https://www.linkedin.com/in/jeffweiner08/',
  'https://www.linkedin.com/in/williamhgates/',
  'https://www.linkedin.com/in/sherylsandberg/',
  'https://www.linkedin.com/in/reidhoffman/',
  'https://www.linkedin.com/in/sundarpichai/',
  'https://www.linkedin.com/in/timcook/',
  'https://www.linkedin.com/in/melindafrenchgates/',
  'https://www.linkedin.com/in/marc-benioff-1b5895/',
  'https://www.linkedin.com/in/elonrmusk/',
]

// ── Browser setup helpers ─────────────────────────────────────────────────────
function parseProxy(proxyUrl) {
  if (!proxyUrl) return undefined
  const u = new URL(proxyUrl)
  return { server: `${u.protocol}//${u.host}`, username: u.username, password: u.password }
}

async function newPage(account) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  })
  const ctx = await browser.newContext({
    viewport:  { width: 1280, height: 800 },
    proxy:     parseProxy(account.proxy_url),
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    locale:    'es-MX',
  })
  await ctx.addCookies([{
    name: 'li_at', value: account.li_at_cookie,
    domain: '.linkedin.com', path: '/',
    httpOnly: true, secure: true, sameSite: 'None',
  }])
  return { browser, ctx, page: await ctx.newPage() }
}

function classify(url) {
  if (/\/feed|\/mynetwork|\/in\/|\/messaging/.test(url)) return 'authenticated'
  if (/\/login|\/authwall|\/uas\/login/.test(url))        return 'login_wall'
  if (/\/checkpoint/.test(url))                            return 'checkpoint'
  return 'other'
}

async function safeGoto(page, url, timeout = 45_000) {
  try {
    // 'commit' = wait only for navigation to start (very fast). We then check the
    // final URL via page.url(). This avoids hangs on LinkedIn's long-polling JS
    // that can keep 'domcontentloaded' pending for >30s on a cold proxy connection.
    await page.goto(url, { waitUntil: 'commit', timeout })
    // Brief wait for the URL to settle (LinkedIn does immediate redirects)
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {})
    return { ok: true, url: page.url(), state: classify(page.url()) }
  } catch (err) {
    const reason = /ERR_TOO_MANY_REDIRECTS/.test(err.message) ? 'redirect_loop'
                 : /timeout/i.test(err.message)               ? 'timeout'
                 : 'goto_error'
    return { ok: false, reason, message: err.message }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🧪 Stress test for "${ACCOUNT_LABEL}" — read-only\n`)

  const { data: account, error } = await supabase
    .from('linkedin_accounts')
    .select('id, label, li_at_cookie, proxy_url, status, li_at_cookie_updated_at')
    .eq('label', ACCOUNT_LABEL)
    .single()

  if (error || !account) {
    console.error(`No account found with label "${ACCOUNT_LABEL}":`, error?.message)
    process.exit(1)
  }

  const cookieAge = account.li_at_cookie_updated_at
    ? ((Date.now() - new Date(account.li_at_cookie_updated_at).getTime()) / 86_400_000).toFixed(1)
    : '?'

  console.log(`Account: ${account.label}`)
  console.log(`Status:  ${account.status}`)
  console.log(`Proxy:   ${account.proxy_url ? new URL(account.proxy_url).host : '(none — direct)'}`)
  console.log(`Cookie:  ${account.li_at_cookie?.length ?? 0} chars, ${cookieAge}d old`)
  console.log()

  if (!account.li_at_cookie) {
    console.error('Account has no cookie. Run "Renovar Cookie" in Orion first.')
    process.exit(1)
  }

  const { browser, ctx, page } = await newPage(account)

  try {
    // ── Warmup — establish proxy connection (cold proxies have 10-30s TLS handshake) ──
    process.stdout.write(`  ▸ Warmup: establishing connection through proxy           `)
    const wt0 = Date.now()
    let warmupOk = false
    try {
      await page.goto('https://www.linkedin.com/feed/', {
        waitUntil: 'commit',
        timeout:   90_000,  // generous — first connection is the slowest
      })
      await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {})
      warmupOk = classify(page.url()) === 'authenticated'
    } catch (e) {
      console.log(`✗ FAIL  ${e.message.slice(0, 80)}`)
      console.log(`\n  Proxy connection failed. Verify ${account.proxy_url ? 'proxy is reachable' : 'cookie is valid'}.`)
      await browser.close()
      process.exit(1)
    }
    if (!warmupOk) {
      console.log(`✗ FAIL  redirected to ${classify(page.url())} (${page.url()})`)
      console.log(`\n  Cookie did not authenticate. Re-renovate via Orion.`)
      await browser.close()
      process.exit(1)
    }
    console.log(`✓ ${Date.now() - wt0}ms  connection warm, authenticated`)
    await sleep(randInt(1500, 3000))

    // T1 — basic auth check (re-feed, should be fast now)
    await step('T1  /feed loads with valid session', async () => {
      const r = await safeGoto(page, 'https://www.linkedin.com/feed/')
      if (!r.ok)                            throw new Error(r.reason)
      if (r.state !== 'authenticated')      throw new Error(`landed on ${r.state}: ${r.url}`)
      return `final=${r.state}`
    })

    await sleep(randInt(2000, 4000))

    // T2 — search results (the path that worked before)
    await step('T2  Search results page renders', async () => {
      const r = await safeGoto(page,
        'https://www.linkedin.com/search/results/people/?keywords=director%20mexico')
      if (!r.ok) throw new Error(r.reason)
      if (r.state === 'login_wall') throw new Error('redirected to login_wall')
      // Search pages must land on /search/. We don't lock on a specific result selector
      // because LinkedIn rotates classnames frequently. Instead, verify URL + content.
      if (!r.url.includes('/search/')) throw new Error(`landed elsewhere: ${r.url}`)
      // Wait for the page to render some content
      await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {})
      const bodyLen = await page.evaluate(() => document.body?.innerText?.length ?? 0).catch(() => 0)
      if (bodyLen < 1_000) throw new Error(`page seems empty (body=${bodyLen} chars)`)
      return `body=${bodyLen}c`
    })

    await sleep(randInt(2000, 4000))

    // T3 — profile pages (THE failure mode that triggered "rate_limited" before)
    let profilesOk = 0
    for (let i = 0; i < 3; i++) {
      const url = SAMPLE_PROFILES[i]
      const handle = url.split('/in/')[1]?.replace('/', '')
      const ok = await step(`T3.${i+1} Profile page: ${handle}`, async () => {
        const r = await safeGoto(page, url)
        if (!r.ok)                       throw new Error(r.reason)
        if (r.state !== 'authenticated') throw new Error(`landed on ${r.state}`)
        return r.state
      })
      if (ok) profilesOk++
      await sleep(randInt(2500, 5000))
    }

    // T4 — messaging (inbox.js path)
    await step('T4  /messaging loads (inbox path)', async () => {
      const r = await safeGoto(page, 'https://www.linkedin.com/messaging/')
      if (!r.ok)                       throw new Error(r.reason)
      if (r.state !== 'authenticated') throw new Error(`landed on ${r.state}`)
      // Wait for messaging UI shell to appear
      await page.waitForSelector('[aria-label*="message" i], .msg-conversations-container, .msg-overlay-list-bubble',
        { timeout: 10_000 }).catch(() => {})
      return r.state
    })

    await sleep(randInt(3000, 6000))

    // T5 — sustained activity (real batch behavior)
    let sustainedOk = 0
    let sustainedFail = 0
    let firstFailUrl = null
    process.stdout.write(`  ▸ T5  Sustained: 10 profile loads with humanized delays    `)
    const t5Start = Date.now()
    for (let i = 0; i < 10; i++) {
      const url = SAMPLE_PROFILES[i]
      const r = await safeGoto(page, url, 20_000)
      if (r.ok && r.state === 'authenticated') {
        sustainedOk++
      } else {
        sustainedFail++
        if (!firstFailUrl) firstFailUrl = `${url} → ${r.reason ?? r.state}`
      }
      await sleep(randInt(1500, 3500))
    }
    const t5Ms = Date.now() - t5Start
    if (sustainedFail === 0) {
      console.log(`✓ ${t5Ms}ms  ${sustainedOk}/10 ok`)
      results.push({ name: 'T5  sustained', ok: true, ms: t5Ms })
    } else {
      console.log(`✗ FAIL  ${sustainedOk}/10 ok, first fail: ${firstFailUrl}`)
      results.push({ name: 'T5  sustained', ok: false, ms: t5Ms, err: firstFailUrl })
    }

    // T6 — cookie freshness recheck (did session survive the run?)
    await step('T6  Cookie still valid at end of run', async () => {
      const r = await safeGoto(page, 'https://www.linkedin.com/feed/')
      if (!r.ok)                       throw new Error(r.reason)
      if (r.state !== 'authenticated') throw new Error('session invalidated mid-run')
      const cookies = await ctx.cookies('https://www.linkedin.com')
      const liAt    = cookies.find(c => c.name === 'li_at')
      if (!liAt) throw new Error('li_at missing from cookie jar')
      const same = liAt.value === account.li_at_cookie
      return same ? 'cookie unchanged' : '⚠️  LinkedIn rotated li_at (still valid)'
    })
  } finally {
    await browser.close()
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  const passed = results.filter(r => r.ok).length
  const failed = results.length - passed
  const totalMs = results.reduce((s, r) => s + r.ms, 0)

  console.log()
  console.log('─────────────────────────────────────────────')
  console.log(`  ${passed}/${results.length} steps passed in ${(totalMs/1000).toFixed(1)}s`)

  if (failed === 0) {
    console.log(`  ✅ Cookie + proxy fully functional for automation`)
    process.exit(0)
  } else {
    console.log(`  ❌ ${failed} step(s) failed:`)
    for (const r of results) if (!r.ok) console.log(`     · ${r.name}: ${r.err}`)
    console.log()
    console.log('  Likely action: re-renovate cookie via Orion → Renovar Cookie')
    process.exit(1)
  }
}

main().catch(err => {
  console.error('FATAL:', err)
  process.exit(2)
})
