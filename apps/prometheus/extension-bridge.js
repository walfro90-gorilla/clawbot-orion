// ─────────────────────────────────────────────────────────────────────────────
// extension-bridge.js — WebSocket server entre Chrome Extension y Orion
//
// FASE 2.1 — primer paso del Dripify-style architecture.
//
// Flujo:
//   1. Extension del usuario abre WS a este server con ?account=<uuid>
//   2. Handshake: extension manda {type:'auth', apiKey, accountId}
//   3. Server valida API key contra linkedin_accounts.extension_api_key
//   4. Server mantiene mapa account_id → WebSocket connection
//   5. Cada N seg poll de extension_commands WHERE status='pending'
//      AND account_id IN conectados — despacha por WS
//   6. Extension ejecuta → reporta {type:'command_result', commandId, result}
//   7. Server actualiza extension_commands status='completed', result=...
//
// PM2 process aparte: orquesta puro, no toca browsers, no toca proxy.
// Reemplaza eventualmente a cookie-server cuando se complete la migración.
// ─────────────────────────────────────────────────────────────────────────────

import { WebSocketServer } from 'ws'
import http from 'http'
import { URL } from 'url'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { checkAndKillLeadIfStuck, checkAccountHealthAndPause } from './lib/extension-dispatch.js'

dotenv.config()

const PORT = parseInt(process.env.EXTENSION_BRIDGE_PORT ?? '4002')
const POLL_INTERVAL_MS = parseInt(process.env.EXTENSION_POLL_INTERVAL_MS ?? '3000')
const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000  // 5 min sin heartbeat → marcar desconectado

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
)

// ── Estado: account_id → { ws, label, lastSeen } ────────────────────────────

const connections = new Map()

// ── HTTP server + WS upgrade ────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // Endpoint health para monitoring
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      connected_accounts: Array.from(connections.entries()).map(([id, c]) => ({
        accountId: id, label: c.label, lastSeen: c.lastSeen,
      })),
      uptime: process.uptime(),
    }))
    return
  }
  res.writeHead(404)
  res.end('Not Found')
})

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  // Solo aceptar upgrades a /api/extension/ws
  const url = new URL(req.url, `http://localhost:${PORT}`)
  if (url.pathname !== '/api/extension/ws') {
    socket.destroy()
    return
  }
  const accountId = url.searchParams.get('account')
  if (!accountId) {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, ws => {
    handleConnection(ws, accountId)
  })
})

// ── Manejo de conexión ─────────────────────────────────────────────────────

async function handleConnection(ws, accountId) {
  console.log(`[bridge] New WS connection for account=${accountId}`)
  let authenticated = false
  let accountLabel = null

  // Timeout para auth handshake: 10s
  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      console.log(`[bridge] Auth timeout for ${accountId} — closing`)
      try { ws.close(4001, 'auth_timeout') } catch {}
    }
  }, 10_000)

  ws.on('message', async (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch {
      return
    }

    if (!authenticated) {
      if (msg.type !== 'auth') {
        try { ws.send(JSON.stringify({ type: 'auth_error', error: 'auth_required' })) } catch {}
        return
      }
      // Validar API key contra DB
      const { data: account } = await supabase
        .from('linkedin_accounts')
        .select('id, label, extension_api_key')
        .eq('id', msg.accountId)
        .maybeSingle()

      if (!account || !account.extension_api_key || account.extension_api_key !== msg.apiKey) {
        const sent = msg.apiKey ?? ''
        const db = account?.extension_api_key ?? ''
        const fmt = (s) => s ? `${s.slice(0, 12)}…${s.slice(-6)} (len=${s.length})` : '<empty>'
        console.warn(`[bridge] Auth FAILED for ${accountId}`)
        console.warn(`[bridge]   sent: ${fmt(sent)}`)
        console.warn(`[bridge]   db:   ${fmt(db)}`)
        console.warn(`[bridge]   match=${sent === db} | account_found=${!!account}`)
        try { ws.send(JSON.stringify({ type: 'auth_error', error: 'invalid_api_key' })) } catch {}
        try { ws.close(4002, 'invalid_api_key') } catch {}
        return
      }

      authenticated = true
      accountLabel = account.label
      clearTimeout(authTimeout)

      // Registrar conexión (si ya hay una previa abierta y viva, la cerramos).
      // Pero si esa previa está pending dispatched (esperando result), damos
      // gracia de 1s antes de matar — evita race condition donde una reconexión
      // mata la conexión que está procesando un comando.
      const existing = connections.get(accountId)
      if (existing && existing.ws.readyState === 1 /* OPEN */) {
        const ageMs = Date.now() - existing.lastSeen
        if (ageMs < 2000) {
          // Conexión muy reciente — probablemente race. Rechazamos esta NUEVA.
          console.log(`[bridge] Rechazando nueva conexión de ${accountLabel} — existente solo tiene ${ageMs}ms`)
          try { ws.send(JSON.stringify({ type: 'auth_error', error: 'duplicate_connection_race' })) } catch {}
          try { ws.close(4005, 'duplicate_race') } catch {}
          return
        }
        try { existing.ws.close(4003, 'replaced_by_new') } catch {}
      }
      connections.set(accountId, { ws, label: accountLabel, lastSeen: Date.now() })

      // Update DB
      await supabase.from('linkedin_accounts')
        .update({ extension_last_seen_at: new Date().toISOString() })
        .eq('id', accountId)

      console.log(`[bridge] ✅ Auth OK: ${accountLabel} (${accountId.slice(0,8)})`)
      ws.send(JSON.stringify({
        type: 'auth_ok',
        accountId,
        accountLabel,
        version: '0.1.0',
      }))
      return
    }

    // Mensajes autenticados
    const conn = connections.get(accountId)
    if (conn) conn.lastSeen = Date.now()

    switch (msg.type) {
      case 'pong':
        // ack del ping del server
        return
      case 'ping':
        try { ws.send(JSON.stringify({ type: 'pong', ts: msg.ts })) } catch {}
        return
      case 'command_result':
        await handleCommandResult(msg)
        return
      default:
        console.log(`[bridge] Unhandled msg type from ${accountLabel}: ${msg.type}`)
    }
  })

  ws.on('close', async (code, reason) => {
    console.log(`[bridge] WS closed for ${accountLabel ?? accountId} (code=${code} reason=${reason})`)
    // Solo remove si esta es la conexión activa (puede haber sido reemplazada)
    const current = connections.get(accountId)
    if (current && current.ws === ws) {
      connections.delete(accountId)
    }
  })

  ws.on('error', (err) => {
    console.warn(`[bridge] WS error for ${accountLabel ?? accountId}: ${err.message}`)
  })
}

// ── Procesar resultados de comandos ─────────────────────────────────────────

async function handleCommandResult(msg) {
  const { commandId, action, result } = msg
  if (!commandId) return

  const isError = result?.ok === false
  await supabase.from('extension_commands').update({
    status:       isError ? 'error' : 'completed',
    result:       result ?? null,
    error:        isError ? (result?.error ?? 'unknown') : null,
    completed_at: new Date().toISOString(),
  }).eq('id', commandId)

  console.log(`[bridge] Command ${commandId.slice(0,8)} (${action}) → ${isError ? 'ERROR' : 'OK'}`)

  // Capa 2: account-level circuit breaker (debounced 5min/account internamente)
  // Si error rate > 60% en últimos 30min → auto-pausa + alerta critical
  try {
    const { data: cmdAcc } = await supabase
      .from('extension_commands').select('account_id').eq('id', commandId).single()
    if (cmdAcc?.account_id) {
      await checkAccountHealthAndPause(cmdAcc.account_id)
    }
  } catch (err) {
    console.error(`[bridge] account health check error:`, err.message)
  }

  // Ingestion: si fue exitoso y la acción tiene ingest definido, procesamos
  if (!isError && action === 'check_inbox' && result?.conversations) {
    try {
      await ingestCheckInbox(commandId, result.conversations)
    } catch (err) {
      console.error(`[bridge] ingest check_inbox failed:`, err.message)
    }
  }
  // send_invite ingest — actualiza lead status + daily_activity counter
  if (!isError && action === 'send_invite' && ['sent', 'sent_unconfirmed', 'dry_run_ok'].includes(result?.status)) {
    try {
      await ingestSendInvite(commandId, result)
    } catch (err) {
      console.error(`[bridge] ingest send_invite failed:`, err.message)
    }
  }
  // send_followup ingest — actualiza lead.last_followup_at + daily_activity
  if (!isError && action === 'send_followup' && ['sent', 'sent_unconfirmed', 'dry_run_ok'].includes(result?.status)) {
    try {
      await ingestSendFollowup(commandId, result)
    } catch (err) {
      console.error(`[bridge] ingest send_followup failed:`, err.message)
    }
  }

  // Lead-level circuit breaker: si lead falla 3x con mismo error en últimas 6h
  // (que no esté ya manejado por otros handlers), kill automático.
  if (action === 'send_followup' && result?.error &&
      !['lead_not_first_degree', 'lead_invite_still_pending', 'profile_not_found'].includes(result.error)) {
    try {
      const { data: cmd } = await supabase
        .from('extension_commands')
        .select('related_lead_id')
        .eq('id', commandId)
        .single()
      if (cmd?.related_lead_id) {
        await checkAndKillLeadIfStuck(cmd.related_lead_id, result.error, { threshold: 3, windowHours: 6 })
      }
    } catch (err) {
      console.error(`[bridge] circuit breaker error:`, err.message)
    }
  }

  // profile_not_found = LinkedIn devolvió /404/ → lead deleted/private → marcar dead
  if (action === 'send_followup' && result?.error === 'profile_not_found') {
    try {
      const { data: cmd } = await supabase
        .from('extension_commands')
        .select('related_lead_id')
        .eq('id', commandId)
        .single()
      if (cmd?.related_lead_id) {
        await supabase.from('leads').update({
          status: 'dead',
          dead_reason: 'profile_404_linkedin',
        }).eq('id', cmd.related_lead_id)
        console.log(`[bridge] 💀 Lead ${cmd.related_lead_id.slice(0,8)} marcado dead: profile_404`)
      }
    } catch (err) {
      console.error(`[bridge] mark dead 404 failed:`, err.message)
    }
  }

  // Sub-Fase 3.8 fix: send_followup detectó que el lead NO está realmente conectado
  // (check_sent_invites tuvo false positive). Revertir lead.status a invite_sent.
  if (action === 'send_followup' &&
      (result?.error === 'lead_invite_still_pending' || result?.error === 'lead_not_first_degree')) {
    try {
      const { data: cmd } = await supabase
        .from('extension_commands')
        .select('related_lead_id')
        .eq('id', commandId)
        .single()
      if (cmd?.related_lead_id) {
        // Ambos errores significan que el lead NO es 1er grado / NO aceptó la invite.
        // Revertimos a invite_sent para que el lead siga en pipeline (puede aceptar
        // después). Marcamos dead_reason como FLAG para que check_sent_invites NO
        // lo vuelva a marcar connected automáticamente — evita ping-pong status.
        const updates = {
          status: 'invite_sent',
          connected_at: null,
          last_followup_at: null,
          dead_reason: 'detected_not_first_degree',
        }
        await supabase.from('leads').update(updates).eq('id', cmd.related_lead_id)
        console.log(`[bridge] ⚙️  Lead ${cmd.related_lead_id.slice(0,8)} revertido: ${result.error} → status=invite_sent + flag`)
      }
    } catch (err) {
      console.error(`[bridge] revert lead status failed:`, err.message)
    }
  }
  // search ingest — inserta leads nuevos en DB
  if (!isError && action === 'search' && result?.status === 'ok' && Array.isArray(result?.profiles)) {
    try {
      await ingestSearch(commandId, result)
    } catch (err) {
      console.error(`[bridge] ingest search failed:`, err.message)
    }
  }
  // check_sent_invites ingest — marca leads como connected si dejaron de estar pending
  if (!isError && action === 'check_sent_invites' && result?.status === 'ok' && Array.isArray(result?.pending)) {
    try {
      await ingestCheckSentInvites(commandId, result.pending)
    } catch (err) {
      console.error(`[bridge] ingest check_sent_invites failed:`, err.message)
    }
  }
}

// ── Ingest: check_sent_invites → marca accepts (leads que dejaron de estar pending)
async function ingestCheckSentInvites(commandId, pending) {
  const { data: cmd } = await supabase
    .from('extension_commands')
    .select('account_id')
    .eq('id', commandId)
    .single()
  if (!cmd?.account_id) return

  // Cargar leads invite_sent de campañas de esta cuenta.
  // Excluimos leads marcados con flag detected_not_first_degree para evitar
  // ping-pong (un FU detectó 2do grado y revirtió → no re-marcar como connected).
  const { data: invitedLeads } = await supabase
    .from('leads')
    .select('id, full_name, linkedin_url, sent_at, dead_reason, campaigns!inner(linkedin_account_id)')
    .eq('campaigns.linkedin_account_id', cmd.account_id)
    .eq('status', 'invite_sent')
    .or('dead_reason.is.null,dead_reason.neq.detected_not_first_degree')

  if (!invitedLeads || invitedLeads.length === 0) {
    console.log(`[bridge] check_sent_invites: 0 leads en invite_sent para esta cuenta`)
    return
  }

  // Normalizar urls de pending (LinkedIn agrega trailing slash, query params, etc.)
  const normalize = (url) => (url || '')
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?linkedin\.com/, '')
    .split('?')[0]
    .replace(/\/$/, '')
  const pendingUrls = new Set(pending.map(p => normalize(p.profileUrl)))
  const pendingNames = new Set(pending.map(p => (p.name ?? '').toLowerCase().trim()))

  let accepted = 0
  // Safety: solo marcar como connected si el invite tiene al menos 1h de antigüedad.
  // Evita marcar como accept un invite que justo se mandó hace 5 min cuya pestaña
  // todavía no actualizó la lista de pending.
  const minSentAgeMs = 60 * 60 * 1000

  for (const lead of invitedLeads) {
    if (!lead.sent_at) continue
    const ageMs = Date.now() - new Date(lead.sent_at).getTime()
    if (ageMs < minSentAgeMs) continue

    const urlMatch = pendingUrls.has(normalize(lead.linkedin_url))
    const nameMatch = lead.full_name && pendingNames.has(lead.full_name.toLowerCase().trim())
    const stillPending = urlMatch || nameMatch

    if (!stillPending) {
      // Lead ya no aparece como pending → fue aceptado (o withdraw)
      const { error } = await supabase.from('leads').update({
        status: 'connected',
        connected_at: new Date().toISOString(),
      }).eq('id', lead.id)
      if (!error) {
        accepted++
        console.log(`[bridge] ✅ Accept detectado: ${lead.full_name} (invite_sent → connected)`)
      }
    }
  }
  console.log(`[bridge] check_sent_invites ingest: ${accepted} accepts detectados de ${invitedLeads.length} pending`)
}

// ── Ingest: search → insertar leads nuevos en DB ───────────────────────────
async function ingestSearch(commandId, result) {
  const { data: cmd } = await supabase
    .from('extension_commands')
    .select('account_id, payload')
    .eq('id', commandId)
    .single()
  if (!cmd) return

  const campaignId = cmd.payload?.campaignId
  if (!campaignId) {
    console.warn(`[bridge] search ingest: payload sin campaignId`)
    return
  }

  const profiles = result.profiles ?? []
  if (profiles.length === 0) {
    console.log(`[bridge] search ${commandId.slice(0,8)}: 0 perfiles`)
    return
  }

  // Dedupe contra leads existentes en la campaña por linkedin_url
  const urls = profiles.map(p => p.profileUrl).filter(Boolean)
  const { data: existing } = await supabase
    .from('leads')
    .select('linkedin_url')
    .eq('campaign_id', campaignId)
    .in('linkedin_url', urls)
  const existingSet = new Set((existing ?? []).map(l => l.linkedin_url))

  const toInsert = profiles
    .filter(p => p.profileUrl && !existingSet.has(p.profileUrl))
    .map(p => ({
      campaign_id:  campaignId,
      linkedin_url: p.profileUrl,
      full_name:    p.name ?? null,
      profile_data: { headline: p.headline, location: p.location, source: 'extension_search' },
      status:       'scraped',
      source:       'extension_search',
      scraped_at:   new Date().toISOString(),
    }))

  if (toInsert.length === 0) {
    console.log(`[bridge] search ${commandId.slice(0,8)}: ${profiles.length} perfiles, todos duplicados`)
    return
  }

  const { error } = await supabase.from('leads').insert(toInsert)
  if (error) {
    console.error(`[bridge] search insert leads error:`, error.message)
    return
  }

  console.log(`[bridge] ✅ search ingested: ${toInsert.length} leads nuevos (${profiles.length - toInsert.length} duplicados) en campaña ${campaignId.slice(0,8)}`)
}

// ── Ingest: send_followup → actualizar lead.last_followup_at + daily_activity
async function ingestSendFollowup(commandId, result) {
  const { data: cmd } = await supabase
    .from('extension_commands')
    .select('account_id, payload, related_lead_id')
    .eq('id', commandId)
    .single()
  if (!cmd?.account_id) return

  const leadId = cmd.related_lead_id ?? cmd.payload?.leadId
  if (!leadId) {
    console.warn(`[bridge] send_followup ingest: sin leadId asociado`)
    return
  }

  if (result.status === 'dry_run_ok') {
    console.log(`[bridge] send_followup dry_run OK para lead ${leadId.slice(0, 8)}`)
    return
  }

  // kind='reply' (FM auto-reply) — NO cambia status del lead (sigue 'replied'),
  // solo registra el outbound event en conversation. El lead sigue activo en
  // la cadena de conversación FM hasta que responda de nuevo o convierta a meeting.
  const kind = cmd.payload?.kind ?? 'follow_up'
  const isReply = kind === 'reply'

  let statusValue = null
  let timestampField = null
  if (!isReply) {
    const step = cmd.payload?.step ?? 1
    statusValue = step === 1 ? 'follow_up_sent'
                : step === 2 ? 'follow_up_sent_2'
                : step === 3 ? 'follow_up_sent_3'
                : step === 4 ? 'follow_up_sent_4'
                : 'follow_up_sent_5'
    timestampField = step === 1 ? 'last_followup_at' : `last_followup${step}_at`

    await supabase.from('leads').update({
      status: statusValue,
      [timestampField]: new Date().toISOString(),
    }).eq('id', leadId)
  }

  await supabase.rpc('increment_daily_activity', {
    p_account_id: cmd.account_id,
    p_field:      'messages_sent',
  })

  // Registrar el evento + actualizar conversation
  const messageText = cmd.payload?.message
  if (messageText) {
    const { data: conv } = await supabase
      .from('conversations')
      .upsert({
        lead_id:             leadId,
        linkedin_account_id: cmd.account_id,
        status:              'active',
        last_message_at:     new Date().toISOString(),
        last_message_text:   `[Tú]: ${messageText.slice(0, 200)}`,
      }, { onConflict: 'lead_id' })
      .select('id')
      .single()

    if (conv?.id) {
      // Constraint-safe values:
      //   event_type ∈ {invite_sent, follow_up_sent[_2..5], reply_sent, message_sent, ...}
      //   sent_via   ∈ {orion, orion_auto, orion_manual, linkedin_*}
      const eventType = isReply ? 'reply_sent' : statusValue
      const { error: evErr } = await supabase.from('conversation_events').insert({
        conversation_id: conv.id,
        event_type:      eventType,
        direction:       'outbound',
        content:         messageText.slice(0, 4000),
        sent_at:         new Date().toISOString(),
        sent_via:        'orion_auto',
      })
      if (evErr) console.error(`[bridge] conversation_events insert failed: ${evErr.message} (event_type=${eventType})`)
    }

    // Sub-Fase 3.8: si content.js capturó thread_id (caso compose-new desde
    // perfil), guardarlo para futuros FU/FM.
    if (result.threadIdCaptured && conv?.id) {
      await supabase.from('conversations')
        .update({ linkedin_thread_id: result.threadIdCaptured })
        .eq('id', conv.id)
      console.log(`[bridge] ✅ thread_id capturado para lead ${leadId.slice(0,8)}: ${result.threadIdCaptured.slice(0, 30)}...`)
    }
  }

  if (isReply) {
    console.log(`[bridge] ✅ FM auto-reply enviado a lead ${leadId.slice(0,8)} (status sigue 'replied')`)
  } else {
    console.log(`[bridge] ✅ send_followup step ${cmd.payload?.step ?? 1} ingested: lead ${leadId.slice(0,8)} → ${statusValue}`)
  }
}

// ── Ingest: send_invite → actualizar lead.status + daily_activity ──────────
async function ingestSendInvite(commandId, result) {
  const { data: cmd } = await supabase
    .from('extension_commands')
    .select('account_id, payload, related_lead_id')
    .eq('id', commandId)
    .single()
  if (!cmd?.account_id) return

  const leadId = cmd.related_lead_id ?? cmd.payload?.leadId
  if (!leadId) {
    console.warn(`[bridge] send_invite ingest: sin leadId asociado`)
    return
  }

  // Si fue dry_run, NO actualizar DB (es test)
  if (result.status === 'dry_run_ok') {
    console.log(`[bridge] send_invite dry_run OK para lead ${leadId.slice(0, 8)} — DB no tocada`)
    return
  }

  // Actualizar lead: status='invite_sent', sent_at=now()
  await supabase.from('leads').update({
    status:  'invite_sent',
    sent_at: new Date().toISOString(),
  }).eq('id', leadId)

  // Incrementar daily_activity (CDMX date-aligned vía RPC)
  await supabase.rpc('increment_daily_activity', {
    p_account_id: cmd.account_id,
    p_field:      'invites_sent',
  })

  // Si el message fue tipeado, registrar conversation + event
  const messageText = cmd.payload?.message
  if (messageText && result.textareaUsed) {
    const { data: conv } = await supabase
      .from('conversations')
      .upsert({
        lead_id:             leadId,
        linkedin_account_id: cmd.account_id,
        status:              'initiated',
      }, { onConflict: 'lead_id' })
      .select('id')
      .single()

    if (conv?.id) {
      await supabase.from('conversation_events').insert({
        conversation_id: conv.id,
        event_type:      'invite_sent',
        direction:       'outbound',
        content:         messageText.slice(0, 4000),
        sent_at:         new Date().toISOString(),
        sent_via:        'orion_extension',
      })
    }
  }

  console.log(`[bridge] ✅ send_invite ingested: lead ${leadId.slice(0,8)} → invite_sent`)
}

// ── Ingest: check_inbox → match leads + mark connected + log replies ────────
async function ingestCheckInbox(commandId, conversations) {
  // 1. Identificar account
  const { data: cmd } = await supabase
    .from('extension_commands')
    .select('account_id, result')
    .eq('id', commandId)
    .single()
  if (!cmd?.account_id) return

  // 2. Cargar leads activos de la cuenta para matchear
  const { data: leads } = await supabase
    .from('leads')
    .select('id, full_name, status, linkedin_url, campaigns!inner(linkedin_account_id)')
    .eq('campaigns.linkedin_account_id', cmd.account_id)
    .in('status', ['invite_sent', 'connected', 'follow_up_sent', 'follow_up_sent_2',
                   'follow_up_sent_3', 'follow_up_sent_4', 'follow_up_sent_5', 'replied'])

  if (!leads || leads.length === 0) {
    console.log(`[bridge] ingest: no active leads for account ${cmd.account_id.slice(0,8)}`)
    return
  }

  const matches    = []
  const connected  = []
  const newReplies = []

  for (const convo of conversations) {
    if (!convo.name) continue
    const scrapedLower = convo.name.toLowerCase().trim()

    // Match: el primer nombre del scraped debe estar en el lead, o viceversa
    const scrapedFirst = scrapedLower.split(/\s+/)[0]
    const lead = leads.find(l => {
      const leadLower = (l.full_name ?? '').toLowerCase()
      const leadFirst = leadLower.split(/\s+/)[0]
      // Match si comparten primer nombre + algún apellido OR el nombre completo aparece embebido
      return (leadFirst === scrapedFirst && scrapedLower.includes(leadLower.split(' ').pop() ?? '__')) ||
             leadLower.includes(scrapedLower) ||
             scrapedLower.includes(leadLower)
    })

    if (!lead) continue
    matches.push({ scrapedName: convo.name, leadName: lead.full_name, status: lead.status, unread: convo.unread })

    // Si invite_sent y aparece en inbox → conexión aceptada
    if (lead.status === 'invite_sent') {
      const { error } = await supabase.from('leads').update({
        status: 'connected',
        connected_at: new Date().toISOString(),
      }).eq('id', lead.id)
      if (!error) {
        connected.push(lead.full_name)
        console.log(`[bridge] ✅ ${lead.full_name}: invite_sent → connected (detected via inbox)`)
      }
    }

    // Si unread > 0 + snippet existe → posible reply nueva del lead
    // Identificar si el snippet es del lead (no nuestro "Tú: ...")
    if (convo.unread > 0 && convo.snippet) {
      const snippet = convo.snippet ?? ''
      // LinkedIn shows "Tú:" para outbound y "Nombre:" para inbound (a veces nada)
      const isFromUser = /^(tú|tu|you)\s*:/i.test(snippet.trim())
      const snippetTrimmed = snippet.replace(/^[^:]+:\s*/, '').trim()

      if (!isFromUser) {
        // Es una reply REAL del lead — actualizar conversation + marcar replied
        const upsertData = {
          lead_id:             lead.id,
          linkedin_account_id: cmd.account_id,
          status:              'active',
          last_message_text:   snippetTrimmed.slice(0, 500),
          last_message_at:     new Date().toISOString(),
        }
        if (convo.threadId) upsertData.linkedin_thread_id = convo.threadId

        const { data: conv } = await supabase
          .from('conversations')
          .upsert(upsertData, { onConflict: 'lead_id' })
          .select('id, linkedin_thread_id')
          .single()

        // Marcar lead como 'replied' si venía de la cadena FU (pausa FU automática)
        const fuStatuses = ['invite_sent','connected','follow_up_sent','follow_up_sent_2','follow_up_sent_3','follow_up_sent_4','follow_up_sent_5']
        if (fuStatuses.includes(lead.status)) {
          await supabase.from('leads').update({
            status: 'replied',
            replied_at: new Date().toISOString(),
          }).eq('id', lead.id)
          console.log(`[bridge] 💬 Reply detectado: ${lead.full_name} → status='replied' (FU pausado)`)
        }

        // Registrar event inbound
        if (conv?.id) {
          await supabase.from('conversation_events').insert({
            conversation_id: conv.id,
            event_type:      'reply_received',
            direction:       'inbound',
            content:         snippetTrimmed.slice(0, 4000),
            sent_at:         new Date().toISOString(),
          })
        }

        newReplies.push({ lead: lead.full_name, snippet: snippetTrimmed.slice(0, 100), threadId: convo.threadId })
      }
    }
  }

  // 3. Persistir summary en extension_commands.result
  const updatedResult = {
    ...cmd.result,
    ingest: {
      total_scraped: conversations.length,
      total_active_leads: leads.length,
      matches: matches.length,
      connected_marked: connected.length,
      potential_new_replies: newReplies.length,
      details: { connected, newReplies: newReplies.slice(0, 5) },
    },
  }
  await supabase.from('extension_commands')
    .update({ result: updatedResult })
    .eq('id', commandId)

  console.log(`[bridge] ingest summary: ${matches.length} matched, ${connected.length} marked connected, ${newReplies.length} potential replies`)
}

// ── Poll de comandos pendientes ─────────────────────────────────────────────

async function pollAndDispatch() {
  const connectedAccountIds = Array.from(connections.keys())
  if (connectedAccountIds.length === 0) return

  // Sub-Fase 3.7: Serialización por cuenta para evitar tab collision.
  // Cada cuenta solo puede tener 1 comando NAVEGACIONAL en flight.
  // Si ya hay 'dispatched' para una cuenta, skipeamos esa cuenta este tick.
  const { data: inFlight } = await supabase
    .from('extension_commands')
    .select('account_id, action, dispatched_at')
    .eq('status', 'dispatched')
    .in('account_id', connectedAccountIds)
    .gt('expires_at', new Date().toISOString())

  const busyAccounts = new Set((inFlight ?? []).map(c => c.account_id))
  if (busyAccounts.size > 0) {
    const labels = [...busyAccounts].map(id => connections.get(id)?.label ?? id.slice(0,8))
    console.log(`[bridge] Cuentas con comando en flight (skip dispatch): ${labels.join(', ')}`)
  }

  const availableAccounts = connectedAccountIds.filter(id => !busyAccounts.has(id))
  if (availableAccounts.length === 0) return

  const { data: commands, error } = await supabase
    .from('extension_commands')
    .select('id, account_id, action, payload')
    .eq('status', 'pending')
    .in('account_id', availableAccounts)
    .gt('expires_at', new Date().toISOString())
    .order('created_at')
    .limit(20)

  if (error) {
    console.error(`[bridge] Poll error: ${error.message}`)
    return
  }
  if (!commands || commands.length === 0) return

  // De los pending: dispatch SOLO el primero por cuenta (FIFO).
  // Los demás esperan al próximo poll cuando este complete.
  const dispatchedThisTick = new Set()
  for (const cmd of commands) {
    if (dispatchedThisTick.has(cmd.account_id)) continue
    const conn = connections.get(cmd.account_id)
    if (!conn || conn.ws.readyState !== 1 /* OPEN */) continue

    // Marcar como dispatched (atómico — RLS para evitar double-dispatch)
    const { data: claimed } = await supabase
      .from('extension_commands')
      .update({ status: 'dispatched', dispatched_at: new Date().toISOString() })
      .eq('id', cmd.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()

    if (!claimed) continue  // otro poll lo tomó

    try {
      conn.ws.send(JSON.stringify({
        type:      'command',
        commandId: cmd.id,
        action:    cmd.action,
        payload:   cmd.payload,
      }))
      dispatchedThisTick.add(cmd.account_id)  // serialization marker
      console.log(`[bridge] Dispatched ${cmd.action} to ${conn.label} (cmd ${cmd.id.slice(0,8)})`)
    } catch (err) {
      console.error(`[bridge] Dispatch error: ${err.message}`)
      // Revert status
      await supabase.from('extension_commands')
        .update({ status: 'pending', dispatched_at: null })
        .eq('id', cmd.id)
    }
  }
}

// ── Heartbeat: keep-alive + detección de desconexión ───────────────────────

function pingAll() {
  const now = Date.now()
  for (const [accountId, conn] of connections.entries()) {
    if (now - conn.lastSeen > HEARTBEAT_TIMEOUT_MS) {
      console.log(`[bridge] Account ${conn.label} stale > 5min — closing`)
      try { conn.ws.close(4004, 'stale_heartbeat') } catch {}
      connections.delete(accountId)
      continue
    }
    try { conn.ws.send(JSON.stringify({ type: 'ping', ts: now })) } catch {}
  }
}

// ── Timeout cleanup: comandos vencidos → status='timeout' ──────────────────

async function cleanupExpired() {
  const { error } = await supabase
    .from('extension_commands')
    .update({ status: 'timeout', error: 'extension_did_not_respond' })
    .in('status', ['pending', 'dispatched'])
    .lt('expires_at', new Date().toISOString())
  if (error) console.error(`[bridge] Cleanup error: ${error.message}`)
}

// ── Start ───────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[bridge] 🚀 Extension WebSocket bridge listening on :${PORT}`)
  console.log(`[bridge]    Health: http://localhost:${PORT}/health`)
  console.log(`[bridge]    WS:     ws://localhost:${PORT}/api/extension/ws?account=<uuid>`)
})

setInterval(pollAndDispatch, POLL_INTERVAL_MS)
setInterval(pingAll, 30_000)
setInterval(cleanupExpired, 30_000)  // reap zombies más rápido (antes 60s)
