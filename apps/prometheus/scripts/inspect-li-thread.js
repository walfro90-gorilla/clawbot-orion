#!/usr/bin/env node
import 'dotenv/config'
import { chromium }     from 'playwright-extra'
import StealthPlugin    from 'puppeteer-extra-plugin-stealth'
import { createClient } from '@supabase/supabase-js'

chromium.use(StealthPlugin())
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))

function parseProxy(p) {
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

  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'commit', timeout: 90_000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {})
  await sleep(2_500)
  await page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'commit', timeout: 60_000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {})
  await sleep(5_000)

  // Get the FIRST li.msg-conversation-listitem and dump its full structure
  const info = await page.evaluate(() => {
    const li = document.querySelector('li.msg-conversation-listitem')
    if (!li) return null

    // Look for any href / data-* / id attributes anywhere in the subtree
    const attrs = []
    li.querySelectorAll('*').forEach(el => {
      Array.from(el.attributes).forEach(a => {
        if (a.name === 'href' || a.name.startsWith('data-') || a.name === 'id') {
          if (a.value && a.value.length > 5 && a.value.length < 200) {
            attrs.push({ tag: el.tagName.toLowerCase(), attr: a.name, value: a.value })
          }
        }
      })
    })

    // Also get top-level li's own attributes
    const topAttrs = Array.from(li.attributes).map(a => ({ name: a.name, value: a.value.slice(0, 200) }))

    return {
      topAttrs,
      attrs: attrs.slice(0, 15),
      html: li.outerHTML.slice(0, 2000),
    }
  })

  if (!info) { console.log('No li.msg-conversation-listitem found'); await browser.close(); return }

  console.log(`── Top-level <li> attributes ──`)
  info.topAttrs.forEach(a => console.log(`  ${a.name}="${a.value}"`))

  console.log(`\n── Inner attributes (href/data-*/id) ──`)
  info.attrs.forEach(a => console.log(`  <${a.tag}> ${a.attr}="${a.value}"`))

  console.log(`\n── Full outerHTML (first 2000 chars) ──`)
  console.log(info.html)

  await browser.close()
}

main().catch(e => { console.error('FATAL:', e); process.exit(2) })
