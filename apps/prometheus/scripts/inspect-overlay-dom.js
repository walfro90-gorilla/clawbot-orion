#!/usr/bin/env node
/**
 * DOM inspector — clicks Message on a lead profile, then dumps every visible
 * element that looks like a name/header in the resulting overlay or page.
 * Helps identify the CURRENT correct selector for LinkedIn's compose overlay.
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
  const leadName = process.argv[2] ?? 'Francisco Boils'
  const { data: account } = await supabase.from('linkedin_accounts').select('*').eq('label', 'Josh').single()
  const { data: lead } = await supabase.from('leads').select('*').ilike('full_name', `%${leadName}%`).limit(1).single()

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    proxy:    parseProxy(account.proxy_url),
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  })
  await ctx.addCookies([{ name: 'li_at', value: account.li_at_cookie, domain: '.linkedin.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' }])
  const page = await ctx.newPage()

  console.log(`▸ Warmup...`)
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'commit', timeout: 90_000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {})
  await sleep(2_500)

  console.log(`▸ Navigating to ${lead.full_name}'s profile...`)
  await page.goto(lead.linkedin_url, { waitUntil: 'commit', timeout: 60_000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {})
  await sleep(3_000)

  console.log(`▸ Clicking Message button (followup.js style)...`)
  const profileArea = page.locator('.pv-top-card, .pvs-profile-actions, [class*="pv-top-card"]').first()
  let clicked = false
  for (const txt of ['Mensaje', 'Message', 'Enviar mensaje']) {
    const btn = profileArea.locator(`button:has-text("${txt}"), a:has-text("${txt}")`).first()
    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await btn.click()
      clicked = true
      console.log(`  ✓ clicked "${txt}"`)
      break
    }
  }
  if (!clicked) {
    const aria = page.locator('button[aria-label*="Mensaje" i], button[aria-label*="Message" i]').first()
    if (await aria.isVisible({ timeout: 2000 })) {
      await aria.click()
      clicked = true
      console.log(`  ✓ clicked via aria-label`)
    }
  }
  if (!clicked) { console.error(`  ✗ no Message button found`); process.exit(1) }

  await sleep(4_500)
  console.log(`▸ URL after click: ${page.url()}`)

  // Save screenshot for visual reference
  await page.screenshot({ path: '/tmp/inspect-after-click.png', fullPage: false })
  console.log(`▸ Screenshot: /tmp/inspect-after-click.png`)

  // Dump all visible text nodes that contain the lead's first name
  console.log(`\n── Searching DOM for "${lead.full_name}" ──`)
  const expected = lead.full_name.split(' ')[0]
  const matches = await page.evaluate((name) => {
    const out = []
    document.querySelectorAll('*').forEach(el => {
      // direct text only (not inherited)
      const direct = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join('')
      if (direct.toLowerCase().includes(name.toLowerCase()) && direct.length < 100) {
        const rect = el.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          out.push({
            tag: el.tagName.toLowerCase(),
            cls: el.className?.toString?.().slice(0, 80) ?? '',
            text: direct.trim().slice(0, 80),
            id:   el.id ?? '',
          })
        }
      }
    })
    return out.slice(0, 25)  // limit
  }, expected)

  if (matches.length === 0) {
    console.log(`  ✗ NO elements found containing "${expected}" — lead's name not on page!`)
  } else {
    matches.forEach((m, i) => {
      console.log(`  [${i+1}] <${m.tag}${m.cls ? ' class="' + m.cls + '"' : ''}>: "${m.text}"`)
    })
  }

  // Also dump overlay-specific elements
  console.log(`\n── Overlay structure dump ──`)
  const overlay = await page.evaluate(() => {
    const overlays = document.querySelectorAll('[class*="msg-overlay"]')
    const result = []
    overlays.forEach((el, i) => {
      if (i > 8) return
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      result.push({
        tag: el.tagName.toLowerCase(),
        cls: el.className.toString().slice(0, 100),
        text: (el.textContent || '').trim().slice(0, 80),
      })
    })
    return result
  })

  if (overlay.length === 0) {
    console.log(`  ✗ NO .msg-overlay-* elements visible — no overlay rendered!`)
  } else {
    overlay.forEach((o, i) => {
      console.log(`  [${i+1}] <${o.tag} class="${o.cls}">`)
      console.log(`       text: "${o.text}"`)
    })
  }

  await browser.close()
}

main().catch(e => { console.error('FATAL:', e); process.exit(2) })
