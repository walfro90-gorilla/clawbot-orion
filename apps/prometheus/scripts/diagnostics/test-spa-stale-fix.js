#!/usr/bin/env node
/**
 * Tests whether the about:blank → clearStorage → goto → reload sequence
 * actually breaks LinkedIn's SPA stale rendering, by reproducing the
 * production failure: load thread A, then thread B; verify B renders.
 *
 * This time we mimic followup.js's prior-lead state: we walk through 3 threads
 * in sequence, each opening with the FULL reset sequence between them.
 */
import 'dotenv/config'
import { chromium }     from 'playwright-extra'
import StealthPlugin    from 'puppeteer-extra-plugin-stealth'
import { createClient } from '@supabase/supabase-js'

chromium.use(StealthPlugin())

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const HEADER_SELECTORS = [
  '.msg-entity-lockup__entity-title',
  '.msg-thread-top-bar-contact-info .t-bold',
  '.msg-thread-top-bar-contact-info h2',
  '.msg-thread-detail__header .t-bold',
  '.msg-thread-detail__header h2',
]
const NAV_NOISE = /^(mensajer[ií]a|messaging|messages?|inbox|notificaci|m[áa]s buzones|more inboxes|0 notificaciones)/i

function parseProxy(p) {
  if (!p) return undefined
  const u = new URL(p)
  return { server: `${u.protocol}//${u.host}`, username: u.username, password: u.password }
}

async function readHeader(page) {
  for (const sel of HEADER_SELECTORS) {
    const el = page.locator(sel).first()
    if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
      const text = (await el.textContent().catch(() => '')).trim()
      if (!text || text.length < 2) continue
      if (NAV_NOISE.test(text.toLowerCase())) continue
      return text
    }
  }
  return null
}

async function loadThreadHard(page, threadId, label) {
  const url = `https://www.linkedin.com/messaging/thread/${threadId}/`
  console.log(`\n  ── Loading "${label}" with FULL reset sequence ──`)
  const t0 = Date.now()

  // Step 1: about:blank
  await page.goto('about:blank').catch(() => {})
  await sleep(400)

  // Step 2: clear messaging storage
  await page.evaluate(() => {
    try {
      Object.keys(localStorage).forEach(k => {
        if (/voyager|messag|conv|thread/i.test(k)) localStorage.removeItem(k)
      })
      Object.keys(sessionStorage).forEach(k => {
        if (/voyager|messag|conv|thread/i.test(k)) sessionStorage.removeItem(k)
      })
    } catch {}
  }).catch(() => {})

  // Step 3: hard goto
  await page.goto(url, { waitUntil: 'commit', timeout: 60_000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {})

  // Step 4: reload
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})

  await page.waitForSelector(
    '.msg-entity-lockup__entity-title, .msg-thread-top-bar-contact-info, .msg-thread-detail__header',
    { timeout: 18_000 }
  ).catch(() => null)
  await sleep(2_500)

  const header = await readHeader(page)
  console.log(`    header: "${header ?? '(none)'}"`)
  console.log(`    URL final: ${page.url().slice(0, 80)}`)
  console.log(`    elapsed: ${Date.now() - t0}ms`)
  return header
}

async function main() {
  const { data: account } = await supabase.from('linkedin_accounts').select('*').eq('label', 'Josh').single()
  const { data: convs }   = await supabase.from('conversations')
    .select('linkedin_thread_id, leads(full_name)')
    .not('linkedin_thread_id', 'is', null).limit(3)

  if (!convs || convs.length < 3) { console.error('Need ≥3 threads'); process.exit(1) }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    proxy:    parseProxy(account.proxy_url),
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  })
  await ctx.addCookies([{
    name: 'li_at', value: account.li_at_cookie,
    domain: '.linkedin.com', path: '/', httpOnly: true, secure: true, sameSite: 'None',
  }])
  const page = await ctx.newPage()

  console.log(`🧪 SPA stale-rendering reset test`)
  console.log(`  ▸ Warmup`)
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'commit', timeout: 90_000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {})
  await sleep(2_500)

  let pass = 0, fail = 0
  for (const c of convs) {
    const expectedFirst = c.leads.full_name.split(' ')[0].toLowerCase()
    const header = await loadThreadHard(page, c.linkedin_thread_id, c.leads.full_name)
    const ok = header && header.toLowerCase().includes(expectedFirst)
    if (ok) { console.log(`    ✓ MATCH`); pass++ }
    else    { console.log(`    ✗ FAIL — expected "${expectedFirst}", got "${(header ?? '').toLowerCase()}"`); fail++ }
  }

  await browser.close()
  console.log()
  console.log(`─────────────────────────────────────────────`)
  console.log(`  ${pass}/${convs.length} threads rendered correctly`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error('FATAL:', e); process.exit(2) })
