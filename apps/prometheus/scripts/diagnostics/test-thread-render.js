#!/usr/bin/env node
/**
 * Isolates the LinkedIn-SPA-stale-rendering bug. Tests two scenarios:
 *
 *   (A) Direct goto to a thread URL — does LinkedIn render the correct thread?
 *   (B) Cross-thread navigation — load thread X, then thread Y via hard reload.
 *       Does Y's content actually render, or do we see X's?
 *
 * Read-only — never sends a message.
 */
import 'dotenv/config'
import { chromium }     from 'playwright-extra'
import StealthPlugin    from 'puppeteer-extra-plugin-stealth'
import { createClient } from '@supabase/supabase-js'

chromium.use(StealthPlugin())

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const THREAD_HEADER_SELECTORS = [
  '.msg-entity-lockup__entity-title',
  '.msg-thread-top-bar-contact-info .t-bold',
  '.msg-thread-top-bar-contact-info h2',
  '.msg-thread-detail__header .t-bold',
  '.msg-thread-detail__header h2',
  '.msg-thread-participant-list__participant-name',
  '[class*="msg-thread"] h2',
]
const NAV_NOISE = /^(mensajer[ií]a|messaging|messages?|inbox|notificaci|m[áa]s buzones|more inboxes|cero notificaciones|0 notificaciones)/i

function parseProxy(proxyUrl) {
  if (!proxyUrl) return undefined
  const u = new URL(proxyUrl)
  return { server: `${u.protocol}//${u.host}`, username: u.username, password: u.password }
}

async function readHeader(page) {
  for (const sel of THREAD_HEADER_SELECTORS) {
    const el = page.locator(sel).first()
    if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
      const text = (await el.textContent().catch(() => '')).trim()
      if (!text || text.length < 2) continue
      if (NAV_NOISE.test(text.toLowerCase())) continue
      return { text, selector: sel }
    }
  }
  return null
}

async function loadThread(page, threadId, label) {
  const url = `https://www.linkedin.com/messaging/thread/${threadId}/`
  console.log(`\n  → Loading ${label} (${threadId.slice(0, 24)}...)`)
  const t0 = Date.now()
  await page.goto(url, { waitUntil: 'commit', timeout: 45_000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {})
  await page.waitForSelector(
    '.msg-entity-lockup__entity-title, .msg-thread-top-bar-contact-info, .msg-thread-detail__header',
    { timeout: 18_000 }
  ).catch(() => null)
  await sleep(3_000)
  const h = await readHeader(page)
  console.log(`    nav done in ${Date.now() - t0}ms`)
  console.log(`    header: "${h?.text ?? '(none)'}" ${h ? `via ${h.selector}` : ''}`)
  console.log(`    URL final: ${page.url().slice(0, 80)}`)
  return h
}

async function main() {
  // Pick two real threads
  const { data: threads } = await supabase
    .from('conversations')
    .select('linkedin_thread_id, leads(full_name)')
    .not('linkedin_thread_id', 'is', null)
    .limit(2)
  if (!threads || threads.length < 2) { console.error('Need ≥2 threads in DB'); process.exit(1) }
  const [t1, t2] = threads.map(t => ({
    id:   t.linkedin_thread_id,
    name: t.leads.full_name,
  }))

  const { data: account } = await supabase.from('linkedin_accounts').select('*').eq('label', 'Josh').single()

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  })
  const ctx = await browser.newContext({
    viewport:  { width: 1280, height: 800 },
    proxy:     parseProxy(account.proxy_url),
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  })
  await ctx.addCookies([{
    name: 'li_at', value: account.li_at_cookie,
    domain: '.linkedin.com', path: '/', httpOnly: true, secure: true, sameSite: 'None',
  }])
  const page = await ctx.newPage()

  // Warmup
  console.log(`🧪 Test thread render — Josh proxy ${parseProxy(account.proxy_url).server}\n`)
  console.log(`  ▸ Warmup: visiting feed...`)
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'commit', timeout: 90_000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {})
  await sleep(2_500)

  // Scenario A: direct load of thread 1
  console.log(`\n── Scenario A: direct load of thread "${t1.name}" ──`)
  const hA = await loadThread(page, t1.id, t1.name)
  await page.screenshot({ path: '/tmp/test-thread-A.png' })
  const matchA = hA && hA.text.toLowerCase().includes(t1.name.split(' ')[0].toLowerCase())
  console.log(`    ${matchA ? '✓' : '✗'} match: "${hA?.text ?? ''}" vs expected "${t1.name}"`)

  // Scenario B: navigate to thread 2 via hard reload (the production fix path)
  console.log(`\n── Scenario B: navigate to "${t2.name}" with hard reload (the fix) ──`)
  const hB = await loadThread(page, t2.id, t2.name)
  await page.screenshot({ path: '/tmp/test-thread-B.png' })
  const matchB = hB && hB.text.toLowerCase().includes(t2.name.split(' ')[0].toLowerCase())
  console.log(`    ${matchB ? '✓' : '✗'} match: "${hB?.text ?? ''}" vs expected "${t2.name}"`)

  // Scenario C: navigate BACK to thread 1 (true SPA-stale test)
  console.log(`\n── Scenario C: back to "${t1.name}" (cross-thread navigation) ──`)
  const hC = await loadThread(page, t1.id, t1.name)
  await page.screenshot({ path: '/tmp/test-thread-C.png' })
  const matchC = hC && hC.text.toLowerCase().includes(t1.name.split(' ')[0].toLowerCase())
  console.log(`    ${matchC ? '✓' : '✗'} match: "${hC?.text ?? ''}" vs expected "${t1.name}"`)

  await browser.close()

  console.log()
  console.log(`─────────────────────────────────────────────`)
  const total = [matchA, matchB, matchC].filter(Boolean).length
  console.log(`  ${total}/3 scenarios passed`)
  console.log(`  Screenshots: /tmp/test-thread-{A,B,C}.png`)
  if (total === 3) console.log(`  ✅ Hard reload fix renders correct thread reliably`)
  else            console.log(`  ❌ SPA-stale bug confirmed in scenario(s) where match failed`)
  process.exit(total === 3 ? 0 : 1)
}

main().catch(e => { console.error('FATAL:', e); process.exit(2) })
