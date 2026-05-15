#!/usr/bin/env node
/**
 * Tests the fast-path reset sequence AFTER pre-contaminating the browser with
 * a different thread (mimics production where previous leads dirty the SPA state).
 *
 * Without the fix: thread B's content shows thread A's name → fail
 * With the fix:   thread B's content correctly shows thread B's name → pass
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

// Lightweight 2-step reset (matches new followup.js fast path)
async function fastPathLoad(page, threadId) {
  const url = `https://www.linkedin.com/messaging/thread/${threadId}/`
  // STEP 1: clear LinkedIn storage (we're already on a linkedin.com page)
  if (page.url().includes('linkedin.com')) {
    const cleared = await page.evaluate(() => {
      let lsCleared = 0, ssCleared = 0
      Object.keys(localStorage).forEach(k => {
        if (/voyager|messag|conv|thread|inbox/i.test(k)) { localStorage.removeItem(k); lsCleared++ }
      })
      Object.keys(sessionStorage).forEach(k => {
        if (/voyager|messag|conv|thread|inbox/i.test(k)) { sessionStorage.removeItem(k); ssCleared++ }
      })
      return { lsCleared, ssCleared }
    }).catch(e => ({ error: e.message }))
    console.log(`    cleared storage: ${JSON.stringify(cleared)}`)
  }
  // STEP 2: goto the thread URL (with storage cleared, SPA can't restore old thread)
  await page.goto(url, { waitUntil: 'commit', timeout: 60_000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {})
  await page.waitForSelector(
    '.msg-entity-lockup__entity-title, .msg-thread-top-bar-contact-info, .msg-thread-detail__header',
    { timeout: 18_000 }
  ).catch(() => null)
  await sleep(2_500)
}

async function main() {
  const { data: account } = await supabase.from('linkedin_accounts').select('*').eq('label', 'Josh').single()
  const { data: convs } = await supabase
    .from('conversations').select('linkedin_thread_id, leads(full_name)')
    .not('linkedin_thread_id', 'is', null).limit(3)
  if (!convs || convs.length < 3) { console.error('Need 3 threads'); process.exit(1) }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    proxy:    parseProxy(account.proxy_url),
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  })
  await ctx.addCookies([{ name: 'li_at', value: account.li_at_cookie, domain: '.linkedin.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' }])
  const page = await ctx.newPage()

  console.log(`🧪 Fast-path test with pre-contamination\n`)
  console.log(`  ▸ Warmup`)
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'commit', timeout: 90_000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {})
  await sleep(2_500)

  // CONTAMINATION: open thread 0 first to dirty the SPA state
  console.log(`\n  ── CONTAMINATING with thread "${convs[0].leads.full_name}" ──`)
  await page.goto(`https://www.linkedin.com/messaging/thread/${convs[0].linkedin_thread_id}/`, { waitUntil: 'commit', timeout: 30_000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {})
  await sleep(3_000)
  console.log(`    contamination header: "${await readHeader(page) ?? '(none)'}"`)

  // Now use fast path to load thread 1, 2 — should NOT show thread 0
  let pass = 0, fail = 0
  for (let i = 1; i < 3; i++) {
    const c = convs[i]
    const expected = c.leads.full_name.split(' ')[0].toLowerCase()
    console.log(`\n  ── FAST PATH load thread "${c.leads.full_name}" ──`)
    await fastPathLoad(page, c.linkedin_thread_id)
    const header = await readHeader(page)
    console.log(`    final header: "${header ?? '(none)'}"`)
    const ok = header && header.toLowerCase().includes(expected)
    if (ok) { console.log(`    ✓ MATCH (no contamination)`); pass++ }
    else    { console.log(`    ✗ FAIL — got "${(header ?? '').toLowerCase()}" expected "${expected}"`); fail++ }
  }

  await browser.close()
  console.log()
  console.log(`─────────────────────────────────────────────`)
  console.log(`  ${pass}/${2} fast-path loads correct (with contamination)`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error('FATAL:', e); process.exit(2) })
