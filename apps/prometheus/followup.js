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
import { randomContextOptions } from './lib/browser.js'

dotenv.config()
chromium.use(StealthPlugin())

const CAMPAIGN_ID    = process.env.CAMPAIGN_ID
const DRY_RUN        = process.env.DRY_RUN !== 'false'
const LIVE_SEND      = process.env.LIVE_SEND === 'true'
const FOLLOW_UP_STEP = parseInt(process.env.FOLLOW_UP_STEP ?? '1') // 1, 2, or 3

const MAX_FOLLOWUPS_PER_RUN = 4   // máx follow-ups por ejecución (anti-ban)
// Cap diario GLOBAL — cuenta todos los tipos de follow-up juntos para no saturar la cuenta.
// Antes era por tipo (8 step1 + 8 step2 + 8 step3 = 24/día), ahora es total compartido.
const MAX_FOLLOWUPS_PER_DAY = 5   // máx mensajes de follow-up en total por día por cuenta
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
      follow_up_step2_message, follow_up_step2_delay_days,
      follow_up_step3_message, follow_up_step3_delay_days,
      linkedin_account_id,
      linkedin_accounts (
        id, label, li_at_cookie, proxy_url, status
      )
    `)
    .eq('id', CAMPAIGN_ID)
    .eq('is_active', true)
    .single()

  if (error || !data) throw new Error(`Campaign not found: ${error?.message}`)
  if (data.follow_up_paused) throw new Error('Follow-up paused for this campaign — skipping.')

  // Validate that the message for this step exists
  if (FOLLOW_UP_STEP === 1 && !data.follow_up_message) {
    throw new Error('No follow_up_message set for this campaign — skipping.')
  }
  if (FOLLOW_UP_STEP === 2 && !data.follow_up_step2_message) {
    throw new Error('No follow_up_step2_message set — skipping step 2.')
  }
  if (FOLLOW_UP_STEP === 3 && !data.follow_up_step3_message) {
    throw new Error('No follow_up_step3_message set — skipping step 3.')
  }

  return data
}

// ── Load leads eligible for follow-up ────────────────────────────────────────
async function loadFollowupLeads(campaign) {
  const isStep2 = FOLLOW_UP_STEP === 2
  const isStep3 = FOLLOW_UP_STEP === 3

  // Delay days per step
  const delayDays = isStep3
    ? (campaign.follow_up_step3_delay_days ?? 21)
    : isStep2
    ? (campaign.follow_up_step2_delay_days ?? 12)
    : (campaign.follow_up_delay_days ?? 3)
  const cutoff    = new Date(Date.now() - delayDays * 24 * 60 * 60 * 1000).toISOString()

  console.log(`[FOLLOWUP] Step ${FOLLOW_UP_STEP} — delay=${delayDays}d, cutoff=${cutoff.split('T')[0]}`)

  let query = supabase
    .from('leads')
    .select('id, full_name, linkedin_url, sent_at, status, last_followup2_at, last_followup3_at')
    .eq('campaign_id', CAMPAIGN_ID)
    .lte('sent_at', cutoff)
    .limit(50)

  if (isStep3) {
    // Step 3: leads that received step 2 but haven't received step 3 yet
    query = query.eq('status', 'follow_up_sent_2').is('last_followup3_at', null)
  } else if (isStep2) {
    // Step 2: leads in 'follow_up_sent' status that haven't received step 2 yet
    query = query.eq('status', 'follow_up_sent').is('last_followup2_at', null)
  } else {
    // Step 1: leads that accepted (connected) but haven't responded
    query = query.eq('status', 'connected')
  }

  const { data: rawLeads, error } = await query
  if (error) throw new Error(`Could not load leads: ${error.message}`)
  if (!rawLeads?.length) return []

  // Shuffle to avoid predictable FIFO pattern (anti-fingerprinting)
  const leads = rawLeads.sort(() => Math.random() - 0.5).slice(0, 20)

  // For step 1: filter out leads that already have a follow_up_sent event
  let alreadySentLeadIds = new Set()

  if (!isStep2 && !isStep3) {
    const leadIds = leads.map(l => l.id)
    const { data: convs } = await supabase
      .from('conversations')
      .select('id, lead_id')
      .in('lead_id', leadIds)

    const convIds = (convs ?? []).map(c => c.id)
    if (convIds.length > 0) {
      const { data: events } = await supabase
        .from('conversation_events')
        .select('conversation_id')
        .in('conversation_id', convIds)
        .eq('event_type', 'follow_up_sent')

      const convToLead = new Map((convs ?? []).map(c => [c.id, c.lead_id]))
      for (const ev of (events ?? [])) {
        const leadId = convToLead.get(ev.conversation_id)
        if (leadId) alreadySentLeadIds.add(leadId)
      }
    }
  }

  // ── Global daily cap: count ALL follow-up types together (anti-ban safety)
  // This prevents steps 1+2+3 from collectively sending too many messages in one day.
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  const { count: sentToday } = await supabase
    .from('conversation_events')
    .select('id', { count: 'exact', head: true })
    .in('event_type', ['follow_up_sent', 'follow_up_sent_2', 'follow_up_sent_3'])
    .eq('direction', 'outbound')
    .gte('sent_at', todayStart.toISOString())

  const remainingToday = Math.max(0, MAX_FOLLOWUPS_PER_DAY - (sentToday ?? 0))
  if (remainingToday === 0) {
    console.log(`[FOLLOWUP] Global daily cap reached (${MAX_FOLLOWUPS_PER_DAY}/day total) — skipping.`)
    return []
  }

  const eligible = leads
    .filter(l => !alreadySentLeadIds.has(l.id))
    .slice(0, Math.min(MAX_FOLLOWUPS_PER_RUN, remainingToday))

  console.log(`[FOLLOWUP] Eligible: ${eligible.length} leads (global cap: ${sentToday ?? 0}/${MAX_FOLLOWUPS_PER_DAY} today, skip ${alreadySentLeadIds.size} already sent)`)
  return eligible
}

// ── Record follow-up sent in conversation_events ──────────────────────────────
async function recordFollowUp(lead, message) {
  const accountId = process.env.ACCOUNT_ID_RESOLVED
  const isStep2   = FOLLOW_UP_STEP === 2
  const isStep3   = FOLLOW_UP_STEP === 3
  const eventType = isStep3 ? 'follow_up_sent_3' : isStep2 ? 'follow_up_sent_2' : 'follow_up_sent'
  const now       = new Date().toISOString()

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
    event_type:      eventType,
    direction:       'outbound',
    content:         message.slice(0, 4000),
    sent_at:         now,
  })

  if (isStep3) {
    await supabase.from('leads').update({
      status:            'follow_up_sent_3',
      last_followup3_at: now,
    }).eq('id', lead.id)
  } else if (isStep2) {
    await supabase.from('leads').update({
      status:            'follow_up_sent_2',
      last_followup2_at: now,
    }).eq('id', lead.id)
  } else {
    await supabase.from('leads').update({ status: 'follow_up_sent' }).eq('id', lead.id)
  }

  console.log(`[FOLLOWUP] ✅ Recorded ${eventType} for "${lead.full_name}"`)
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

  console.log(`[FOLLOWUP] Starting follow-up job for campaign ${CAMPAIGN_ID} (step ${FOLLOW_UP_STEP}/3)`)
  console.log(`[FOLLOWUP] DRY_RUN=${DRY_RUN} | LIVE_SEND=${LIVE_SEND}`)

  const campaign = await loadCampaign()
  const account  = campaign.linkedin_accounts

  if (!account) throw new Error('No LinkedIn account linked to campaign.')
  if (account.status !== 'active') throw new Error(`Account status=${account.status} — skipping.`)

  // Make account ID available to recordFollowUp()
  process.env.ACCOUNT_ID_RESOLVED = account.id

  // Select message based on step
  const followUpMessage = FOLLOW_UP_STEP === 3
    ? campaign.follow_up_step3_message
    : FOLLOW_UP_STEP === 2
    ? campaign.follow_up_step2_message
    : campaign.follow_up_message

  const leads = await loadFollowupLeads(campaign)

  if (leads.length === 0) {
    console.log('[FOLLOWUP] No eligible leads for follow-up — done.')
    console.log('[FOLLOWUP] Sent: 0')
    process.exit(0)
  }

  if (DRY_RUN) {
    console.log(`[FOLLOWUP] [DRY_RUN] Would send step ${FOLLOW_UP_STEP} follow-ups to ${leads.length} leads:`)
    for (const l of leads) console.log(`  - ${l.full_name} (${l.linkedin_url}) sent_at=${l.sent_at}`)
    console.log('[FOLLOWUP] Sent: 0')
    process.exit(0)
  }

  // ── Launch browser ───────────────────────────────────────────────────────────


  const PROXY_URL = process.env.PROXY_URL || account.proxy_url || null
  if (!PROXY_URL) {
    console.error('[FOLLOWUP] ❌ PROXY_URL no configurado — abortando para evitar ban de IP de datacenter.')
    process.exit(1)
  }
  const proxy     = parseProxy(PROXY_URL)

  const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  if (proxy?.server) launchArgs.push(`--proxy-server=${proxy.server}`)

  const browser = await chromium.launch({ headless: true, args: launchArgs })
  const context = await browser.newContext(randomContextOptions(proxy ?? undefined))
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

      // Personalize message: replace [Nombre] with lead's first name
      const firstName = lead.full_name?.split(' ')[0] ?? 'estimado/a'
      const personalizedMessage = followUpMessage.replace(/\[Nombre\]/gi, firstName)

      try {
        const outcome = await sendFollowUp(page, lead, personalizedMessage)

        if (outcome === 'captcha') {
          console.error('[FOLLOWUP] ⛔ Captcha — stopping.')
          await supabase.from('linkedin_accounts').update({ status: 'rate_limited' }).eq('id', account.id)
          process.exitCode = 2
          break
        }

        if (outcome === 'sent') {
          if (LIVE_SEND) {
            await recordFollowUp(lead, personalizedMessage)
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
