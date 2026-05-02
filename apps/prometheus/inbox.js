/**
 * inbox.js — Prometheus inbox reader
 *
 * Detecta conexiones aceptadas y mensajes recibidos en LinkedIn.
 * Actualiza el estado de los leads en Supabase.
 *
 * Movimientos anti-ban:
 *   - Simula sesión real: visita feed antes del inbox
 *   - Scroll humanizado en notificaciones y mensajes
 *   - Delays variables entre acciones (no predecibles)
 *   - NO abre cada conversación en ráfaga; las lee secuencialmente con pausa
 *   - Solo lee las últimas 24-48h de actividad (no barre todo el inbox)
 *   - Limita a MAX_CONVOS_PER_RUN conversaciones por ejecución
 *
 * Usage:
 *   ACCOUNT_ID=<uuid> node inbox.js
 */

import { chromium } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import dotenv from 'dotenv'
import { supabase } from './lib/supabase.js'
import { generateReplyDraft, qualifyInboundMessage, generateInboundDeclineReply, fetchPlaybookExamples } from './ai.js'
import { randomContextOptions } from './lib/browser.js'

dotenv.config()
chromium.use(StealthPlugin())

const ACCOUNT_ID = process.env.ACCOUNT_ID
const DRY_RUN    = process.env.DRY_RUN === 'true'

// ── Límites de seguridad ──────────────────────────────────────────────────────
const MAX_CONVOS_PER_RUN = 20  // aumentado: procesa más conversaciones por run para no acumular backlog
const MAX_NOTIFS_READ    = 25  // máx notificaciones procesadas

// ── Helpers ───────────────────────────────────────────────────────────────────
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

// Delay humano corto (entre clics dentro de una página)
async function microDelay() {
  await new Promise(r => setTimeout(r, randInt(600, 1800)))
}

// Delay humano largo (entre secciones — notificaciones → mensajes)
async function sectionDelay() {
  await new Promise(r => setTimeout(r, randInt(3000, 7000)))
}

// Scroll suave como humano — distancia y velocidad variable
async function humanScroll(page, distance = 600) {
  const steps = randInt(4, 8)
  const step  = Math.floor(distance / steps)
  for (let i = 0; i < steps; i++) {
    await page.evaluate(s => window.scrollBy(0, s), step + randInt(-20, 20))
    await new Promise(r => setTimeout(r, randInt(80, 220)))
  }
}

// Parsea proxy URL "http://user:pass@host:port" en { server, username, password }
// Chromium necesita el server SIN credenciales en --proxy-server;
// las credenciales van en browser.newContext({ proxy: ... })
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

// Normaliza una URL de LinkedIn a formato canónico sin trailing params
function normalizeLinkedInUrl(href) {
  if (!href) return null
  try {
    const url = new URL(href.startsWith('http') ? href : `https://www.linkedin.com${href}`)
    // Extraer /in/username sin query params ni trailing slash
    const match = url.pathname.match(/\/in\/([^/?#]+)/)
    if (!match) return null
    return `https://www.linkedin.com/in/${match[1]}/`
  } catch {
    return null
  }
}

// ── Cargar cuenta de Supabase ─────────────────────────────────────────────────
async function loadAccount() {
  const { data, error } = await supabase
    .from('linkedin_accounts')
    .select('id, label, li_at_cookie, proxy_url, status')
    .eq('id', ACCOUNT_ID)
    .single()

  if (error || !data) throw new Error(`Account not found: ${error?.message}`)
  if (data.status === 'banned')        throw new Error(`Account ${data.label} is banned — skipping inbox`)
  if (data.status === 'rate_limited')  console.warn(`[INBOX] ⚠ Account ${data.label} is rate_limited — proceeding carefully`)

  return data
}

// ── Cargar leads invite_sent / connected para esta cuenta ─────────────────────
async function loadActiveLeads() {
  // Leads vinculados a campañas de esta cuenta
  const { data, error } = await supabase
    .from('leads')
    .select(`
      id, full_name, linkedin_url, status,
      campaign_id,
      campaigns!inner(linkedin_account_id)
    `)
    .in('status', [
      'invite_sent', 'connected', 'replied',
      'follow_up_sent', 'follow_up_sent_2', 'follow_up_sent_3',
      'follow_up_sent_4', 'follow_up_sent_5',
    ])
    .eq('campaigns.linkedin_account_id', ACCOUNT_ID)

  if (error) throw new Error(`Could not load leads: ${error.message}`)
  return data ?? []
}

// Construir mapa profileUrl → lead para matching rápido
function buildLeadMap(leads) {
  const map = new Map()
  for (const lead of leads) {
    const normalized = normalizeLinkedInUrl(lead.linkedin_url)
    if (normalized) map.set(normalized, lead)
  }
  return map
}

// ── Actualizar lead en Supabase ───────────────────────────────────────────────
async function markConnected(lead) {
  if (DRY_RUN) {
    console.log(`[INBOX][DRY] Connected: ${lead.full_name}`)
    return
  }
  await supabase.from('leads').update({
    status:       'connected',
    connected_at: new Date().toISOString(),
  }).eq('id', lead.id)
  console.log(`[INBOX] ✓ Connected: ${lead.full_name}`)
}

// ── Slack notification (fire-and-forget) ─────────────────────────────────────
function notifySlack(lead, messageText) {
  const url = process.env.SLACK_WEBHOOK_URL
  if (!url) return
  const preview = (messageText ?? '').slice(0, 200)
  const body = JSON.stringify({
    text: `💬 *${lead.full_name}* respondió en LinkedIn!\n"${preview}"\n<${lead.linkedin_url}|Ver perfil en LinkedIn>`,
  })
  import('https').then(({ default: https }) => {
    const parsed = new URL(url)
    const req = https.request({ hostname: parsed.hostname, path: parsed.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, () => {})
    req.on('error', () => {})
    req.write(body)
    req.end()
  }).catch(() => {})
}

async function markReplied(lead, messageText, threadId) {
  if (DRY_RUN) {
    console.log(`[INBOX][DRY] Replied: ${lead.full_name} — "${messageText?.slice(0, 60)}..."`)
    return
  }

  // Upsert en conversations — actualiza last_message_text con el más reciente
  const { data: conv, error: convErr } = await supabase
    .from('conversations')
    .upsert({
      lead_id:             lead.id,
      linkedin_account_id: ACCOUNT_ID,
      linkedin_thread_id:  threadId,
      status:              'active',
      last_message_at:     new Date().toISOString(),
      last_message_text:   messageText?.slice(0, 1000) ?? null,
      inbox_checked_at:    new Date().toISOString(),
    }, { onConflict: 'lead_id' })
    .select('id')
    .single()

  if (convErr) {
    console.warn(`[INBOX] Could not upsert conversation for ${lead.full_name}:`, convErr.message)
    return
  }

  // Siempre insertar el mensaje en conversation_events (historial completo)
  if (conv?.id && messageText) {
    await supabase.from('conversation_events').insert({
      conversation_id: conv.id,
      event_type:      'reply_received',
      direction:       'inbound',
      content:         messageText.slice(0, 4000),
      sent_at:         new Date().toISOString(),
    })
  }

  // Solo actualizar lead.status si aún no está marcado como replied
  if (lead.status !== 'replied') {
    await supabase.from('leads').update({
      status:     'replied',
      replied_at: new Date().toISOString(),
    }).eq('id', lead.id)
  }

  console.log(`[INBOX] ✓ Replied: ${lead.full_name} — "${messageText?.slice(0, 60)}"`)

  // Notify team on Slack (fire-and-forget — won't block or crash inbox)
  notifySlack(lead, messageText)
}

// ── Generate AI reply draft (fire-and-forget) ─────────────────────────────────
// Llamado después de markReplied(). Genera un borrador con Gemini y lo guarda en
// conversations.ai_reply_draft para aprobación humana en Orion.
async function generateDraftAsync(lead, inboundMessageText, replyModeOverride = null) {
  try {
    // 1. Conversación existente — turno actual + id
    const { data: conv } = await supabase
      .from('conversations')
      .select('id, conversation_turn')
      .eq('lead_id', lead.id)
      .maybeSingle()

    // 2. Historial COMPLETO (inbound + outbound) para contexto multi-turn
    let conversationHistory = []
    if (conv?.id) {
      const { data: events } = await supabase
        .from('conversation_events')
        .select('direction, content, sent_at, event_type')
        .eq('conversation_id', conv.id)
        .in('event_type', [
          'invite_sent', 'message_sent',
          'reply_received', 'reply_sent',
          'follow_up_sent', 'follow_up_sent_2', 'follow_up_sent_3',
          'follow_up_sent_4', 'follow_up_sent_5',
        ])
        .order('sent_at', { ascending: true })
      conversationHistory = events ?? []
    }

    // 3. Perfil completo del lead (profile_data JSONB)
    const { data: fullLead } = await supabase
      .from('leads')
      .select('profile_data, campaign_id')
      .eq('id', lead.id)
      .single()

    // 4. Config auto-reply + Cal.com URL + delay por cuenta + persona IA
    const { data: campaign } = await supabase
      .from('campaigns')
      .select('auto_reply_mode, auto_reply_delay_min, auto_reply_delay_max, linkedin_account_id, ai_tone, ai_sender_persona, ai_company_context, ai_example_messages, fm1_example_reply, fm2_example_reply, fm3_example_reply')
      .eq('id', fullLead?.campaign_id ?? lead.campaign_id)
      .single()

    let calUrl = null
    let accountDelayMin = null
    let accountDelayMax = null
    if (campaign?.linkedin_account_id) {
      const { data: acct } = await supabase
        .from('linkedin_accounts')
        .select('cal_com_url, reply_delay_min, reply_delay_max, warmup_status')
        .eq('id', campaign.linkedin_account_id)
        .single()
      calUrl = acct?.cal_com_url ?? null
      // Prioridad: account override → default por warmup_status → campaign → global default
      if (acct?.reply_delay_min != null && acct?.reply_delay_max != null) {
        accountDelayMin = acct.reply_delay_min
        accountDelayMax = acct.reply_delay_max
      } else {
        // Defaults por warmup_status — más conservador en cuentas nuevas
        const WARMUP_DELAYS = {
          cold:    { min: 60, max: 90  },
          warming: { min: 25, max: 45  },
          warm:    { min: 8,  max: 20  },
          hot:     { min: 1,  max: 5   },
        }
        const wd = WARMUP_DELAYS[acct?.warmup_status ?? 'warm']
        if (wd) { accountDelayMin = wd.min; accountDelayMax = wd.max }
      }
    }

    // 5. Generar draft con contexto completo y estrategia por turno
    const turnCount = conv?.conversation_turn ?? 0

    // Seleccionar ejemplo FM del turno actual (FM1/FM2/FM3)
    const turnExample = turnCount === 0
      ? (campaign?.fm1_example_reply ?? null)
      : turnCount <= 2
        ? (campaign?.fm2_example_reply ?? null)
        : (campaign?.fm3_example_reply ?? null)

    // Playbook del Cerebro — ejemplos relevantes al perfil del lead para este turno
    const playbookExamples = await fetchPlaybookExamples({
      leadProfileData: fullLead?.profile_data ?? {},
      turnNumber: turnCount,
      limit: 2,
    }).catch(() => '')

    const draft = await generateReplyDraft({
      leadName:           lead.full_name,
      leadProfileData:    fullLead?.profile_data ?? {},
      conversationHistory,
      inboundMessage:     inboundMessageText,
      calUrl,
      turnCount,
      aiTone:             campaign?.ai_tone ?? 'casual',
      senderPersona:      campaign?.ai_sender_persona ?? null,
      companyContext:     campaign?.ai_company_context ?? null,
      exampleMessages:    campaign?.ai_example_messages ?? null,
      turnExample,
      playbookExamples,
    })

    if (!draft) return

    // 6. Programar envío automático si mode != 'manual'
    // replyModeOverride permite que inbound use account.inbound_reply_mode en lugar del de campaña
    const mode     = replyModeOverride ?? campaign?.auto_reply_mode ?? 'manual'
    const delayMin = accountDelayMin ?? campaign?.auto_reply_delay_min ?? 45
    const delayMax = accountDelayMax ?? campaign?.auto_reply_delay_max ?? 90
    const delayMs  = (Math.floor(Math.random() * (delayMax - delayMin + 1)) + delayMin) * 60_000
    const scheduledAt = mode !== 'manual' ? new Date(Date.now() + delayMs).toISOString() : null

    await supabase
      .from('conversations')
      .update({
        ai_reply_draft:        draft,
        ai_draft_generated_at: new Date().toISOString(),
        ...(scheduledAt ? { ai_reply_scheduled_at: scheduledAt } : {}),
      })
      .eq('lead_id', lead.id)

    const modeLabel = scheduledAt
      ? `modo=${mode}, envío programado en ~${delayMin}-${delayMax} min`
      : 'modo=manual, esperando aprobación'
    console.log(`[INBOX] 🤖 Draft turno ${turnCount} para "${lead.full_name}" (${draft.length} chars) — ${modeLabel}`)
  } catch (err) {
    console.warn(`[INBOX] AI draft failed for "${lead.full_name}":`, err.message)
  }
}

// ── Paso 1: Notificaciones — detectar conexiones aceptadas ────────────────────
async function checkNotifications(page, leadMap, stats) {
  console.log('[INBOX] → Checking notifications...')
  await page.goto('https://www.linkedin.com/notifications/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  })

  await microDelay()
  await humanScroll(page, randInt(200, 400))
  await microDelay()

  // Debug: verificar que estamos en la página correcta
  const pageTitle = await page.title()
  console.log(`[INBOX] Notifications page title: "${pageTitle}"`)

  // Extraer notificaciones del DOM — estrategia robusta
  const notifications = await page.evaluate((maxN) => {
    const results = []
    const acceptedRe = /accepted your invitation|acept.*invit|aceitou|te acept/i
    const repliedRe  = /replied|responded|te respondió|sent you a message|te envió|escribió/i

    const allProfileLinks = Array.from(document.querySelectorAll('a[href*="/in/"]'))
    for (const link of allProfileLinks.slice(0, 30)) {
      if (results.length >= maxN) break
      const href = link.getAttribute('href') ?? ''
      const container = link.closest('li, article, [data-urn], section, [role="listitem"]')
        ?? link.parentElement?.parentElement
        ?? link.parentElement
      const text = (container?.textContent ?? link.textContent ?? '').replace(/\s+/g, ' ').trim()

      const isAccepted = acceptedRe.test(text)
      const isReplied  = repliedRe.test(text)
      if (isAccepted || isReplied) {
        results.push({ href, text: text.slice(0, 200), type: isReplied ? 'replied' : 'accepted' })
      }
    }
    return { results }
  }, MAX_NOTIFS_READ)

  console.log(`[INBOX] Found ${notifications.results.length} notifications (accepted + replied)`)

  for (const notif of notifications.results) {
    const profileUrl = normalizeLinkedInUrl(notif.href)
    if (!profileUrl) continue

    const lead = leadMap.get(profileUrl)
    if (!lead) {
      console.log(`[INBOX] Notif profile not in leadMap: ${profileUrl}`)
      continue
    }

    console.log(`[INBOX] Notif type=${notif.type} for ${lead.full_name}`)

    if (notif.type === 'replied') {
      // Notificación de reply — marcar como replied con texto de la notificación
      if (lead.status === 'invite_sent') {
        await markConnected(lead)
        stats.connected++
      }
      // Usar el texto de la notificación como preview del mensaje (mejor que nada hasta que tengamos el hilo)
      const previewText = notif.text?.replace(/.*(?:replied|respondió|sent you a message)[:\s]*/i, '').trim().slice(0, 500) || null
      await markReplied(lead, previewText ?? '[Replied — open LinkedIn for full message]', null)
      stats.replied++
      leadMap.set(profileUrl, { ...lead, status: 'replied' })
      // Fire-and-forget: generate AI reply draft
      generateDraftAsync(lead, previewText).catch(e => console.error(`[inbox] generateDraftAsync error para ${lead.full_name}:`, e.message))
    } else if (lead.status === 'invite_sent') {
      await markConnected(lead)
      leadMap.set(profileUrl, { ...lead, status: 'connected' })
      stats.connected++
    }

    await microDelay()
  }
}

// ── Helpers para el GraphQL de mensajería ─────────────────────────────────────

// Normaliza nombre: quita acentos, puntuación, espacios extra → para comparación fuzzy
function normalizeName(str) {
  return (str ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // quita acentos
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')                       // reemplaza puntuación con espacio
    .replace(/\s+/g, ' ')
    .trim()
}

// Construye mapa de búsqueda por nombre (exacto + normalizado) → lead
function buildLeadNameMap(leads) {
  const map = new Map()
  for (const lead of leads) {
    if (!lead.full_name) continue
    // Clave exacta lowercase
    map.set(lead.full_name.toLowerCase().trim(), lead)
    // Clave normalizada (sin acentos, sin puntuación)
    const norm = normalizeName(lead.full_name)
    if (norm) map.set(norm, lead)
  }
  return map
}

// Fuzzy match: intenta varios niveles para "J. García" → "Juan García"
function fuzzyMatchLead(fullName, leadNameMap, leads) {
  // 1. Exacto
  const exact = leadNameMap.get(fullName.toLowerCase().trim())
  if (exact) return exact

  // 2. Normalizado (sin acentos)
  const norm = normalizeName(fullName)
  const byNorm = leadNameMap.get(norm)
  if (byNorm) return byNorm

  // 3. Parcial — todos los tokens de la conversación están en el nombre del lead (o viceversa)
  const convTokens = norm.split(' ').filter(t => t.length > 1)
  for (const lead of leads) {
    const leadNorm = normalizeName(lead.full_name)
    const leadTokens = leadNorm.split(' ').filter(t => t.length > 1)
    // Todos los tokens de la conv están en el lead
    const convInLead = convTokens.every(t => leadNorm.includes(t))
    // Primer y último token del lead están en la conv
    const firstLast = leadTokens.length >= 2 &&
      convTokens.includes(leadTokens[0]) &&
      convTokens.includes(leadTokens[leadTokens.length - 1])
    if (convInLead || firstLast) return lead
  }
  return null
}

// Extrae el ID del hilo de mensajes del backendUrn de una conversación GraphQL
// backendUrn: "urn:li:messagingThread:2-XXXX..."  → "2-XXXX..."
function extractThreadId(convo) {
  const backendUrn = convo.backendUrn ?? ''
  return backendUrn.replace('urn:li:messagingThread:', '') || null
}

// Extrae el participante que NO es el dueño de la cuenta (distance !== 'SELF')
function getOtherParticipant(convo) {
  const parts = convo.conversationParticipants ?? []
  return parts.find(p => p.participantType?.member?.distance !== 'SELF') ?? null
}

// ── Procesar mensaje inbound de persona desconocida (no en leadMap) ───────────
// Califica con IA si es un lead potencial. Si sí, crea lead + genera draft.
async function processInboundUnknown(member, messageText, threadId, account) {
  const senderName    = `${member.firstName?.text ?? ''} ${member.lastName?.text ?? ''}`.trim()
  const senderHeadline = member.headline?.text ?? null
  const publicId      = member.publicIdentifier ?? null
  const profileUrl    = publicId ? `https://www.linkedin.com/in/${publicId}/` : null

  // Respetar flag de inbound por cuenta
  if (account.inbound_enabled === false) {
    console.log(`[INBOX] 📬 Inbound desactivado para cuenta "${account.label}" — skip`)
    return
  }

  console.log(`[INBOX] 📬 Inbound desconocido: ${senderName}${senderHeadline ? ` (${senderHeadline})` : ''} — calificando...`)

  // Evitar duplicados: si ya existe un lead con esta URL, no crear otro
  if (profileUrl) {
    const { data: existing } = await supabase.from('leads')
      .select('id, status')
      .eq('linkedin_url', profileUrl)
      .maybeSingle()
    if (existing) {
      console.log(`[INBOX]   Lead ya existe (${existing.status}) — skip inbound create`)
      return
    }
  }

  // Clasificar con IA — headline + reglas personalizadas si las hay
  const qualification = await qualifyInboundMessage({
    senderName,
    senderHeadline,
    messageText,
    qualificationRules: account.inbound_qualification_rules ?? null,
    accountContext: account?.label ? `Cuenta LinkedIn de ${account.label}` : '',
  }).catch((err) => {
    console.warn(`[INBOX] qualifyInboundMessage error:`, err.message)
    return { signal: 'unknown', qualified: false, reason: 'Error de clasificación' }
  })

  const signal = qualification.signal // 'lead' | 'vendor' | 'recruiter' | 'spam' | 'unknown'
  console.log(`[INBOX]   Clasificación: ${signal} — ${qualification.reason}`)

  // Spam/bot: descartar silenciosamente, no crear lead
  if (signal === 'spam') {
    console.log(`[INBOX]   Spam detectado — descartado sin registro`)
    return
  }

  if (DRY_RUN) {
    console.log(`[INBOX][DRY] Inbound ${signal}: ${senderName} — no se crea en dry-run`)
    return
  }

  // Campaña activa de esta cuenta (para contexto AI y asignación)
  const { data: campaign } = await supabase.from('campaigns')
    .select('id, name, auto_reply_mode, auto_reply_delay_min, auto_reply_delay_max, ai_tone, ai_sender_persona, ai_company_context, ai_example_messages')
    .eq('linkedin_account_id', account.id)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Crear lead — todos excepto spam se registran para trazabilidad
  const { data: newLead, error: leadErr } = await supabase.from('leads').insert({
    campaign_id:      campaign?.id ?? null,
    linkedin_url:     profileUrl,
    full_name:        senderName,
    status:           qualification.qualified ? 'replied' : 'disqualified',
    source:           'inbound',
    replied_at:       qualification.qualified ? new Date().toISOString() : null,
    ai_qualified:     qualification.qualified,
    inbound_signal:   signal,
    inbound_message:  messageText?.slice(0, 2000) ?? null,
    profile_data: {
      headline: senderHeadline,
      location: member.location?.basicLocation?.countryCode ?? null,
    },
  }).select('id').single()

  if (leadErr || !newLead?.id) {
    console.error(`[INBOX] Error creando lead inbound ${senderName}:`, leadErr?.message)
    return
  }

  console.log(`[INBOX] ✅ Lead inbound creado: ${senderName} (${signal}) id=${newLead.id}`)

  // Crear conversación
  const { data: conv } = await supabase.from('conversations').upsert({
    lead_id:             newLead.id,
    linkedin_account_id: account.id,
    linkedin_thread_id:  threadId,
    status:              'active',
    last_message_at:     new Date().toISOString(),
    last_message_text:   messageText?.slice(0, 1000),
    inbox_checked_at:    new Date().toISOString(),
  }, { onConflict: 'lead_id' }).select('id').single()

  if (!conv?.id) return

  // Registrar evento inbound
  await supabase.from('conversation_events').insert({
    conversation_id: conv.id,
    event_type:      'reply_received',
    direction:       'inbound',
    content:         messageText?.slice(0, 4000),
    sent_at:         new Date().toISOString(),
  })

  // ── Flujo según señal ─────────────────────────────────────────────────────

  if (signal === 'lead') {
    // Comprador potencial → draft de respuesta usando modo de inbound de la cuenta
    const replyMode = account.inbound_reply_mode ?? 'manual'
    const fakeLead  = { id: newLead.id, full_name: senderName, campaign_id: campaign?.id ?? null }
    generateDraftAsync(fakeLead, messageText, replyMode)
      .catch(e => console.error(`[INBOX] Draft inbound lead error para ${senderName}:`, e.message))

  } else if (signal === 'vendor' || signal === 'recruiter') {
    // Vendedor/recruiter → siempre generamos rechazo educado
    const declineText = await generateInboundDeclineReply({
      senderName,
      senderHeadline,
      inboundMessage:  messageText,
      declineTemplate: account.inbound_decline_template ?? null,
      senderPersona:   campaign?.ai_sender_persona ?? null,
    }).catch(() => null)

    if (!declineText) return

    // Calcular scheduling: manual (solo draft) o auto (con delay)
    const replyMode = account.inbound_reply_mode ?? 'manual'
    const delayMin  = account.reply_delay_min  ?? 25
    const delayMax  = account.reply_delay_max  ?? 60
    const delayMs   = (Math.floor(Math.random() * (delayMax - delayMin + 1)) + delayMin) * 60_000
    const scheduledAt = replyMode !== 'manual'
      ? new Date(Date.now() + delayMs).toISOString()
      : null

    await supabase.from('conversations').update({
      ai_reply_draft:        declineText,
      ai_draft_generated_at: new Date().toISOString(),
      ...(scheduledAt ? { ai_reply_scheduled_at: scheduledAt } : {}),
    }).eq('id', conv.id)

    console.log(`[INBOX]   Rechazo educado generado para ${signal} "${senderName}" — modo: ${replyMode}`)

  } else {
    // unknown → lead creado, sin draft, aparece en Orion para revisión manual
    console.log(`[INBOX]   Signal "unknown" — queda en Orion para revisión manual`)
  }
}

// ── Paso 2: Messaging — detectar mensajes recibidos via LinkedIn GraphQL ─────
// Recibe globalApiResponses capturadas globalmente desde el inicio del run
async function checkMessaging(page, leadMap, leads, stats, globalApiResponses, account) {
  console.log('[INBOX] → Checking messaging inbox via Voyager API...')
  console.log(`[INBOX] API responses captured so far: ${globalApiResponses.size}`)

  // Navegar a /messaging/ para que LinkedIn dispare los GraphQL de conversaciones
  await page.goto('https://www.linkedin.com/messaging/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  })
  await page.waitForTimeout(12000)

  console.log(`[INBOX] API responses after /messaging/: ${globalApiResponses.size}`)

  // ── Recolectar todas las conversaciones paginando via syncToken ──────────────
  // LinkedIn devuelve máx. 20 por request; usamos el syncToken del metadata para
  // hacer fetch directo a las páginas siguientes (más confiable que scroll DOM).
  const allConversations = []
  let firstPageUrl  = null
  let firstPageJson = null

  for (const [url, json] of globalApiResponses) {
    const lurl = url.toLowerCase()
    if (lurl.includes('messengerconversations') && !lurl.includes('presencestatus')) {
      firstPageUrl  = url
      firstPageJson = json
      break
    }
  }

  if (!firstPageJson) {
    console.warn('[INBOX] No messengerConversations GraphQL response captured — skipping messaging check')
    return
  }

  const page1Elements = firstPageJson?.data?.messengerConversationsBySyncToken?.elements
    ?? firstPageJson?.data?.messengerConversationsByCategory?.elements
    ?? []
  allConversations.push(...page1Elements)
  console.log(`[INBOX] Page 1: ${page1Elements.length} conversations`)

  // Helper: build next-page URL by swapping syncToken in variables param
  function buildNextPageUrl(baseUrl, newSyncToken) {
    try {
      const u = new URL(baseUrl)
      const rawVars = u.searchParams.get('variables')
      if (rawVars) {
        const parsed = JSON.parse(rawVars)
        parsed.syncToken = newSyncToken
        u.searchParams.set('variables', JSON.stringify(parsed))
        return u.toString()
      }
    } catch { /* fall through to regex */ }
    // Regex fallback for non-standard formats
    return baseUrl.replace(/"syncToken":"[^"]*"/, `"syncToken":"${newSyncToken}"`)
  }

  // Fetch páginas adicionales via syncToken (hasta 4 más = ~100 conversaciones total)
  let nextSyncToken = firstPageJson?.data?.messengerConversationsBySyncToken?.metadata?.newSyncToken

  for (let pageNum = 2; pageNum <= 5 && nextSyncToken && firstPageUrl; pageNum++) {
    const nextUrl = buildNextPageUrl(firstPageUrl, nextSyncToken)

    await page.waitForTimeout(randInt(1500, 3000))

    const nextData = await page.evaluate(async (url) => {
      try {
        // CSRF token: JSESSIONID cookie tiene formato "ajax:TOKEN" — extraer solo TOKEN
        const jsid = document.cookie.match(/JSESSIONID="?([^";\s]+)"?/)?.[1] ?? ''
        const csrf = jsid.replace(/^ajax:/, '')
        const resp = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: {
            'accept': 'application/vnd.linkedin.normalized+json+2.1',
            'x-restli-protocol-version': '2.0.0',
            'csrf-token': csrf,
          },
        })
        if (!resp.ok) return { __status: resp.status }
        return await resp.json()
      } catch (e) {
        return { __error: String(e) }
      }
    }, nextUrl)

    if (nextData?.__error || nextData?.__status) {
      console.log(`[INBOX] Page ${pageNum}: fetch stopped (${nextData.__error ?? 'HTTP ' + nextData.__status})`)
      break
    }

    const nextElements = nextData?.data?.messengerConversationsBySyncToken?.elements ?? []
    if (nextElements.length === 0) {
      console.log(`[INBOX] Page ${pageNum}: no more conversations — end of list`)
      break
    }

    allConversations.push(...nextElements)
    nextSyncToken = nextData?.data?.messengerConversationsBySyncToken?.metadata?.newSyncToken
    console.log(`[INBOX] Page ${pageNum}: +${nextElements.length} conversations (total: ${allConversations.length})`)
    if (!nextSyncToken) break
  }

  console.log(`[INBOX] Total conversations fetched: ${allConversations.length}`)

  // Construir lookup por nombre completo para el matching de participantes GraphQL
  const leadNameMap = buildLeadNameMap(leads)

  // Ordenar: primero conversaciones con unread > 0
  const sorted = [
    ...allConversations.filter(c => (c.unreadCount ?? 0) > 0),
    ...allConversations.filter(c => (c.unreadCount ?? 0) === 0),
  ]

  let processed = 0

  for (const convo of sorted) {
    if (processed >= MAX_CONVOS_PER_RUN) break

    // Encontrar el participante que no somos nosotros
    const other = getOtherParticipant(convo)
    if (!other) continue

    const member = other.participantType?.member
    if (!member) continue

    const firstName = member.firstName?.text ?? ''
    const lastName  = member.lastName?.text  ?? ''
    const fullName  = `${firstName} ${lastName}`.trim()

    // Intentar match por nombre — exacto primero, luego fuzzy (sin acentos, parcial)
    const matchedLead = fuzzyMatchLead(fullName, leadNameMap, leads)

    if (!matchedLead) {
      // Persona desconocida — si tiene mensajes sin leer, calificar como inbound potencial
      if ((convo.unreadCount ?? 0) > 0) {
        const threadId = extractThreadId(convo)
        // Necesitamos el texto del mensaje — navegar al hilo para obtenerlo
        // (usamos la misma lógica que para leads conocidos, pero de forma simplificada)
        let inboundText = null
        if (threadId) {
          try {
            for (const url of [...globalApiResponses.keys()]) {
              if (url.toLowerCase().includes('messengermessages')) globalApiResponses.delete(url)
            }
            await page.goto(`https://www.linkedin.com/messaging/thread/${threadId}/`, {
              waitUntil: 'domcontentloaded', timeout: 20000,
            })
            await page.waitForTimeout(2500)
            for (const [url, json] of globalApiResponses.entries()) {
              if (url.toLowerCase().includes('messengermessages')) {
                const els = json?.data?.messengerMessagesBySyncToken?.elements
                  ?? json?.data?.messengerMessagesByAnchorTimestamp?.elements
                  ?? json?.data?.messengerMessages?.elements ?? []
                const isSelf = m => m.sender?.participantType?.member?.distance === 'SELF'
                const lastOutIdx = [...els].reduce((idx, m, i) => isSelf(m) ? i : idx, -1)
                const pending = els.slice(lastOutIdx + 1).filter(m => !isSelf(m))
                const parts = pending.map(m => (m.body?.text ?? '').trim()).filter(Boolean)
                if (parts.length) inboundText = parts.join('\n\n')
                break
              }
            }
          } catch (e) {
            console.warn(`[INBOX] Error leyendo hilo inbound desconocido:`, e.message)
          }
        }
        if (inboundText) {
          await processInboundUnknown(member, inboundText, threadId, account)
          stats.replied++
        }
      }
      continue
    }

    const unreadCount = convo.unreadCount ?? 0
    const threadId    = extractThreadId(convo)
    console.log(`[INBOX] Matched lead: ${matchedLead.full_name} — unread=${unreadCount} thread=${threadId?.slice(0, 20)}`)

    // Solo procesar si hay mensajes no leídos O si el lead no está marcado como replied todavía
    const needsProcessing = unreadCount > 0 || matchedLead.status !== 'replied'
    if (!needsProcessing) {
      console.log(`[INBOX]   Already replied and no new messages — skip`)
      continue
    }

    processed++

    // ── Obtener texto del mensaje navegando al hilo ──────────────────────────
    // LinkedIn hace un llamado GraphQL messengerMessages cuando carga el thread.
    // Usamos globalApiResponses (ya parseado por el interceptor global) en vez de
    // waitForResponse, porque ambos llaman a response.json() en el mismo objeto
    // y el primero consume el body dejando al segundo sin datos.
    let messageText = null

    if (threadId) {
      await sectionDelay()

      // Limpiar entradas previas de messengerMessages del mapa para detectar solo
      // las que dispara este hilo específico
      for (const url of [...globalApiResponses.keys()]) {
        if (url.toLowerCase().includes('messengermessages')) {
          globalApiResponses.delete(url)
        }
      }

      try {
        // Intento 1 — navegar al thread
        const gotoThread = async () => {
          await page.goto(`https://www.linkedin.com/messaging/thread/${threadId}/`, {
            waitUntil: 'domcontentloaded',
            timeout: 25000,
          })
          await page.waitForTimeout(5000)
        }
        await gotoThread().catch(async (err) => {
          console.warn(`[INBOX] Thread nav attempt 1 failed (${err.message}) — retrying...`)
          await page.waitForTimeout(3000)
          await gotoThread()  // retry once
        })

        // Buscar la respuesta de mensajes en el interceptor global
        let messagesData = null
        for (const [url, json] of globalApiResponses) {
          if (url.toLowerCase().includes('messengermessages')) {
            messagesData = json
            console.log(`[INBOX] Found messengerMessages: ${url.replace('https://www.linkedin.com', '').slice(0, 100)}`)
            break
          }
        }

        // Si no se capturó aún, esperar un poco más y reintentar búsqueda
        if (!messagesData) {
          await page.waitForTimeout(3000)
          for (const [url, json] of globalApiResponses) {
            if (url.toLowerCase().includes('messengermessages')) {
              messagesData = json
              console.log(`[INBOX] Found messengerMessages (delayed): ${url.slice(0, 80)}`)
              break
            }
          }
        }

        if (messagesData) {
          // Extraer el texto del último mensaje inbound
          const msgElements = messagesData?.data?.messengerMessagesBySyncToken?.elements
            ?? messagesData?.data?.messengerMessagesByAnchorTimestamp?.elements
            ?? messagesData?.data?.messengerMessages?.elements
            ?? []

          console.log(`[INBOX] Thread messages count: ${msgElements.length}`)

          // Separar mensajes por dirección (SELF = nuestros, otros = del lead)
          const isSelf = msg => msg.sender?.participantType?.member?.distance === 'SELF'

          // Encontrar el índice del ÚLTIMO mensaje outbound nuestro
          // Todo lo inbound DESPUÉS de ese punto = respuesta pendiente del lead
          let lastOutboundIdx = -1
          for (let i = msgElements.length - 1; i >= 0; i--) {
            if (isSelf(msgElements[i])) { lastOutboundIdx = i; break }
          }

          // Recoger TODOS los mensajes inbound después del último outbound
          // Si no hay outbound aún (primera respuesta a invite), tomar todos los inbound
          const pendingInbound = msgElements
            .slice(lastOutboundIdx + 1)
            .filter(msg => !isSelf(msg))

          // Concatenar para dar contexto completo a la IA
          // Emojis como "👍" tienen .length === 2 (UTF-16), trim().length >= 1 los captura
          const parts = pendingInbound
            .map(msg => (msg.body?.text ?? msg.body ?? '').trim())
            .filter(t => t.length >= 1)

          if (parts.length > 0) {
            messageText = parts.join('\n\n')
            console.log(`[INBOX]   Inbound messages (${parts.length}): "${messageText.slice(0, 120)}"`)
          } else if (pendingInbound.length === 0 && msgElements.every(isSelf)) {
            console.log(`[INBOX]   No inbound messages in thread (${msgElements.length} total, all outbound)`)
          }
        } else {
          console.log('[INBOX] No messengerMessages captured for this thread — using placeholder')
        }
      } catch (err) {
        console.warn(`[INBOX] Error navigating to thread ${threadId}:`, err.message)
      }
    }

    // Determinar si hay respuesta real del lead
    // Si solo tenemos placeholder (sin mensaje inbound), solo actualizar a connected
    const hasRealReply = messageText !== null

    // Si no hay mensaje inbound y unreadCount === 0: solo asegurar connected, no marcar como replied
    if (!hasRealReply && (convo.unreadCount ?? 0) === 0) {
      if (matchedLead.status === 'invite_sent') {
        await markConnected(matchedLead)
        stats.connected++
        const profileUrl = normalizeLinkedInUrl(matchedLead.linkedin_url)
        if (profileUrl) leadMap.set(profileUrl, { ...matchedLead, status: 'connected' })
      }
      await microDelay()
      continue
    }

    // Si no hay texto del API, intentar leer del DOM como último recurso
    if (!messageText && threadId) {
      console.warn(`[INBOX] ⚠️  Sin texto API para ${matchedLead.full_name} — intentando DOM...`)
      try {
        // El thread ya está cargado. Los mensajes del lead están en elementos de texto.
        const domTexts = await page.evaluate(() => {
          const msgs = document.querySelectorAll('.msg-s-message-list__event .msg-s-event-listitem__body, .msg-thread .msg-message .body, [class*="message-group"] [class*="body"]')
          return [...msgs].map(el => el.textContent?.trim()).filter(Boolean)
        })
        if (domTexts.length > 0) {
          // Tomar los últimos mensajes (más recientes)
          messageText = domTexts.slice(-3).join('\n\n')
          console.log(`[INBOX]   DOM fallback extrajo ${domTexts.length} msgs: "${messageText.slice(0, 80)}"`)
        }
      } catch {
        // DOM fallback también falló
      }
    }

    if (!messageText) {
      console.warn(`[INBOX] ⚠️  Sin texto para ${matchedLead.full_name} — marcando para revisión manual.`)
      await supabase.from('conversations').update({
        inbox_checked_at: new Date().toISOString(),
        last_message_text: '[Sin texto — revisar LinkedIn manualmente]',
      }).eq('lead_id', matchedLead.id)
      stats.replied++
      continue
    }

    // Actualizar estado del lead
    if (matchedLead.status === 'invite_sent') {
      await markConnected(matchedLead)
      stats.connected++
    }

    await markReplied(matchedLead, messageText, threadId)
    stats.replied++
    // Fire-and-forget: generate AI reply draft
    generateDraftAsync(matchedLead, messageText).catch(e => console.error(`[INBOX] generateDraftAsync error para ${matchedLead.full_name}:`, e.message))

    // Actualizar el leadMap para no reprocesar
    const profileUrl = normalizeLinkedInUrl(matchedLead.linkedin_url)
    if (profileUrl) {
      leadMap.set(profileUrl, { ...matchedLead, status: 'replied' })
    }

    await microDelay()
  }

  console.log(`[INBOX] Messaging check done — processed ${processed} matched conversations`)
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  if (!ACCOUNT_ID) {
    console.error('[INBOX] ERROR: ACCOUNT_ID not set'); process.exit(1)
  }

  console.log(`[INBOX] Starting inbox check for account ${ACCOUNT_ID}`)
  if (DRY_RUN) console.log('[INBOX] DRY_RUN mode — no DB writes')

  const account = await loadAccount()
  console.log(`[INBOX] Account: ${account.label}`)

  const leads   = await loadActiveLeads()
  const leadMap = buildLeadMap(leads)
  console.log(`[INBOX] Tracking ${leadMap.size} active leads (invite_sent / connected)`)

  if (leadMap.size === 0) {
    console.log('[INBOX] No leads to track — done.')
    await supabase.from('linkedin_accounts')
      .update({ last_inbox_check_at: new Date().toISOString() })
      .eq('id', ACCOUNT_ID)
    return
  }

  // ── Lanzar browser ──────────────────────────────────────────────────────────

  const proxy = parseProxy(account.proxy_url)
  if (!proxy) {
    console.error('[INBOX] ❌ No proxy configurado para esta cuenta — abortando para evitar ban de IP de datacenter.');
    process.exit(1);
  }
  console.log(`[INBOX] Using proxy: ${proxy.server} (user=${proxy.username ?? 'none'})`)

  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
  ]

  const browser = await chromium.launch({
    headless: true,
    args: launchArgs,
  })

  const context = await browser.newContext(randomContextOptions(proxy ?? undefined))

  // Inyectar li_at cookie
  await context.addCookies([{
    name:     'li_at',
    value:    account.li_at_cookie,
    domain:   '.linkedin.com',
    path:     '/',
    httpOnly: true,
    secure:   true,
    sameSite: 'None',
  }])

  const page = await context.newPage()

  // Bloquear recursos innecesarios para ir más rápido y parecer menos bot
  await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}', r => r.abort())
  await page.route('**/li/track', r => r.abort()) // tracking de LinkedIn

  // ── Interceptar globalmente TODOS los Voyager API responses desde el inicio ──
  const globalApiResponses = new Map() // url → json

  page.on('response', async (response) => {
    const url = response.url()
    if (!url.includes('/voyager/api/')) return
    if (response.status() !== 200) return
    try {
      const json = await response.json()
      globalApiResponses.set(url, json)
      // Log solo los endpoints únicos relevantes (evitar spam de presenceStatuses)
      if (!url.includes('presenceStatus') && !url.includes('voyagerGlobalAlerts')) {
        console.log(`[INBOX] [global] API: ${url.replace('https://www.linkedin.com', '').slice(0, 100)}`)
      }
    } catch { /* ignorar no-JSON */ }
  })

  const stats = { connected: 0, replied: 0, errors: 0 }
  const startedAt = Date.now()

  try {
    // ── Warmup: visitar feed como usuario real ────────────────────────────────
    // El chat panel de LinkedIn carga aquí y hace llamadas al API de conversaciones
    console.log('[INBOX] Warming up — visiting feed...')
    await page.goto('https://www.linkedin.com/feed/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })

    if (page.url().includes('/login') || page.url().includes('/authwall')) {
      console.error('[INBOX] Cookie expired — re-login required')
      await browser.close(); process.exit(1)
    }

    // Simular leer el feed — esperamos más para que el chat panel cargue
    await page.waitForTimeout(randInt(6000, 10000))
    await humanScroll(page, randInt(300, 700))
    await page.waitForTimeout(randInt(3000, 5000))

    console.log(`[INBOX] Session warm — ${globalApiResponses.size} messaging API responses captured so far.`)
    await sectionDelay()

    // ── Paso 1: Notificaciones ────────────────────────────────────────────────
    try {
      await checkNotifications(page, leadMap, stats)
    } catch (err) {
      console.warn('[INBOX] Notifications check failed:', err.message)
      stats.errors++
    }

    await sectionDelay()

    // ── Paso 2: Messaging ─────────────────────────────────────────────────────
    try {
      await checkMessaging(page, leadMap, leads, stats, globalApiResponses, account)
    } catch (err) {
      console.warn('[INBOX] Messaging check failed:', err.message)
      stats.errors++
    }

  } finally {
    await browser.close()
  }

  const duration = Date.now() - startedAt

  // ── Actualizar timestamp de última revisión ───────────────────────────────
  if (!DRY_RUN) {
    await supabase.from('linkedin_accounts')
      .update({ last_inbox_check_at: new Date().toISOString() })
      .eq('id', ACCOUNT_ID)

    // Log en scheduler_log
    await supabase.from('scheduler_log').insert({
      account_id:  ACCOUNT_ID,
      job_type:    'inbox',
      status:      stats.errors > 0 ? 'partial' : 'ok',
      leads_sent:  0,
      leads_found: stats.connected + stats.replied,
      duration_ms: duration,
      details: {
        connected: stats.connected,
        replied:   stats.replied,
        errors:    stats.errors,
      },
    })
  }

  console.log(`\n[INBOX] ✓ Done in ${(duration / 1000).toFixed(1)}s`)
  console.log(`[INBOX] Connected: ${stats.connected} | Replied: ${stats.replied} | Errors: ${stats.errors}`)
}

run().catch(err => {
  console.error('[INBOX] Fatal:', err)
  process.exit(1)
})
