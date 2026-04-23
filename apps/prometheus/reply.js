/**
 * reply.js — Send a reply to an existing LinkedIn conversation
 *
 * Used by Orion's /api/leads/reply endpoint when a user replies
 * directly from the CRM inbox to a lead's message.
 *
 * Prefers navigating to the known thread ID (stored in conversations.linkedin_thread_id).
 * Falls back to navigating to the lead's profile and clicking Message.
 *
 * Usage:
 *   LEAD_ID=<uuid> REPLY_MESSAGE=<text> node reply.js
 *   LEAD_ID=<uuid> REPLY_MESSAGE=<text> DRY_RUN=true node reply.js
 */

import { chromium } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import dotenv from 'dotenv'
import { supabase } from './lib/supabase.js'
import { randomContextOptions } from './lib/browser.js'

dotenv.config()
chromium.use(StealthPlugin())

const LEAD_ID       = process.env.LEAD_ID
const REPLY_MESSAGE = process.env.REPLY_MESSAGE
const DRY_RUN       = process.env.DRY_RUN !== 'false'
const LIVE_SEND     = process.env.LIVE_SEND === 'true'

// ── Helpers ───────────────────────────────────────────────────────────────────
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min
const sleep   = (ms)       => new Promise(r => setTimeout(r, ms))

async function microDelay() { await sleep(randInt(600, 1800)) }

async function humanScroll(page, distance = 400) {
  const steps = randInt(3, 6)
  const step  = Math.floor(distance / steps)
  for (let i = 0; i < steps; i++) {
    await page.evaluate(s => window.scrollBy(0, s), step + randInt(-20, 20))
    await sleep(randInt(80, 220))
  }
}

function parseProxy(proxyUrl) {
  if (!proxyUrl) return null
  try {
    const u = new URL(proxyUrl)
    return {
      server:   `${u.protocol}//${u.hostname}:${u.port}`,
      username: u.username || undefined,
      password: u.password || undefined,
    }
  } catch {
    return { server: proxyUrl }
  }
}

// ── Load context from DB ──────────────────────────────────────────────────────
async function loadContext() {
  // Lead + account via campaign
  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .select(`
      id, full_name, linkedin_url, campaign_id,
      campaigns (
        linkedin_account_id,
        linkedin_accounts ( id, label, li_at_cookie, proxy_url, status )
      )
    `)
    .eq('id', LEAD_ID)
    .single()

  if (leadErr || !lead) throw new Error(`Lead not found: ${leadErr?.message}`)

  const account = lead.campaigns?.linkedin_accounts
  if (!account) throw new Error('No LinkedIn account linked to this lead\'s campaign')
  if (account.status === 'banned')       throw new Error(`Account "${account.label}" is banned`)
  if (account.status === 'rate_limited') console.warn(`[REPLY] ⚠️  Account "${account.label}" is rate_limited — proceeding carefully`)

  // Load conversation for thread ID (might be null if inbox hasn't run yet)
  const { data: conv } = await supabase
    .from('conversations')
    .select('id, linkedin_thread_id')
    .eq('lead_id', LEAD_ID)
    .maybeSingle()

  return { lead, account, conv }
}

// ── Record sent reply in conversation_events ──────────────────────────────────
async function recordReply(convId, accountId, messageText) {
  if (DRY_RUN) return

  // Resolve conversation ID — upsert if not yet created
  let resolvedConvId = convId
  if (!resolvedConvId) {
    const { data, error } = await supabase
      .from('conversations')
      .upsert({ lead_id: LEAD_ID, linkedin_account_id: accountId }, { onConflict: 'lead_id' })
      .select('id').single()
    if (error || !data?.id) {
      console.error('[REPLY] No se pudo resolver/crear conversación:', error?.message)
      return
    }
    resolvedConvId = data.id
  }

  await supabase.from('conversation_events').insert({
    conversation_id: resolvedConvId,
    event_type:      'reply_sent',
    direction:       'outbound',
    content:         messageText.slice(0, 4000),
    sent_at:         new Date().toISOString(),
  })

  // Update last_message_at on conversation
  await supabase.from('conversations').update({
    last_message_at:   new Date().toISOString(),
    last_message_text: `[Tú]: ${messageText.slice(0, 500)}`,
  }).eq('id', resolvedConvId)

  console.log(`[REPLY] ✓ Recorded reply_sent in conversation_events`)
}

// ── Type and send message ─────────────────────────────────────────────────────
async function typeAndSend(page, textarea, leadName) {
  await textarea.click()
  await microDelay()

  for (const char of REPLY_MESSAGE) {
    await page.keyboard.type(char, { delay: randInt(30, 80) })
  }
  await sleep(randInt(500, 1200))

  if (!LIVE_SEND || DRY_RUN) {
    console.log(`[REPLY] [STAGING] Typed reply to "${leadName}" — NOT sending (LIVE_SEND=${LIVE_SEND}, DRY_RUN=${DRY_RUN})`)
    console.log(`[REPLY] Preview: "${REPLY_MESSAGE.slice(0, 100)}"`)
    await page.keyboard.selectAll()
    await page.keyboard.press('Backspace')
    return true
  }

  // Click Send
  const sendBtn = page.getByRole('button', { name: /^(send|enviar|submit)$/i }).first()
  const hasSend = await sendBtn.isVisible({ timeout: 5000 }).catch(() => false)
  if (hasSend) {
    await sendBtn.click()
  } else {
    // Fallback: Enter key
    await page.keyboard.press('Enter')
  }

  await sleep(randInt(1000, 2000))
  console.log(`[REPLY] ✓ Sent reply to "${leadName}"`)
  return true
}

// ── Navigate to thread by ID ──────────────────────────────────────────────────
async function sendViaThread(page, threadId, leadName) {
  console.log(`[REPLY] Navigating to thread ${threadId.slice(0, 20)}...`)
  await page.goto(`https://www.linkedin.com/messaging/thread/${threadId}/`, {
    waitUntil: 'domcontentloaded',
    timeout:   30000,
  })
  await sleep(randInt(3000, 5000))

  if (page.url().includes('/checkpoint') || page.url().includes('/challenge')) {
    console.error('[REPLY] ⛔ Checkpoint detected — aborting.')
    return 'captcha'
  }

  const textarea = page.locator(
    'div[role="textbox"][contenteditable="true"], ' +
    '.msg-form__contenteditable, ' +
    '[data-artdeco-is-focused] [contenteditable="true"]'
  ).first()

  const hasTextarea = await textarea.isVisible({ timeout: 10000 }).catch(() => false)
  if (!hasTextarea) {
    console.warn(`[REPLY] No textarea found in thread — falling back to profile navigation`)
    return null // signal fallback
  }

  await typeAndSend(page, textarea, leadName)
  return 'sent'
}

// ── Navigate via profile → Message button ────────────────────────────────────
async function sendViaProfile(page, profileUrl, leadName) {
  console.log(`[REPLY] Navigating to profile ${profileUrl}`)
  await page.goto(profileUrl.endsWith('/') ? profileUrl : profileUrl + '/', {
    waitUntil: 'domcontentloaded',
    timeout:   30000,
  })
  await sleep(randInt(2000, 4000))

  if (page.url().includes('/checkpoint') || page.url().includes('/challenge')) {
    console.error('[REPLY] ⛔ Checkpoint detected — aborting.')
    return 'captcha'
  }

  await humanScroll(page, randInt(200, 500))
  await microDelay()

  const msgBtn = page.getByRole('button', {
    name: /^(message|mensaje|enviar mensaje|send message)$/i,
  }).first()
  const hasMsgBtn = await msgBtn.isVisible({ timeout: 8000 }).catch(() => false)

  if (hasMsgBtn) {
    await msgBtn.click()
  } else {
    const altBtn = page.locator(
      'a[href*="/messaging/"], button[aria-label*="message" i], button[aria-label*="mensaje" i]'
    ).first()
    const hasAlt = await altBtn.isVisible({ timeout: 3000 }).catch(() => false)
    if (!hasAlt) {
      console.warn(`[REPLY] No message button found for "${leadName}"`)
      return 'no_button'
    }
    await altBtn.click()
  }

  await sleep(randInt(1500, 2500))

  // Locate textarea (overlay or messaging page)
  const textarea = page.locator(
    'div[role="textbox"][contenteditable="true"], ' +
    '.msg-form__contenteditable, ' +
    '.msg-overlay-conversation-bubble--is-active [contenteditable="true"]'
  ).first()

  const hasTextarea = await textarea.isVisible({ timeout: 10000 }).catch(() => false)
  if (!hasTextarea) {
    console.warn(`[REPLY] No textarea found after clicking Message for "${leadName}"`)
    return 'error'
  }

  await typeAndSend(page, textarea, leadName)
  return 'sent'
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  if (!LEAD_ID)       { console.error('[REPLY] ERROR: LEAD_ID not set'); process.exit(1) }
  if (!REPLY_MESSAGE) { console.error('[REPLY] ERROR: REPLY_MESSAGE not set'); process.exit(1) }

  console.log(`[REPLY] Sending reply for lead ${LEAD_ID}`)
  if (DRY_RUN) console.log('[REPLY] DRY_RUN mode — no real message will be sent')

  const { lead, account, conv } = await loadContext()
  console.log(`[REPLY] Lead: ${lead.full_name} | Account: ${account.label}`)

  const proxy = parseProxy(account.proxy_url)
  if (proxy) console.log(`[REPLY] Using proxy: ${proxy.server}`)
  else       console.log('[REPLY] ⚠️  No proxy — ban risk')

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  const context = await browser.newContext(randomContextOptions(proxy ?? undefined))

  await context.addCookies([{
    name: 'li_at', value: account.li_at_cookie,
    domain: '.linkedin.com', path: '/', httpOnly: true, secure: true, sameSite: 'None',
  }])

  const page = await context.newPage()
  await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}', r => r.abort())
  await page.route('**/li/track', r => r.abort())

  let outcome = 'error'

  try {
    // Warmup
    console.log('[REPLY] Warming up — visiting feed...')
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 })

    if (page.url().includes('/login') || page.url().includes('/authwall')) {
      console.error('[REPLY] Cookie expired'); process.exit(2)
    }

    await sleep(randInt(4000, 8000))
    await humanScroll(page, randInt(200, 500))
    await sleep(randInt(2000, 4000))

    // Try thread first (most reliable if we have the ID)
    if (conv?.linkedin_thread_id) {
      const result = await sendViaThread(page, conv.linkedin_thread_id, lead.full_name)
      if (result === 'sent') {
        outcome = 'sent'
      } else if (result === 'captcha') {
        process.exit(2)
      } else {
        // Fallback to profile
        const fallback = await sendViaProfile(page, lead.linkedin_url, lead.full_name)
        outcome = fallback === 'sent' ? 'sent' : fallback
        if (fallback === 'captcha') process.exit(2)
      }
    } else {
      // No thread ID — go via profile
      const result = await sendViaProfile(page, lead.linkedin_url, lead.full_name)
      outcome = result === 'sent' ? 'sent' : result
      if (result === 'captcha') process.exit(2)
    }

    if (outcome === 'sent') {
      await recordReply(conv?.id ?? null, account.id, REPLY_MESSAGE)
    }

  } finally {
    await browser.close()
  }

  console.log(`\n[REPLY] Outcome: ${outcome}`)
  if (outcome !== 'sent') process.exit(1)
}

run().catch(err => {
  console.error('[REPLY] Fatal:', err)
  process.exit(1)
})
