#!/usr/bin/env node
import 'dotenv/config'
import { chromium }     from 'playwright-extra'
import StealthPlugin    from 'puppeteer-extra-plugin-stealth'
import { createClient } from '@supabase/supabase-js'
chromium.use(StealthPlugin())
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))
function parseProxy(p) { const u = new URL(p); return { server: `${u.protocol}//${u.host}`, username: u.username, password: u.password } }

const profileUrl = process.argv[2] ?? 'https://www.linkedin.com/in/carlos-casta%C3%B1eda-98789a23/'

const { data: a } = await sb.from('linkedin_accounts').select('*').eq('label', 'Josh').single()
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })

// New context each time (matches new followup.js architecture)
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  proxy: parseProxy(a.proxy_url),
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
})
await ctx.addCookies([{ name: 'li_at', value: a.li_at_cookie, domain: '.linkedin.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' }])
const page = await ctx.newPage()

console.log('▸ Warmup /feed...')
const t1 = Date.now()
await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'commit', timeout: 60000 })
await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {})
await page.waitForSelector('main, .scaffold-layout', { timeout: 15000 }).catch(() => {})
await sleep(3000)
console.log(`  warmup done in ${Date.now()-t1}ms — url=${page.url().slice(0,80)}`)

console.log(`\n▸ Navigate to profile: ${profileUrl}`)
const t2 = Date.now()
await page.goto(profileUrl, { waitUntil: 'commit', timeout: 60000 })
await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {})
console.log(`  goto commit in ${Date.now()-t2}ms — url=${page.url().slice(0,80)}`)

// Probe page state at multiple timings
for (const wait of [2000, 5000, 8000, 12000]) {
  await sleep(wait - (Date.now() - t2))
  const buttonCount = await page.locator('button').count().catch(() => 0)
  const titleText = await page.title().catch(() => '')
  const bodyLen = await page.evaluate(() => document.body?.innerText?.length ?? 0).catch(() => 0)
  console.log(`  +${wait}ms → buttons=${buttonCount} bodyLen=${bodyLen} title="${titleText}"`)
}

// Dump first 15 visible buttons
console.log('\n▸ Visible button text:')
const buttons = await page.$$eval('button, a[role="button"]', els =>
  els.slice(0, 30).map(b => {
    const text = b.textContent?.trim().slice(0, 60) ?? ''
    const aria = b.getAttribute('aria-label')?.slice(0, 60) ?? ''
    const visible = b.offsetParent !== null
    return { text, aria, visible }
  }).filter(b => b.visible && (b.text || b.aria))
)
buttons.forEach((b, i) => console.log(`  [${i+1}] text="${b.text}" aria="${b.aria}"`))

await page.screenshot({ path: '/tmp/debug-profile.png', fullPage: false })
console.log(`\n▸ Screenshot: /tmp/debug-profile.png`)

await browser.close()
