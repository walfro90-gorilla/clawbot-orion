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
import { generateFollowUpMessage, fetchPlaybookExamples } from './ai.js'

dotenv.config()
chromium.use(StealthPlugin())

const CAMPAIGN_ID    = process.env.CAMPAIGN_ID
const DRY_RUN        = process.env.DRY_RUN !== 'false'
const LIVE_SEND      = process.env.LIVE_SEND === 'true'
const FOLLOW_UP_STEP = parseInt(process.env.FOLLOW_UP_STEP ?? '1') // 1, 2, or 3

const MAX_FOLLOWUPS_PER_RUN = 4   // máx follow-ups por ejecución (anti-ban)
// Cap diario GLOBAL — cuenta todos los tipos de follow-up juntos para no saturar la cuenta.
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
      id, name, follow_up_paused,
      follow_up_message,        follow_up_delay_days,
      follow_up_step2_message,  follow_up_step2_delay_hours,
      follow_up_step3_message,  follow_up_step3_delay_hours,
      follow_up_step4_message,  follow_up_step4_delay_hours,
      follow_up_step5_message,  follow_up_step5_delay_hours,
      auto_reply_mode, auto_reply_delay_min, auto_reply_delay_max,
      ai_tone, ai_sender_persona, ai_company_context, ai_example_messages,
      linkedin_account_id,
      linkedin_accounts (
        id, label, li_at_cookie, proxy_url, status, cal_com_url
      )
    `)
    .eq('id', CAMPAIGN_ID)
    .eq('is_active', true)
    .single()

  if (error || !data) throw new Error(`Campaign not found: ${error?.message}`)
  if (data.follow_up_paused) throw new Error('Follow-up paused for this campaign — skipping.')

  const isAiMode = data.auto_reply_mode && data.auto_reply_mode !== 'manual'

  // Static templates required in manual mode.
  // In AI mode, templates are optional (Gemini generates if missing).
  if (!isAiMode) {
    const templateByStep = [null, data.follow_up_message, data.follow_up_step2_message,
      data.follow_up_step3_message, data.follow_up_step4_message, data.follow_up_step5_message]
    if (!templateByStep[FOLLOW_UP_STEP]) {
      throw new Error(`No follow_up_step${FOLLOW_UP_STEP}_message set and auto_reply_mode=manual — skipping.`)
    }
  }

  return data
}

// ── Load leads eligible for follow-up ────────────────────────────────────────
async function loadFollowupLeads(campaign) {
  // ── Step config: status, timestamp ref, delay hours, "already sent" guard ───
  const STEP_CONFIG = {
    1: { status: 'connected',          refField: 'connected_at',      delayHours:  0.17,  guardField: null,               nextGuard: null              }, // 10 min min
    2: { status: 'follow_up_sent',     refField: 'last_followup_at',  delayHours: campaign.follow_up_step2_delay_hours ?? 15, guardField: 'last_followup2_at', nextGuard: null },
    3: { status: 'follow_up_sent_2',   refField: 'last_followup2_at', delayHours: campaign.follow_up_step3_delay_hours ?? 28, guardField: 'last_followup3_at', nextGuard: null },
    4: { status: 'follow_up_sent_3',   refField: 'last_followup3_at', delayHours: campaign.follow_up_step4_delay_hours ?? 96, guardField: 'last_followup4_at', nextGuard: null },
    5: { status: 'follow_up_sent_4',   refField: 'last_followup4_at', delayHours: campaign.follow_up_step5_delay_hours ?? 84, guardField: 'last_followup5_at', nextGuard: null },
  }

  const cfg = STEP_CONFIG[FOLLOW_UP_STEP]
  if (!cfg) throw new Error(`Invalid FOLLOW_UP_STEP=${FOLLOW_UP_STEP}`)

  const delayMs = cfg.delayHours * 60 * 60 * 1000
  const cutoff  = new Date(Date.now() - delayMs).toISOString()

  console.log(`[FOLLOWUP] Step ${FOLLOW_UP_STEP} — delay=${cfg.delayHours}h — ref=${cfg.refField} — cutoff=${new Date(cutoff).toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}`)

  let query = supabase
    .from('leads')
    .select('id, full_name, linkedin_url, connected_at, sent_at, status, last_followup_at, last_followup2_at, last_followup3_at, last_followup4_at, last_followup5_at, profile_data')
    .eq('campaign_id', CAMPAIGN_ID)
    .eq('status', cfg.status)
    .not(cfg.refField, 'is', null)      // ref timestamp must exist
    .lte(cfg.refField, cutoff)          // enough time has passed
    .limit(50)

  // Guard: don't re-send if this step was already sent
  if (cfg.guardField) {
    query = query.is(cfg.guardField, null)
  }

  const { data: rawLeads, error } = await query
  if (error) throw new Error(`Could not load leads: ${error.message}`)
  if (!rawLeads?.length) return []

  // Shuffle to avoid predictable FIFO pattern (anti-fingerprinting)
  const leads = rawLeads.sort(() => Math.random() - 0.5).slice(0, 20)

  // For step 1 only: double-check no follow_up_sent event already exists
  // (guards against duplicate sends if status update lagged)
  let alreadySentLeadIds = new Set()

  if (FOLLOW_UP_STEP === 1) {
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
  // Reset at MX midnight (UTC-6 = 06:00 UTC). Using UTC midnight would cause evening
  // sends (e.g. 7 PM MX = 01:00 UTC next day) to wrongly count toward the next day.
  const todayStart = new Date()
  todayStart.setUTCHours(6, 0, 0, 0)  // 06:00 UTC = 00:00 MX (UTC-6, no DST since 2023)
  if (new Date().getUTCHours() < 6) todayStart.setUTCDate(todayStart.getUTCDate() - 1)

  const { count: sentToday } = await supabase
    .from('conversation_events')
    .select('id', { count: 'exact', head: true })
    .in('event_type', ['follow_up_sent', 'follow_up_sent_2', 'follow_up_sent_3', 'follow_up_sent_4', 'follow_up_sent_5'])
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
// ── Fetch initial invite + previous FU messages for AI context ──────────────
async function fetchConversationContext(leadId) {
  const { data: conv } = await supabase
    .from('conversations')
    .select('id')
    .eq('lead_id', leadId)
    .maybeSingle()

  if (!conv?.id) return { inviteMessage: null, previousFollowUps: [] }

  const { data: events } = await supabase
    .from('conversation_events')
    .select('event_type, content, sent_at')
    .eq('conversation_id', conv.id)
    .in('event_type', ['invite_sent', 'follow_up_sent', 'follow_up_sent_2', 'follow_up_sent_3'])
    .order('sent_at', { ascending: true })

  const inviteMessage    = events?.find(e => e.event_type === 'invite_sent')?.content ?? null
  const previousFollowUps = (events ?? [])
    .filter(e => ['follow_up_sent', 'follow_up_sent_2', 'follow_up_sent_3'].includes(e.event_type))
    .map(e => e.content ?? '')

  return { inviteMessage, previousFollowUps }
}

async function recordFollowUp(lead, message, aiGenerated = false) {
  const accountId = process.env.ACCOUNT_ID_RESOLVED
  const now = new Date().toISOString()

  // Map step → event type, new status, timestamp field
  const STEP_MAP = {
    1: { eventType: 'follow_up_sent',   newStatus: 'follow_up_sent',   tsField: 'last_followup_at'  },
    2: { eventType: 'follow_up_sent_2', newStatus: 'follow_up_sent_2', tsField: 'last_followup2_at' },
    3: { eventType: 'follow_up_sent_3', newStatus: 'follow_up_sent_3', tsField: 'last_followup3_at' },
    4: { eventType: 'follow_up_sent_4', newStatus: 'follow_up_sent_4', tsField: 'last_followup4_at' },
    5: { eventType: 'follow_up_sent_5', newStatus: 'follow_up_sent_5', tsField: 'last_followup5_at' },
  }
  const { eventType, newStatus, tsField } = STEP_MAP[FOLLOW_UP_STEP] ?? STEP_MAP[1]

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
    ai_generated:    aiGenerated,
  })

  const { error: leadErr } = await supabase.from('leads').update({
    status:    newStatus,
    [tsField]: now,
  }).eq('id', lead.id)

  if (leadErr) {
    console.error(`[FOLLOWUP] ❌ Failed to update lead status for "${lead.full_name}": ${leadErr.message}`)
  } else {
    console.log(`[FOLLOWUP] ✅ Recorded ${eventType} → ${newStatus} for "${lead.full_name}"`)
  }
}

// ── Find the message compose textarea — handles all LinkedIn UI variants ──────
// LinkedIn has multiple layouts: overlay bubble, /messaging/thread/ page, /messaging/ page.
// All have different selectors. This function tries all of them with fallbacks.
async function findComposeTextarea(page) {
  // Log all contenteditable elements for debugging
  async function dumpEditables() {
    const els = await page.locator('[contenteditable="true"], textarea').all()
    const info = []
    for (const el of els.slice(0, 10)) {
      const box = await el.boundingBox().catch(() => null)
      const label = await el.getAttribute('aria-label').catch(() => '')
      const ph = await el.getAttribute('data-placeholder').catch(() => '') || await el.getAttribute('placeholder').catch(() => '')
      const cls = (await el.getAttribute('class').catch(() => '')).slice(0, 60)
      if (box) info.push(`[y=${Math.round(box.y)} w=${Math.round(box.width)} h=${Math.round(box.height)} label="${label}" ph="${ph}" cls="${cls}"]`)
    }
    return info.join(' | ')
  }

  // Strategy 0: LinkedIn chat overlay bubble (opens on profile page when clicking Mensaje)
  const overlayCandidates = [
    '.msg-overlay-conversation-bubble--is-active [contenteditable="true"]',
    // Also try without --is-active: works when overlay opened but active class delayed
    '.msg-overlay-conversation-bubble [contenteditable="true"]',
    '.msg-overlay-list-bubble [contenteditable="true"]',
    '[class*="msg-overlay"][class*="active"] [contenteditable="true"]',
    '[class*="msg-overlay"] [contenteditable="true"]',
    '[class*="msg-form"] [contenteditable="true"]',
    '[class*="msg-convo"] [contenteditable="true"]',
    '.msg-form__contenteditable',
  ]
  for (const sel of overlayCandidates) {
    const el = page.locator(sel).last()
    if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log(`[FOLLOWUP] Textarea found via overlay selector: ${sel}`)
      return el
    }
  }

  // Strategy 1: contenteditable with aria-label/placeholder — covers most new UI variants
  // Also includes <textarea> elements LinkedIn uses in some views
  const byAttr = page.locator(
    '[contenteditable="true"][aria-label], ' +
    '[contenteditable="true"][data-placeholder], ' +
    '[contenteditable="true"][placeholder], ' +
    'textarea[placeholder*="mensaje" i], ' +
    'textarea[placeholder*="message" i], ' +
    'textarea[aria-label*="mensaje" i]'
  ).first()
  if (await byAttr.isVisible({ timeout: 4000 }).catch(() => false)) return byAttr

  // Strategy 2: /messaging/ thread or compose page — reply box at bottom
  if (page.url().includes('/messaging/')) {
    // Wait a bit more for the thread to fully render after conversation click
    await page.waitForTimeout(1500)

    const threadReplySelectors = [
      '.msg-form__contenteditable',
      '[class*="msg-form"] [contenteditable="true"]',
      '[class*="msg-form"] textarea',
      '[class*="reply"] [contenteditable="true"]',
      'div.editor-content[contenteditable="true"]',
      // New LinkedIn UI uses these:
      '[data-artdeco-is-focused] [contenteditable]',
      '.scaffold-layout__detail [contenteditable="true"]',
      '.msg-thread-composer [contenteditable="true"]',
    ]
    for (const sel of threadReplySelectors) {
      const el = page.locator(sel).last()
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log(`[FOLLOWUP] Textarea found via thread selector: ${sel}`)
        return el
      }
    }

    // Fallback: any contenteditable in the lower half — log all for debugging
    const debugInfo = await dumpEditables()
    console.log(`[FOLLOWUP] /messaging/ editables: ${debugInfo || '(none found)'}`)

    const allEditable = await page.locator('[contenteditable="true"], textarea').all()
    for (const el of allEditable.reverse()) {
      const box = await el.boundingBox().catch(() => null)
      if (box && box.y > 200 && box.width > 100) {
        const visible = await el.isVisible().catch(() => false)
        if (visible) {
          console.log(`[FOLLOWUP] Textarea found via y-position fallback (y=${Math.round(box.y)})`)
          return el
        }
      }
    }
    console.warn(`[FOLLOWUP] No messaging textarea found on /messaging/ page.`)
  }

  // Strategy 3: broadest fallback — any visible contenteditable or textarea
  const allEditable = page.locator('[contenteditable="true"], textarea')
  const count = await allEditable.count().catch(() => 0)
  for (let i = count - 1; i >= 0; i--) {
    const el = allEditable.nth(i)
    const box = await el.boundingBox().catch(() => null)
    if (box && box.width > 80 && box.height > 12) {
      const visible = await el.isVisible().catch(() => false)
      if (visible) return el
    }
  }

  return null
}

// ── Close any lingering chat overlays from previous leads ────────────────────
async function closeOpenOverlays(page) {
  // Si estamos en cualquier página de mensajería, navegar a feed PRIMERO.
  // Esto limpia el estado de LinkedIn para que el siguiente "Mensaje" abra
  // el thread correcto y no el último visitado (el aria-label bug del thread page).
  const currentUrl = page.url()
  if (currentUrl.includes('/messaging/') || currentUrl.includes('/messaging')) {
    console.log(`[FOLLOWUP] 🔄 Reseteando estado de messaging — navegando a feed para limpiar contexto`)
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 20000 })
      .catch(() => {})
    await page.waitForTimeout(randInt(1500, 2500))
    return // feed limpio — no hay overlays que cerrar
  }

  // Press Escape first to dismiss any active overlay
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(400)

  // Click close (×) buttons on all visible overlay bubbles
  const closeBtnSelectors = [
    '.msg-overlay-bubble-header__controls button[aria-label*="close" i]',
    '.msg-overlay-bubble-header__controls button[aria-label*="Close" i]',
    '.msg-overlay-bubble-header__controls button[aria-label*="cerrar" i]',
    '.msg-overlay-bubble-header__controls button[aria-label*="Cerrar" i]',
    '.msg-overlay-bubble-header__controls button',
  ]
  for (const sel of closeBtnSelectors) {
    const btns = page.locator(sel)
    const cnt = await btns.count().catch(() => 0)
    for (let i = cnt - 1; i >= 0; i--) {
      if (await btns.nth(i).isVisible({ timeout: 300 }).catch(() => false)) {
        await btns.nth(i).click().catch(() => {})
        await page.waitForTimeout(200)
      }
    }
    if (cnt > 0) break
  }
}

// ── Navigate to profile and send message ─────────────────────────────────────
async function sendFollowUp(page, lead, message) {
  const profileUrl = lead.linkedin_url.endsWith('/')
    ? lead.linkedin_url
    : lead.linkedin_url + '/'

  console.log(`[FOLLOWUP] Navigating to ${lead.full_name} → ${profileUrl}`)

  // Close any lingering overlays from the previous lead before navigating
  await closeOpenOverlays(page)

  // Use networkidle so React finishes rendering action buttons
  await page.goto(profileUrl, { waitUntil: 'networkidle', timeout: 45000 })
    .catch(() => page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }))

  // Checkpoint / captcha detection
  if (page.url().includes('/checkpoint') || page.url().includes('/challenge')) {
    console.error('[FOLLOWUP] ⛔ Checkpoint detected — aborting.')
    return 'captcha'
  }

  // Wait for the profile top section to be present (LinkedIn renders it early)
  await page.waitForSelector('main, .scaffold-layout__main, #main', { timeout: 10000 }).catch(() => null)
  await page.waitForTimeout(randInt(2000, 3500))

  // Scroll down slightly to trigger lazy rendering of action buttons — but NOT too far
  // (over-scrolling causes the page to show activity feed where spurious "Mensaje" buttons exist)
  await page.evaluate(() => window.scrollBy(0, 150))
  await page.waitForTimeout(randInt(800, 1500))

  // Scroll BACK to top so the profile action buttons are in the viewport
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(randInt(500, 800))

  // ── Attempt A: find "Message" button on profile page ─────────────────────
  let clickedMessage = false

  // Dump all visible buttons first for debugging
  async function dumpButtons() {
    const btns = await page.locator('button, a[role="button"]').all()
    const info = []
    for (const b of btns.slice(0, 25)) {
      const txt   = (await b.textContent().catch(() => '')).trim().slice(0, 60)
      const label = (await b.getAttribute('aria-label').catch(() => '')).trim().slice(0, 60)
      const vis   = await b.isVisible().catch(() => false)
      if (vis && (txt || label)) info.push(`[${txt || label}]`)
    }
    return info.join(' | ')
  }

  // Strategy A1: profile action buttons — scoped to top 600px to avoid scrolled-in activity feed
  // "Mensajes" in the nav bar and activity "Mensaje" buttons must be excluded
  const profileActionArea = page.locator([
    '.pv-top-card',
    '.pvs-profile-actions',
    '[class*="profile-top-card"]',
    '[class*="pv-top-card"]',
    '.ph5.pb5',
  ].join(', ')).first()

  const msgTextPatterns = ['Mensaje', 'Message', 'Enviar mensaje', 'Send message', 'Mensagem']

  for (const txt of msgTextPatterns) {
    // Search within profile area first (avoids nav "Mensajes" link)
    let loc = profileActionArea.locator(
      `button:has-text("${txt}"), a:has-text("${txt}"), [role="button"]:has-text("${txt}")`
    ).first()
    if (!await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Fallback: exact text match only — "Mensaje" won't match "Mensajes"
      loc = page.locator(`button:text-is("${txt}"), [role="button"]:text-is("${txt}")`).first()
    }
    if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
      await loc.click()
      clickedMessage = true
      console.log(`[FOLLOWUP] ✓ Message button found: text="${txt}"`)
      break
    }
  }

  // Strategy A2: aria-label variants
  if (!clickedMessage) {
    const loc = page.locator([
      'button[aria-label*="Mensaje" i]',
      'button[aria-label*="Message" i]',
      'button[aria-label*="Enviar" i]',
      'a[aria-label*="Mensaje" i]',
      'a[aria-label*="Message" i]',
      '[data-control-name="message"]',
    ].join(', ')).first()
    if (await loc.isVisible({ timeout: 3000 }).catch(() => false)) {
      await loc.click()
      clickedMessage = true
      console.log(`[FOLLOWUP] ✓ Message button found via aria-label`)
    }
  }

  // Strategy A3: direct messaging link
  if (!clickedMessage) {
    const loc = page.locator('a[href*="/messaging/"]').first()
    if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
      await loc.click()
      clickedMessage = true
      console.log(`[FOLLOWUP] ✓ Message link found (href)`)
    }
  }

  // Strategy A4: "More actions" (...) dropdown may hide the Message option
  if (!clickedMessage) {
    const moreSelectors = [
      'button[aria-label*="More" i]',
      'button[aria-label*="Más" i]',
      'button[aria-label*="Acciones" i]',
      '[data-control-name="overflow"]',
    ]
    const moreBtn = page.locator(moreSelectors.join(', ')).first()
    if (await moreBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await moreBtn.click()
      await page.waitForTimeout(1200)
      for (const txt of msgTextPatterns) {
        const opt = page.locator(`[role="menuitem"]:has-text("${txt}"), li:has-text("${txt}")`).first()
        if (await opt.isVisible({ timeout: 2000 }).catch(() => false)) {
          await opt.click()
          clickedMessage = true
          console.log(`[FOLLOWUP] ✓ Message found in "More" dropdown`)
          break
        }
      }
      if (!clickedMessage) await page.keyboard.press('Escape').catch(() => {})
    }
  }

  // ── Attempt B: search existing conversation on /messaging/ ───────────────
  // For FU2+ leads already have an existing thread — search it directly.
  // Even for FU1, this finds the right person via the conversation search box.
  if (!clickedMessage) {
    const btnLog = await dumpButtons()
    console.log(`[FOLLOWUP] Profile button not found — buttons: ${btnLog || '(none)'}`)
    console.log(`[FOLLOWUP] Trying /messaging/ conversation search for "${lead.full_name}"`)

    await page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'networkidle', timeout: 30000 })
      .catch(() => page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}))
    await page.waitForTimeout(randInt(2000, 3500))

    // Search by full name to avoid matching message content (e.g. "Fernando" in another thread's text)
    const searchQuery = lead.full_name ?? ''
    const firstName   = searchQuery.split(' ')[0]

    // Step B1: Search existing conversations by FULL NAME (search box in left panel)
    const convSearchSelectors = [
      'input[placeholder*="Buscar mensajes" i]',
      'input[placeholder*="Search messages" i]',
      'input[aria-label*="Buscar" i]',
      'input[aria-label*="Search" i]',
      '.msg-connections-typeahead__search-bar input',
      '.msg-search-form__search-bar input',
    ]
    const convSearch = page.locator(convSearchSelectors.join(', ')).first()
    if (await convSearch.isVisible({ timeout: 5000 }).catch(() => false)) {
      await convSearch.click()
      await page.waitForTimeout(500)
      await convSearch.fill(searchQuery)  // full name — more specific than first name
      await page.waitForTimeout(2000)

      // Verify each result's name before clicking — avoid wrong conversations
      const convItems = page.locator([
        'li.msg-conversation-listitem',
        '[class*="msg-conversation-listitem"]',
        '[data-test-id*="conversation"]',
        '.msg-conversations-container__conversations-list li',
        '[class*="conversationItem"]',
        '[class*="conversation-item"]',
      ].join(', '))

      const count = await convItems.count().catch(() => 0)
      for (let i = 0; i < Math.min(count, 5); i++) {
        const item = convItems.nth(i)
        if (!await item.isVisible({ timeout: 1000 }).catch(() => false)) continue
        const itemText = (await item.textContent().catch(() => '')).toLowerCase()
        if (itemText.includes(firstName.toLowerCase())) {
          await item.click()
          await page.waitForTimeout(randInt(1500, 2500))
          clickedMessage = true
          console.log(`[FOLLOWUP] ✓ Opened existing conversation via /messaging/ search for "${lead.full_name}"`)
          break
        }
      }
      if (!clickedMessage) console.log(`[FOLLOWUP] No matching conversation found for "${lead.full_name}" in search results`)
    }

    // Step B2: fallback — click compose and search for recipient (new message)
    if (!clickedMessage) {
      console.log(`[FOLLOWUP] Conversation search failed — trying compose new message for "${lead.full_name}"`)
      const composeSelectors = [
        'button[aria-label*="Compose" i]',
        'button[aria-label*="Redact" i]',
        'button[aria-label*="Nuevo" i]',
        'button[aria-label*="Nueva" i]',
        'button[aria-label*="Redactar" i]',
        'button:has-text("Nuevo mensaje")',
        'button:has-text("New message")',
        '.msg-overlay-bubble-header__controls button',
      ]
      const composeBtn = page.locator(composeSelectors.join(', ')).first()
      if (await composeBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
        await composeBtn.click()
        await page.waitForTimeout(1500)

        const recipientInput = page.locator('input[placeholder*="Search" i], input[placeholder*="Buscar" i], input[aria-label*="recipient" i], input[aria-label*="destinatario" i]').first()
        if (await recipientInput.isVisible({ timeout: 4000 }).catch(() => false)) {
          await recipientInput.fill(firstName)
          await page.waitForTimeout(2000)

          const result = page.locator('[class*="type-ahead"] li, [role="option"], [class*="autocomplete"] li, [class*="typeahead"] li').first()
          if (await result.isVisible({ timeout: 3000 }).catch(() => false)) {
            await result.click()
            await page.waitForTimeout(1000)
            clickedMessage = true
            console.log(`[FOLLOWUP] ✓ Opened via compose-new for "${lead.full_name}"`)
          }
        }
      }
    }
  }

  if (!clickedMessage) {
    const btnLog = await dumpButtons()
    console.warn(`[FOLLOWUP] ⚠️  No message button for "${lead.full_name}". Page: ${page.url()} | Buttons: ${btnLog || '(none)'}`)
    return 'no_button'
  }

  // Wait for navigation or overlay to appear
  await page.waitForTimeout(randInt(1500, 2500))
  const afterClickUrl = page.url()
  console.log(`[FOLLOWUP] After click — URL: ${afterClickUrl}`)

  // 3 possible outcomes after clicking Message:
  // A) URL stays at /in/xxx/  → overlay bubble opened on profile page
  // B) URL changed to /messaging/thread/xxx/ → full thread page navigation
  // C) URL changed to /messaging/ → messaging home
  const isOverlayMode = afterClickUrl.includes('/in/')
  const isThreadPage  = afterClickUrl.includes('/messaging/thread/')

  // B) Full thread page — verify it belongs to our lead, store thread ID, wait for render
  if (isThreadPage) {
    const threadId = afterClickUrl.split('/messaging/thread/')[1]?.replace(/\//g, '')
    console.log(`[FOLLOWUP] Thread page mode — thread ID: ${threadId ?? 'unknown'}`)

    // Wait for thread header to render so we can verify the contact name
    await page.waitForSelector('h2, h3, [class*="thread"] [class*="name"], [class*="participant"]', { timeout: 8000 }).catch(() => null)
    await page.waitForTimeout(1500)

    // Verify this thread belongs to our lead (not a previously open conversation).
    // Se leen múltiples selectores hasta encontrar el nombre del participante.
    const expectedFirst = lead.full_name.split(' ')[0].toLowerCase()
    const threadHeaderSelectors = [
      '.msg-entity-lockup__entity-title',
      '.msg-thread-top-bar-contact-info .t-bold',
      '.msg-thread-detail__header .t-bold',
      '.msg-thread-participant-list__participant-name',
      'h2[class*="msg"], h3[class*="msg"]',
      '[class*="thread"] h2, [class*="thread"] h3',
      'h2, h3',
    ]
    let headerText = ''
    for (const sel of threadHeaderSelectors) {
      const el = page.locator(sel).first()
      if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
        const txt = (await el.textContent().catch(() => '')).trim()
        if (txt.length > 2) { headerText = txt; break }
      }
    }
    const headerLower = headerText.toLowerCase()
    // Requiere coincidencia POSITIVA del nombre — sin bypass para header vacío
    // Si no se puede leer el header, asumir incorrecto y hacer fallback search
    const correctThread = headerLower.length > 0 && headerLower.includes(expectedFirst)

    if (!correctThread) {
      if (headerLower.length > 0) {
        console.warn(`[FOLLOWUP] ⚠️  Thread header "${headerText}" no coincide con "${lead.full_name}" — buscando en /messaging/`)
      } else {
        console.warn(`[FOLLOWUP] ⚠️  No se pudo leer el header del thread para "${lead.full_name}" — buscando en /messaging/ como medida de seguridad`)
      }
      // Navigate to /messaging/ and search for the lead's actual conversation
      await page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'networkidle', timeout: 30000 })
        .catch(() => page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}))
      await page.waitForTimeout(randInt(2000, 3000))

      const convSearchSelectors = [
        'input[placeholder*="Buscar mensajes" i]',
        'input[placeholder*="Search messages" i]',
        'input[aria-label*="Buscar" i]',
        'input[aria-label*="Search" i]',
      ]
      const convSearch = page.locator(convSearchSelectors.join(', ')).first()
      if (await convSearch.isVisible({ timeout: 5000 }).catch(() => false)) {
        await convSearch.click()
        await page.waitForTimeout(500)
        await convSearch.fill(lead.full_name)
        await page.waitForTimeout(2000)

        const convItems = page.locator([
          'li.msg-conversation-listitem',
          '[class*="msg-conversation-listitem"]',
          '.msg-conversations-container__conversations-list li',
        ].join(', '))
        const cnt = await convItems.count().catch(() => 0)
        for (let i = 0; i < Math.min(cnt, 5); i++) {
          const item = convItems.nth(i)
          if (!await item.isVisible({ timeout: 1000 }).catch(() => false)) continue
          const txt = (await item.textContent().catch(() => '')).toLowerCase()
          if (txt.includes(lead.full_name.split(' ')[0].toLowerCase())) {
            await item.click()
            await page.waitForTimeout(randInt(1500, 2500))
            clickedMessage = true
            console.log(`[FOLLOWUP] ✓ Found correct conversation for "${lead.full_name}" via /messaging/ search`)
            break
          }
        }
      }
      if (!clickedMessage) {
        console.warn(`[FOLLOWUP] ⚠️  Could not find "${lead.full_name}" conversation in /messaging/`)
      }
    } else {
      if (threadId) {
        const { data: conv } = await supabase.from('conversations')
          .select('id').eq('lead_id', lead.id).maybeSingle()
        if (conv?.id) {
          await supabase.from('conversations')
            .update({ linkedin_thread_id: threadId }).eq('id', conv.id)
          console.log(`[FOLLOWUP] ✓ Thread ID stored in DB for "${lead.full_name}"`)
        }
      }
      // Scroll to bottom of thread to reveal reply box, then wait for it
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await page.waitForSelector(
        '.msg-form__contenteditable, [class*="msg-form"] [contenteditable="true"], [class*="msg-form"] textarea',
        { timeout: 12000, state: 'visible' }
      ).catch(() => null)
      await page.waitForTimeout(randInt(1500, 2500))
    }
  }

  if (isOverlayMode) {
    console.log(`[FOLLOWUP] Overlay mode — waiting for overlay bubble to render...`)

    // Wait ONLY for the actual overlay bubble, NOT any contenteditable (nav search matches too early)
    const overlayAppeared = await page.waitForSelector(
      '.msg-overlay-conversation-bubble, .msg-overlay-list-bubble, [class*="msg-overlay-conversation"], [class*="msg-overlay-list"]',
      { timeout: 10000, state: 'visible' }
    ).catch(() => null)

    if (!overlayAppeared) {
      // Overlay didn't appear — try clicking the button again
      console.log(`[FOLLOWUP] Overlay not visible after 10s — retrying button click...`)
      for (const txt of ['Mensaje', 'Message', 'Enviar mensaje']) {
        const btn = page.locator(`button:text-is("${txt}"), [role="button"]:text-is("${txt}")`).first()
        if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await btn.click()
          console.log(`[FOLLOWUP] Retried button click: "${txt}"`)
          break
        }
      }
      await page.waitForSelector(
        '.msg-overlay-conversation-bubble, .msg-overlay-list-bubble, [class*="msg-overlay-conversation"]',
        { timeout: 8000, state: 'visible' }
      ).catch(() => null)
    }

    await page.waitForTimeout(randInt(1500, 2500))

    // If overlay is minimized, click to expand it
    const minimized = page.locator(
      '.msg-overlay-conversation-bubble--is-minimized, [class*="msg-overlay"][class*="minimized"]'
    ).first()
    if (await minimized.isVisible({ timeout: 1000 }).catch(() => false)) {
      console.log(`[FOLLOWUP] Overlay minimized — clicking to expand...`)
      await minimized.click()
      await page.waitForTimeout(1000)
    }

    // Click inside the overlay body to ensure it's expanded and focused
    const overlayBody = page.locator(
      '.msg-overlay-conversation-bubble__content, .msg-overlay-conversation-bubble, .msg-overlay-list-bubble'
    ).last()
    if (await overlayBody.isVisible({ timeout: 3000 }).catch(() => false)) {
      await overlayBody.click({ position: { x: 100, y: 60 } }).catch(() => {})
      await page.waitForTimeout(800)
    }
  }

  // Find compose textarea using multi-strategy function
  const textarea = await findComposeTextarea(page)

  if (!textarea) {
    // Last resort: press Escape (dismiss any modal) and retry
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1000)
    const retryTextarea = await findComposeTextarea(page)
    if (!retryTextarea) {
      console.warn(`[FOLLOWUP] ⚠️  Compose textarea not found for "${lead.full_name}" after all strategies.`)
      await page.screenshot({ path: `debug_followup_${lead.id?.slice(0,8)}.png` }).catch(() => {})
      return 'error'
    }
    if (!await verifyCorrectOverlay(page, lead)) return 'error'
    await typeAndSend(page, retryTextarea, lead, message)
    // Reset messaging state — navegar a feed para que el siguiente lead empiece limpio
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(randInt(1000, 2000))
    return 'sent'
  }

  if (!await verifyCorrectOverlay(page, lead)) return 'error'
  await typeAndSend(page, textarea, lead, message)
  // Reset messaging state — navegar a feed para que el siguiente lead empiece limpio
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(randInt(1000, 2000))
  return 'sent'
}

// ── Guard: verify the open overlay/thread belongs to the intended lead ────────
// Prevents sending message to the wrong person when a previous overlay is still open.
async function verifyCorrectOverlay(page, lead) {
  const expectedFirst = lead.full_name.split(' ')[0].toLowerCase()

  // Selectores ordenados: overlay primero, luego thread page, luego genéricos
  const headerSelectors = [
    '.msg-overlay-bubble-header__title',
    '.msg-overlay-conversation-bubble__header h2',
    '[class*="msg-overlay"] h2',
    '[class*="msg-overlay"] h3',
    // Thread page selectors
    '.msg-entity-lockup__entity-title',
    '.msg-thread-top-bar-contact-info .t-bold',
    '.msg-thread-detail__header .t-bold',
    '.msg-thread-participant-list__participant-name',
    '[class*="thread-detail"] h2',
    '[class*="thread-detail"] h3',
    'h2.t-16',
    // Fallback genérico — solo si hay texto corto (nombre de persona)
    'h2',
  ]

  for (const sel of headerSelectors) {
    const el = page.locator(sel).first()
    if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
      const text = (await el.textContent().catch(() => '')).trim().toLowerCase()
      if (!text || text.length < 2) continue  // elemento vacío — intentar siguiente
      // Ignorar "Mensajería", "Messaging", page-level titles
      if (/^(mensajer[ií]a|messaging|messages?|inbox|notificaci)$/i.test(text)) continue

      if (!text.includes(expectedFirst)) {
        console.error(`[FOLLOWUP] ❌ Thread/overlay incorrecto! Header="${text}" — esperado "${lead.full_name}" — ABORTANDO envío.`)
        await page.screenshot({ path: `debug_followup_wrongoverlay_${lead.id?.slice(0,8)}.png` }).catch(() => {})
        await closeOpenOverlays(page)
        return false
      }
      console.log(`[FOLLOWUP] ✓ Header verificado: "${text}" coincide con "${lead.full_name}"`)
      return true
    }
  }

  // Ningún header encontrado — NO permitir envío ciegamente.
  // Loguear como advertencia pero dejar pasar solo si la URL corresponde al perfil del lead.
  const currentUrl = page.url()
  const profileId = lead.linkedin_url?.split('/in/')?.[1]?.replace(/\//g, '') ?? ''
  if (profileId && currentUrl.includes(profileId)) {
    console.log(`[FOLLOWUP] ℹ️  No se encontró header de overlay pero URL corresponde al perfil de "${lead.full_name}" — permitiendo`)
    return true
  }

  console.warn(`[FOLLOWUP] ⚠️  No se pudo verificar el header para "${lead.full_name}" (URL: ${currentUrl}) — abortando por seguridad`)
  return false
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

  const isAiMode = campaign.auto_reply_mode && campaign.auto_reply_mode !== 'manual'
  const calUrl   = account.cal_com_url ?? null

  // Static template by step (fallback when AI mode is off or AI fails)
  const TEMPLATE_BY_STEP = {
    1: campaign.follow_up_message,
    2: campaign.follow_up_step2_message,
    3: campaign.follow_up_step3_message,
    4: campaign.follow_up_step4_message,
    5: campaign.follow_up_step5_message,
  }
  const staticFollowUpMessage = TEMPLATE_BY_STEP[FOLLOW_UP_STEP] ?? null

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
  let page = await context.newPage()

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
    // Pre-fetch playbook examples once per run (same for all leads in this batch)
    const playbookExamples = isAiMode
      ? await fetchPlaybookExamples({ turnNumber: FOLLOW_UP_STEP - 1 })
      : ''

    for (const lead of leads) {
      console.log(`\n[FOLLOWUP] ─── ${lead.full_name} (${sentCount + 1}/${leads.length}) ───`)

      // Resolve message: AI-generated or static template
      let messageToSend = staticFollowUpMessage
      let aiGenerated = false

      // If static template exists, use it (templates take priority over AI for FU sequence)
      if (staticFollowUpMessage) {
        const firstName = lead.full_name?.split(' ')[0] ?? 'estimado/a'
        messageToSend = staticFollowUpMessage
          .replace(/\[Nombre\]/gi, firstName)
          .replace(/\[LINK_AGENDA\]/gi, calUrl ?? 'https://cal.com')
          .replace(/\[LINK CALENDLY O GHL\]/gi, calUrl ?? 'https://cal.com')
        aiGenerated = false
        console.log(`[FOLLOWUP] 📝 Template FU${FOLLOW_UP_STEP} personalizado para "${lead.full_name}" (${messageToSend.length} chars)`)
      } else if (isAiMode) {
        // No template → fall back to Gemini
        try {
          const { inviteMessage, previousFollowUps } = await fetchConversationContext(lead.id)
          messageToSend = await generateFollowUpMessage({
            leadName:          lead.full_name,
            leadProfileData:   lead.profile_data ?? {},
            inviteMessage,
            previousFollowUps,
            followUpStep:      FOLLOW_UP_STEP,
            calUrl,
            aiTone:            campaign.ai_tone ?? 'casual',
            senderPersona:     campaign.ai_sender_persona ?? null,
            companyContext:    campaign.ai_company_context ?? null,
            exampleMessages:   campaign.ai_example_messages ?? null,
            playbookExamples,
          })
          aiGenerated = true
          console.log(`[FOLLOWUP] 🤖 AI FU${FOLLOW_UP_STEP} generado (${messageToSend.length} chars)`)
        } catch (aiErr) {
          console.error(`[FOLLOWUP] ⚠️  AI generation failed for "${lead.full_name}": ${aiErr.message}`)
          console.error('[FOLLOWUP] No template and AI failed — skipping lead.')
          errorCount++
          continue
        }
      } else {
        console.error(`[FOLLOWUP] No template for step ${FOLLOW_UP_STEP} and AI disabled — skipping lead.`)
        errorCount++
        continue
      }

      try {
        // If page is in a crashed state, open a fresh one before attempting
        const pageIsCrashed = await page.evaluate(() => true).catch(() => true) === true
          ? false : true
        if (pageIsCrashed || page.isClosed()) {
          console.log(`[FOLLOWUP] Page crashed/closed — opening fresh page`)
          page = await context.newPage()
          await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
          await page.waitForTimeout(2000)
        }

        const outcome = await sendFollowUp(page, lead, messageToSend)

        if (outcome === 'captcha') {
          console.error('[FOLLOWUP] ⛔ Captcha — stopping.')
          await supabase.from('linkedin_accounts').update({ status: 'rate_limited' }).eq('id', account.id)
          process.exitCode = 2
          break
        }

        if (outcome === 'sent') {
          if (LIVE_SEND) {
            await recordFollowUp(lead, messageToSend, aiGenerated)
            await logActivity(account.id, 'message_sent', { lead_id: lead.id, campaign_id: CAMPAIGN_ID, type: 'follow_up' })
            await incrementDaily(account.id, 'messages_sent')
          }
          sentCount++
        } else {
          errorCount++
        }
      } catch (err) {
        console.error(`[FOLLOWUP] Error on "${lead.full_name}": ${err.message}`)
        // Recover crashed page for next lead
        if (err.message?.includes('crashed') || err.message?.includes('closed') || err.message?.includes('Target closed')) {
          console.log(`[FOLLOWUP] Recovering crashed page...`)
          try { page = await context.newPage() } catch { /* browser itself may be gone */ }
        }
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
