#!/usr/bin/env node
/**
 * Backfills `conversations.linkedin_thread_id` for leads with existing threads.
 *
 * LinkedIn's /messaging/ list uses Ember.js — thread IDs are NOT exposed in
 * the DOM as hrefs or data attributes. We have to click each <li> and capture
 * the URL change to learn its thread ID.
 *
 * Strategy:
 *   1. Open /messaging/
 *   2. Scrape participant names from <h3 class="msg-conversation-listitem__participant-names">
 *   3. For each lead in DB needing backfill: find the <li> with matching name, click it,
 *      capture the resulting /messaging/thread/<id>/ URL, store in DB
 *
 * Read-only on LinkedIn — no messages sent.
 *
 * Usage:
 *   node scripts/backfill-thread-ids.js Josh           # apply
 *   node scripts/backfill-thread-ids.js Josh --dry-run # preview only
 */
import 'dotenv/config'
import { chromium }     from 'playwright-extra'
import StealthPlugin    from 'puppeteer-extra-plugin-stealth'
import { createClient } from '@supabase/supabase-js'

chromium.use(StealthPlugin())

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const ACCOUNT_LABEL = process.argv[2] ?? 'Josh'
const DRY_RUN       = process.argv.includes('--dry-run')

function parseProxy(p) {
  if (!p) return undefined
  const u = new URL(p)
  return { server: `${u.protocol}//${u.host}`, username: u.username, password: u.password }
}

function normalize(s) {
  return (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim()
}

async function main() {
  console.log(`\n🔁 Backfill thread IDs for ${ACCOUNT_LABEL} ${DRY_RUN ? '(DRY RUN)' : ''}\n`)

  const { data: account } = await supabase.from('linkedin_accounts').select('*').eq('label', ACCOUNT_LABEL).single()
  if (!account) { console.error('Account not found'); process.exit(1) }

  // Find leads belonging to this account that have FU history but no thread_id stored
  const { data: leads } = await supabase
    .from('leads')
    .select('id, full_name, status, campaign_id, campaigns(linkedin_account_id)')
    .in('status', ['follow_up_sent', 'follow_up_sent_2', 'follow_up_sent_3', 'follow_up_sent_4', 'follow_up_sent_5', 'replied'])
  const myLeads = (leads ?? []).filter(l => l.campaigns?.linkedin_account_id === account.id)

  const { data: existingConvs } = await supabase.from('conversations').select('lead_id, linkedin_thread_id')
  const existingMap = new Map(existingConvs?.map(c => [c.lead_id, c.linkedin_thread_id]) ?? [])
  const needBackfill = myLeads.filter(l => !existingMap.get(l.id))
  console.log(`  ${myLeads.length} FU/replied leads on this account`)
  console.log(`  ${needBackfill.length} need thread ID backfill\n`)
  if (needBackfill.length === 0) { console.log('  Nothing to do.'); process.exit(0) }

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

  console.log(`  ▸ Warmup`)
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'commit', timeout: 90_000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {})
  await sleep(2_500)

  console.log(`  ▸ Loading /messaging/`)
  await page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'commit', timeout: 60_000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {})
  await page.waitForSelector('li.msg-conversation-listitem', { timeout: 15_000 }).catch(() => null)
  await sleep(3_000)

  // Scroll the conversation list to load more entries — keep going until count stabilizes
  let prevCount = 0
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => {
      const list = document.querySelector('.msg-conversations-container__conversations-list')
      if (list) list.scrollTop = list.scrollHeight
    }).catch(() => {})
    await sleep(1_200)
    const cnt = await page.locator('li.msg-conversation-listitem').count().catch(() => 0)
    if (cnt === prevCount && i >= 5) break  // stable for several iterations → done loading
    prevCount = cnt
  }

  // Map participant name → li index for quick matching
  const items = await page.$$eval('li.msg-conversation-listitem', els =>
    els.map((el, idx) => {
      const nameEl = el.querySelector('.msg-conversation-listitem__participant-names, h3, [class*="participant-names"]')
      const name = (nameEl?.textContent || '').trim()
      return { index: idx, name }
    }).filter(it => it.name)
  )
  console.log(`  ▸ Found ${items.length} conversations in inbox\n`)

  // Pre-seed with already-stored thread IDs to detect collisions correctly
  const seenThreadIds = new Set(
    (existingConvs ?? []).map(c => c.linkedin_thread_id).filter(Boolean)
  )
  let matched = 0, errored = 0
  for (const lead of needBackfill) {
    const leadFirst = normalize(lead.full_name.split(' ')[0])
    const leadLast  = normalize(lead.full_name.split(' ').slice(-1)[0] ?? '')
    const item = items.find(it => {
      const n = normalize(it.name)
      return n.includes(leadFirst) && (leadLast.length < 3 || n.includes(leadLast))
    })
    if (!item) {
      console.log(`  ✗ ${lead.full_name}  (no matching conversation in inbox)`)
      continue
    }

    // Click the li and capture the resulting thread URL.
    // Between clicks, the LinkedIn SPA can serve stale URLs (the previous click's
    // thread URL persists). Detect collision against already-seen thread IDs and
    // do a full reset before retrying.
    let newUrl = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Always re-fetch the live li position by participant-name match — order
        // can shift when a thread bumps to top after read.
        const liLocator = page.locator(`li.msg-conversation-listitem:has(:text-is("${item.name.replace(/"/g, '\\"')}"))`).first()
        const fallback  = page.locator('li.msg-conversation-listitem').nth(item.index)
        const target    = await liLocator.count().then(c => c > 0 ? liLocator : fallback)

        await target.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {})
        await sleep(400)
        await target.click({ timeout: 8_000 })

        newUrl = await page.waitForFunction(
          () => location.pathname.includes('/messaging/thread/') ? location.href : null,
          { timeout: 12_000 }
        ).then(jh => jh.jsonValue()).catch(() => null)

        const threadId = newUrl?.match(/\/messaging\/thread\/([^\/]+)\//)?.[1]
        if (threadId && !seenThreadIds.has(threadId)) {
          seenThreadIds.add(threadId)
          break  // unique result — accept it
        }
        // Collision: thread ID already used for a previous lead → SPA stale state
        if (attempt === 0) {
          console.log(`     (retry: SPA stale, resetting /messaging/ for "${lead.full_name}")`)
          await page.goto('about:blank').catch(() => {})
          await sleep(500)
          await page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'commit', timeout: 60_000 })
          await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {})
          await page.waitForSelector('li.msg-conversation-listitem', { timeout: 15_000 }).catch(() => null)
          await sleep(2_500)
          // Re-scroll to find the lead
          for (let i = 0; i < 15; i++) {
            await page.evaluate(() => {
              const list = document.querySelector('.msg-conversations-container__conversations-list')
              if (list) list.scrollTop = list.scrollHeight
            }).catch(() => {})
            await sleep(900)
          }
          newUrl = null
          continue
        }
      } catch (err) {
        if (attempt === 1) throw err
      }
    }

    if (!newUrl) {
      console.log(`  ✗ ${lead.full_name}  (could not capture unique thread URL)`)
      errored++
      continue
    }

    const threadId = newUrl.match(/\/messaging\/thread\/([^\/]+)\//)?.[1]
    if (!threadId) {
      console.log(`  ✗ ${lead.full_name}  (couldn't extract thread ID from ${newUrl})`)
      errored++
      continue
    }

    // Final guard: don't save a thread ID we already used for someone else.
    // Tracks `seenThreadIds` AFTER the retry loop in case both attempts collided.
    if (seenThreadIds.has(threadId) && !Array.from(existingMap.entries()).some(([id, tid]) => id === lead.id && tid === threadId)) {
      console.log(`  ✗ ${lead.full_name}  (collision with existing thread ID — SPA stale persisted, skipping)`)
      errored++
      continue
    }
    seenThreadIds.add(threadId)

    console.log(`  ✓ ${lead.full_name}  →  ${threadId.slice(0, 28)}...  (matched "${item.name.slice(0, 35)}")`)

    if (!DRY_RUN) {
      const { data: existing } = await supabase.from('conversations').select('id').eq('lead_id', lead.id).maybeSingle()
      if (existing) {
        await supabase.from('conversations').update({ linkedin_thread_id: threadId }).eq('id', existing.id)
      } else {
        await supabase.from('conversations').insert({
          lead_id: lead.id,
          linkedin_account_id: account.id,
          linkedin_thread_id:  threadId,
        })
      }
    }
    matched++
    await sleep(800)
  }

  await browser.close()
  console.log()
  console.log(`─────────────────────────────────────────────`)
  console.log(`  ${matched}/${needBackfill.length} thread IDs ${DRY_RUN ? 'would be' : 'were'} backfilled${errored ? ` (${errored} errors)` : ''}`)
}

main().catch(e => { console.error('FATAL:', e); process.exit(2) })
