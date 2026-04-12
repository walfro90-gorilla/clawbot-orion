/**
 * followup.js — Prometheus follow-up sender
 *
 * Envía mensajes de seguimiento a leads que:
 *   - Aceptaron la invitación (status = 'connected')
 *   - No han respondido aún
 *   - La invitación fue enviada hace al menos `follow_up_delay_days` días
 *   - No han recibido ya un follow-up (no hay evento 'follow_up_sent' en conversation_events)
 *
 * Anti-ban:
 *   - Max 3–5 follow-ups por ejecución (variable)
 *   - Delays humanos entre mensajes (45–120s)
 *   - Solo se lanza dentro de horario laboral (el scheduler lo controla)
 *   - No envía si el lead ya respondió (status = 'replied')
 *
 * Usage:
 *   CAMPAIGN_ID=<uuid> node followup.js
 *   CAMPAIGN_ID=<uuid> DRY_RUN=true node followup.js
 */

import { chromium } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import dotenv from 'dotenv'
import { supabase, logActivity, incrementDaily } from './lib/supabase.js'

dotenv.config()
chromium.use(StealthPlugin())

const CAMPAIGN_ID = process.env.CAMPAIGN_ID
const DRY_RUN     = process.env.DRY_RUN !== 'false'
const LIVE_SEND   = process.env.LIVE_SEND === 'true'

const MAX_FOLLOWUPS_PER_RUN = 4   // máx follow-ups por ejecución (anti-ban)
const MAX_FOLLOWUPS_PER_DAY = 8   // cap diario por cuenta (suma de todas las ejecuciones del día)
const DELAY_MIN_MS          = DRY_RUN ? 3_000  : 45 * 1000
const DELAY_MAX_MS          = DRY_RUN ? 6_000  : 120 * 1000

// ── Helpers ───────────────────────────────────────────────────────────────────
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

async function microDelay() {
  await new Promise(r => setTimeout(r, randInt(600, 1800)))
}

async function humanScroll(page, distance = 400) {
  const steps = randInt(3, 6)
  const step  = Math.floor(distance / steps)
  for (let i = 0; i < steps; i++) {
    await page.evaluate(s => window.scrollBy(0, s), step + randInt(-20, 20))
    await new Promise(r => setTimeout(r, randInt(80, 220)))
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

// ── Load campaign + account ───────────────────────────────────────────────────
async function loadCampaign() {
  const { data, error } = await supabase
    .from('campaigns')
    .select(`
      id, name, follow_up_message, follow_up_delay_days, follow_up_paused,
      linkedin_account_id,
      linkedin_accounts (
        id, label, li_at_cookie, proxy_url, status
      )
    `)
    .eq('id', CAMPAIGN_ID)
    .eq('is_active', true)
    .single()

  if (error || !data) throw new Error(`Campaign not found: ${error?.message}`)
  if (!data.follow_up_message) throw new Error('No follow_up_message set for this campaign — skipping.')
  if (data.follow_up_paused) throw new Error('Follow-up paused for this campaign — skipping.')
  return data
}

// ── Load leads eligible for follow-up ────────────────────────────────────────
async function loadFollowupLeads(campaign) {
  const delayDays = campaign.follow_up_delay_days ?? 3
  const cutoff    = new Date(Date.now() - delayDays * 24 * 60 * 60 * 1000).toISOString()

  // Leads connected + sent invite at least delayDays ago
  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, full_name, linkedin_url, sent_at, status')
    .eq('campaign_id', CAMPAIGN_ID)
    .eq('status', 'connected')
    .lte('sent_at', cutoff)
    .order('sent_at', { ascending: true })
    .limit(20) // load extra to filter out already-sent below

  if (error) throw new Error(`Could not load leads: ${error.message}`)
  if (!leads?.length) return []

  // Filter out leads that already have a follow_up_sent event
  const leadIds = leads.map(l => l.id)

  // Get conversation_ids for these leads
  const { data: convs } = await supabase
    .from('conversations')
    .select('id, lead_id')
    .in('lead_id', leadIds)

  const convByLead = new Map((convs ?? []).map(c => [c.lead_id, c.id]))
  const convIds    = (convs ?? []).map(c => c.id)

  let alreadySentLeadIds = new Set()
  if (convIds.length > 0) {
    const { data: events } = await supabase
      .from('conversation_events')
      .select('conversation_id')
      .in('conversation_id', convIds)
      .eq('event_type', 'follow_up_sent')

    // Map conv_id back to lead_id
    const convToLead = new Map((convs ?? []).map(c => [c.id, c.lead_id]))
    for (const ev of (events ?? [])) {
      const leadId = convToLead.get(ev.conversation_id)
      if (leadId) alreadySentLeadIds.add(leadId)
    }
  }

  // Check daily cap: count follow_up_sent events from today across ALL conversations of this account
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  const { count: sentToday } = await supabase
    .from('conversation_events')
    .select('id', { count: 'exact', head: true })
    .eq('event_type', 'follow_up_sent')
    .eq('direction', 'outbound')
    .gte('sent_at', todayStart.toISOString())

  const remainingToday = Math.max(0, MAX_FOLLOWUPS_PER_DAY - (sentToday ?? 0))
  if (remainingToday === 0) {
    console.log(`[FOLLOWUP] Daily cap reached (${MAX_FOLLOWUPS_PER_DAY}/day) — skipping.`)
    return []
  }

  const eligible = leads
    .filter(l => !alreadySentLeadIds.has(l.id))
    .slice(0, Math.min(MAX_FOLLOWUPS_PER_RUN, remainingToday))

  console.log(`[FOLLOWUP] Eligible: ${eligible.length} leads (cap: ${sentToday ?? 0}/${MAX_FOLLOWUPS_PER_DAY} today, skip ${alreadySentLeadIds.size} already sent)`)
  return eligible
}

// ── Record follow-up sent in conversation_events ──────────────────────────────
async function recordFollowUp(lead, message) {
  const accountId = process.env.ACCOUNT_ID_RESOLVED

  // Upsert conversation
  const { data: conv } = await supabase
    .from('conversations')
    .upsert(
      { lead_id: lead.id, linkedin_account_id: accountId },
      { onConflict: 'lead_id' }
    )
    .select('id')
    .single()

  if (!conv?.id) {
    console.warn(`[FOLLOWUP] Could not upsert conversation for lead ${lead.id}`)
    return
  }

  await supabase.from('conversation_events').insert({
    conversation_id: conv.id,
    event_type:      'follow_up_sent',
    direction:       'outbound',
    content:         message.slice(0, 4000),
    sent_at:         new Date().toISOString(),
  })

  console.log(`[FOLLOWUP] ✅ Recorded follow_up_sent for "${lead.full_name}"`)
}

// ── Navigate to profile and send message ─────────────────────────────────────
async function sendFollowUp(page, lead, message) {
  const profileUrl = lead.linkedin_url.endsWith('/')
    ? lead.linkedin_url
    : lead.linkedin_url + '/'

  console.log(`[FOLLOWUP] Navigating to ${lead.full_name} → ${profileUrl}`)
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(randInt(2000, 4000))

  // Checkpoint / captcha detection
  if (page.url().includes('/checkpoint') || page.url().includes('/challenge')) {
    console.error('[FOLLOWUP] ⛔ Checkpoint detected — aborting.')
    return 'captcha'
  }

  // Scroll to simulate reading profile
  await humanScroll(page, randInt(300, 600))
  await microDelay()

  // Find the Message button (they're connected — should be a direct message button)
  const msgBtn = page.getByRole('button', {
    name: /^(message|mensaje|enviar mensaje|send message)$/i,
  }).first()

  const hasMsgBtn = await msgBtn.isVisible({ timeout: 8000 }).catch(() => false)
  if (!hasMsgBtn) {
    // Try alt locators (LinkedIn A/B tests)
    const altBtn = page.locator(
      'a[href*="/messaging/"], button[aria-label*="message" i], button[aria-label*="mensaje" i]'
    ).first()
    const hasAlt = await altBtn.isVisible({ timeout: 3000 }).catch(() => false)
    if (!hasAlt) {
      console.warn(`[FOLLOWUP] ⚠️  No message button found for "${lead.full_name}" — may no longer be connected or premium-gated.`)
      return 'no_button'
    }
    await altBtn.click()
  } else {
    await msgBtn.click()
  }

  await page.waitForTimeout(randInt(1500, 2500))

  // Handle possible redirect to /messaging/ page
  if (page.url().includes('/messaging/')) {
    const textarea = page.locator('div[role="textbox"], [contenteditable="true"]').first()
    const hasTextarea = await textarea.isVisible({ timeout: 8000 }).catch(() => false)
    if (!hasTextarea) {
      console.warn(`[FOLLOWUP] No messaging textarea found on /messaging/ page.`)
      return 'error'
    }
    await typeAndSend(page, textarea, lead, message)
    return 'sent'
  }

  // Messaging overlay at bottom of page
  const textarea = page.locator(
    'div[role="textbox"][contenteditable="true"], ' +
    '.msg-form__contenteditable, ' +
    '.msg-overlay-conversation-bubble--is-active [contenteditable="true"]'
  ).first()

  const hasTextarea = await textarea.isVisible({ timeout: 8000 }).catch(() => false)
  if (!hasTextarea) {
    // Try pressing Escape to dismiss any overlay then re-check
    await page.keyboard.press('Escape')
    await page.waitForTimeout(randInt(600, 1000))
    const hasAfterEsc = await textarea.isVisible({ timeout: 3000 }).catch(() => false)
    if (!hasAfterEsc) {
      console.warn(`[FOLLOWUP] ⚠️  Messaging textarea not found for "${lead.full_name}".`)
      return 'error'
    }
  }

  await typeAndSend(page, textarea, lead, message)
  return 'sent'
}

// ── Type message and click Send ───────────────────────────────────────────────
async function typeAndSend(page, textarea, lead, message) {
  // Click textarea to focus it
  await textarea.click()
  await page.waitForTimeout(randInt(300, 700))

  // Type character-by-character with human delays
  for (const char of message) {
    await page.keyboard.type(char, { delay: randInt(30, 80) })
  }

  await page.waitForTimeout(randInt(500, 1200))

  if (!LIVE_SEND) {
    console.log(`[FOLLOWUP] [STAGING] Typed message for "${lead.full_name}" — NOT sending (LIVE_SEND=false).`)
    console.log(`[FOLLOWUP] Message preview: "${message.slice(0, 80)}..."`)
    // Clear the typed message
    await page.keyboard.selectAll()
    await page.keyboard.press('Backspace')
    return
  }

  // Find Send button
  const sendBtn = page.getByRole('button', {
    name: /^(send|enviar|submit)$/i,
  }).first()

  const hasSend = await sendBtn.isVisible({ timeout: 5000 }).catch(() => false)
  if (hasSend) {
    await sendBtn.click()
  } else {
    // Fallback: Enter key
    await page.keyboard.press('Enter')
  }

  await page.waitForTimeout(randInt(800, 1500))
  console.log(`[FOLLOWUP] 📤 Message sent to "${lead.full_name}"`)
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  if (!CAMPAIGN_ID) {
    console.error('[FOLLOWUP] CAMPAIGN_ID not set.')
    process.exit(1)
  }

  console.log(`[FOLLOWUP] Starting follow-up job for campaign ${CAMPAIGN_ID}`)
  console.log(`[FOLLOWUP] DRY_RUN=${DRY_RUN} | LIVE_SEND=${LIVE_SEND}`)

  const campaign = await loadCampaign()
  const account  = campaign.linkedin_accounts

  if (!account) throw new Error('No LinkedIn account linked to campaign.')
  if (account.status !== 'active') throw new Error(`Account status=${account.status} — skipping.`)

  // Make account ID available to recordFollowUp()
  process.env.ACCOUNT_ID_RESOLVED = account.id

  const leads = await loadFollowupLeads(campaign)

  if (leads.length === 0) {
    console.log('[FOLLOWUP] No eligible leads for follow-up — done.')
    console.log('[FOLLOWUP] Sent: 0')
    process.exit(0)
  }

  if (DRY_RUN) {
    console.log(`[FOLLOWUP] [DRY_RUN] Would send follow-ups to ${leads.length} leads:`)
    for (const l of leads) console.log(`  - ${l.full_name} (${l.linkedin_url}) sent_at=${l.sent_at}`)
    console.log('[FOLLOWUP] Sent: 0')
    process.exit(0)
  }

  // ── Launch browser ───────────────────────────────────────────────────────────
  const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  ]
  const userAgent = USER_AGENTS[randInt(0, USER_AGENTS.length - 1)]
  const vpWidth   = randInt(1260, 1440)
  const vpHeight  = randInt(860, 920)

  const PROXY_URL = process.env.PROXY_URL || account.proxy_url || null
  const proxy     = parseProxy(PROXY_URL)

  const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  if (proxy?.server) launchArgs.push(`--proxy-server=${proxy.server}`)

  const browser = await chromium.launch({ headless: true, args: launchArgs })
  const context = await browser.newContext({
    userAgent,
    viewport:   { width: vpWidth, height: vpHeight },
    locale:     'es-MX',
    timezoneId: 'America/Mexico_City',
    ...(proxy ? { proxy } : {}),
  })
  const page = await context.newPage()

  // Inject LinkedIn cookie
  await context.addCookies([{
    name:   'li_at',
    value:  account.li_at_cookie,
    domain: '.linkedin.com',
    path:   '/',
    httpOnly: true,
    secure:   true,
  }])

  let sentCount    = 0
  let errorCount   = 0

  try {
    // ── Warmup: visit feed first ──────────────────────────────────────────────
    console.log('[FOLLOWUP] Warming up — visiting LinkedIn feed...')
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(randInt(3000, 6000))
    await humanScroll(page, randInt(400, 800))
    await page.waitForTimeout(randInt(2000, 4000))

    // ── Process each lead ─────────────────────────────────────────────────────
    for (const lead of leads) {
      console.log(`\n[FOLLOWUP] ─── ${lead.full_name} (${sentCount + 1}/${leads.length}) ───`)

      try {
        const outcome = await sendFollowUp(page, lead, campaign.follow_up_message)

        if (outcome === 'captcha') {
          console.error('[FOLLOWUP] ⛔ Captcha — stopping.')
          await supabase.from('linkedin_accounts').update({ status: 'rate_limited' }).eq('id', account.id)
          process.exitCode = 2
          break
        }

        if (outcome === 'sent') {
          if (LIVE_SEND) {
            await recordFollowUp(lead, campaign.follow_up_message)
            await logActivity(account.id, 'message_sent', { lead_id: lead.id, campaign_id: CAMPAIGN_ID, type: 'follow_up' })
            await incrementDaily(account.id, 'messages_sent')
          }
          sentCount++
        } else {
          errorCount++
        }
      } catch (err) {
        console.error(`[FOLLOWUP] Error on "${lead.full_name}": ${err.message}`)
        errorCount++
      }

      // Human delay between messages
      if (sentCount < leads.length) {
        const delay = randInt(DELAY_MIN_MS, DELAY_MAX_MS)
        console.log(`[FOLLOWUP] Waiting ${Math.round(delay / 1000)}s before next lead...`)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  } finally {
    await browser.close()
  }

  console.log(`\n[FOLLOWUP] ══════════════════════════════`)
  console.log(`[FOLLOWUP] Sent:   ${sentCount}`)
  console.log(`[FOLLOWUP] Errors: ${errorCount}`)
  console.log(`[FOLLOWUP] ══════════════════════════════`)
  process.exit(process.exitCode ?? 0)
}

run().catch(err => {
  console.error('[FOLLOWUP] Fatal error:', err.message)
  process.exit(1)
})
