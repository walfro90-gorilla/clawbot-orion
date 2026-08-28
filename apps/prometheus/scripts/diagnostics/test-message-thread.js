#!/usr/bin/env node
/**
 * Diagnostic: simulates the followup.js messaging flow up to (but NOT including)
 * the actual message send. Lets us verify the "hard reload thread URL" fix
 * without waiting for the scheduler or sending real messages.
 *
 * Steps reproduced:
 *   1. Load profile
 *   2. Click "Message" button
 *   3. Detect URL → /messaging/thread/<id>/
 *   4. *NEW FIX*: hard reload the thread URL to bypass SPA stale state
 *   5. Wait for thread header to render
 *   6. Read header text via the same selectors followup.js uses
 *   7. Verify header matches lead name
 *   8. Save screenshot for inspection
 *
 * Usage:
 *   node scripts/test-message-thread.js                       # defaults to Josh + Francisco Boils
 *   node scripts/test-message-thread.js Josh "Pablo Medellín" # any lead by full_name
 *   node scripts/test-message-thread.js Josh --connected      # picks first connected lead
 *
 * Read-only — never sends a message.
 */
import 'dotenv/config'
import { chromium }     from 'playwright-extra'
import StealthPlugin    from 'puppeteer-extra-plugin-stealth'
import { createClient } from '@supabase/supabase-js'

chromium.use(StealthPlugin())

const ACCOUNT_LABEL = process.argv[2] ?? 'Josh'
const LEAD_ARG      = process.argv[3] ?? 'Francisco Boils'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Same selectors as followup.js verifier
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

async function readThreadHeader(page) {
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

async function findMessageButton(page) {
  // Mirrors followup.js priority order: scoped to profile action area first to
  // avoid matching the global "Mensajes" link in the nav bar.
  const profileActionArea = page.locator([
    '.pv-top-card',
    '.pvs-profile-actions',
    '[class*="profile-top-card"]',
    '[class*="pv-top-card"]',
    '.ph5.pb5',
  ].join(', ')).first()

  // Strategy A1: scoped text search
  for (const txt of ['Mensaje', 'Message', 'Enviar mensaje', 'Send message']) {
    let loc = profileActionArea.locator(
      `button:has-text("${txt}"), a:has-text("${txt}"), [role="button"]:has-text("${txt}")`
    ).first()
    if (!await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
      loc = page.locator(`button:text-is("${txt}"), [role="button"]:text-is("${txt}")`).first()
    }
    if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
      return { el: loc, selector: `text=${txt}` }
    }
  }

  // Strategy A2: aria-label
  const aria = page.locator([
    'button[aria-label*="Mensaje" i]',
    'button[aria-label*="Message" i]',
    'a[aria-label*="Mensaje" i]',
    'a[aria-label*="Message" i]',
    '[data-control-name="message"]',
  ].join(', ')).first()
  if (await aria.isVisible({ timeout: 2000 }).catch(() => false)) {
    return { el: aria, selector: 'aria-label' }
  }

  // Strategy A3: direct messaging link (last resort — leads to /messaging/ inbox)
  const link = page.locator('a[href*="/messaging/"]').first()
  if (await link.isVisible({ timeout: 1500 }).catch(() => false)) {
    return { el: link, selector: 'a[href*=messaging]' }
  }

  return null
}

async function main() {
  console.log(`\n🧪 Test: messaging thread flow — read-only (no message sent)\n`)

  // Load account
  const { data: account } = await supabase.from('linkedin_accounts')
    .select('*').eq('label', ACCOUNT_LABEL).single()
  if (!account) { console.error(`Account "${ACCOUNT_LABEL}" not found`); process.exit(1) }

  // Load lead
  let lead
  if (LEAD_ARG === '--connected') {
    const { data } = await supabase.from('leads')
      .select('id, full_name, linkedin_url, status, campaign_id')
      .eq('status', 'connected').order('connected_at', { ascending: false }).limit(1).single()
    lead = data
  } else {
    const { data } = await supabase.from('leads')
      .select('id, full_name, linkedin_url, status, campaign_id')
      .ilike('full_name', `%${LEAD_ARG}%`).limit(1).single()
    lead = data
  }
  if (!lead) { console.error(`Lead "${LEAD_ARG}" not found`); process.exit(1) }

  console.log(`Account: ${account.label} (${account.proxy_url ? new URL(account.proxy_url).host : 'no proxy'})`)
  console.log(`Lead:    ${lead.full_name} | status=${lead.status}`)
  console.log(`URL:     ${lead.linkedin_url}`)
  console.log()

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
  const page = await ctx.newPage()

  let pass = 0, fail = 0
  function check(name, ok, detail = '') {
    if (ok) { console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); pass++ }
    else    { console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); fail++ }
  }

  try {
    // Warmup
    process.stdout.write(`  ▸ Warmup: connecting through proxy...                  `)
    const wt = Date.now()
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'commit', timeout: 90_000 })
    await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {})
    if (page.url().includes('/login')) { console.log(`✗ FAIL — landed on login`); process.exit(1) }
    console.log(`✓ ${Date.now() - wt}ms`)
    await sleep(2_000)

    // Step 1: navigate to lead profile
    process.stdout.write(`  ▸ Navigate to profile...                              `)
    const t1 = Date.now()
    await page.goto(lead.linkedin_url, { waitUntil: 'commit', timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {})
    await sleep(2_500)
    check(`profile loaded`, !page.url().includes('/login'), `${Date.now() - t1}ms  url=${page.url().slice(0, 60)}...`)

    // Step 2: click Message button
    const btn = await findMessageButton(page)
    if (!btn) { check('Message button found', false, 'NOT FOUND — lead may not be connected'); throw new Error('no_message_button') }
    check('Message button found', true, `via ${btn.selector}`)

    await btn.el.click()
    await sleep(3_000)
    const afterClickUrl = page.url()
    const isThreadPage = afterClickUrl.includes('/messaging/thread/')
    check('URL is /messaging/thread/<id>/', isThreadPage, afterClickUrl.slice(0, 80))

    // Read header BEFORE the hard reload (to compare)
    const headerBefore = await readThreadHeader(page)
    console.log(`     ─ Header BEFORE hard reload: "${headerBefore?.text ?? '(none)'}" ${headerBefore ? `via ${headerBefore.selector}` : ''}`)

    // Step 3: HARD RELOAD (the new fix)
    if (isThreadPage) {
      process.stdout.write(`  ▸ Hard reload thread URL (the new fix)...             `)
      const t3 = Date.now()
      await page.goto(afterClickUrl, { waitUntil: 'commit', timeout: 30_000 }).catch(() => {})
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {})
      await page.waitForSelector(
        '.msg-entity-lockup__entity-title, .msg-thread-top-bar-contact-info, .msg-thread-detail__header, [class*="msg-thread"] [class*="participant"]',
        { timeout: 12_000 }
      ).catch(() => null)
      await sleep(2_500)
      console.log(`✓ ${Date.now() - t3}ms`)
    }

    // Step 4: read header AFTER hard reload (the critical test)
    const headerAfter = await readThreadHeader(page)
    console.log(`     ─ Header AFTER hard reload:  "${headerAfter?.text ?? '(none)'}" ${headerAfter ? `via ${headerAfter.selector}` : ''}`)

    const expectedFirst = lead.full_name.split(' ')[0].toLowerCase()
    const actualHeader  = (headerAfter?.text ?? '').toLowerCase()
    const matches       = actualHeader.includes(expectedFirst)
    check(`Header matches lead name`, matches,
      `expected="${expectedFirst}" actual="${actualHeader}"`)

    // Save screenshot for inspection
    const screenshotPath = `/tmp/test-message-thread-${lead.id?.slice(0, 8)}.png`
    await page.screenshot({ path: screenshotPath, fullPage: false })
    console.log(`     ─ Screenshot: ${screenshotPath}`)
  } catch (err) {
    console.log(`\n  Fatal: ${err.message}`)
    fail++
  } finally {
    await browser.close()
  }

  console.log()
  console.log('─────────────────────────────────────────────')
  console.log(`  ${pass} pass / ${fail} fail`)
  if (fail === 0) console.log(`  ✅ Hard reload fix works for ${lead.full_name}`)
  else            console.log(`  ❌ Fix needs more work — see screenshot for actual DOM`)
  process.exit(fail ? 1 : 0)
}

main().catch(err => { console.error('FATAL:', err); process.exit(2) })
