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
import { getOrCreateAccountFingerprint, contextOptionsFromFingerprint, launchPersistentBrowserContext } from './lib/browser.js'
import { humanClick, humanType, varyMessage } from './lib/humanize.js'

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
    sent_via:        process.env.REPLY_SOURCE === 'manual' ? 'orion_manual' : 'orion_auto',
    ai_generated:    process.env.REPLY_SOURCE !== 'manual',
  })

  // Update last_message_at + LIMPIAR DRAFT (solo al confirmar envío exitoso).
  // Si CLEAR_DRAFT_ON_SUCCESS=true (approve-draft flow), también incrementamos
  // conversation_turn. Antes esto lo hacía approve-draft route ANTES de saber
  // si reply.js iba a funcionar, lo cual causaba que la UI mostrara "enviado"
  // aunque reply.js fallara (ej. Message Request sin Accept).
  const conversationUpdate = {
    last_message_at:       new Date().toISOString(),
    last_message_text:     `[Tú]: ${messageText.slice(0, 500)}`,
    ai_reply_draft:        null,
    ai_draft_generated_at: null,
  }
  if (process.env.CLEAR_DRAFT_ON_SUCCESS === 'true') {
    // Solo incrementar turn cuando vino de approve-draft (no de auto-reply,
    // que ya lo hace en otro lugar).
    const { data: convCurrent } = await supabase
      .from('conversations')
      .select('conversation_turn')
      .eq('id', resolvedConvId).single()
    conversationUpdate.conversation_turn = (convCurrent?.conversation_turn ?? 0) + 1
  }
  await supabase.from('conversations').update(conversationUpdate).eq('id', resolvedConvId)

  console.log(`[REPLY] ✓ Recorded reply_sent in conversation_events + draft limpiado`)
}

// ── Type and send message ─────────────────────────────────────────────────────
async function typeAndSend(page, textarea, leadName) {
  // Slight template variation to avoid character-identical messages
  const varied = varyMessage(REPLY_MESSAGE)

  // Click textarea with mouse trajectory (not teleport)
  await humanClick(page, textarea)
  await microDelay()

  // Type with full human rhythm: punctuation pauses, distractions, natural variance
  await humanType(page, varied)
  await sleep(randInt(700, 1500))

  if (!LIVE_SEND || DRY_RUN) {
    console.log(`[REPLY] [STAGING] Typed reply to "${leadName}" — NOT sending (LIVE_SEND=${LIVE_SEND}, DRY_RUN=${DRY_RUN})`)
    console.log(`[REPLY] Preview: "${varied.slice(0, 100)}"`)
    // Playwright has no selectAll() — use Ctrl+A
    await page.keyboard.press('Control+a').catch(() => {})
    await page.keyboard.press('Backspace').catch(() => {})
    return true
  }

  // Click Send with humanized mouse movement
  const sendBtn = page.getByRole('button', { name: /^(send|enviar|submit)$/i }).first()
  const hasSend = await sendBtn.isVisible({ timeout: 5000 }).catch(() => false)
  if (hasSend) {
    await humanClick(page, sendBtn)
  } else {
    // Fallback: Enter key
    await page.keyboard.press('Enter')
  }

  await sleep(randInt(1000, 2000))
  console.log(`[REPLY] ✓ Sent reply to "${leadName}"`)
  return true
}

// ── Detectar y aceptar "Message Request" si el thread lo requiere ─────────────
// Cuando alguien NO conectado (2do/3er grado) te escribe, LinkedIn pone el
// thread en "Solicitudes de mensaje". El textarea no aparece hasta hacer click
// en "Aceptar". Sin esto, reply.js falla con "No textarea found".
async function acceptMessageRequestIfNeeded(page, leadName) {
  // Estrategia 1: button por texto explícito
  const acceptBtnTexts = [
    /^aceptar$/i,
    /^accept$/i,
    /^aceptar mensaje$/i,
    /^accept message$/i,
    /^marcar como conocido$/i,
  ]

  for (const re of acceptBtnTexts) {
    const btn = page.getByRole('button', { name: re }).first()
    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
      console.log(`[REPLY] 📨 Message Request detectado para "${leadName}" — aceptando...`)
      await humanClick(page, btn)
      await sleep(randInt(2500, 4500))   // esperar a que LinkedIn reemplace el banner con el textarea
      return true
    }
  }

  // Estrategia 2: text-based scan (LinkedIn cambia clases pero el texto sigue)
  // Buscar elementos con texto "aceptar" cerca del top del thread
  const acceptByText = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'))
    for (const el of candidates) {
      const txt = (el.textContent ?? '').trim().toLowerCase()
      if (/^(aceptar|accept|marcar como conocido)$/.test(txt)) {
        const rect = el.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          return { x: rect.x + rect.width/2, y: rect.y + rect.height/2 }
        }
      }
    }
    return null
  })
  if (acceptByText) {
    console.log(`[REPLY] 📨 Message Request (text scan) — click @ ${acceptByText.x|0},${acceptByText.y|0}`)
    await page.mouse.move(acceptByText.x - 50, acceptByText.y - 30)
    await sleep(randInt(150, 350))
    await page.mouse.move(acceptByText.x, acceptByText.y)
    await sleep(randInt(80, 200))
    await page.mouse.click(acceptByText.x, acceptByText.y)
    await sleep(randInt(2500, 4500))
    return true
  }

  return false
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

  const textareaSelector = 'div[role="textbox"][contenteditable="true"], ' +
    '.msg-form__contenteditable, ' +
    '[data-artdeco-is-focused] [contenteditable="true"]'

  const textarea = page.locator(textareaSelector).first()
  let hasTextarea = await textarea.isVisible({ timeout: 8000 }).catch(() => false)

  // Si no hay textarea, puede ser Message Request — intentar aceptar
  if (!hasTextarea) {
    const accepted = await acceptMessageRequestIfNeeded(page, leadName)
    if (accepted) {
      hasTextarea = await page.locator(textareaSelector).first().isVisible({ timeout: 8000 }).catch(() => false)
      if (hasTextarea) {
        console.log(`[REPLY] ✓ Message Request aceptado — textarea ahora visible`)
      }
    }
  }

  if (!hasTextarea) {
    console.warn(`[REPLY] No textarea found in thread (ni después de Accept) — falling back to profile navigation`)
    return null // signal fallback
  }

  // Quick name sanity check — the thread header should contain the lead's first name
  const firstName = leadName.split(' ')[0]
  const headerText = await page.locator(
    'h2[class*="msg"], .msg-thread__top-bar-title, .msg-entity-lockup__entity-title'
  ).first().textContent({ timeout: 3000 }).catch(() => null)

  if (headerText && !headerText.toLowerCase().includes(firstName.toLowerCase())) {
    console.warn(`[REPLY] ⚠️  Thread header "${headerText?.trim()}" no coincide con "${firstName}" — falling back to profile`)
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

  // Verify the overlay/thread that opened belongs to the correct lead
  // LinkedIn bug: clicking "Message" from a profile can open the last viewed thread instead
  const firstName = leadName.split(' ')[0]
  const threadHeader = await page.locator(
    '.msg-overlay-conversation-bubble--is-active .msg-overlay-conversation-bubble__participants-names, ' +
    '.msg-thread__top-bar-title, ' +
    '.msg-entity-lockup__entity-title, ' +
    'h2[class*="msg"], [class*="conversation-title"]'
  ).first().textContent({ timeout: 4000 }).catch(() => null)

  if (threadHeader && !threadHeader.toLowerCase().includes(firstName.toLowerCase())) {
    console.warn(`[REPLY] ⚠️  Thread abierto: "${threadHeader?.trim()}" — esperado: "${firstName}". Thread incorrecto, abortando.`)
    return 'error'
  }

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

  // FASE 1.2: persistent context por cuenta
  const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  const fingerprint = await getOrCreateAccountFingerprint(supabase, account.id)
  const contextOpts = contextOptionsFromFingerprint(fingerprint, proxy ?? undefined)
  const context = await launchPersistentBrowserContext(chromium, account.id, contextOpts, {
    args:       launchArgs,
    liAtCookie: account.li_at_cookie,
  })
  const browser = context.browser()

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
