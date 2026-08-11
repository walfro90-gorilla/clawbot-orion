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
import { supabase } from './lib/supabase.js'
import dotenv from 'dotenv'
import { checkAndKillLeadIfStuck, checkAccountHealthAndPause, dispatchInvite, LEAD_FAULT_ERRORS } from './lib/extension-dispatch.js'
import { isSystemLinkedInAccount } from './lib/system-accounts.js'
import { isGroupConversationName } from './lib/group-conversation.js'
import { applyLeadAttemptOutcome, isNonFaultError } from './lib/lead-failure.js'

dotenv.config()

const PORT = parseInt(process.env.EXTENSION_BRIDGE_PORT ?? '4002')
// Post-mortem 2026-07-03: 3s = ~115k queries/día de piso (haya o no trabajo), principal
// drenaje continuo del IO-burst en Nano. 10s = −67% carga base; la latencia de dispatch ≤10s
// es irrelevante para automatización de LinkedIn (los command_result llegan por WS push, no poll).
const POLL_INTERVAL_MS = parseInt(process.env.EXTENSION_POLL_INTERVAL_MS ?? '10000')
// Reduced from 5min to 90s (2026-05-29 "Reloj Suizo" plan) — antes el server
// creía conectado mientras el SW dormía, dejando un gap de hasta 5min antes
// de detectar disconnect. 90s = 6× margen sobre alarm keep-alive cada 15s.
const HEARTBEAT_TIMEOUT_MS = 90 * 1000

// Auth lockout server-side: si una mismo accountId falla auth >5 veces en 2min,
// lo bloqueamos 5min para evitar 50+ Auth FAILED en logs por loop infinito del cliente.
const AUTH_FAILURES = new Map() // accountId → { count, firstFailAt, lockedUntil }
const AUTH_FAIL_WINDOW_MS = 2 * 60 * 1000
const AUTH_FAIL_THRESHOLD = 5
const AUTH_LOCKOUT_MS = 5 * 60 * 1000

// Cliente Supabase con timeout (fetchWithTimeout 20s) desde lib/supabase.js.
// Post-mortem 2026-07-03: el bridge usaba createClient CRUDO sin timeout → sus queries
// colgaban ~indefinidamente bajo un 522 de Cloudflare, fugando sockets y sumando presión
// al pooler ya saturado. El cliente compartido acota cada query y libera el socket al abortar.
// (supabase importado arriba desde ./lib/supabase.js)

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

// v0.7.13 stress test harness — readStressTestLockBridge: si activo y no expirado,
// retorna account_id afectado. pollAndDispatch usa esto para dejar pasar SOLO
// commands con payload.is_stress_test=true para esa cuenta.
async function readStressTestLockBridge() {
  const { data } = await supabase
    .from('runtime_config')
    .select('value')
    .eq('key', 'stress_test_lock')
    .maybeSingle()
  const v = data?.value
  if (!v?.active) return null
  if (v.expires_at && new Date(v.expires_at).getTime() < Date.now()) return null
  return v.account_id ?? null
}

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

        // Auth lockout: tracker de fallos por accountId
        const now = Date.now()
        let tracker = AUTH_FAILURES.get(accountId)
        if (!tracker || now - tracker.firstFailAt > AUTH_FAIL_WINDOW_MS) {
          tracker = { count: 0, firstFailAt: now, lockedUntil: 0 }
        }
        tracker.count++
        AUTH_FAILURES.set(accountId, tracker)

        if (tracker.count >= AUTH_FAIL_THRESHOLD && tracker.lockedUntil < now) {
          tracker.lockedUntil = now + AUTH_LOCKOUT_MS
          console.warn(`[bridge] 🔒 AUTH LOCKOUT for ${accountId} — ${tracker.count} failures in ${Math.round((now - tracker.firstFailAt)/1000)}s, blocked for 5min`)
        }

        // Si está locked, rechazar sin logear los detalles repetidos
        if (tracker.lockedUntil > now) {
          try { ws.send(JSON.stringify({ type: 'auth_error', error: 'too_many_auth_failures_locked', retryAfter: tracker.lockedUntil })) } catch {}
          try { ws.close(4002, 'auth_locked_5min') } catch {}
          return
        }

        console.warn(`[bridge] Auth FAILED for ${accountId} (${tracker.count}/${AUTH_FAIL_THRESHOLD})`)
        console.warn(`[bridge]   sent: ${fmt(sent)}`)
        console.warn(`[bridge]   db:   ${fmt(db)}`)
        console.warn(`[bridge]   match=${sent === db} | account_found=${!!account}`)
        try { ws.send(JSON.stringify({ type: 'auth_error', error: 'invalid_api_key' })) } catch {}
        try { ws.close(4002, 'invalid_api_key') } catch {}
        return
      }
      // Auth OK: reset tracker
      AUTH_FAILURES.delete(accountId)

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
          //
          // ⚠️ NO mandes auth_error aquí (incidente Josh, 16-jul-2026). El cliente mete
          // CUALQUIER auth_error en el mismo lockout de 5 MINUTOS que 'invalid_api_key'
          // (background.js:379, único escritor de auth_lockout_until) → un race transitorio
          // de ~600ms dejaba la cuenta 5 min offline con un banner rojo "Error de
          // autenticación" que ni siquiera está en ERROR_MESSAGES del popup. Son problemas
          // opuestos: invalid_api_key no se arregla reintentando; esto se arregla en 2s.
          //
          // Cerrando a secas, el listener 'close' de la extensión hace scheduleReconnect()
          // y reconecta limpio (~2s), cuando este `existing` ya pasó los 2000ms. Sirve para
          // la v0.9.25 YA desplegada, sin recargar la extensión en cada laptop.
          // El motivo queda en el close code 4005 + este log para diagnóstico.
          console.log(`[bridge] Rechazando nueva conexión de ${accountLabel} — existente solo tiene ${ageMs}ms (cierre silencioso: reintenta solo en ~2s)`)
          try { ws.close(4005, 'duplicate_race') } catch {}
          return
        }
        try { existing.ws.close(4003, 'replaced_by_new') } catch {}
      }
      connections.set(accountId, { ws, label: accountLabel, lastSeen: Date.now() })

      // Update DB con ext_version reportada (Chrome ext envía msg.version)
      const extVer = msg.extVersion ?? msg.version ?? null
      await supabase.from('linkedin_accounts')
        .update({
          extension_last_seen_at: new Date().toISOString(),
          ...(extVer ? { ext_version: extVer } : {}),
        })
        .eq('id', accountId)

      // Log connect event para auditoría de uptime
      await supabase.from('account_connectivity_log').insert({
        linkedin_account_id: accountId,
        event_type:          'connected',
        ext_version:         extVer,
        details:             { source: 'ws_auth_ok', userAgent: msg.userAgent ?? null },
      })

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

    // Persistir extension_last_seen_at en cada ping (throttled a 2min/cuenta) para
    // que la métrica refleje liveness REAL — no solo el momento de auth. Permite
    // distinguir "SW vivo conectado" de "SW muerto hace rato" en dashboard/popup.
    if ((msg.type === 'ping' || msg.type === 'pong') && conn) {
      const lastPersist = conn.lastSeenPersisted ?? 0
      if (Date.now() - lastPersist > 120_000) {
        conn.lastSeenPersisted = Date.now()
        supabase.from('linkedin_accounts')
          .update({ extension_last_seen_at: new Date().toISOString() })
          .eq('id', accountId)
          .then(() => {}).catch(() => {})
      }
    }

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
      case 'command_ack':
        // Opción B telemetría: content.js confirmó RECEPCIÓN (pre-ejecución).
        // Sella acked_at para clasificar el residuo si luego expira sin resultado.
        await handleCommandAck(msg)
        return
      case 'phase_update':
        // v0.7.0 FSM: persistir el phase + log de timeline para auditing/resume
        await handlePhaseUpdate(msg)
        return
      case 'micro_phase':
        // v0.7.2 µ-PHASE: append a micro_phase_log JSONB (más granular que phase_log)
        await handleMicroPhase(msg)
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
      if (accountId) {
        // Log disconnect para auditoría
        supabase.from('account_connectivity_log').insert({
          linkedin_account_id: accountId,
          event_type:          'disconnected',
          details:             { code, reason: String(reason ?? '').slice(0, 100) },
        }).then(() => {}).catch(err => console.warn('[bridge] disconnect log failed:', err.message))
      }
    }
  })

  ws.on('error', (err) => {
    console.warn(`[bridge] WS error for ${accountLabel ?? accountId}: ${err.message}`)
  })
}

// ── v0.7.2 µ-PHASE handler ─────────────────────────────────────────────────
async function handleMicroPhase(msg) {
  const { commandId, action, entry } = msg
  if (!commandId || !entry) return
  try {
    const { data: cmd } = await supabase
      .from('extension_commands')
      .select('micro_phase_log')
      .eq('id', commandId)
      .maybeSingle()
    const prev = Array.isArray(cmd?.micro_phase_log) ? cmd.micro_phase_log : []
    const next = [...prev, entry].slice(-100)  // cap a 100 transitions
    const { error: upErr } = await supabase
      .from('extension_commands')
      .update({ micro_phase_log: next })
      .eq('id', commandId)
    if (upErr) console.warn(`[bridge] micro_phase persist failed: ${upErr.message}`)
  } catch (err) {
    console.warn(`[bridge] handleMicroPhase error:`, err.message)
  }
}

// ── v0.7.0 FSM: handler de phase updates ────────────────────────────────────
async function handlePhaseUpdate(msg) {
  const { commandId, phase, ts, extra } = msg
  if (!commandId || !phase) return
  try {
    // Append a phase_log y update current_phase. Usa fetch-modify-update porque
    // Supabase no soporta jsonb_append nativo via REST.
    const { data: cmd } = await supabase
      .from('extension_commands')
      .select('phase_log')
      .eq('id', commandId)
      .maybeSingle()
    const prevLog = Array.isArray(cmd?.phase_log) ? cmd.phase_log : []
    const newEntry = { phase, ts, extra: extra ?? null }
    const newLog = [...prevLog, newEntry].slice(-30)  // cap a 30 transitions
    const { error: upErr } = await supabase
      .from('extension_commands')
      .update({ phase_log: newLog, current_phase: phase })
      .eq('id', commandId)
    if (upErr) console.warn(`[bridge] phase_update persist failed: ${upErr.message}`)
  } catch (err) {
    console.warn(`[bridge] handlePhaseUpdate error:`, err.message)
  }
}

// ── Opción B: ACK de recepción ──────────────────────────────────────────────
// content.js manda orion_cmd_ack al recibir el comando (antes de ejecutar). El SW
// lo reenvía como command_ack. Sólo sellamos acked_at si aún no estaba (idempotente)
// y el comando sigue dispatched (no pisar uno ya completado).
async function handleCommandAck(msg) {
  const { commandId } = msg
  if (!commandId) return
  try {
    const { error } = await supabase
      .from('extension_commands')
      .update({ acked_at: new Date().toISOString() })
      .eq('id', commandId)
      .eq('status', 'dispatched')
      .is('acked_at', null)
    if (error) console.warn(`[bridge] command_ack persist failed: ${error.message}`)
  } catch (err) {
    console.warn(`[bridge] handleCommandAck error:`, err.message)
  }
}

// ── Procesar resultados de comandos ─────────────────────────────────────────

async function handleCommandResult(msg) {
  const { commandId, action, result } = msg
  if (!commandId) return

  // v0.7.10 fantasma fix: la extensión emite {status:'error', error:'<code>'}
  // sin tocar ok. Antes sólo mirábamos result?.ok===false → 96% de los fallos
  // se persistían como 'completed' con error=null, generando métricas fantasma.
  // Ahora cualquier de los dos shapes cuenta como error.
  const isError = result?.ok === false || result?.status === 'error'
  await supabase.from('extension_commands').update({
    status:       isError ? 'error' : 'completed',
    result:       result ?? null,
    error:        isError ? (result?.error ?? result?.reason ?? 'unknown') : null,
    completed_at: new Date().toISOString(),
  }).eq('id', commandId)

  console.log(`[bridge] Command ${commandId.slice(0,8)} (${action}) → ${isError ? `ERROR (${result?.error ?? result?.status ?? 'unknown'})` : 'OK'}`)

  // daily_activity.errors (17-jul): contar el error para el tile por cuenta — SOLO si NO es un
  // lead-fault benigno (not_first_degree, etc.). Así el contador (que llevaba en 0 desde siempre)
  // refleja fallas reales de sistema/página/red, no ruido esperado. Query de account_id solo en error.
  if (isError) {
    const errCode = result?.error ?? result?.reason ?? 'unknown'
    if (!LEAD_FAULT_ERRORS.has(errCode)) {
      const { data: cAcct } = await supabase.from('extension_commands').select('account_id').eq('id', commandId).maybeSingle()
      if (cAcct?.account_id) {
        const { error: incErrErr } = await supabase.rpc('increment_daily_activity', { p_account_id: cAcct.account_id, p_field: 'errors' })
        if (incErrErr) console.error(`[bridge] ❌ RPC increment_daily_activity(errors) ${cAcct.account_id.slice(0,8)}: ${incErrErr.message}`)
      }
    }
  }

  // ── Lead fault-tolerance tracking (FIFO + cooldown + quarantine) ──────────
  // Solo para acciones lead-scoped (invite/followup/reply). check_inbox/search
  // no tienen related_lead_id. awaiting_response NO cuenta como fault — el
  // helper isNonFaultError lo filtra. NO depende del fallback FSM de abajo:
  // si fue ok-success o ok-status-tolerable, contamos como success aquí.
  if (action === 'send_followup' || action === 'send_invite') {
    try {
      // BUG-H fix 2026-06-04: añadir payload al select y gate is_stress_test
      // para que stress dryRun NO contamine counters del lead real.
      // Asimetría histórica: dispatch-time YA tenía el gate (extension-dispatch.js:561)
      // pero handleCommandResult lo había omitido.
      const { data: cmdLead } = await supabase
        .from('extension_commands')
        .select('related_lead_id, payload')
        .eq('id', commandId)
        .maybeSingle()
      const isStressTest = !!cmdLead?.payload?.is_stress_test
      if (cmdLead?.related_lead_id && !isStressTest) {
        const errCode = isError ? (result?.error ?? 'unknown') : null
        const outcome = isError ? 'failure' : 'success'
        // awaiting_response llega como result.status (no ok=false). Si llega así,
        // tratamos como non-fault explicitamente para no resetear failures.
        if (!isError && result?.status === 'awaiting_response') {
          // skip — handler dedicado más abajo se encarga; failures intact.
        } else if (outcome === 'failure' && isNonFaultError(errCode)) {
          // no-op: errors manejados por handlers especiales no cuentan
        } else {
          await applyLeadAttemptOutcome(cmdLead.related_lead_id, outcome, errCode)
        }
      } else if (isStressTest) {
        console.log(`[bridge] [stress] applyLeadAttemptOutcome skipped (is_stress_test=true, lead=${cmdLead?.related_lead_id?.slice(0,8)})`)
      }
    } catch (err) {
      console.error(`[bridge] applyLeadAttemptOutcome failed: ${err.message}`)
    }
  }

  // Capa 3: "No current window" counter (Chrome cerrado detection)
  try {
    const { data: cmdAcc } = await supabase
      .from('extension_commands').select('account_id').eq('id', commandId).single()
    if (cmdAcc?.account_id) {
      const errMsg = String(result?.error ?? '').toLowerCase()
      if (errMsg.includes('no current window')) {
        recordNoWindowError(cmdAcc.account_id)
      } else if (!isError) {
        // Cmd exitoso → reset counter (Chrome volvió a estar disponible)
        resetNoWindowCounter(cmdAcc.account_id)
      }
      // Capa 2: account-level circuit breaker (debounced 5min/account internamente)
      await checkAccountHealthAndPause(cmdAcc.account_id)
    }
  } catch (err) {
    console.error(`[bridge] account health check error:`, err.message)
  }

  // v0.7.16 — LinkedIn security banner handler.
  // content.js retorna {error:'linkedin_security_check', bannerCode, bannerSeverity}.
  // critical → pause account 12-24h + alert critical; warning → cooldown 30min + alert.
  if (result?.error === 'linkedin_security_check') {
    try {
      const { data: cmdRow } = await supabase
        .from('extension_commands').select('account_id, related_lead_id').eq('id', commandId).single()
      const acctId = cmdRow?.account_id
      const code = result.bannerCode || 'unknown_banner'
      const sev = result.bannerSeverity || 'warning'
      console.warn(`[bridge] LinkedIn security banner detected: ${code} (${sev}) account=${acctId?.slice?.(0,8)}`)

      if (acctId && sev === 'critical') {
        const pauseHrs = code === 'captcha_checkpoint' ? 24 : code === 'account_locked' ? 12 : 1
        const pauseUntil = new Date(Date.now() + pauseHrs * 3_600_000).toISOString()
        // v0.7.21 P1-4: capturar error explícitamente (anti silent-fail)
        const { error: upErr } = await supabase.from('linkedin_accounts').update({
          extension_paused: true,
          extension_paused_until: pauseUntil,
          extension_paused_reason: `banner_${code}`,
        }).eq('id', acctId)
        if (upErr) console.error(`[bridge] banner critical update failed: ${upErr.message}`)
        // v0.8 FIX: columnas correctas de account_alerts (antes usaba account_id/code/metadata
        // inexistentes + faltaba alert_type NOT NULL → el insert FALLABA silencioso → la cuenta
        // se pausaba por banner SIN alerta visible = "pauser silencioso").
        const { error: alErr } = await supabase.from('account_alerts').insert({
          linkedin_account_id: acctId,
          alert_type: `banner_${code}`,
          severity: 'critical',
          message: `LinkedIn security checkpoint (${code}). Account paused ${pauseHrs}h until ${pauseUntil}.`,
          details: { textSignal: result.textSignal, selectorSignal: result.selectorSignal, commandId },
          auto_paused: true,
        })
        if (alErr) console.error(`[bridge] banner critical alert insert failed: ${alErr.message}`)
      } else if (acctId && sev === 'warning') {
        const cooldownUntil = new Date(Date.now() + 30 * 60_000).toISOString()
        // v0.7.21 P1-4: capturar error explícitamente + log consistente con critical
        const { error: upErr } = await supabase.from('linkedin_accounts').update({
          extension_paused_until: cooldownUntil,
          extension_paused_reason: `banner_${code}`,
        }).eq('id', acctId)
        if (upErr) console.error(`[bridge] banner warning update failed: ${upErr.message}`)
        const { error: alErr } = await supabase.from('account_alerts').insert({
          linkedin_account_id: acctId,
          alert_type: `banner_${code}`,
          severity: 'warning',
          message: `LinkedIn rate/limit warning (${code}). Cooldown 30min until ${cooldownUntil}.`,
          details: { textSignal: result.textSignal, selectorSignal: result.selectorSignal, commandId },
        })
        if (alErr) console.error(`[bridge] banner warning alert insert failed: ${alErr.message}`)
      }
      // No contar como lead-fault: el lead no falló por sí mismo.
      // (isNonFaultError no incluye este código — añadir a NON_FAULT_ERRORS)
    } catch (err) {
      console.error(`[bridge] banner handler failed:`, err.message)
    }
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
  // v7 SalesNav: la extensión resolvió el /in/ público del lead (SalesNav pide email a 2do-grado
  // frío → no se conecta desde ahí). Persistimos linkedin_url=/in/ y dejamos el lead 'scraped':
  // el próximo tick lo invita desde el perfil PÚBLICO (flujo free, sin muro de email) y el FU
  // luego funciona. Des-pausamos por si estaba pausado por la mitigación del loop de FU.
  if (!isError && action === 'send_invite' && result?.status === 'resolve_public_profile' && result?.resolvedProfileUrl) {
    try {
      const { data: c } = await supabase.from('extension_commands')
        .select('related_lead_id, payload').eq('id', commandId).single()
      const lid = c?.related_lead_id ?? c?.payload?.leadId
      if (lid && /linkedin\.com\/in\//.test(result.resolvedProfileUrl)) {
        await supabase.from('leads')
          .update({ linkedin_url: result.resolvedProfileUrl, automation_paused: false })
          .eq('id', lid)
        console.log(`[bridge] ✅ SalesNav lead ${lid.slice(0,8)} → /in/ resuelto (${result.resolvedProfileUrl}); re-invita free next tick`)
      }
    } catch (err) {
      console.error(`[bridge] resolve_public_profile persist failed:`, err.message)
    }
  }
  // send_followup ingest — actualiza lead.last_followup_at + daily_activity
  // v0.6.45: 'already_responded' = pre-send guard detectó que ya respondimos
  // v0.7.0: 'sent_confirmed' = FSM confirmó por DOM fingerprint que el msg está visible
  // v0.7.0: si error pero phase >= send_clicked → ingest como sent_unconfirmed
  //         (Send fue presionado, asumir que LinkedIn lo procesó, no reintentar).
  const okStatuses = ['sent', 'sent_unconfirmed', 'sent_confirmed', 'dry_run_ok', 'already_responded']
  let shouldIngest = !isError && action === 'send_followup' && okStatuses.includes(result?.status)
  if (!shouldIngest && action === 'send_followup') {
    // v0.7.0 fallback: si el cmd entró a phase 'send_clicked' o 'send_confirmed'
    // y luego falló por timeout/error, igual ingestamos como sent_unconfirmed.
    // v0.7.14 (caso Rodrigo Centeno 01-jun): EXTENDIDO también a phase='typed'
    // cuando el error es POST-typing (selector_drift en confirm DOM o LinkedIn
    // truncó la captura). Si llegó a typed con result.reason='truncated' o
    // result.error matches message_in_dom_*/send_button_*/confirm_*, asumimos
    // que el mensaje sí salió a LinkedIn (lo visual confirma en screenshot del
    // usuario) y los fallos son del verify DOM, no del send real.
    try {
      const { data: cmd } = await supabase
        .from('extension_commands')
        .select('current_phase, payload')
        .eq('id', commandId).maybeSingle()
      const ph = cmd?.current_phase
      const reason = String(result?.reason ?? result?.error ?? '').toLowerCase()
      const isPostTypingFailure = /truncated|message_in_dom|send_button_(?:not_found|enabled_timeout)|confirm_(?:timeout|failed)/.test(reason)
      if (ph === 'send_confirmed' || ph === 'send_clicked' || (ph === 'typed' && isPostTypingFailure)) {
        const fallbackStatus = ph === 'send_confirmed' ? 'sent_confirmed' : 'sent_unconfirmed'
        console.log(`[bridge] 🔁 FSM fallback v0.7.14: cmd ${commandId.slice(0,8)} phase=${ph} reason="${reason.slice(0,40)}" → ingest as ${fallbackStatus}`)
        result = { ...result, status: fallbackStatus, message: cmd.payload?.message }
        shouldIngest = true
      }
    } catch (err) {
      console.warn(`[bridge] FSM fallback check failed:`, err.message)
    }
  }
  if (shouldIngest) {
    try {
      await ingestSendFollowup(commandId, result)
      if (result.status === 'already_responded') {
        console.log(`[bridge] ↻ already_responded: ${result.lastOutboundPreview?.slice(0,60)}…`)
      } else if (result.status === 'sent_confirmed') {
        console.log(`[bridge] ✅✅ sent_confirmed (FSM DOM polling matched fingerprint)`)
      }
    } catch (err) {
      console.error(`[bridge] ingest send_followup failed:`, err.message)
    }
  }

  // Lead-level circuit breaker: si lead falla 3x con mismo error en últimas 6h
  // (que no esté ya manejado por otros handlers), kill automático.
  // v0.7.8: awaiting_response NO es error — el detector reporta status, no error;
  //         pero excluimos lead_not_messageable y awaiting_response defensivamente.
  if (action === 'send_followup' && result?.error &&
      !['lead_not_first_degree', 'lead_invite_still_pending', 'profile_not_found',
        'lead_not_messageable', 'awaiting_response'].includes(result.error)) {
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

  // v0.7.6: lead_not_messageable = LinkedIn cerró el thread (2°/3° + sin respuesta,
  // InMail required, sponsored thread). NO reintentar — marcar lead apropiadamente.
  if (action === 'send_followup' && result?.error === 'lead_not_messageable') {
    try {
      const { data: cmd } = await supabase
        .from('extension_commands')
        .select('related_lead_id')
        .eq('id', commandId)
        .single()
      if (cmd?.related_lead_id) {
        const reason = result.reason ?? 'unknown'
        // 2°/3° + InMail required: lead NO es 1er grado, revert a invite_sent
        // para que check_sent_invites lo re-verifique (no kill permanente).
        if (reason.includes('2nd_degree') || reason.includes('3rd_degree') ||
            reason.includes('inmail_required') || reason.includes('inmail_credits')) {
          // (2026-07-04) Si estuvo GENUINAMENTE conectado, ser 2do/3er grado AHORA = el
          // contacto nos ELIMINÓ → Super DEAD (no re-invitar). Solo si NO hubo conexión real
          // aplicamos el revert-con-cap (falso accept / lead InMail-only de siempre).
          if (await wasGenuinelyConnected(cmd.related_lead_id)) {
            await markDisconnectedSuperDead(cmd.related_lead_id, `not_messageable_${reason}`)
          } else {
          // v0.7.13 P1-1: contar reverts. Si >= cap → dead (evita loop infinito).
          // Antes de v0.7.13, un lead InMail-only se quedaba rebotando entre
          // invite_sent → check_inbox → revert → infinito.
          const { data: leadRow } = await supabase
            .from('leads')
            .select('inmail_revert_count')
            .eq('id', cmd.related_lead_id)
            .maybeSingle()
          const newCount = (leadRow?.inmail_revert_count ?? 0) + 1
          const { data: capCfg } = await supabase
            .from('runtime_config').select('value').eq('key', 'inmail_revert_cap').maybeSingle()
          const cap = typeof capCfg?.value === 'number' ? capCfg.value : 2
          if (newCount >= cap) {
            await supabase.from('leads').update({
              status: 'dead',
              dead_reason: 'inmail_only_x' + newCount,
              inmail_revert_count: newCount,
            }).eq('id', cmd.related_lead_id)
            console.log(`[bridge] 💀 lead ${cmd.related_lead_id.slice(0,8)} dead: inmail_only_x${newCount} (cap ${cap})`)
          } else {
            await supabase.from('leads').update({
              status: 'invite_sent',
              connected_at: null,
              // (2026-07-06) GAP-2: flag CANÓNICO. 2do/3er-grado/InMail ES no-first-degree → usar el
              // mismo string que reconocen los guards (846 check_sent_invites / 976 check_connections /
              // 1743 check_inbox / dispatch) para que NO se re-marque connected ni se re-despache FU.
              // (`reason` queda en el log para diagnóstico; inmail_revert_count sigue como telemetría.)
              dead_reason: 'detected_not_first_degree',
              inmail_revert_count: newCount,
            }).eq('id', cmd.related_lead_id)
            console.log(`[bridge] 🚫 lead ${cmd.related_lead_id.slice(0,8)} reverted ${newCount}/${cap}: not_first_degree via not_messageable (${reason})`)
          }
          }
        } else if (reason.includes('sponsored')) {
          // Sponsored thread = no es real lead, mark dead permanent
          await supabase.from('leads').update({
            status: 'dead',
            dead_reason: 'sponsored_thread',
          }).eq('id', cmd.related_lead_id)
        } else if (reason.includes('awaiting_reply') || reason.includes('no_editor_with_awaiting') || reason.includes('awaiting_response') || reason.includes('cannot_message') || reason.includes('message_blocked')) {
          // v0.7.15 Fix B: awaiting_reply_badge / no_editor_with_awaiting = LinkedIn
          // anti-spam window (lead anti-spam-locked hasta que ELLOS respondan).
          // Antes esto sólo seteaba dead_reason flag → status seguía 'connected' →
          // smart-sync drift → scheduler re-despachaba → loop infinito (caso Alfonso
          // Martinez 2026-06-02: 2 cmds en 4h, ambos error_lead_not_messageable).
          // Fix: mover a status='awaiting_response' que el sweep v0.7.8 mata al 21d.
          await supabase.from('leads').update({
            status: 'awaiting_response',
            awaiting_response_since: new Date().toISOString(),
            awaiting_response_reason: reason.slice(0, 200),
            dead_reason: null,
          }).eq('id', cmd.related_lead_id)
          console.log(`[bridge] ⏳ lead ${cmd.related_lead_id.slice(0,8)} → awaiting_response (${reason.slice(0,40)})`)
        } else {
          // Reason desconocida — flag pero NO cambiar status (defensive)
          await supabase.from('leads').update({
            dead_reason: `not_messageable_${reason}`.slice(0, 100),
          }).eq('id', cmd.related_lead_id)
        }
      }
    } catch (err) {
      console.error(`[bridge] lead_not_messageable handler failed:`, err.message)
    }
  }

  // v0.7.48: thread ROTO en auto-reply/FU. thread_header_mismatch = el linkedin_thread_id
  // capturado apunta a OTRA persona (el bot YA abortó para no mandar al equivocado, correcto).
  // thread_editor_not_found = el thread abre sin editor (grupo/InMail/restringido o stale).
  // Estos son comunes en inbounds recuperados por el deep sweep con captura imperfecta → el
  // lead se queda 'replied' sin contestar. Fix: LIMPIAR el thread_id malo de la conversación →
  // el próximo check_inbox/deep-sweep le re-captura el thread correcto (por nombre) y reintenta.
  // El give-up lo acota la cuarentena (5 consecutive_failures) — no necesita contador propio.
  if (action === 'send_followup' && (result?.error === 'thread_header_mismatch' || result?.error === 'thread_editor_not_found')) {
    try {
      const { data: cmd } = await supabase
        .from('extension_commands').select('related_lead_id').eq('id', commandId).single()
      if (cmd?.related_lead_id) {
        await supabase.from('conversations')
          .update({ linkedin_thread_id: null })
          .eq('lead_id', cmd.related_lead_id)
        console.log(`[bridge] 🧵 lead ${cmd.related_lead_id.slice(0,8)}: thread malo limpiado (${result.error}) → re-captura en próximo check_inbox`)
      }
    } catch (err) {
      console.error(`[bridge] thread-reset handler failed:`, err.message)
    }
  }

  // v0.7.8: awaiting_response = LinkedIn aplica ban window al lead conectado
  // (banner "no has recibido respuesta aún" + composer/send disabled).
  // NO es error: lead está OK, solo hay que esperar. Marcamos status especial
  // sin consumir retry, sin avanzar fu_count, sin ingest de mensaje.
  if (action === 'send_followup' && result?.status === 'awaiting_response') {
    try {
      const { data: cmd } = await supabase
        .from('extension_commands')
        .select('related_lead_id')
        .eq('id', commandId)
        .single()
      if (cmd?.related_lead_id) {
        const rawReason = result.reason ?? 'unknown'
        const reasonStr = String(typeof rawReason === 'string' ? rawReason : JSON.stringify(rawReason)).slice(0, 100)
        const { error: awErr } = await supabase.from('leads').update({
          status: 'awaiting_response',
          awaiting_response_since: new Date().toISOString(),
          awaiting_response_reason: reasonStr,
        }).eq('id', cmd.related_lead_id)
        if (awErr) {
          console.error(`[bridge] awaiting_response update failed:`, awErr.message)
        } else {
          console.log(`[bridge] ⏳ lead ${cmd.related_lead_id.slice(0,8)} → awaiting_response (${reasonStr})`)
        }
      }
    } catch (err) {
      console.error(`[bridge] awaiting_response handler failed:`, err.message)
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
        // (2026-07-04) Si el lead estuvo GENUINAMENTE conectado, este not_first_degree = el
        // contacto nos ELIMINÓ de su red → Super DEAD (NO re-invitar: anti-ban / denuncia).
        // Solo si NO hay evidencia de conexión real es un falso-positivo de accept-detection
        // → revert a invite_sent + FLAG (para que check_sent_invites no haga ping-pong).
        if (await wasGenuinelyConnected(cmd.related_lead_id)) {
          await markDisconnectedSuperDead(cmd.related_lead_id, result.error)
        } else {
          const updates = {
            status: 'invite_sent',
            connected_at: null,
            last_followup_at: null,
            dead_reason: 'detected_not_first_degree',
          }
          await supabase.from('leads').update(updates).eq('id', cmd.related_lead_id)
          console.log(`[bridge] ⚙️  Lead ${cmd.related_lead_id.slice(0,8)} revertido (falso accept): ${result.error} → invite_sent + flag`)
        }
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
  // resolve_companies ingest (v0.10.0) — nombre de empresa → company URN cacheado
  if (!isError && action === 'resolve_companies' && Array.isArray(result?.resolved)) {
    try {
      await ingestResolveCompanies(result.resolved)
    } catch (err) {
      console.error(`[bridge] ingest resolve_companies failed:`, err.message)
    }
  }
  // check_sent_invites ingest — marca leads como connected si dejaron de estar pending
  if (!isError && action === 'check_sent_invites' && result?.status === 'ok' && Array.isArray(result?.pending)) {
    try {
      await ingestCheckSentInvites(commandId, result.pending, result.statedTotal)
    } catch (err) {
      console.error(`[bridge] ingest check_sent_invites failed:`, err.message)
    }
  }
  // check_connections ingest — accept-detection POSITIVA (presencia en la lista de conexiones)
  if (!isError && action === 'check_connections' && result?.status === 'ok' && Array.isArray(result?.connections)) {
    try {
      await ingestCheckConnections(commandId, result.connections)
    } catch (err) {
      console.error(`[bridge] ingest check_connections failed:`, err.message)
    }
  }
  // ── Post-Prospecting (v0.9) ──────────────────────────────────────────────
  // search_posts ingest — inserta post_opportunities nuevas (status='scraped')
  if (!isError && action === 'search_posts' && result?.status === 'ok' && Array.isArray(result?.posts)) {
    try {
      await ingestSearchPosts(commandId, result)
    } catch (err) {
      console.error(`[bridge] ingest search_posts failed:`, err.message)
    }
  }
  // comment_on_post ingest — gradúa lead + encadena connect (o marca failed)
  if (action === 'comment_on_post') {
    try {
      await ingestCommentPosted(commandId, result, isError)
    } catch (err) {
      console.error(`[bridge] ingest comment_on_post failed:`, err.message)
    }
  }

  // get_contact_info ingest (v0.10.12) — email/tel del overlay → leads.contact_info.
  // Resultado TERMINAL (ok O error de la extensión): siempre escribe contact_info para
  // sacar al lead de la cola del scrape (NULL = pendiente). Comando expirado (la ext
  // no estaba) NO pasa por aquí → retry natural.
  if (action === 'get_contact_info') {
    try {
      await ingestContactInfo(commandId, result, isError)
    } catch (err) {
      console.error(`[bridge] ingest get_contact_info failed:`, err.message)
    }
  }

  // publish_post ingest (v0.9.2) — marca el generated_post como publicado o failed
  if (action === 'publish_post') {
    try {
      const published = !isError && result?.status === 'published'
      await supabase.from('generated_posts').update({
        status: published ? 'published' : 'failed',
        published_at: published ? new Date().toISOString() : null,
        reject_reason: published ? null : String(result?.error ?? 'publish_failed').slice(0, 100),
        updated_at: new Date().toISOString(),
      }).eq('command_id', commandId)
      console.log(`[bridge] publish_post ${commandId.slice(0, 8)} → ${published ? 'published' : 'failed (' + (result?.error ?? '?') + ')'}`)
    } catch (err) {
      console.error(`[bridge] ingest publish_post failed:`, err.message)
    }
  }
}

// ── Ingest: get_contact_info → leads.contact_info (digest diario) ────────────
async function ingestContactInfo(commandId, result, isError) {
  const { data: cmd } = await supabase
    .from('extension_commands')
    .select('related_lead_id')
    .eq('id', commandId)
    .single()
  if (!cmd?.related_lead_id) {
    console.warn(`[bridge] get_contact_info ${commandId.slice(0, 8)} sin related_lead_id — skip`)
    return
  }
  let contactInfo
  if (isError || result?.status === 'error') {
    contactInfo = { error: String(result?.error ?? 'scrape_failed').slice(0, 80) }
  } else {
    // Solo campos con valor; todo vacío → {} (centinela "visitado, sin datos")
    contactInfo = {}
    if (result?.email) contactInfo.email = String(result.email).slice(0, 200)
    const phones = Array.isArray(result?.phones) ? result.phones.filter(Boolean).map(p => String(p).slice(0, 40)).slice(0, 5) : []
    if (phones.length) contactInfo.phones = phones
    const websites = Array.isArray(result?.websites) ? result.websites.filter(Boolean).map(w => String(w).slice(0, 200)).slice(0, 5) : []
    if (websites.length) contactInfo.websites = websites
    if (result?.birthday) contactInfo.birthday = String(result.birthday).slice(0, 60)
  }
  const { error } = await supabase.from('leads').update({
    contact_info: contactInfo,
    contact_info_at: new Date().toISOString(),
  }).eq('id', cmd.related_lead_id)
  if (error) {
    console.error(`[bridge] contact_info update failed:`, error.message)
  } else {
    const got = [contactInfo.email && 'email', contactInfo.phones && 'tel', contactInfo.websites && 'web']
      .filter(Boolean).join('+') || (contactInfo.error ? `error:${contactInfo.error}` : 'sin datos')
    console.log(`[bridge] 📇 contact_info lead ${cmd.related_lead_id.slice(0, 8)} → ${got}`)
  }
}

// ── Ingest: check_sent_invites → marca accepts (leads que dejaron de estar pending)
async function ingestCheckSentInvites(commandId, pending, statedTotal = null) {
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

  // 🔴 SAFETY GUARD (v0.7.34): si el scrape devolvió 0 pending PERO tenemos
  // invite_sent leads, es casi seguro un FALLO DEL PARSER (/sent/ drift es gap
  // conocido) — NO que TODOS aceptaron de golpe. Sin este guard, cada invite_sent
  // >1h caería en stillPending=false → falso accept masivo → followups a gente que
  // nunca conectó. Asimetría: perder un accept real (lo recapturamos next cycle) <<<
  // marcar falsos connected. Abortamos.
  if (!Array.isArray(pending) || pending.length === 0) {
    console.warn(`[bridge] check_sent_invites: pending=0 con ${invitedLeads.length} invite_sent leads → ABORT (probable parser failure, NO marco accepts)`)
    return
  }
  // Normalizar urls de pending (LinkedIn agrega trailing slash, query params, etc.)
  // v0.7.46: + decodeURIComponent (acentos URL-encoded: /in/ra%C3%BAl-p%C3%A1ez ≠
  // /in/raúl-páez) + strip de sufijo de locale (/in/slug/es, /en, /pt…). Sin esto, esas
  // URLs no matcheaban el profileUrl del scrape → el lead PENDIENTE parecía ausente →
  // falso 'connected' → FU → lead_not_first_degree (24/7d). Más matching solo reduce
  // falsos-positivos; un accept real sigue ausente del pending sin importar el normalize.
  const normalize = (url) => {
    let u = (url || '').toLowerCase().split('?')[0]
    try { u = decodeURIComponent(u) } catch {}
    return u
      .replace(/^https?:\/\/(www\.)?linkedin\.com/, '')
      .replace(/\/$/, '')
      .replace(/\/(es|en|pt|fr|de|it|nl|es-es|en-us|pt-br)$/, '')  // sufijo de locale
      .replace(/\/$/, '')
  }
  const pendingUrls = new Set(pending.map(p => normalize(p.profileUrl)))
  const pendingNames = new Set(pending.map(p => (p.name ?? '').toLowerCase().trim()))

  const isPending = (lead) =>
    pendingUrls.has(normalize(lead.linkedin_url)) ||
    (lead.full_name && pendingNames.has(lead.full_name.toLowerCase().trim()))

  // v0.7.38 DETECCIÓN POR VENTANA TEMPORAL (resuelve /sent/ paginado SIN falsos):
  // LinkedIn /sent/ ordena newest-first; capturamos los N más recientes (no todos
  // los 86). Boundary = sent_at MÁS VIEJO entre los leads que SÍ vemos en pending.
  // Un lead AUSENTE del pending solo es "aceptado" si es MÁS NUEVO que el boundary
  // (estaría en la página capturada si siguiera pendiente → ausencia = aceptado).
  // Un lead más viejo que el boundary es AMBIGUO (puede estar en página 2) → skip.
  // Si NO hay ningún DB lead en pending → no hay boundary → skip todo (seguro).
  const capturedDbTimes = invitedLeads
    .filter(l => l.sent_at && isPending(l))
    .map(l => new Date(l.sent_at).getTime())
  const boundaryTime = capturedDbTimes.length ? Math.min(...capturedDbTimes) : null
  const incomplete = statedTotal && pending.length < statedTotal
  if (incomplete) {
    console.log(`[bridge] check_sent_invites: scrape parcial (${pending.length}/${statedTotal}) → modo ventana, boundary=${boundaryTime ? new Date(boundaryTime).toISOString() : 'null(skip)'}`)
  }

  let accepted = 0, skippedAmbiguous = 0
  const minSentAgeMs = 60 * 60 * 1000  // no marcar accept si el invite tiene <1h

  for (const lead of invitedLeads) {
    if (!lead.sent_at) continue
    const sentMs = new Date(lead.sent_at).getTime()
    if (Date.now() - sentMs < minSentAgeMs) continue
    if (isPending(lead)) continue  // sigue pendiente → no aceptado

    // Ausente del pending. ¿Dentro de la ventana capturada?
    // (2026-07-04) DESACTIVADA la ruta AGRESIVA >10d (era v0.7.50). Motivo: la paginación de
    // /sent/ se rompió (LinkedIn cambió el control "Mostrar más resultados") → el scrape captura
    // solo ~10 pending de N, así que casi todo invite viejo está AUSENTE de esa ventana parcial y
    // la heurística ">10d ausente = aceptó" fabricaba falsos-accept en masa (churn
    // detected_not_first_degree: Josh 49 / Wal 16 / Café 16 → FU1 desperdiciados navegando a
    // no-conexiones). Ya es REDUNDANTE: check_connections da detección POSITIVA por presencia
    // (scrapea la lista COMPLETA de conexiones y marca connected sin inferencia). Ahora
    // check_sent_invites vuelve a ser CONSERVADOR: solo concluye accept con scrape COMPLETO o con
    // lead más nuevo que el boundary (ventana confiable); lo demás → ambiguo, lo cierra check_connections.
    if (incomplete) {
      if (boundaryTime === null || sentMs <= boundaryTime) {
        skippedAmbiguous++  // ausente pero bajo/sin ventana confiable → ambiguo, no marcar
        continue
      }
    }
    // Seguro concluir accept: scrape completo, o lead más nuevo que el boundary.
    const { error } = await supabase.from('leads').update({
      status: 'connected', connected_at: new Date().toISOString(),
    }).eq('id', lead.id)
    if (!error) {
      accepted++
      console.log(`[bridge] ✅ Accept detectado: ${lead.full_name} (invite_sent → connected)`)
    }
  }
  console.log(`[bridge] check_sent_invites ingest: ${accepted} accepts de ${invitedLeads.length} invite_sent (${skippedAmbiguous} ambiguos saltados por ventana)`)
}

// ── Ingest: check_connections → accept-detection POSITIVA por presencia en conexiones ──
// (2026-07-04) Un lead invite_sent que APARECE en la lista de conexiones ACEPTÓ (definitivo,
// no inferencia por ausencia). Cierra las zonas ciegas de check_sent_invites (ventana/boundary/
// timing). La presencia positiva OVERRIDE el flag detected_not_first_degree (si de verdad
// conectó, era un falso revert). Solo AÑADE marks connected → seguro ante scrape parcial (marca
// menos, nunca falsos-accept masivos como el modo ausencia).
async function ingestCheckConnections(commandId, connections) {
  const { data: cmd } = await supabase.from('extension_commands').select('account_id').eq('id', commandId).single()
  if (!cmd?.account_id) return
  if (!Array.isArray(connections) || connections.length === 0) {
    console.warn(`[bridge] check_connections: 0 conexiones scrapeadas → nada que marcar (posible parser fail)`)
    return
  }
  const { data: invitedLeads } = await supabase
    .from('leads')
    .select('id, full_name, linkedin_url, sent_at, dead_reason, campaigns!inner(linkedin_account_id)')
    .eq('campaigns.linkedin_account_id', cmd.account_id)
    .eq('status', 'invite_sent')
  if (!invitedLeads || invitedLeads.length === 0) {
    console.log(`[bridge] check_connections: 0 leads invite_sent para esta cuenta`); return
  }
  const normalize = (url) => {
    let u = (url || '').toLowerCase().split('?')[0]
    try { u = decodeURIComponent(u) } catch {}
    return u.replace(/^https?:\/\/(www\.)?linkedin\.com/, '').replace(/\/$/, '')
      .replace(/\/(es|en|pt|fr|de|it|nl|es-es|en-us|pt-br)$/, '').replace(/\/$/, '')
  }
  const connUrls = new Set(connections.map(c => normalize(c.profileUrl)))
  const connNames = new Set(connections.map(c => (c.name ?? '').toLowerCase().trim()).filter(Boolean))
  // (2026-07-06) Anti-loop de falso-accept por HOMÓNIMO. El match por nombre es evidencia
  // DÉBIL: con el scrape masivo de 0.9.15 (~400-940 conexiones) un lead 2do-grado colisiona
  // por nombre exacto con una conexión real de 1er grado → se marca connected falsamente →
  // FU → compose ve InMail/2do-grado → re-flag detected_not_first_degree → loop (pico 05-jul).
  // El match por URL (profileUrl vanity) es evidencia FUERTE y no colisiona → siempre cuenta.
  const isConnection = (lead) => {
    if (connUrls.has(normalize(lead.linkedin_url))) return true   // URL = fuerte → siempre
    // (a) NUNCA dejar que un match de nombre overridee el flag: si un FU llegó al compose y
    //     detectó 2do-grado, esa es evidencia DIRECTA de no-1er-grado; un homónimo no la revierte.
    if (lead.dead_reason === 'detected_not_first_degree') return false
    // (b) exigir nombre distintivo: >=2 tokens y el último no es inicial abreviada
    //     ("Carlos R." / "Ana G." colisionan trivialmente contra cientos de conexiones).
    const nm = (lead.full_name || '').toLowerCase().trim()
    const toks = nm.split(/\s+/).filter(Boolean)
    if (toks.length < 2 || /^[a-z]\.?$/.test(toks[toks.length - 1])) return false
    return connNames.has(nm)
  }

  let accepted = 0
  const minSentAgeMs = 30 * 60 * 1000  // ignora invites <30min (evita carreras de UI)
  for (const lead of invitedLeads) {
    if (lead.sent_at && Date.now() - new Date(lead.sent_at).getTime() < minSentAgeMs) continue
    if (!isConnection(lead)) continue   // no está en conexiones → sigue pendiente
    const { error } = await supabase.from('leads').update({
      status: 'connected',
      connected_at: new Date().toISOString(),
      inmail_revert_count: 0,
      dead_reason: lead.dead_reason === 'detected_not_first_degree' ? null : lead.dead_reason,
    }).eq('id', lead.id)
    if (!error) { accepted++; console.log(`[bridge] ✅ Accept CONFIRMADO (en conexiones): ${lead.full_name} (invite_sent → connected)`) }
  }
  console.log(`[bridge] check_connections ingest: ${accepted} accepts confirmados de ${invitedLeads.length} invite_sent (${connections.length} conexiones scrapeadas)`)
}

// ── Ingest: search → insertar leads nuevos en DB ───────────────────────────
// ── Detección de DESCONEXIÓN (el contacto nos eliminó) → Super DEAD ──────────────
// (2026-07-04) Un contacto que ACEPTÓ y luego nos ELIMINÓ de su red NO debe re-invitarse
// ni re-mensajearse (riesgo anti-ban / que nos denuncien). Cuando un envío falla con
// "not_first_degree"/"not_messageable" distinguimos:
//   - estuvo GENUINAMENTE conectado (FU enviado / respondió / etapa post-conexión) → nos
//     ELIMINÓ → Super DEAD irreversible (status=dead + disconnected_at + automation_paused).
//   - sin evidencia (posible falso-positivo de accept-detection) → revert a invite_sent (previo).
async function wasGenuinelyConnected(leadId) {
  const { data: lead } = await supabase.from('leads')
    .select('followup_step, last_followup_at, status, replied_at')
    .eq('id', leadId).maybeSingle()
  if (!lead) return false
  if ((lead.followup_step ?? 0) > 0) return true                 // le mandamos un FU → estaba conectado
  if (lead.last_followup_at) return true
  if (lead.replied_at) return true                               // nos respondió → definitivamente conectado
  if (['replied', 'follow_up_sent', 'awaiting_response', 'meeting_booked'].includes(lead.status)) return true
  const { data: conv } = await supabase.from('conversations').select('id').eq('lead_id', leadId).maybeSingle()
  if (conv) {
    const { count } = await supabase.from('conversation_events')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conv.id).eq('direction', 'inbound')
    if ((count ?? 0) > 0) return true                            // recibió inbound → conexión real
  }
  return false
}

async function markDisconnectedSuperDead(leadId, detail) {
  await supabase.from('leads').update({
    status: 'dead',
    dead_reason: 'disconnected_by_contact',
    disconnected_at: new Date().toISOString(),
    automation_paused: true,   // fail-closed: bloquea cualquier ruta que filtre por automation_paused
  }).eq('id', leadId)
  try {
    const { data: conv } = await supabase.from('conversations').select('id').eq('lead_id', leadId).maybeSingle()
    if (conv) {
      await supabase.from('conversation_events').insert({
        conversation_id: conv.id, event_type: 'note_added', direction: 'outbound',
        content: `El contacto nos eliminó de su red (detectado: ${detail}). Lead → Super DEAD: no más contacto (anti-ban).`,
      })
      await supabase.from('conversations').update({ status: 'dead' }).eq('lead_id', leadId)
    }
  } catch { /* best-effort: el marcado del lead es lo crítico */ }
  console.log(`[bridge] ⛔ lead ${leadId.slice(0,8)} SUPER-DEAD: el contacto nos eliminó (${detail}) — no re-invitar/re-mensajear`)
}

// #3 (2026-07-03): backoff yield-aware de búsqueda. net-new=0 → +1 al streak seco (cap 6);
// >0 → reset a 0. Lo lee trySearchForCampaign para hacer backoff del piso de drought y no
// martillar un pool agotado cada 30min. Best-effort (nunca rompe el ingest). Búsqueda es
// infrecuente → el read-modify-write (2 queries en el path seco) es despreciable.
async function bumpDrySearchStreak(campaignId, netNew) {
  if (!campaignId) return
  try {
    if (netNew > 0) {
      await supabase.from('campaigns').update({ dry_search_streak: 0 }).eq('id', campaignId)
    } else {
      const { data } = await supabase.from('campaigns').select('dry_search_streak').eq('id', campaignId).single()
      const next = Math.min((data?.dry_search_streak ?? 0) + 1, 6)
      await supabase.from('campaigns').update({ dry_search_streak: next }).eq('id', campaignId)
    }
  } catch (e) {
    console.warn(`[bridge] bumpDrySearchStreak falló:`, e?.message)
  }
}

// (10-ago-2026) Filtro de GEO en el ingest. La búsqueda company-scoped tira el geoUrn de
// la URL a propósito (chocaba con el facet y daba 0 resultados), pero eso surfacea empleados
// EXTRANJEROS de empresas multinacionales de la lista (Café: hunter douglas / MOLEX →
// Brasil, Alemania, India). Este chokepoint server-side descarta al insertar los leads
// cuya ubicación cae FUERA de la geo de la campaña — cubre free Y SalesNav de un solo lugar,
// sin tocar los scrapers frágiles del DOM.
const _stripGeo = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()

// Países RECONOCIBLES → código canónico (para que "united states"≡"estados unidos", etc.).
// Nombres en español (las cuentas es-MX reciben ubicaciones en español) + alias en inglés
// como red. Cubre LATAM+España (geos de las campañas), EE.UU., y los países que se colaron
// (Brasil, Alemania, India, Suiza, Italia, Francia, Países Bajos, Portugal, China…). No es
// exhaustiva: con reconocer el país del perfil basta para decidir; si no reconoce ninguno,
// conserva el lead. Las claves multi-palabra van ANTES para no perderlas.
const COUNTRY_CANON = {
  'estados unidos':'us','united states':'us','usa':'us',
  'republica dominicana':'do','costa rica':'cr','el salvador':'sv','puerto rico':'pr',
  'paises bajos':'nl','holanda':'nl','netherlands':'nl',
  'reino unido':'uk','inglaterra':'uk','united kingdom':'uk','gran bretana':'uk',
  'arabia saudita':'sa','emiratos arabes':'ae','nueva zelanda':'nz','corea del sur':'kr','corea':'kr',
  'mexico':'mx','colombia':'co','espana':'es','spain':'es','chile':'cl','peru':'pe','panama':'pa',
  'argentina':'ar','uruguay':'uy','paraguay':'py','bolivia':'bo','ecuador':'ec','venezuela':'ve',
  'guatemala':'gt','honduras':'hn','nicaragua':'ni','cuba':'cu',
  'brasil':'br','brazil':'br','canada':'ca','alemania':'de','germany':'de','francia':'fr','france':'fr',
  'italia':'it','italy':'it','portugal':'pt','irlanda':'ie','belgica':'be','suiza':'ch','switzerland':'ch',
  'austria':'at','polonia':'pl','suecia':'se','noruega':'no','dinamarca':'dk','finlandia':'fi',
  'rusia':'ru','turquia':'tr','india':'in','china':'cn','japon':'jp','singapur':'sg','israel':'il',
  'australia':'au','sudafrica':'za','egipto':'eg','nigeria':'ng','marruecos':'ma',
}
const COUNTRY_KEYS = Object.keys(COUNTRY_CANON).sort((a, b) => b.length - a.length) // multi-palabra primero

// true si la ubicación del perfil cae dentro de la geo de la campaña.
//   - sin geo configurada → true (la campaña no filtra por país)
//   - ubicación vacía → true (beneficio de la duda; el facet ya garantiza la empresa)
//   - ubicación que NO nombra ningún país conocido (solo ciudad/región, ej. "Área
//     metropolitana de San Luis Potosí") → true (beneficio de la duda — NO asumir extranjero)
//   - ubicación que nombra país(es): true solo si ALGUNO está en la geo objetivo
// Modelo conservador: descarta SOLO cuando la ubicación nombra explícitamente un país fuera
// de la lista. Prefiere colar un domestic ambiguo que tirar un lead válido.
export function matchesCampaignGeo(profileLoc, geoRaw) {
  const geoCanon = new Set(String(geoRaw ?? '').split(',').map(s => COUNTRY_CANON[_stripGeo(s)]).filter(Boolean))
  if (geoCanon.size === 0) return true
  const loc = _stripGeo(profileLoc)
  if (!loc) return true
  const mentioned = COUNTRY_KEYS.filter(k => loc.includes(k)).map(k => COUNTRY_CANON[k])
  if (mentioned.length === 0) return true            // solo ciudad/región → conservar
  return mentioned.some(c => geoCanon.has(c))        // nombra país → keep si alguno es de la geo
}

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

  // v0.10.0: de qué empresa objetivo vino esta búsqueda (null = búsqueda por título).
  const targetCompanyId   = cmd.payload?.targetCompanyId ?? null
  const targetCompanyName = cmd.payload?.targetCompany ?? null
  // Solo con facet currentCompany LinkedIn GARANTIZA que el perfil trabaja ahí. Sin URN
  // (empresa no resuelta) la búsqueda fue por texto → NO poblamos currentCompany: sería
  // darle a la IA una empresa inventada (NO_INVENT_COMPANY_RULE).
  const companyIsCertain = !!cmd.payload?.companyUrn && !!targetCompanyName

  const rawProfiles = result.profiles ?? []
  if (rawProfiles.length === 0) {
    console.log(`[bridge] search ${commandId.slice(0,8)}: 0 perfiles${targetCompanyName ? ` (@${targetCompanyName})` : ''}`)
    await bumpDrySearchStreak(campaignId, 0)
    return
  }

  // (10-ago) FILTRO DE GEO: descarta empleados fuera del país de la campaña (multinacionales
  // de la lista surfacean gente de Brasil/Alemania/etc. porque company-scoped tira el geoUrn).
  const { data: camp } = await supabase.from('campaigns').select('search_location').eq('id', campaignId).maybeSingle()
  const geoRaw = camp?.search_location ?? ''
  let droppedGeo = 0
  const profiles = rawProfiles.filter(p => {
    if (matchesCampaignGeo(p.location, geoRaw)) return true
    droppedGeo++; return false
  })
  if (droppedGeo > 0) console.log(`[bridge] search ${commandId.slice(0,8)}: 🌎 ${droppedGeo} perfiles FUERA de geo "${geoRaw}" descartados${targetCompanyName ? ` (@${targetCompanyName})` : ''}`)
  if (profiles.length === 0) {
    await bumpDrySearchStreak(campaignId, 0)
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
      profile_data: {
        headline: p.headline, location: p.location, source: 'extension_search',
        // v0.10.0: empresa objetivo de la que salió el lead.
        ...(targetCompanyName ? { targetCompany: targetCompanyName } : {}),
        // Con facet es dato DURO (lo filtró LinkedIn) → mejor que la inferencia del LLM
        // desde el headline, y ahorra ese pass.
        ...(companyIsCertain ? { currentCompany: targetCompanyName } : {}),
      },
      status:       'scraped',
      source:       'extension_search',
      scraped_at:   new Date().toISOString(),
    }))

  if (toInsert.length === 0) {
    console.log(`[bridge] search ${commandId.slice(0,8)}: ${profiles.length} perfiles, todos duplicados`)
    await bumpDrySearchStreak(campaignId, 0)
    return
  }

  const { error } = await supabase.from('leads').insert(toInsert)
  if (error) {
    console.error(`[bridge] search insert leads error:`, error.message)
    return
  }

  console.log(`[bridge] ✅ search ingested: ${toInsert.length} leads nuevos (${profiles.length - toInsert.length} duplicados) en campaña ${campaignId.slice(0,8)}${targetCompanyName ? ` @${targetCompanyName}` : ''}`)
  await bumpDrySearchStreak(campaignId, toInsert.length)

  if (targetCompanyId) {
    const { data: row } = await supabase
      .from('campaign_target_companies').select('leads_found').eq('id', targetCompanyId).maybeSingle()
    await supabase.from('campaign_target_companies')
      .update({ leads_found: (row?.leads_found ?? 0) + toInsert.length })
      .eq('id', targetCompanyId)
  }
}

// v0.10.0 — resultado de resolve_companies → caché de URNs.
// ready      = URN resuelto y el nombre matchea → facet currentCompany en las búsquedas.
// unresolved = agotó los 3 intentos → se busca por "nombre exacto" (degradado, no bloqueado).
// pending    = falló pero le quedan intentos → el scheduler reintenta en 24h.
const COMPANY_RESOLVE_MAX_TRIES = 3

async function ingestResolveCompanies(resolved) {
  const ids = resolved.map(r => r?.id).filter(Boolean)
  if (ids.length === 0) return
  const { data: rows } = await supabase
    .from('campaign_target_companies').select('id, resolve_attempts').in('id', ids)
  const attempts = new Map((rows ?? []).map(r => [r.id, r.resolve_attempts ?? 0]))

  let ok = 0, degraded = 0, retry = 0
  for (const r of resolved) {
    if (!r?.id) continue
    if (r.urn && r.matched) {
      // followers = tamaño de la página elegida. Es el detector de páginas duplicadas:
      // la corporativa de Mondelēz tiene 4M y la duplicada regional 77. Guardarlo permite
      // auditar la lista con una query en vez de re-resolver a ciegas.
      await supabase.from('campaign_target_companies')
        .update({ status: 'ready', linkedin_urn: String(r.urn), slug: r.slug ?? null,
                  followers: Number.isFinite(r.followers) ? Math.round(r.followers) : null,
                  // Nombre de la página elegida. Con el nombre de la lista al lado, una
                  // sola query dice si el resolver ató la empresa correcta.
                  page_title: r.resultTitle ?? null })
        .eq('id', r.id)
      ok++
    } else if ((attempts.get(r.id) ?? 0) >= COMPANY_RESOLVE_MAX_TRIES) {
      await supabase.from('campaign_target_companies')
        .update({ status: 'unresolved', slug: r.slug ?? null })
        .eq('id', r.id)
      degraded++
    } else {
      retry++
    }
  }
  console.log(`[bridge] ✅ resolve_companies: ${ok} ready, ${degraded} sin URN (búsqueda por nombre), ${retry} a reintento`)
}

// ── Ingest: search_posts → inserta post_opportunities (status='scraped') ─────
// La calificación con IA y la redacción del comentario las hace el scheduler
// (tryQualifyPostOpportunities), NO aquí, para no bloquear el WS handler.
async function ingestSearchPosts(commandId, result) {
  const { data: cmd } = await supabase
    .from('extension_commands')
    .select('account_id, payload')
    .eq('id', commandId)
    .single()
  if (!cmd?.account_id) return

  const postCampaignId = cmd.payload?.postCampaignId
  if (!postCampaignId) {
    console.warn(`[bridge] search_posts ingest: payload sin postCampaignId`)
    return
  }

  const posts = (result.posts ?? []).filter(p => p?.postUrn && p?.authorProfileUrl)
  const skippedNoAuthor = (result.posts ?? []).length - posts.length
  if (posts.length === 0) {
    console.log(`[bridge] search_posts ${commandId.slice(0,8)}: 0 posts con autor (${skippedNoAuthor} sin /in/)`)
    return
  }

  // Dedupe contra oportunidades existentes por post_urn (la unique constraint
  // también lo protege; esto evita el ruido de errores de inserción).
  const urns = posts.map(p => p.postUrn)
  const { data: existing } = await supabase
    .from('post_opportunities')
    .select('post_urn')
    .eq('post_campaign_id', postCampaignId)
    .in('post_urn', urns)
  const existingSet = new Set((existing ?? []).map(o => o.post_urn))

  const toInsert = posts
    .filter(p => !existingSet.has(p.postUrn))
    .map(p => ({
      post_campaign_id:    postCampaignId,
      linkedin_account_id: cmd.account_id,
      post_urn:            p.postUrn,
      post_permalink:      p.postPermalink ?? null,
      post_text:           (p.postText ?? '').slice(0, 4000),
      author_name:         p.authorName ?? null,
      author_profile_url:  p.authorProfileUrl,
      author_headline:     p.authorHeadline ?? null,
      status:              'scraped',
    }))

  if (toInsert.length === 0) {
    console.log(`[bridge] search_posts ${commandId.slice(0,8)}: ${posts.length} posts, todos duplicados`)
    return
  }

  // ignoreDuplicates por si hay carrera con la unique (post_campaign_id, post_urn).
  const { error } = await supabase
    .from('post_opportunities')
    .upsert(toInsert, { onConflict: 'post_campaign_id,post_urn', ignoreDuplicates: true })
  if (error) {
    console.error(`[bridge] search_posts insert error:`, error.message)
    return
  }
  console.log(`[bridge] ✅ search_posts ingested: ${toInsert.length} oportunidades nuevas (${posts.length - toInsert.length} dup, ${skippedNoAuthor} sin autor) en post-campaña ${postCampaignId.slice(0,8)}`)
}

// ── Ingest: comment_on_post → gradúa lead + encadena connect (o marca failed) ─
async function ingestCommentPosted(commandId, result, isError) {
  const { data: cmd } = await supabase
    .from('extension_commands')
    .select('account_id, payload')
    .eq('id', commandId)
    .single()
  if (!cmd?.account_id) return

  const opportunityId = cmd.payload?.opportunityId
  if (!opportunityId) {
    console.warn(`[bridge] comment_on_post ingest: payload sin opportunityId`)
    return
  }

  const { data: opp } = await supabase
    .from('post_opportunities')
    .select('id, post_campaign_id, post_urn, post_permalink, post_text, author_name, author_profile_url, author_headline, lead_id, status')
    .eq('id', opportunityId)
    .single()
  if (!opp) {
    console.warn(`[bridge] comment_on_post ingest: oportunidad ${opportunityId.slice(0,8)} no encontrada`)
    return
  }

  // Idempotencia: si ya se graduó (lead_id puesto / status posted), no repetir.
  if (opp.lead_id || opp.status === 'posted') {
    console.log(`[bridge] comment_on_post ${commandId.slice(0,8)}: oportunidad ya posteada/graduada — skip`)
    return
  }

  // Fallo del comentario → marcar failed, NO graduar ni conectar.
  if (isError || result?.status !== 'posted') {
    await supabase.from('post_opportunities').update({
      status: 'failed',
      last_error: (result?.error ?? result?.status ?? 'unknown').toString().slice(0, 200),
      updated_at: new Date().toISOString(),
    }).eq('id', opportunityId)
    console.log(`[bridge] ⚠️ comment_on_post falló para opp ${opportunityId.slice(0,8)}: ${result?.error ?? result?.status}`)
    return
  }

  if (!opp.author_profile_url) {
    // No debería pasar (filtramos en scrape), pero sin URL no se puede graduar.
    await supabase.from('post_opportunities').update({
      status: 'failed', last_error: 'no_author_profile_url', updated_at: new Date().toISOString(),
    }).eq('id', opportunityId)
    return
  }

  // Cargar la post-campaña para shadow_campaign_id + pitch_note.
  const { data: pc } = await supabase
    .from('post_campaigns')
    .select('shadow_campaign_id, pitch_note, name')
    .eq('id', opp.post_campaign_id)
    .single()
  const shadowCampaignId = pc?.shadow_campaign_id ?? null
  const commentText = cmd.payload?.comment ?? null

  // Graduar a lead. Dedup contra un lead existente con la misma URL en la shadow campaign.
  let leadId = null
  const { data: existingLead } = await supabase
    .from('leads')
    .select('id')
    .eq('linkedin_url', opp.author_profile_url)
    .eq('campaign_id', shadowCampaignId)
    .maybeSingle()
  if (existingLead?.id) {
    leadId = existingLead.id
  } else {
    const { data: newLead, error: leadErr } = await supabase
      .from('leads')
      .insert({
        campaign_id:  shadowCampaignId,
        linkedin_url: opp.author_profile_url,
        full_name:    opp.author_name ?? null,
        profile_data: {
          headline: opp.author_headline ?? null,
          source: 'post',
          post_urn: opp.post_urn,
          post_permalink: opp.post_permalink,
          post_text: (opp.post_text ?? '').slice(0, 1000),
        },
        status:     'commented',
        source:     'post',
        scraped_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (leadErr) {
      console.error(`[bridge] comment_on_post graduación lead falló: ${leadErr.message}`)
      await supabase.from('post_opportunities').update({
        status: 'failed', last_error: `graduation_failed: ${leadErr.message}`.slice(0, 200), updated_at: new Date().toISOString(),
      }).eq('id', opportunityId)
      return
    }
    leadId = newLead.id
  }

  // Marcar la oportunidad posteada + linkear el lead.
  await supabase.from('post_opportunities').update({
    status: 'posted', posted_at: new Date().toISOString(), lead_id: leadId, updated_at: new Date().toISOString(),
  }).eq('id', opportunityId)

  // Conversation (initiated) + evento comment_posted.
  const { data: conv } = await supabase
    .from('conversations')
    .upsert({
      lead_id:             leadId,
      linkedin_account_id: cmd.account_id,
      status:              'initiated',
      last_message_at:     new Date().toISOString(),
      last_message_text:   commentText ? `[Comentario]: ${commentText.slice(0, 180)}` : '[Comentario publicado]',
    }, { onConflict: 'lead_id' })
    .select('id')
    .single()
  if (conv?.id) {
    const { error: evErr } = await supabase.from('conversation_events').insert({
      conversation_id: conv.id,
      event_type:      'comment_posted',
      direction:       'outbound',
      content:         commentText ? commentText.slice(0, 4000) : null,
      sent_at:         new Date().toISOString(),
      sent_via:        'orion_auto',
      metadata:        { post_urn: opp.post_urn, post_permalink: opp.post_permalink },
    })
    if (evErr) console.error(`[bridge] ❌ comment_posted event insert: ${evErr.message}`)
  }

  // Contador diario de comentarios (separado del de invites).
  const { error: incErr } = await supabase.rpc('increment_daily_activity', {
    p_account_id: cmd.account_id, p_field: 'comments_posted',
  })
  if (incErr) console.error(`[bridge] ❌ RPC increment_daily_activity (comments_posted) failed: ${incErr.message}`)

  await supabase.from('activity_log').insert({
    linkedin_account_id: cmd.account_id,
    lead_id:             leadId,
    action:              'comment_on_post',
    result:              'success',
    details:             { postUrn: opp.post_urn, opportunityId },
  }).then(({ error }) => { if (error) console.warn(`[bridge] activity_log (comment_on_post) failed: ${error.message}`) })

  // Encadenar el connect con la nota PRIVADA de pitch. ingestSendInvite lo lleva
  // a status='invite_sent' → de aquí entra al pipeline normal (check_inbox → connected → FU).
  const cmdId = await dispatchInvite({ id: cmd.account_id }, { id: leadId, linkedin_url: opp.author_profile_url }, {
    message: pc?.pitch_note ?? null,
    dryRun: false,
  })
  console.log(`[bridge] ✅ comment_on_post: opp ${opportunityId.slice(0,8)} posteado → lead ${leadId.slice(0,8)} graduado → connect ${cmdId ? cmdId.slice(0,8) : 'FALLÓ'} (pitch privado)`)
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

  // v0.8 FU dinámico: todos los pasos comparten el status genérico 'follow_up_sent';
  // el paso lo lleva el contador leads.followup_step + el timestamp único last_followup_at.
  let statusValue = null
  if (!isReply) {
    const step = cmd.payload?.step ?? 1
    statusValue = 'follow_up_sent'

    await supabase.from('leads').update({
      status:        'follow_up_sent',
      followup_step: step,
      last_followup_at: new Date().toISOString(),
      // v0.7.13 P0-4: reset lockout_skip_count en cada FU exitoso —
      // un FU que SÍ logró enviarse "limpia" el historial de lockouts.
      lockout_skip_count: 0,
    }).eq('id', leadId)
  }

  // RPC error capture (2026-05-29 fix): antes era fire-and-forget; ahora loggea
  // si falla para detectar problemas de counter silenciosos.
  const { error: incMsgErr } = await supabase.rpc('increment_daily_activity', {
    p_account_id: cmd.account_id,
    p_field:      'messages_sent',
  })
  if (incMsgErr) console.error(`[bridge] ❌ RPC increment_daily_activity (messages_sent) failed for ${cmd.account_id.slice(0,8)}: ${incMsgErr.message}`)

  // Registrar el evento + actualizar conversation
  const messageText = cmd.payload?.message
  if (messageText) {
    const { data: conv } = await supabase
      .from('conversations')
      .upsert({
        lead_id:             leadId,
        linkedin_account_id: cmd.account_id,
        // 'active' por defecto (un FU/FM normal promueve initiated/connected → active).
        // El sensor de salida manda convStatus:'closed_lost' para que su mensaje de cierre
        // RE-AFIRME el estado terminal en vez de revivir la conversación al ingestarse.
        status:              cmd.payload?.convStatus ?? 'active',
        last_message_at:     new Date().toISOString(),
        last_message_text:   `[Tú]: ${messageText.slice(0, 200)}`,
      }, { onConflict: 'lead_id' })
      .select('id')
      .single()

    if (conv?.id) {
      // Constraint-safe values:
      //   event_type ∈ {invite_sent, follow_up_sent, reply_sent, message_sent, ...}  (FU genérico; el paso vive en leads.followup_step)
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
  // v7-C: si el invite salió redirigiendo un lead SalesNav a su /in/ público (background lo pasa
  // en _debugRedirect.resolvedInUrl), persistimos linkedin_url=/in/ → el FU/auto-reply luego
  // funcionan (antes quedaba /sales/lead/ y el FU entraba en loop).
  const updatePayload = { status: 'invite_sent', sent_at: new Date().toISOString() }
  const resolvedIn = result?._debugRedirect?.resolvedInUrl
  if (resolvedIn && /linkedin\.com\/in\//.test(resolvedIn)) updatePayload.linkedin_url = resolvedIn
  await supabase.from('leads').update(updatePayload).eq('id', leadId)

  // Incrementar daily_activity (CDMX date-aligned vía RPC)
  // RPC error capture (2026-05-29 fix): visibilidad si counter silenciosamente falla.
  const { error: incInvErr } = await supabase.rpc('increment_daily_activity', {
    p_account_id: cmd.account_id,
    p_field:      'invites_sent',
  })
  if (incInvErr) console.error(`[bridge] ❌ RPC increment_daily_activity (invites_sent) failed for ${cmd.account_id.slice(0,8)}: ${incInvErr.message}`)

  // v0.7.22 BUG-K: registrar activity_log para send_invite success (antes vacío →
  // observability gap por-cmd). Permite auditoría de cuándo/cómo se envió cada invite.
  const { error: actLogErr } = await supabase.from('activity_log').insert({
    linkedin_account_id: cmd.account_id,
    lead_id:             leadId,
    action:              'send_invite',
    result:              'success',
    details:             { status: result.status, path: result.path ?? null, withNote: !!result.withNote },
  })
  if (actLogErr) console.warn(`[bridge] activity_log insert (send_invite) failed: ${actLogErr.message}`)

  // SIEMPRE registrar conversation + event de invite_sent (con o sin nota).
  // BUG fix: antes solo se loggeaba si textareaUsed=true → invites sin nota
  // (path spa_route_no_note) nunca creaban evento → dashboard contaba 0 ayer/streak.
  const messageText = cmd.payload?.message
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
    // Fix 29-may: garantizar que conversation tenga last_message_at desde el inicio,
    // así aparece en /dashboard/conversations ORDER BY last_message_at. Antes solo
    // FU ingest lo poblaba → invites quedaban con last_message_at=NULL → invisibles.
    await supabase.from('conversations').update({
      last_message_at:   new Date().toISOString(),
      last_message_text: (messageText && result.textareaUsed)
        ? `[Tú]: ${messageText.slice(0, 200)}`
        : '[Invitación enviada (sin nota)]',
    }).eq('id', conv.id)

    // BUG fix: sent_via='orion_extension' viola el CHECK constraint
    // (allowed: orion, orion_auto, orion_manual, linkedin_manual, linkedin_inbound, unknown).
    // Usamos 'orion_auto' que es lo correcto para acciones autónomas del bot.
    const { error: evErr } = await supabase.from('conversation_events').insert({
      conversation_id: conv.id,
      event_type:      'invite_sent',
      direction:       'outbound',
      content:         (messageText && result.textareaUsed) ? messageText.slice(0, 4000) : null,
      sent_at:         new Date().toISOString(),
      sent_via:        'orion_auto',
    })
    if (evErr) console.error(`[bridge] ❌ invite_sent event insert: ${evErr.message}`)
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
    .select('id, full_name, status, linkedin_url, dead_reason, campaigns!inner(linkedin_account_id)')
    .eq('campaigns.linkedin_account_id', cmd.account_id)
    .in('status', ['invite_sent', 'connected', 'follow_up_sent', 'replied'])

  if (!leads || leads.length === 0) {
    console.log(`[bridge] ingest: no active leads for account ${cmd.account_id.slice(0,8)}`)
    return
  }

  const matches    = []
  const connected  = []
  const newReplies = []

  for (const convo of conversations) {
    if (!convo.name) continue
    // BUG FIX: NO ingestar cuentas de SISTEMA de LinkedIn (Talent Solutions, etc.) —
    // sus notificaciones se tomaban como "reply", creaban orphans/leads y disparaban
    // auto-reply → thread_editor_not_found. No son personas contestables.
    if (isSystemLinkedInAccount(convo.name)) continue
    // v0.7.43: NO ingestar conversaciones GRUPALES (3+ personas). El flag isGroup
    // viene del content.js (facepile/nombre); isGroupConversationName es el respaldo
    // server-side por si el flag no llegó. Son intros/referidos — el auto-reply
    // mezcla el contexto de varios participantes y confunde al AI (caso Yatin+Rajveer).
    if (convo.isGroup || isGroupConversationName(convo.name)) {
      console.log(`[bridge] skip conversación grupal: "${convo.name}"`)
      continue
    }
    const scrapedLower = convo.name.toLowerCase().trim()

    // Match PRIMARIO por thread_id (fix 29-may-2026): si el scraped trae threadId
    // y existe una conversation con ese thread_id ya vinculada a un lead, ESE es
    // el match correcto sin importar string del nombre. Esto resuelve el bug donde
    // el lead se guardó con nombre abreviado/truncado ("Jose Pablo T.") y el inbox
    // scrape trae el nombre completo ("Jose Pablo Torres Reyes") → string match
    // fallaba → quedaba como orphan, scheduler nunca disparaba FM auto-reply.
    let lead = null
    if (convo.threadId) {
      const { data: matchConv } = await supabase
        .from('conversations')
        .select('lead_id')
        .eq('linkedin_thread_id', convo.threadId)
        .maybeSingle()
      if (matchConv?.lead_id) {
        lead = leads.find(l => l.id === matchConv.lead_id) ?? null
      }
    }
    // FALLBACK: string matching por nombre (original)
    if (!lead) {
      const scrapedFirst = scrapedLower.split(/\s+/)[0]
      lead = leads.find(l => {
        const leadLower = (l.full_name ?? '').toLowerCase()
        const leadFirst = leadLower.split(/\s+/)[0]
        return (leadFirst === scrapedFirst && scrapedLower.includes(leadLower.split(' ').pop() ?? '__')) ||
               leadLower.includes(scrapedLower) ||
               scrapedLower.includes(leadLower)
      })
    }

    if (!lead) {
      // Conversación que NO matchea ningún lead activo → es ORPHAN. Loguear para
      // que el usuario decida (crear lead, ignorar, etc.). Upsert por thread_id
      // o por name (si no hay thread_id) para evitar duplicados en barridos repetidos.
      try {
        const orphanKey = convo.threadId
          ? { linkedin_account_id: cmd.account_id, linkedin_thread_id: convo.threadId }
          : { linkedin_account_id: cmd.account_id, scraped_name: convo.name }
        const { data: existing } = await supabase
          .from('orphan_conversations')
          .select('id, occurrence_count, snippet, unread_count, last_activity_label, linkedin_thread_id, linkedin_profile_url, last_seen_at')
          .match(orphanKey)
          .maybeSingle()
        if (existing) {
          // IO FIX (Disk IO budget): este UPDATE corría en CADA inbox sweep para
          // CADA orphan → 61k updates NON-HOT (last_seen_at está indexado en
          // idx_orphan_status_seen), el #1 consumidor de Disk IO de la instancia.
          // Ahora solo escribimos si algo MATERIAL cambió, o si last_seen_at quedó
          // viejo (>1h) para refrescar liveness. Mantiene el BUG fix de persistir
          // thread_id/profile_url cuando un sweep posterior los captura.
          const newSnippet = convo.snippet ?? null
          const newUnread  = convo.unread ?? 0
          const newLabel   = convo.lastActivity ?? null
          const lastSeenMs = existing.last_seen_at ? Date.parse(existing.last_seen_at) : 0
          const stale      = Date.now() - lastSeenMs > 3_600_000
          const changed =
            newSnippet !== (existing.snippet ?? null) ||
            newUnread  !== (existing.unread_count ?? 0) ||
            newLabel   !== (existing.last_activity_label ?? null) ||
            (convo.threadId  && convo.threadId  !== existing.linkedin_thread_id) ||
            (convo.threadUrl && convo.threadUrl !== existing.linkedin_profile_url)
          if (changed || stale) {
            await supabase.from('orphan_conversations').update({
              occurrence_count: (existing.occurrence_count ?? 1) + 1,
              last_seen_at: new Date().toISOString(),
              snippet: newSnippet,
              unread_count: newUnread,
              last_activity_label: newLabel,
              ...(convo.threadId ? { linkedin_thread_id: convo.threadId } : {}),
              ...(convo.threadUrl ? { linkedin_profile_url: convo.threadUrl } : {}),
            }).eq('id', existing.id)
          }
        } else {
          await supabase.from('orphan_conversations').insert({
            linkedin_account_id: cmd.account_id,
            scraped_name:        convo.name,
            snippet:             convo.snippet ?? null,
            unread_count:        convo.unread ?? 0,
            linkedin_thread_id:  convo.threadId ?? null,
            linkedin_profile_url: convo.threadUrl ?? null,
            last_activity_label: convo.lastActivity ?? null,
          })
        }

        // P-C: AUTO-PROMOTE orphan → lead contestable si:
        //  - tiene thread_id (capturado vía click) Y
        //  - el snippet es un INBOUND genuino del lead (no "Tú:"/"[Tú]:") Y
        //  - NO es patrocinado/promo (filtrar spam de LinkedIn) Y
        //  - el snippet tiene contenido sustantivo (>30 chars, evita "Consultor IT" etc)
        // Opción C: removido el requirement `unread > 0` para incluir conversaciones
        // que el usuario ya abrió pero no contestó (Wal lee sin responder a menudo).
        const snip = (convo.snippet ?? '').trim()
        const isInbound = snip.length > 0 && !/^(\[?tú\]?|tu|you)\s*:/i.test(snip)
        const isSponsored = /^\s*(patrocinado|sponsored|promo)/i.test(snip)
        const hasSubstance = snip.length > 30
        // Fix 29-may-2026: fallback al thread_id ya guardado en DB si el scrape
        // actual no lo trae (captureThreads skipea conversations que ya tienen
        // thread_id). Sin esto, orphans históricos quedaban stuck pending para
        // siempre porque convo.threadId=null en scrapes subsiguientes.
        const effectiveThreadId = convo.threadId ?? existing?.linkedin_thread_id ?? null
        if (effectiveThreadId && isInbound && !isSponsored && hasSubstance) {
          try {
            // Campaña activa de la cuenta para colgar el lead
            const { data: camp } = await supabase
              .from('campaigns')
              .select('id')
              .eq('linkedin_account_id', cmd.account_id)
              .eq('is_active', true)
              .limit(1)
              .maybeSingle()
            if (camp?.id) {
              // Evitar duplicar si ya existe lead con ese thread (usa effectiveThreadId)
              const { data: existingConv } = await supabase
                .from('conversations')
                .select('lead_id')
                .eq('linkedin_thread_id', effectiveThreadId)
                .maybeSingle()
              if (!existingConv) {
                const cleanName = convo.name.replace(/\s*·.*$/, '').trim()
                // Fix 2026-05-29: leads.linkedin_url es NOT NULL. Si el orphan
                // no tiene profile URL real (común: solo tiene messaging URL),
                // usamos thread URL como placeholder. El FU/auto-reply usará
                // el thread_id directo, no necesita perfil URL.
                const fallbackUrl = convo.threadUrl
                  ?? existing?.linkedin_profile_url
                  ?? `https://www.linkedin.com/messaging/thread/${effectiveThreadId}/`
                const { data: newLead, error: leadErr } = await supabase.from('leads').insert({
                  campaign_id:  camp.id,
                  full_name:    cleanName,
                  linkedin_url: fallbackUrl,
                  status:       'replied',
                  replied_at:   new Date().toISOString(),
                  source:      'inbound_orphan_promoted',
                }).select('id').single()
                if (leadErr) console.error(`[bridge] ❌ auto-promote lead INSERT failed for ${cleanName}: ${leadErr.message}`)
                if (newLead?.id) {
                  const { data: newConv } = await supabase.from('conversations').upsert({
                    lead_id:             newLead.id,
                    linkedin_account_id: cmd.account_id,
                    linkedin_thread_id:  effectiveThreadId,
                    status:              'active',
                    last_message_text:   snip.replace(/^[^:]+:\s*/, '').slice(0, 500),
                    last_message_at:     new Date().toISOString(),
                  }, { onConflict: 'lead_id' }).select('id').single()
                  if (newConv?.id) {
                    await supabase.from('conversation_events').insert({
                      conversation_id: newConv.id,
                      event_type:      'reply_received',
                      direction:       'inbound',
                      content:         snip.replace(/^[^:]+:\s*/, '').slice(0, 4000),
                      sent_at:         new Date().toISOString(),
                      sent_via:        'linkedin_inbound',
                    })
                  }
                  // Marcar orphan como promovido
                  await supabase.from('orphan_conversations')
                    .update({ status: 'lead_created', matched_lead_id: newLead.id })
                    .match(orphanKey)
                  console.log(`[bridge] ⬆️  Orphan "${cleanName}" promovido a lead replied (thread capturado) → auto-reply lo contestará`)
                }
              }
            }
          } catch (err) {
            console.warn(`[bridge] orphan promote failed for "${convo.name}":`, err.message)
          }
        }
      } catch (err) {
        console.warn(`[bridge] orphan upsert failed for "${convo.name}":`, err.message)
      }
      continue
    }
    matches.push({ scrapedName: convo.name, leadName: lead.full_name, status: lead.status, unread: convo.unread })

    // Si invite_sent y aparece en inbox → conexión aceptada.
    // (2026-07-06) GAP-1 fail-closed: NO promover si el lead está flagged detected_not_first_degree
    // (evidencia DIRECTA de 2do-grado por un FU que llegó al compose). Un match difuso por nombre/
    // thread es evidencia DÉBIL y no revierte esa señal → evita resucitar el loop de falso-accept.
    // El reply REAL (más abajo) SÍ se sigue procesando: una respuesta genuina es conexión real.
    if (lead.status === 'invite_sent' && lead.dead_reason !== 'detected_not_first_degree') {
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
    // v0.7.44: detectar inbound aunque unread=0 (mensaje ya LEÍDO sin contestar — caso
    // Bernardo: el usuario abrió el thread, unread=0, pero nunca le respondió). Antes esto
    // exigía unread>0 → el lead seguía 'connected' → FU genérico sobre su mensaje real.
    // Ahora detectamos por dirección del snippet + dedup por last_message_text para no
    // re-marcar/re-insertar el mismo inbound en cada check_inbox.
    if (convo.snippet) {
      const snippet = convo.snippet ?? ''
      // LinkedIn shows "Tú:" para outbound y "Nombre:" para inbound (a veces nada)
      const isFromUser = /^(\[?\s*tú\s*\]?|tu|you)\s*:/i.test(snippet.trim())
      const snippetTrimmed = snippet.replace(/^[^:]+:\s*/, '').trim()

      // dedup: ¿ya registramos este inbound? (evita spam de eventos con unread=0 recurrente)
      const { data: prevConv } = await supabase
        .from('conversations').select('last_message_text').eq('lead_id', lead.id).maybeSingle()
      const alreadyRecorded = (prevConv?.last_message_text ?? '').trim() === snippetTrimmed.slice(0, 500).trim()

      if (!isFromUser && snippetTrimmed.length > 0 && !alreadyRecorded) {
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

        // Marcar lead como 'replied' si venía de la cadena FU (pausa FU automática).
        // v0.8 FIX: si YA estaba 'replied' (RE-REPLY — el contacto volvió a escribir),
        // refrescar replied_at=now. Antes solo se seteaba en la 1ra respuesta, así que un
        // contacto que se callaba >7d y volvía a escribir se quedaba con replied_at viejo →
        // caía fuera de la ventana fm_max_age del auto-reply → sin respuesta (caso Daniel).
        const fuStatuses = ['invite_sent','connected','follow_up_sent']
        if (fuStatuses.includes(lead.status)) {
          await supabase.from('leads').update({
            status: 'replied',
            replied_at: new Date().toISOString(),
          }).eq('id', lead.id)
          console.log(`[bridge] 💬 Reply detectado: ${lead.full_name} → status='replied' (FU pausado)`)
        } else if (lead.status === 'replied') {
          await supabase.from('leads').update({ replied_at: new Date().toISOString() }).eq('id', lead.id)
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

// Capa 3 safety net: cooldown por cuenta cuando Chrome cerrado detectado.
// Si 3+ comandos consecutivos fallan con "No current window" → no dispatchar
// más durante COOLDOWN_MS. Evita gastar comandos contra Chrome cerrado.
const NO_WINDOW_COOLDOWN_MS = 5 * 60 * 1000
const NO_WINDOW_THRESHOLD = 3
const noWindowCounter = new Map()  // accountId → consecutive count
const noWindowCooldownUntil = new Map()  // accountId → timestamp

function recordNoWindowError(accountId) {
  const count = (noWindowCounter.get(accountId) ?? 0) + 1
  noWindowCounter.set(accountId, count)
  if (count >= NO_WINDOW_THRESHOLD) {
    noWindowCooldownUntil.set(accountId, Date.now() + NO_WINDOW_COOLDOWN_MS)
    console.log(`[bridge] 🛑 Cuenta ${accountId.slice(0,8)} cooldown ${NO_WINDOW_COOLDOWN_MS/60000}min: ${count}x "No current window" — Chrome aparenta cerrado`)
    noWindowCounter.set(accountId, 0)
  }
}
function resetNoWindowCounter(accountId) {
  noWindowCounter.set(accountId, 0)
  noWindowCooldownUntil.delete(accountId)
}
function isAccountInNoWindowCooldown(accountId) {
  const until = noWindowCooldownUntil.get(accountId)
  if (!until) return false
  if (Date.now() < until) return true
  noWindowCooldownUntil.delete(accountId)
  return false
}

async function pollAndDispatch() {
  const connectedAccountIds = Array.from(connections.keys())
  if (connectedAccountIds.length === 0) return

  // v0.7.15 Fix A: respetar linkedin_accounts.extension_paused — el scheduler ya
  // lo hacía vía checkCampaignActiveGates, pero el bridge despachaba TODO lo que
  // estuviera en queue (incluyendo cmds creados antes de la pausa y cmds que
  // bypass scheduler como check_inbox). Caso 2026-06-02: Josh paused desde
  // ayer pero check_inbox seguía dispatching cada 15 min.
  // v0.7.21 P1-4: además de extension_paused (boolean), respetar
  // extension_paused_until (TIMESTAMPTZ futuro) — esto cubre el gap del banner
  // warning (invite_limit/rate_limit) que sólo setea el cooldown sin pausar.
  const { data: pausedRows } = await supabase
    .from('linkedin_accounts')
    .select('id, label, extension_paused, extension_paused_until, extension_paused_reason, inbox_paused')
    .in('id', connectedAccountIds)
  const pausedAccounts = new Set()
  const nowMs = Date.now()
  for (const row of pausedRows ?? []) {
    if (row.extension_paused) { pausedAccounts.add(row.id); continue }
    const untilMs = row.extension_paused_until ? new Date(row.extension_paused_until).getTime() : 0
    if (untilMs > nowMs) {
      pausedAccounts.add(row.id)
      const remainMin = Math.round((untilMs - nowMs) / 60_000)
      console.log(`[bridge] ⏸  ${row.label} paused_until ${remainMin}min (${row.extension_paused_reason ?? 'n/a'})`)
    }
  }
  if (pausedAccounts.size > 0) {
    const labels = [...pausedAccounts].map(id => connections.get(id)?.label ?? id.slice(0, 8))
    console.log(`[bridge] 🛑 Cuentas paused (skip dispatch): ${labels.join(', ')}`)
  }

  // v0.7.13 stress test harness: si stress_test_lock está activo para una cuenta,
  // solo despachamos commands con payload.is_stress_test=true para esa cuenta.
  // Los demás (producción) esperan a que expire el lock.
  const stressLockedAccount = await readStressTestLockBridge()

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

  // Capa 3: excluir cuentas en cooldown por "No current window" repetidos
  const cooldownAccounts = connectedAccountIds.filter(id => isAccountInNoWindowCooldown(id))
  if (cooldownAccounts.length > 0) {
    const labels = cooldownAccounts.map(id => connections.get(id)?.label ?? id.slice(0,8))
    console.log(`[bridge] Cuentas en cooldown (Chrome cerrado): ${labels.join(', ')}`)
  }

  const availableAccounts = connectedAccountIds.filter(id =>
    !busyAccounts.has(id)
    && !isAccountInNoWindowCooldown(id)
    && !pausedAccounts.has(id)  // v0.7.15 Fix A: paused = NO dispatch
  )
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
    // v0.7.13 stress_test_lock: para la cuenta lockeada, solo cmds is_stress_test
    if (stressLockedAccount && cmd.account_id === stressLockedAccount && !cmd.payload?.is_stress_test) {
      continue
    }
    const conn = connections.get(cmd.account_id)
    if (!conn || conn.ws.readyState !== 1 /* OPEN */) continue

    // Freshness gate (ventana zombie): tras un corte de red silencioso (sleep, WiFi/NAT drop
    // sin FIN) el socket queda readyState=1 hasta que el sweeper lo cierra a los 90s. Despachar
    // ahí = comando al vacío → timeout (incidente Josh 16-jul: send_invite perdido). Si el socket
    // está "quieto" (sin inbound reciente, o con bytes sin flushear), RETENEMOS el cmd — sigue
    // 'pending', se despacha limpio al reconectar. Solo puede RETRASAR, nunca perder ni duplicar:
    // el cmd aún no se marcó 'dispatched'. lastSeen se refresca con cualquier inbound + pingAll/20s,
    // así que un socket sano nunca pasa de ~20s; 40s = ~2 pings perdidos.
    const staleMs = Date.now() - conn.lastSeen
    if (conn.ws.bufferedAmount > 0 || staleMs > 40_000) {
      console.log(`[bridge] ⏸️  dispatch retenido ${conn.label ?? cmd.account_id.slice(0,8)} — socket quieto (lastSeen ${Math.round(staleMs/1000)}s, buffered ${conn.ws.bufferedAmount}) → reintenta al reconectar`)
      continue
    }

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
// v0.7.11 fix: stamp completed_at junto con el status flip. Antes quedaba NULL
// y el lockout 24h del scheduler (.gte('completed_at', cutoff)) NUNCA matcheaba
// (NULL >= X es false en Postgres) → re-dispatch cada 5min para leads en
// timeout perpetuo. Ahora completed_at = NOW() en la misma transacción.

async function cleanupExpired() {
  const nowIso = new Date().toISOString()
  // v0.7.26 BUG extension_did_not_respond fix B2: distinguir dos causas muy
  // distintas que antes se mezclaban bajo 'extension_did_not_respond':
  //   - status='pending' al expirar → NUNCA se dispatchó (cuenta paused/busy/
  //     desconectada). NO es culpa de la extensión ni del lead. error='expired_in_queue'.
  //   - status='dispatched' al expirar → SÍ llegó al SW pero no reportó resultado
  //     (content.js navegó/murió, SW killed). error='extension_did_not_respond'.
  // Esto da observabilidad real (61-88% de los did_not_respond eran queue-expiry)
  // y permite que la lógica de lockout/fault NO penalice al lead por queue-expiry.
  const { error: e1 } = await supabase
    .from('extension_commands')
    .update({ status: 'timeout', error: 'expired_in_queue', completed_at: nowIso })
    .eq('status', 'pending')
    .lt('expires_at', nowIso)
  if (e1) console.error(`[bridge] Cleanup error (pending): ${e1.message}`)

  // Opción B taxonomía: el branch dispatched-expirado se parte según acked_at.
  //   - acked_at NULL → content.js NUNCA confirmó recepción: SW killed / no
  //     inyectado / WS caído entre dispatch y ejecución → error='content_unreachable'.
  //     Es INFRA (no culpa del lead) — NO debe lockear al lead (como expired_in_queue).
  //   - acked_at SET → content.js SÍ recibió pero murió mid-work (navegación reinject,
  //     SW kill mid-ejecución) → error='content_died_mid_work'. Per-comando: SÍ cuenta
  //     para lockout (loop pattern), el scheduler lo incluye en TIMEOUT_ERROR_CODES.
  // v0.7.34 AUTO-RETRY content_unreachable: como content.js NUNCA recibió el comando
  // (sin ack → nunca ejecutó → nunca envió), es 100% SEGURO re-despacharlo (cero
  // riesgo de doble-envío, a diferencia de content_died_mid_work). Convierte "SW murió
  // mid-comando → comando perdido en silencio" en "→ bridge lo re-despacha solo".
  // Cap MAX_UNREACHABLE_RETRIES para evitar loops si el SW está crónicamente roto.
  const MAX_UNREACHABLE_RETRIES = 2
  const { data: unackedCmds, error: e2aSel } = await supabase
    .from('extension_commands')
    .select('id, account_id, action, payload, related_lead_id, micro_phase_log')
    .eq('status', 'dispatched')
    .is('acked_at', null)
    .lt('expires_at', nowIso)
  if (e2aSel) console.error(`[bridge] Cleanup select (unacked): ${e2aSel.message}`)
  for (const cmd of (unackedCmds ?? [])) {
    // SEGURIDAD: el ack es best-effort (se pierde si el WS estaba caído). Si content.js
    // emitió checkpoints en micro_phase_log, SÍ corrió aunque el ack se perdiera →
    // es content_died_mid_work (pudo haber enviado) → NUNCA re-despachar. Solo
    // content.js-sin-actividad-alguna es content_unreachable (seguro re-despachar).
    const ranSomething = Array.isArray(cmd.micro_phase_log) && cmd.micro_phase_log.length > 0
    const errorCode = ranSomething ? 'content_died_mid_work' : 'content_unreachable'
    const { error: mErr } = await supabase
      .from('extension_commands')
      .update({ status: 'timeout', error: errorCode, completed_at: nowIso })
      .eq('id', cmd.id)
    if (mErr) { console.error(`[bridge] mark ${errorCode} failed: ${mErr.message}`); continue }
    if (ranSomething) continue  // corrió → no retry (riesgo doble-envío)

    // content_unreachable real (cero actividad) → auto-retry seguro si bajo el cap.
    const retryN = Number(cmd.payload?._unreachable_retry ?? 0)
    if (retryN >= MAX_UNREACHABLE_RETRIES) {
      console.log(`[bridge] content_unreachable retry cap (${retryN}) reached for ${cmd.action} ${cmd.id.slice(0,8)}`)
      continue
    }
    const retryRow = {
      account_id: cmd.account_id,
      action: cmd.action,
      payload: { ...(cmd.payload ?? {}), _unreachable_retry: retryN + 1, _retry_of: cmd.id },
      status: 'pending',
      expires_at: new Date(Date.now() + 6 * 60_000).toISOString(),
    }
    if (cmd.related_lead_id) retryRow.related_lead_id = cmd.related_lead_id
    const { error: insErr } = await supabase.from('extension_commands').insert(retryRow)
    if (insErr) console.error(`[bridge] content_unreachable auto-retry insert failed: ${insErr.message}`)
    else console.log(`[bridge] content_unreachable → auto-retry ${retryN + 1}/${MAX_UNREACHABLE_RETRIES} ${cmd.action} (orig ${cmd.id.slice(0,8)})`)
  }

  const { error: e2b } = await supabase
    .from('extension_commands')
    .update({ status: 'timeout', error: 'content_died_mid_work', completed_at: nowIso })
    .eq('status', 'dispatched')
    .not('acked_at', 'is', null)
    .lt('expires_at', nowIso)
  if (e2b) console.error(`[bridge] Cleanup error (died_mid_work): ${e2b.message}`)
}

// ── Start ───────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[bridge] 🚀 Extension WebSocket bridge listening on :${PORT}`)
  console.log(`[bridge]    Health: http://localhost:${PORT}/health`)
  console.log(`[bridge]    WS:     ws://localhost:${PORT}/api/extension/ws?account=<uuid>`)
})

setInterval(pollAndDispatch, POLL_INTERVAL_MS)
// v0.7.46: ping cada 20s (era 30s). MV3 mata el SW del extension a los ~30s idle; un
// ping cada 30s era una carrera (podía llegar tras la muerte del SW). A 20s el SW recibe
// el WS message dentro de su ventana idle → se mantiene VIVO mientras Chrome esté abierto.
// Es el keepalive canónico de MV3 (actividad WebSocket extiende la vida del SW). Server-side,
// sin tocar el extension ni reload. NO ayuda con laptop dormida (eso requiere config de OS).
setInterval(pingAll, 20_000)
setInterval(cleanupExpired, 30_000)  // reap zombies más rápido (antes 60s)
