#!/usr/bin/env node
/**
 * Dumps the actual DOM structure of /messaging/ conversation list so we can
 * find the right selectors for thread URLs + participant names.
 */
import 'dotenv/config'
import { chromium }     from 'playwright-extra'
import StealthPlugin    from 'puppeteer-extra-plugin-stealth'
import { createClient } from '@supabase/supabase-js'

chromium.use(StealthPlugin())

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))

function parseProxy(p) {
  if (!p) return undefined
  const u = new URL(p)
  return { server: `${u.protocol}//${u.host}`, username: u.username, password: u.password }
}

async function main() {
  const { data: account } = await supabase.from('linkedin_accounts').select('*').eq('label', 'Josh').single()
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    proxy:    parseProxy(account.proxy_url),
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  })
  await ctx.addCookies([{ name: 'li_at', value: account.li_at_cookie, domain: '.linkedin.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' }])
  const page = await ctx.newPage()

  console.log(`▸ Warmup`)
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'commit', timeout: 90_000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {})
  await sleep(2_500)

  console.log(`▸ Loading /messaging/`)
  await page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'commit', timeout: 60_000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {})
  await sleep(5_000)

  // Take screenshot for visual reference
  await page.screenshot({ path: '/tmp/inspect-messaging.png', fullPage: false })
  console.log(`▸ Screenshot: /tmp/inspect-messaging.png`)

  // Strategy 1: search for ALL anchors with /messaging/thread/ in href
  console.log(`\n── Strategy 1: <a> tags with /messaging/thread/ ──`)
  const anchors = await page.$$eval('a[href*="/messaging/thread/"]', els =>
    els.slice(0, 5).map(a => ({
      href: a.href,
      text: a.textContent?.trim().slice(0, 100) ?? '',
      classes: a.className?.toString().slice(0, 100) ?? '',
    }))
  )
  console.log(`  Found ${anchors.length} anchors`)
  anchors.forEach((a, i) => console.log(`  [${i+1}] href=${a.href.slice(0, 80)}\n      text="${a.text}"\n      classes="${a.classes}"`))

  // Strategy 2: any element with class containing "conversation"
  console.log(`\n── Strategy 2: elements with "conversation" in class ──`)
  const convs = await page.$$eval('[class*="conversation"]:not(div):not(span)', els =>
    els.slice(0, 8).map(el => ({
      tag: el.tagName.toLowerCase(),
      classes: el.className?.toString().slice(0, 120) ?? '',
      text: el.textContent?.trim().slice(0, 80) ?? '',
    }))
  ).catch(() => [])
  console.log(`  Found ${convs.length} non-div elements`)
  convs.forEach((c, i) => console.log(`  [${i+1}] <${c.tag} class="${c.classes}">\n      text="${c.text}"`))

  // Strategy 3: list items in messaging
  console.log(`\n── Strategy 3: <li> in messaging area ──`)
  const lis = await page.$$eval('main li', els =>
    els.slice(0, 6).map(el => ({
      classes: el.className?.toString().slice(0, 100) ?? '',
      text: el.textContent?.trim().slice(0, 60) ?? '',
      hasAnchor: !!el.querySelector('a[href*="/messaging/thread/"]'),
    }))
  ).catch(() => [])
  console.log(`  Found ${lis.length} <li> in main`)
  lis.forEach((l, i) => console.log(`  [${i+1}] class="${l.classes}" hasThreadLink=${l.hasAnchor}\n      text="${l.text}"`))

  // Strategy 4: deep dump of messaging container structure
  console.log(`\n── Strategy 4: messaging container HTML structure ──`)
  const containerInfo = await page.evaluate(() => {
    const candidates = [
      '[class*="msg-conversations-container"]',
      '[class*="conversations-container"]',
      '[role="list"][aria-label*="conversa" i]',
      '[role="list"][aria-label*="message" i]',
      '[data-test-app="messaging"]',
      'main [role="region"]',
    ]
    for (const sel of candidates) {
      const el = document.querySelector(sel)
      if (el) {
        return {
          selector: sel,
          tag: el.tagName.toLowerCase(),
          classes: el.className?.toString().slice(0, 150) ?? '',
          childrenCount: el.children.length,
          firstChildHTML: el.children[0]?.outerHTML?.slice(0, 600) ?? '',
        }
      }
    }
    return null
  })
  if (containerInfo) {
    console.log(`  Found via "${containerInfo.selector}"`)
    console.log(`    <${containerInfo.tag} class="${containerInfo.classes}">`)
    console.log(`    children: ${containerInfo.childrenCount}`)
    console.log(`    first child HTML: ${containerInfo.firstChildHTML}`)
  } else {
    console.log(`  No messaging container found by tested selectors`)
  }

  await browser.close()
}

main().catch(e => { console.error('FATAL:', e); process.exit(2) })
