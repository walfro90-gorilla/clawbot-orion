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
import { generateReplyDraft } from './ai.js'

dotenv.config()
chromium.use(StealthPlugin())

const ACCOUNT_ID = process.env.ACCOUNT_ID
const DRY_RUN    = process.env.DRY_RUN === 'true'

// ── Límites de seguridad ──────────────────────────────────────────────────────
const MAX_CONVOS_PER_RUN = 8   // máx conversaciones abiertas por ejecución
const MAX_NOTIFS_READ    = 15  // máx notificaciones procesadas

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
    .in('status', ['invite_sent', 'connected', 'replied'])
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
    status: 'connected',
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
async function generateDraftAsync(lead, inboundMessageText) {
  try {
    // Obtener historial de mensajes salientes para dar contexto a Gemini
    const { data: conv } = await supabase
      .from('conversations')
      .select('id')
      .eq('lead_id', lead.id)
      .maybeSingle()

    let outboundHistory = []
    if (conv?.id) {
      const { data: events } = await supabase
        .from('conversation_events')
        .select('content, direction')
        .eq('conversation_id', conv.id)
        .eq('direction', 'outbound')
        .order('sent_at', { ascending: true })
      outboundHistory = (events ?? []).map(e => e.content).filter(Boolean)
    }

    // Obtener cal_com_url de la cuenta LinkedIn (vía campaña)
    const { data: campaign } = await supabase
      .from('campaigns')
      .select('linkedin_account_id')
      .eq('id', lead.campaign_id)
      .single()

    let calUrl = null
    if (campaign?.linkedin_account_id) {
      const { data: acct } = await supabase
        .from('linkedin_accounts')
        .select('cal_com_url')
        .eq('id', campaign.linkedin_account_id)
        .single()
      calUrl = acct?.cal_com_url ?? null
    }

    const draft = await generateReplyDraft({
      leadName:        lead.full_name,
      outboundHistory,
      inboundMessage:  inboundMessageText,
      calUrl,
    })

    if (!draft) return

    // Guardar borrador en la conversation
    await supabase
      .from('conversations')
      .update({
        ai_reply_draft:        draft,
        ai_draft_generated_at: new Date().toISOString(),
      })
      .eq('lead_id', lead.id)

    console.log(`[INBOX] 🤖 AI draft generado para "${lead.full_name}" (${draft.length} chars)`)
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
      generateDraftAsync(lead, previewText).catch(() => {})
    } else if (lead.status === 'invite_sent') {
      await markConnected(lead)
      leadMap.set(profileUrl, { ...lead, status: 'connected' })
      stats.connected++
    }

    await microDelay()
  }
}

// ── Helpers para el GraphQL de mensajería ─────────────────────────────────────

// Construye mapa de búsqueda por nombre: "nombre completo lowercase" → lead
function buildLeadNameMap(leads) {
  const map = new Map()
  for (const lead of leads) {
    if (lead.full_name) {
      map.set(lead.full_name.toLowerCase().trim(), lead)
    }
  }
  return map
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

// ── Paso 2: Messaging — detectar mensajes recibidos via LinkedIn GraphQL ─────
// Recibe globalApiResponses capturadas globalmente desde el inicio del run
async function checkMessaging(page, leadMap, leads, stats, globalApiResponses) {
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

    // Intentar match por nombre en ambos mapas
    const matchedLead = leadNameMap.get(fullName.toLowerCase())

    if (!matchedLead) {
      // No es un lead nuestro — skip
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
        await page.goto(`https://www.linkedin.com/messaging/thread/${threadId}/`, {
          waitUntil: 'domcontentloaded',
          timeout: 25000,
        })

        await page.waitForTimeout(5000) // Dar tiempo al SPA para disparar el GraphQL call

        // Buscar la respuesta de mensajes en el interceptor global
        let messagesData = null
        for (const [url, json] of globalApiResponses) {
          if (url.toLowerCase().includes('messengermessages')) {
            messagesData = json
            console.log(`[INBOX] Found messengerMessages: ${url.replace('https://www.linkedin.com', '').slice(0, 100)}`)
            break
          }
        }

        if (messagesData) {
          // Extraer el texto del último mensaje inbound
          const msgElements = messagesData?.data?.messengerMessagesBySyncToken?.elements
            ?? messagesData?.data?.messengerMessagesByAnchorTimestamp?.elements
            ?? messagesData?.data?.messengerMessages?.elements
            ?? []

          console.log(`[INBOX] Thread messages count: ${msgElements.length}`)

          // Filtrar mensajes inbound (del lead, no nuestros — distance !== 'SELF')
          const inboundMessages = msgElements.filter(msg => {
            const senderDistance = msg.sender?.participantType?.member?.distance
            return senderDistance && senderDistance !== 'SELF'
          })

          // Solo usar mensajes inbound para capturar respuestas
          // Nota: emojis como "👍" tienen .length === 2 en JS (UTF-16 surrogate pair)
          // por eso usamos trim().length >= 1 para no perderlos
          for (const msg of inboundMessages.slice(-3)) {
            const body = (msg.body?.text ?? msg.body ?? '').trim()
            if (body.length >= 1) messageText = body
          }
          if (messageText) {
            console.log(`[INBOX]   Latest inbound message: "${messageText.slice(0, 100)}"`)
          } else if (inboundMessages.length === 0) {
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

    // Si no hay texto pero tiene unread, usar placeholder
    if (!messageText) {
      messageText = `[Mensaje detectado — revisar LinkedIn] Última actividad: ${new Date(convo.lastActivityAt).toLocaleString('es-MX')}`
    }

    // Actualizar estado del lead
    if (matchedLead.status === 'invite_sent') {
      await markConnected(matchedLead)
      stats.connected++
    }

    await markReplied(matchedLead, messageText, threadId)
    stats.replied++
    // Fire-and-forget: generate AI reply draft
    generateDraftAsync(matchedLead, messageText).catch(() => {})

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
  const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  ]

  const proxy = parseProxy(account.proxy_url)
  if (proxy) console.log(`[INBOX] Using proxy: ${proxy.server} (user=${proxy.username ?? 'none'})`)
  else       console.log('[INBOX] ⚠️  No proxy — ban risk alto en IPs de datacenter')

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

  const context = await browser.newContext({
    userAgent:  USER_AGENTS[randInt(0, USER_AGENTS.length - 1)],
    viewport:   { width: randInt(1260, 1440), height: randInt(860, 950) },
    locale:     'es-MX',
    timezoneId: 'America/Mexico_City',
    // Proxy con credenciales — Playwright lo pasa correctamente a Chromium
    ...(proxy ? { proxy } : {}),
    extraHTTPHeaders: {
      'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
    },
  })

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
      await checkMessaging(page, leadMap, leads, stats, globalApiResponses)
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
