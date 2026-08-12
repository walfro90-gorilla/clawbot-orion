// extension-dispatch.js — utilidades para que el scheduler inserte comandos
// en extension_commands en lugar de spawnear scripts Playwright.
//
// Diseño: cada función dispatch* (a) valida gates relevantes y (b) inserta
// el comando en la queue. El bridge polea y despacha a la extension del
// usuario. Las gates duplicadas con scheduler.js se reusan acá.

import { supabase, createAlert } from './supabase.js'
import { stampLastAttempt } from './lead-failure.js'

// (2026-07-06) A1: guard de versión de extensión. Cada acción "nueva" requiere una versión
// mínima de la extensión; si la conectada es más vieja, dispatchCommand NO la despacha (evita
// 'Unknown action' silencioso + ejecuciones mal hechas). Extensible: agrega acción→versión aquí.
// Solo se listan las acciones nuevas — las demás no se gatean (min undefined = sin gate).
const ACTION_MIN_VERSION = {
  check_connections: '0.9.15',
  resolve_companies: '0.10.0',
  reload_extension:  '0.10.4',
  get_contact_info:  '0.10.15',
}

// v0.10.0: la búsqueda con facet currentCompany requiere la misma versión. Una ext
// vieja IGNORA payload.companyUrn y buscaría solo por título → leads de cualquier
// empresa. El scheduler consulta esto antes de entrar en modo company-scoped.
export const COMPANY_SCOPED_MIN_VERSION = '0.10.0'

// v0.10.13: scraping del overlay de contact-info (email/tel de conexiones 1er grado)
// para el digest diario. El scheduler pre-checa esta versión para skippear en
// silencio (sin generar la alerta extension_outdated en cada tick).
export const CONTACT_INFO_MIN_VERSION = '0.10.15'

// Compara semver simple (a.b.c). Versión desconocida (null) = demasiado vieja → fail-closed.
export function meetsVersion(have, min) {
  if (!have) return false
  const pa = String(have).split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(min).split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const a = pa[i] ?? 0, b = pb[i] ?? 0
    if (a > b) return true
    if (a < b) return false
  }
  return true
}

// ── Time helpers (timezone-aware per account) ────────────────────────────────

const DEFAULT_TZ = 'America/Mexico_City'

export function mxTime(tz = DEFAULT_TZ) {
  const now = new Date()
  const mxHour = parseInt(new Intl.DateTimeFormat('es-MX', {
    timeZone: tz, hour: 'numeric', hour12: false,
  }).format(now))
  const mxDay = new Intl.DateTimeFormat('es-MX', {
    timeZone: tz, weekday: 'long',
  }).format(now).toLowerCase()
  const mxDate = new Intl.DateTimeFormat('es-MX', {
    timeZone: tz,
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: true,
  }).format(now)
  return { mxHour, mxDay, mxDate, now }
}

const DEFAULT_DAYS = ['lunes','martes','miércoles','jueves','viernes']
const ALL_DAYS = [...DEFAULT_DAYS, 'sábado','domingo']

export function isBusinessHours(startHour = 9, endHour = 19, days = DEFAULT_DAYS, tz = DEFAULT_TZ) {
  const { mxHour, mxDay } = mxTime(tz)
  if (!days.some(d => mxDay.includes(d))) return false
  if (mxHour < startHour || mxHour >= endHour) return false
  // Lunch pause 13:00 (saltable con SKIP_LUNCH_PAUSE=true)
  if (process.env.SKIP_LUNCH_PAUSE !== 'true' && mxHour === 13) return false
  return true
}

// v0.7.47: start/end opcionales (override per-account via account_config.inbox_hours).
// Defaults 8-21 → backward-compatible (sin override = idéntico a hoy).
export function isInboxHours(days = ALL_DAYS, tz = DEFAULT_TZ, startHour = 8, endHour = 21) {
  const { mxHour, mxDay } = mxTime(tz)
  return days.some(d => mxDay.includes(d)) && mxHour >= startHour && mxHour < endHour
}

export function minutesSince(isoDate) {
  if (!isoDate) return Infinity
  return (Date.now() - new Date(isoDate).getTime()) / 60_000
}

// Date string YYYY-MM-DD aligned a la timezone dada (default CDMX)
export function mxDateStr(tz = DEFAULT_TZ) {
  // Use Intl para obtener Y-M-D en la TZ exacta (handles DST también)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  return parts  // en-CA da formato 'YYYY-MM-DD' nativo
}

// ── Extension connection check ───────────────────────────────────────────────

const BRIDGE_HEALTH_URL = process.env.BRIDGE_HEALTH_URL ?? 'http://localhost:4002/health'

let _healthCache = { ts: 0, data: null }

/**
 * Returns set of accountIds currently connected to the bridge.
 * Cached 5s for performance (single tick may check multiple accounts).
 */
export async function getConnectedAccountIds() {
  const now = Date.now()
  if (_healthCache.data && now - _healthCache.ts < 5_000) {
    return _healthCache.data
  }
  try {
    const ctrl = new AbortController()
    // v0.8: el timeout cubre TAMBIÉN el r.json() — antes se hacía clearTimeout ANTES
    // de leer el body, así que si el bridge respondía headers pero el body se estancaba,
    // r.json() colgaba indefinido → cuelgue del tick → watchdog hard-kill.
    const t = setTimeout(() => ctrl.abort(), 3000)
    try {
      const r = await fetch(BRIDGE_HEALTH_URL, { signal: ctrl.signal })
      const j = await r.json()
      const ids = new Set((j.connected_accounts ?? []).map(a => a.accountId))
      _healthCache = { ts: now, data: ids }
      return ids
    } finally {
      clearTimeout(t)
    }
  } catch (err) {
    console.warn(`[ext-dispatch] bridge health check failed: ${err.message}`)
    return new Set()
  }
}

export async function isExtensionOnline(accountId) {
  const ids = await getConnectedAccountIds()
  return ids.has(accountId)
}

// ── Warmup ramp + caps (port from scheduler.js) ──────────────────────────────

const WARMUP_LEGACY = { cold: 5, warming: 12, warm: 20, hot: 25 }

export function effectiveWarmupCap(account) {
  if (!account.warmup_started_at) return null
  const days = (Date.now() - new Date(account.warmup_started_at).getTime()) / 86_400_000
  if (days < 3)  return 3
  if (days < 7)  return 5
  if (days < 14) return 8
  if (days < 21) return 12
  if (days < 30) return 18
  return null
}

/**
 * Calcula el cap diario efectivo combinando:
 * - daily_invite_target de la campaña
 * - daily_connection_limit de la cuenta (override manual)
 * - warmup ramp progresivo por edad de cuenta
 * - warmup legacy (status: cold/warming/warm/hot) como fallback
 */
export function getEffectiveDailyCap(account, campaign) {
  const ramp = effectiveWarmupCap(account)
  const legacy = WARMUP_LEGACY[account.warmup_status ?? 'cold'] ?? 5
  const warmupDefault = ramp ?? legacy
  const accountCap = account.daily_connection_limit ?? warmupDefault
  return Math.min(campaign.daily_invite_target ?? 20, accountCap, warmupDefault)
}

// ── Daily activity (CDMX-aligned) ────────────────────────────────────────────

export async function getDailyActivityToday(accountId, tz = DEFAULT_TZ) {
  const { data } = await supabase
    .from('daily_activity')
    .select('invites_sent, messages_sent, errors')
    .eq('linkedin_account_id', accountId)
    .eq('date', mxDateStr(tz))
    .maybeSingle()
  return {
    invites_sent: data?.invites_sent ?? 0,
    messages_sent: data?.messages_sent ?? 0,
    errors: data?.errors ?? 0,
  }
}

// ── Pending leads count (campaign) ───────────────────────────────────────────

export async function getPendingLeadsCount(campaignId) {
  const { count } = await supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .in('status', ['scraped', 'pending'])
  return count ?? 0
}

// ── In-flight command check (lead-level dedup) ───────────────────────────────
// Evita que el scheduler dispatche un segundo comando para el mismo lead mientras
// uno previo sigue en flight (pending/dispatched). Sin esto, si la extension
// no responde rápido, el siguiente tick puede crear otro cmd duplicado.
export async function hasInFlightCommand(leadId, action = null) {
  if (!leadId) return false
  // Zombie cleanup (2026-05-29 fix): si un command lleva >10min en 'dispatched'
  // sin completar, la extensión murió mid-execution. NO lo consideramos in-flight,
  // permitiendo retry. Antes el lead quedaba bloqueado hasta expires_at (15min).
  const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString()
  let q = supabase
    .from('extension_commands')
    .select('id', { count: 'exact', head: true })
    .eq('related_lead_id', leadId)
    .in('status', ['pending', 'dispatched'])
    .gt('expires_at', new Date().toISOString())
    // Excluir zombies: dispatched hace >10min sin completar
    .or(`status.eq.pending,dispatched_at.gt.${tenMinAgo}`)
  if (action) q = q.eq('action', action)
  const { count } = await q
  return (count ?? 0) > 0
}

// ── Account-level circuit breaker (Capa 2) ──────────────────────────────────
// Si una cuenta acumula > THRESHOLD% errores NO-lead-fault en ventana, auto-pausa.
// Crea account_alert critical para que humano revise. Protege contra ban masivo
// cuando algo está globalmente roto (captcha persistente, fingerprint quemado, etc.)
const ACCOUNT_HEALTH_CHECK_COOLDOWN_MS = 5 * 60 * 1000  // 5 min entre checks por cuenta
const _lastAccountCheck = new Map()

// Errores que NO cuentan al circuit breaker (son fault del lead, no de la cuenta).
// Exportado: el bridge lo usa para NO inflar daily_activity.errors con faults benignos.
export const LEAD_FAULT_ERRORS = new Set([
  'lead_not_first_degree',
  'lead_invite_still_pending',
  'profile_not_found',
  'thread_header_mismatch',
])

// Errores de PÁGINA/RENDER que NO son culpa de la cuenta. Estos errores indican
// problemas de timing/SPA/race-conditions de LinkedIn UI, no del lead ni de la
// cuenta. NO deben contar para el account-level circuit breaker (Capa 2) porque
// si no, una racha de errores de UI auto-pausa la cuenta sin razón real.
// 29-may-2026: añadidos tras observar Wal pausada 4× hoy por estos errores.
const PAGE_RENDER_ERRORS = new Set([
  'thread_editor_not_found',
  'thread_not_found_in_inbox',
  'not_on_thread_compose_or_profile_page',
  'conversations_container_not_found',
  'compose_editor_not_found_in_overlay',
  'message_typing_incomplete',
  'lead_not_messageable',  // v0.7.6: LinkedIn cerró el thread, no es page error pero tampoco lead fault
])

// v0.7.3 L5: extra PAGE_ERRORS auto-classificados por phase-analyzer.
// Refrescado cada 5min desde runtime_config.
let _pageErrorsExtra = new Set()
let _pageErrorsExtraLastFetch = 0
async function refreshPageErrorsExtra() {
  if (Date.now() - _pageErrorsExtraLastFetch < 5 * 60_000) return
  _pageErrorsExtraLastFetch = Date.now()
  try {
    const { data } = await supabase
      .from('runtime_config')
      .select('value')
      .eq('key', 'page_errors_extra')
      .maybeSingle()
    if (Array.isArray(data?.value)) {
      _pageErrorsExtra = new Set(data.value)
      if (_pageErrorsExtra.size > 0) {
        console.log(`[ext-dispatch] L5: page_errors_extra cargado (${_pageErrorsExtra.size} entries)`)
      }
    }
  } catch {}
}
refreshPageErrorsExtra()
setInterval(refreshPageErrorsExtra, 5 * 60_000)

function isExtraPageError(errStr) {
  if (!errStr) return false
  const s = String(errStr).toLowerCase()
  for (const pattern of _pageErrorsExtra) {
    // pattern puede tener wildcards (e.g., 'micro_phase_X_timeout_*ms')
    if (pattern.includes('*')) {
      // Convertir wildcard a regex simple
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')
      if (regex.test(s)) return true
    } else if (s === pattern || s.includes(pattern)) {
      return true
    }
  }
  return false
}

// Errores TRANSITORIOS de infraestructura (Chrome cerrado, SW dormido, content
// script no inyectado). NO indican ban/captcha — son problemas de disponibilidad.
// Filtrar string que empieza con "redirect_retry_failed" o contiene estos patrones.
function isTransientInfraError(errStr) {
  if (!errStr) return false
  const s = String(errStr).toLowerCase()
  return (
    s.includes('no current window') ||
    s.includes('message channel closed') ||
    s.includes('receiving end does not exist') ||
    s.includes('extension context invalidated') ||
    s.includes('content_busy_executing') ||
    s.startsWith('redirect_retry_failed:') ||
    // v0.6.45: estos son race conditions del SW/content.js, no de la cuenta.
    s.startsWith('exec_hard_timeout_') ||
    s.startsWith('navigation_during_typing_') ||
    s.startsWith('editor_detached_')
  )
}

export async function checkAccountHealthAndPause(accountId, opts = {}) {
  const { windowMin = 30, minCommands = 5, errorThresholdPct = 60 } = opts
  if (!accountId) return { skipped: 'no_account_id' }

  // Debounce: máximo 1 check por cuenta cada 5 min
  const last = _lastAccountCheck.get(accountId) ?? 0
  if (Date.now() - last < ACCOUNT_HEALTH_CHECK_COOLDOWN_MS) {
    return { skipped: 'cooldown' }
  }
  _lastAccountCheck.set(accountId, Date.now())

  // v0.6.46 fix: si el SW está muriendo seguido (extension_last_seen_at stale),
  // los timeouts son por WS instability, NO por account-fault real (captcha/ban).
  // Pausar no ayuda — el SW no responde ni para verificar. Mejor mantener active
  // y dejar que el usuario active Background Mode en Chrome.
  const { data: accCheck } = await supabase
    .from('linkedin_accounts')
    .select('extension_last_seen_at')
    .eq('id', accountId)
    .single()
  const lastSeenAgoSec = accCheck?.extension_last_seen_at
    ? (Date.now() - new Date(accCheck.extension_last_seen_at).getTime()) / 1000
    : Infinity
  if (lastSeenAgoSec > 90) {
    return {
      healthy: true,
      reason: 'sw_unstable_skip_autopause',
      lastSeenAgoSec: Math.round(lastSeenAgoSec),
    }
  }
  // Adicional: si hubo connection_unstable alert reciente, también skip
  const { data: unstableAlert } = await supabase
    .from('account_alerts')
    .select('id')
    .eq('linkedin_account_id', accountId)
    .eq('alert_type', 'connection_unstable')
    .gte('created_at', new Date(Date.now() - 30 * 60_000).toISOString())
    .limit(1)
    .maybeSingle()
  if (unstableAlert?.id) {
    return { healthy: true, reason: 'connection_unstable_skip_autopause' }
  }

  const cutoff = new Date(Date.now() - windowMin * 60_000).toISOString()
  const { data: cmds } = await supabase
    .from('extension_commands')
    .select('result, status, related_lead_id')
    .eq('account_id', accountId)
    .gte('created_at', cutoff)
    .in('status', ['completed', 'error', 'timeout'])

  if (!cmds || cmds.length < minCommands) {
    return { healthy: true, reason: 'insufficient_data', count: cmds?.length ?? 0 }
  }

  // Account-fault errors REALES: captcha, authwall, rate_limited, etc.
  // EXCLUYE: lead-fault (2do grado, 404), page-render (UI race), Y infra-transitoria.
  // Timeouts SI cuentan PERO solo si no hay error específico que los explica
  // como page-render (porque cleanupExpired marca todos como timeout sin error).
  const accountFaultErrors = cmds.filter(c => {
    const err = c.result?.error
    if (!err) {
      if (c.status === 'timeout') return true  // timeout puro sin contexto = account-fault
      return false
    }
    if (LEAD_FAULT_ERRORS.has(err)) return false
    if (PAGE_RENDER_ERRORS.has(err)) return false
    // v0.9.8: los timeouts de µ-fase (typing_complete, editor_focused, send_button_enabled…)
    // son races de UI/render de LinkedIn, NO account-fault. Antes NO se excluían → el spike
    // de micro_phase_typing_complete_timeout (bug shadow DOM) auto-pausó a Josh 8× vía este
    // circuit breaker. Raíz arreglada en la extensión 0.9.8; esto es defensa para que ningún
    // timeout residual de µ-fase vuelva a auto-pausar la cuenta (Capa 1 los maneja por-lead).
    if (typeof err === 'string' && err.startsWith('micro_phase_') && err.includes('timeout')) return false
    if (isTransientInfraError(err)) return false
    return true
  })

  // ARQUITECTURA CORRECTA: Capa 2 solo se activa si los errores vienen de MÚLTIPLES
  // leads distintos. Si todos los errores son de 1-2 leads, es problema específico
  // del lead (Capa 1 los maneja) — NO pausar cuenta global.
  // Threshold: necesitas >=3 leads distintos con error account-fault en la ventana.
  const distinctLeadsWithError = new Set(
    accountFaultErrors.map(c => c.related_lead_id).filter(Boolean)
  )
  const MIN_DISTINCT_LEADS_FOR_PAUSE = 3
  if (distinctLeadsWithError.size < MIN_DISTINCT_LEADS_FOR_PAUSE) {
    return {
      healthy: true,
      reason: 'errors_concentrated_in_few_leads',
      distinctLeads: distinctLeadsWithError.size,
      totalErrors: accountFaultErrors.length,
      cmds: cmds.length,
    }
  }

  const errorPct = (accountFaultErrors.length / cmds.length) * 100
  if (errorPct < errorThresholdPct) {
    return { healthy: true, errorPct: Math.round(errorPct), count: cmds.length }
  }

  // ¿Ya está pausada? si sí, no spamear alertas
  const { data: acc } = await supabase
    .from('linkedin_accounts')
    .select('label, extension_paused')
    .eq('id', accountId)
    .single()
  if (acc?.extension_paused) {
    return { healthy: false, alreadyPaused: true, errorPct: Math.round(errorPct) }
  }

  // Pause + insert alert critical
  await supabase.from('linkedin_accounts').update({
    extension_paused: true,
    extension_paused_reason: 'circuit_breaker_error_spike',  // v0.9.13: razón HONESTA (no "by_user")
  }).eq('id', accountId)

  await supabase.from('account_alerts').insert({
    linkedin_account_id: accountId,
    alert_type: 'error_spike',
    severity: 'critical',
    message: `🛑 Cuenta "${acc?.label ?? accountId.slice(0,8)}" auto-pausada por circuit breaker: ${Math.round(errorPct)}% errores en últimos ${windowMin}min (${accountFaultErrors.length}/${cmds.length}). Revisa logs y despausa manualmente en /dashboard/accounts.`,
    details: {
      error_rate_pct: errorPct,
      window_min: windowMin,
      total_commands: cmds.length,
      error_count: accountFaultErrors.length,
      triggered_by: 'capa_2_account_circuit_breaker',
      sample_errors: accountFaultErrors.slice(0, 5).map(e => e.result?.error ?? 'timeout'),
    },
    auto_paused: true,
  })

  console.log(`[ext-dispatch] 🛑 Account ${accountId.slice(0,8)} (${acc?.label}) AUTO-PAUSED: ${Math.round(errorPct)}% error rate (${accountFaultErrors.length}/${cmds.length})`)
  return { healthy: false, paused: true, errorPct: Math.round(errorPct), count: cmds.length }
}

// ── Lead-level circuit breaker ───────────────────────────────────────────────
// Si un lead falla N veces consecutivas con MISMO error_code en últimas X horas,
// marca el lead como dead automáticamente. Detiene loops infinitos en errores que
// no tienen handler específico (ej: not_on_thread_compose_or_profile_page).
// Returns true si el lead fue killed (caller debe skipear el dispatch).
export async function checkAndKillLeadIfStuck(leadId, errorCode, opts = {}) {
  const { threshold = 3, windowHours = 6 } = opts
  if (!leadId || !errorCode) return false

  // CRÍTICO: NUNCA matar un lead por errores de infra transitoria (Chrome cerrado,
  // SW muerto, message channel closed, redirect_retry_failed). Esos NO son culpa
  // del lead — son fallos de disponibilidad. Matar leads buenos por esto = bug.
  if (isTransientInfraError(errorCode)) {
    return false
  }

  // Tampoco matar por errores de PÁGINA/render (no culpa del lead):
  //  - thread_editor_not_found: el panel del thread no carga (issue de nav/hidratación,
  //    ya mitigado por P1 thread-via-inbox-click). El 2do-grado real se detecta aparte
  //    como compose_no_editor_recaptcha_only → lead_not_first_degree.
  //  - not_on_thread_compose_or_profile_page: navegación SPA imperfecta.
  //  - thread_not_found_in_inbox / conversations_container_not_found: lista no cargó.
  //  - thread_header_mismatch: LinkedIn navegó a thread incorrecto (anterior quedó
  //    "pegado") — NO es culpa del lead, es race condition de SPA. v0.6.42+.
  //  - message_typing_incomplete: typing fue interrumpido (notif/render/focus).
  //  - exec_hard_timeout_send_followup_*: SW colgó (auto-heal v0.6.40).
  //  - navigation_during_typing_at_char_*: URL cambió mid-type (v0.6.41 guard).
  const PAGE_ERRORS = new Set([
    'thread_editor_not_found',
    'not_on_thread_compose_or_profile_page',
    'thread_not_found_in_inbox',
    'conversations_container_not_found',
    'compose_editor_not_found_in_overlay',
    'thread_header_mismatch',
    'message_typing_incomplete',
  ])
  if (PAGE_ERRORS.has(errorCode)) {
    return false
  }
  // Errores con sufijo dinámico (timestamps/char counts) — match por prefijo
  if (errorCode.startsWith('exec_hard_timeout_') ||
      errorCode.startsWith('navigation_during_typing_') ||
      errorCode.startsWith('editor_detached_') ||
      errorCode.startsWith('micro_phase_')) {
    return false
  }
  // L5: extra PAGE_ERRORS aprendidos por phase-analyzer
  if (isExtraPageError(errorCode)) {
    return false
  }

  const cutoff = new Date(Date.now() - windowHours * 3_600_000).toISOString()
  // Solo cmds completados o errored — excluye in-flight para no "tapar" los errors históricos
  const { data: recentErrors } = await supabase
    .from('extension_commands')
    .select('result, created_at, status')
    .eq('related_lead_id', leadId)
    .eq('action', 'send_followup')
    .gte('created_at', cutoff)
    .in('status', ['completed', 'error', 'timeout'])
    .order('created_at', { ascending: false })
    .limit(threshold)

  if (!recentErrors || recentErrors.length < threshold) return false

  // Verificar que TODOS los últimos N comandos hayan fallado con el mismo error
  // (o sean timeout — también cuenta como fallo de este lead)
  const allSameError = recentErrors.every(r =>
    r.result?.error === errorCode || (r.status === 'timeout' && errorCode === 'timeout')
  )
  if (!allSameError) return false

  // Kill switch: mark dead
  await supabase.from('leads').update({
    status: 'dead',
    dead_reason: `auto_kill_${errorCode}_x${threshold}`,
  }).eq('id', leadId)
  console.log(`[ext-dispatch] 💀 Lead ${leadId.slice(0,8)} auto-killed: ${threshold}x ${errorCode}`)
  return true
}

// ── Content-based dedup ──────────────────────────────────────────────────────
// Verifica si un mensaje idéntico/similar fue enviado a este lead en últimas X horas.
// Defensa contra duplicados que escapan a hasInFlightCommand (e.g., cmd anterior
// completado pero ingest falló y lead status no avanzó).
export async function wasMessageRecentlySent(leadId, messageText, withinHours = 4) {
  if (!leadId || !messageText) return false
  const cutoff = new Date(Date.now() - withinHours * 3_600_000).toISOString()
  const fingerprint = messageText.replace(/\s+/g, ' ').trim().slice(0, 120)
  if (fingerprint.length < 20) return false  // muy corto, no confiable

  const { data: conv } = await supabase
    .from('conversations')
    .select('id')
    .eq('lead_id', leadId)
    .maybeSingle()
  if (!conv) return false

  const { data: events } = await supabase
    .from('conversation_events')
    .select('content, sent_at')
    .eq('conversation_id', conv.id)
    .eq('direction', 'outbound')
    .gte('sent_at', cutoff)
    .order('sent_at', { ascending: false })
    .limit(10)

  return (events ?? []).some(e => {
    const eFp = (e.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
    return eFp === fingerprint
  })
}

// ── Title whitelist/blacklist filter ─────────────────────────────────────────

// v0.7.43: matching de BLACKLIST por PALABRA COMPLETA, no substring. Antes
// `h.includes('intern')` rechazaba "Director International Revenue" (Jorge Perea)
// porque "international" CONTIENE "intern"; igual `'hr'` matcheaba "CHRO". Eran
// falsos positivos que filtraban leads válidos en silencio (Josh: no_leads_pass_
// whitelist con candidatos buenos). Tratamos letras acentuadas como parte de la
// palabra para no romper términos en español ("diseñador", etc.). El whitelist se
// deja como substring (permisivo a propósito: "Director" debe cazar "Directores").
const _WORD_CHARS = 'a-z0-9áéíóúñü'
function blacklistHit(h, blacklist) {
  return blacklist.some(b => {
    const term = (b ?? '').toLowerCase().trim()
    if (!term) return false
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^${_WORD_CHARS}])${esc}([^${_WORD_CHARS}]|$)`, 'i').test(h)
  })
}

// v0.9.x (hallazgo Wal 2026-07-03 #4): normaliza para comparar quitando acentos
// (á→a, ü→u) pero PRESERVANDO la ñ (no se toca U+0303). Antes el whitelist por substring
// fallaba "Dirección" vs "Direccion". No aplica a blacklist (queda igual, ya robusto).
const _stripAcc = (s) => (s ?? '').toLowerCase().normalize('NFD').replace(/[\u0301\u0308]/g, '')

export function passesTitleFilters(headline, whitelist = [], blacklist = []) {
  const h = (headline ?? '').toLowerCase()
  if (blacklist?.length) {
    if (blacklistHit(h, blacklist)) return false
  }
  if (whitelist?.length) {
    // v0.7.7: si headline está vacío (search no scrapeó headline), PASS.
    // El search query ya filtró por los keywords correctos del campaign — no es
    // necesario refilter aquí cuando no tenemos headline data. Esto desbloquea
    // pools donde el scrape no captura headlines (~80% de leads tienen null).
    if (h.length === 0) return true
    // Substring permisivo a propósito ("Director" caza "Directores"), pero insensible
    // a acentos. NOTA: variantes de OTRA raíz ("Directivo") requieren añadir el término
    // al whitelist (config) — el substring no las alcanza por diseño.
    const hn = _stripAcc(h)
    if (!whitelist.some(w => hn.includes(_stripAcc(w)))) return false
  }
  return true
}

// ── Peso de responsabilidad (Fase 2, jul-2026) ───────────────────────────────
// El flujo objetivo pide invitar "al top de más responsabilidad" de cada empresa. El
// whitelist es PLANO (pasa/no pasa), así que un Coordinador de Compras competía de igual
// a igual con el Director General. Esto ordena el pool ya filtrado.
// Headline vacío → 0: no se penaliza ni se premia, cae al desempate FIFO de siempre.
// ponytail: heurística por regex, no LLM. Si hace falta más finura (idiomas raros,
// títulos inventados), el upgrade es puntuar con el LLM en el pass de enriquecimiento
// y persistir el score — no complicar esta tabla.
// OJO: normaliza con _stripAllMarks (no _stripAcc): ese preserva la ñ DESCOMPUESTA
// (n + U+0303) para el whitelist, y un patrón con "ñ" precompuesta nunca casaría.
const _stripAllMarks = (s) => (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

const SENIORITY_TIERS = [
  [5, /(^|[^a-z])(ceo|cfo|coo|cto|cio|cmo|cro|cso|cpo|chief|founder|co-?founder|owner|president[ea]?|propietari[oa]|duen[oa]|socio)([^a-z]|$)/],
  [4, /(^|[^a-z])(vp|vicepresident[ea]?|vice president|director[a]? general|director[a]? ejecutiv[oa]|managing director|executive director|country manager|general manager|gerente general)([^a-z]|$)/],
  [3, /(^|[^a-z])(director[a]?|head of|jef[ea])([^a-z]|$)/],
  [2, /(^|[^a-z])(gerente|manager|lider|lead)([^a-z]|$)/],
  [1, /(^|[^a-z])(coordinador[a]?|coordinator|supervisor[a]?|especialista|specialist|analista|analyst|ejecutiv[oa])([^a-z]|$)/],
]

export function seniorityRank(headline) {
  const h = _stripAllMarks(headline)
  if (!h) return 0
  for (const [rank, re] of SENIORITY_TIERS) {
    if (re.test(h)) return rank
  }
  return 0
}

// ── Core dispatch primitives ─────────────────────────────────────────────────

/**
 * Inserta un comando en extension_commands. Returns insertedId o null si falla.
 * @param {string} accountId
 * @param {string} action - 'search' | 'send_invite' | 'send_followup' | 'check_inbox'
 * @param {object} payload
 * @param {object} opts - { relatedLeadId, expiresInMinutes }
 */
export async function dispatchCommand(accountId, action, payload, opts = {}) {
  const { relatedLeadId, expiresInMinutes = 30 } = opts
  // A1: guard de versión (fail-closed). Solo lee ext_version para acciones gateadas (las nuevas).
  const minV = ACTION_MIN_VERSION[action]
  if (minV) {
    const { data: acct } = await supabase.from('linkedin_accounts').select('ext_version, label').eq('id', accountId).maybeSingle()
    if (!meetsVersion(acct?.ext_version, minV)) {
      console.warn(`[ext-dispatch] ⏭️ ${action} BLOQUEADO: ext ${acct?.ext_version ?? '?'} < ${minV} (${acct?.label ?? accountId.slice(0,8)}) — recargar extensión`)
      try {
        await createAlert(accountId, null, 'extension_outdated', 'warning',
          `Extensión desactualizada (v${acct?.ext_version ?? '?'}) — recárgala en chrome://extensions. Se bloqueó "${action}" (requiere ≥${minV}).`,
          { action, ext_version: acct?.ext_version ?? null, required: minV }, false)
      } catch { /* best-effort */ }
      return null
    }
  }
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60_000).toISOString()
  const row = {
    account_id: accountId,
    action,
    payload,
    status: 'pending',
    expires_at: expiresAt,
  }
  if (relatedLeadId) row.related_lead_id = relatedLeadId
  const { data, error } = await supabase
    .from('extension_commands')
    .insert(row)
    .select('id')
    .single()
  if (error) {
    console.error(`[ext-dispatch] insert ${action} failed: ${error.message}`)
    return null
  }
  // FIFO fairness: stamp last_attempt_at AL MOMENTO de dispatch (no al result).
  // Sin esto, un lead que falla y queda en cooldown mantiene last_attempt_at
  // viejo y compite contra leads sanos no atendidos. Lo hacemos fire-and-forget
  // para no bloquear el dispatch — el error solo se loggea.
  // v0.7.13: si payload.is_stress_test, NO contamines counters de producción.
  const isStressTest = !!payload?.is_stress_test
  if (relatedLeadId && !isStressTest) {
    stampLastAttempt(relatedLeadId).catch(err =>
      console.error(`[ext-dispatch] stampLastAttempt failed: ${err.message}`))
  }
  const tag = isStressTest ? '[stress]' : '[ext-dispatch]'
  console.log(`${tag} queued ${action} ${data.id.slice(0,8)} for ${accountId.slice(0,8)}`)
  return data.id
}

// ── Convenience wrappers ─────────────────────────────────────────────────────

export async function dispatchSearch(account, campaign, keywords, opts = {}) {
  // Convertir location single-string ("Mexico City, Monterrey, Guadalajara, ...")
  // a array de strings para que content.js pueda hacer post-filter por substring
  // y background.js mapeé a geoUrn IDs en URL.
  const locationStr = campaign.search_location ?? ''
  const locationArr = locationStr
    .split(',').map(s => s.trim()).filter(Boolean)

  // v0.7.49: ROTACIÓN DE GEOGRAFÍA — si la campaña tiene MÚLTIPLES ubicaciones, cada búsqueda
  // usa UNA sola (rotando por el mismo idx que la keyword). Así cada país tiene su page-1
  // FRESCO en cada vuelta, en vez de combinar todos en una page-1 que se repite y se agota.
  // Con 1 ubicación = no-op (Wal y cualquier campaña single-location quedan idénticas).
  // geoUrn (background.js) filtra server-side el país correcto; el post-filter de content.js
  // matchea el nombre en el idioma del UI (por eso se usan nombres en español para cuentas es-MX).
  let rotatedLocations = locationArr
  if (locationArr.length > 1) {
    const locIdx = (campaign.last_search_keyword_idx ?? 0) % locationArr.length
    rotatedLocations = [locationArr[locIdx]]
  }

  // v0.10.0 BUSCAR POR EMPRESA — facet nativo, cursor por empresa.
  // Antes (v0.7.26): la empresa se concatenaba al keyword ("Director General Softtek")
  // y se rotaba con el MISMO índice que el título → cobertura diagonal, match difuso,
  // 10% de acierto medido en CAFE 57. Ahora la empresa llega resuelta desde
  // campaign_target_companies (opts.targetCompany) y viaja como companyUrn → facet
  // currentCompany en la URL. Sin URN resuelto degradamos al nombre entre comillas
  // (mejor que nada, y el nombre exacto es más estricto que el texto suelto de antes).
  const tc = opts.targetCompany ?? null
  let finalKeywords = keywords ?? campaign.search_keywords?.[0] ?? 'Director'
  if (tc && !tc.linkedin_urn) finalKeywords = `"${tc.name}" ${finalKeywords}`

  return dispatchCommand(account.id, 'search', {
    campaignId:       campaign.id,
    // v0.10.10 (3-ago): SalesNav TAMBIÉN en modo empresa. buildSalesNavSearchUrl arma el
    // filtro nativo CURRENT_COMPANY desde payload.companyUrn (ext ≥0.10.1); probado en
    // vivo en la cuenta de Josh (cmd 8392b757): el filtro aplica y el scraper extrae.
    // Ventaja SalesNav: ve TODA la empresa, no solo tu red (el free con facet mostraba
    // 4 personas de Mondelēz; SalesNav ve la plantilla completa).
    // Sin URN resuelto NO hay filtro nativo → seguimos en free con "nombre exacto".
    searchMode:       (tc && !tc.linkedin_urn) ? 'free' : (account.search_mode ?? 'free'),
    keywords:         finalKeywords,
    companyUrn:       tc?.linkedin_urn ?? null,   // facet currentCompany (v0.10.0)
    targetCompanyId:  tc?.id ?? null,             // para que el bridge marque el cursor + etiquete leads
    targetCompany:    tc?.name ?? null,
    // Con empresa NO se filtra geografía (la empresa opera donde opera) ni se post-filtra
    // por location: el facet ya acota y el geo rotado mataba búsquedas legítimas.
    locations:        tc ? null : (rotatedLocations.length ? rotatedLocations : null),
    location:         tc ? null : (locationStr || null),         // legacy single-string (ignorado en URL builder)
    secondDegreeOnly: campaign.search_2nd_degree_only !== false,
    // El filtro de tamaño no aplica cuando YA elegimos la empresa (y podría excluirla).
    minEmployees:     tc ? null : (campaign.search_min_employees ?? null),
    companyNames:     null,  // post-filter por headline: sigue muerto (era el bug de v0.7.26)
    titleWhitelist:   campaign.title_whitelist ?? null,
    titleBlacklist:   campaign.title_blacklist ?? null,
    targetCount:      Math.min(campaign.search_count ?? 25, 50),
    maxPages:         4,
  }, { expiresInMinutes: 15 })
}

// v0.10.0 — resuelve un LOTE de empresas (nombre → company URN) en un solo comando.
// La extensión navega una vez por empresa dentro del mismo comando; batchear evita
// gastar un gap de búsqueda por empresa.
// v0.10.4 — pide a la extensión que se recargue sola (equivale al ↻ de
// chrome://extensions). Úsalo DESPUÉS de publicar un bundle nuevo: el operador ya no
// tiene que tocar nada. Requiere que la máquina tenga ≥0.10.4 instalada.
export async function dispatchReloadExtension(account) {
  return dispatchCommand(account.id ?? account, 'reload_extension', {}, { expiresInMinutes: 10 })
}

export async function dispatchResolveCompanies(account, companies) {
  return dispatchCommand(account.id, 'resolve_companies', {
    companies: companies.map(c => ({ id: c.id, name: c.name })),
  }, { expiresInMinutes: 20 })
}

export async function dispatchInvite(account, lead, opts = {}) {
  const { message = null, dryRun = false } = opts
  return dispatchCommand(account.id, 'send_invite', {
    profileUrl: lead.linkedin_url,
    leadId:     lead.id,
    message,
    dryRun,
  }, { relatedLeadId: lead.id, expiresInMinutes: 10 })
}

export async function dispatchCheckInbox(account) {
  // Plan B RE-HABILITADO 2026-05-28: ambas cuentas Wal y Josh en v0.6.35+, que tiene
  // el fix del bug click-URL-race (verifica que la URL CAMBIE tras el click antes de
  // asignar threadId). Ahora seguro capturar thread_ids siempre — necesario para que
  // auto-promote orphan→lead funcione y Orion responda mensajes inbound de prospects
  // no invitados.
  return dispatchCommand(account.id, 'check_inbox', {
    limit: 30,
    captureThreads: true,
    maxCaptures: 15,
  }, {
    expiresInMinutes: 15,
  })
}

export async function dispatchCheckSentInvites(account) {
  return dispatchCommand(account.id, 'check_sent_invites', {}, {
    expiresInMinutes: 10,
  })
}

// (2026-07-04) Accept-detection POSITIVA: scrapea la lista de conexiones y marca connected
// por PRESENCIA (no por ausencia como check_sent_invites). Backstop que cierra las zonas ciegas.
export async function dispatchCheckConnections(account) {
  return dispatchCommand(account.id, 'check_connections', {}, {
    expiresInMinutes: 10,
  })
}

export async function dispatchFollowup(account, lead, step, message, threadUrl, profileUrl) {
  // v0.7.26 BUG extension_did_not_respond fix B3: expiry DINÁMICO alineado con
  // el hard timeout de content.js (calcHardTimeout = msgLen*550 + 120s, cap 480s).
  // Antes era 3min (180s) FIJO, pero content.js puede tardar legítimamente hasta
  // 200-480s con humanType en horas pesadas CDMX → el bridge expiraba el cmd
  // MIENTRAS content.js seguía tipeando → marcado extension_did_not_respond aunque
  // el mensaje SÍ se enviaba. 35+ timeouts 120ms y parte de los did_not_respond.
  // Expiry = hard_timeout + 45s margen (SW→bridge report roundtrip), clamp [4,9]min.
  const msgLen = message?.length ?? 0
  const hardMs = msgLen > 0 ? Math.min(480_000, msgLen * 550 + 120_000) : 90_000
  const expiresInMinutes = Math.max(4, Math.min(9, Math.ceil((hardMs + 45_000) / 60_000)))
  return dispatchCommand(account.id, 'send_followup', {
    threadUrl,        // null si lead no tiene thread (invite sin nota)
    profileUrl,       // fallback: navegar al perfil + compose
    leadId:   lead.id,
    leadName: lead.full_name,
    message,
    step,
  }, { relatedLeadId: lead.id, expiresInMinutes })
}

// ── Campaign-level gate composites ───────────────────────────────────────────

/**
 * Devuelve null si la campaña puede correr ACCIONES en este momento, o un
 * string con la razón de skip si no. Centraliza todas las gates de horario,
 * pausa y conectividad.
 */
export async function checkCampaignActiveGates(campaign, account) {
  if (!campaign.is_active) return 'campaign_inactive'
  if (account.status === 'banned') return 'account_banned'
  // v0.9.13: reflejar la razón REAL de la pausa, no el literal engañoso "by_user"
  // (circuit breaker/banner pausan sin ser humano). Solo se usa para logs/skip-reason.
  if (account.extension_paused) return `extension_paused:${account.extension_paused_reason ?? 'by_user'}`

  // Schedule hours (default 9-19h Lun-Vie) — respeta timezone de la cuenta
  const tz = account.timezone || DEFAULT_TZ
  const startHour = campaign.schedule_start_hour ?? 9
  const endHour = campaign.schedule_end_hour ?? 19
  const days = campaign.schedule_days?.length ? campaign.schedule_days : DEFAULT_DAYS
  if (!isBusinessHours(startHour, endHour, days, tz)) return 'outside_business_hours'

  // Extension online
  const online = await isExtensionOnline(account.id)
  if (!online) return 'extension_offline'

  return null  // OK
}

// ── Post-Prospecting (v0.9) ──────────────────────────────────────────────────

// Contador diario de comentarios públicos (columna separada, NO comparte el
// presupuesto de invitaciones). El RPC increment_daily_activity('comments_posted')
// lo incrementa desde el bridge tras un comentario exitoso.
export async function getDailyCommentsToday(accountId, tz = DEFAULT_TZ) {
  const { data } = await supabase
    .from('daily_activity')
    .select('comments_posted')
    .eq('linkedin_account_id', accountId)
    .eq('date', mxDateStr(tz))
    .maybeSingle()
  return data?.comments_posted ?? 0
}

// Cap efectivo de comentarios/día: target de la campaña, recortado por warmup.
// Cuentas frías comentan muy poco (1-2) — el comentario público es más riesgoso
// que una invitación privada.
export function getEffectiveCommentCap(account, postCampaign) {
  const target = postCampaign.daily_comment_target ?? 5
  const ws = account.warmup_status ?? 'cold'
  if (ws === 'cold') return Math.min(target, 2)
  if (ws === 'warming') return Math.min(target, 4)
  return target
}

/**
 * Despacha una búsqueda de POSTS (no perfiles). Espejo de dispatchSearch.
 * @param {object} account
 * @param {object} postCampaign
 * @param {string} keyword - keyword rotada (post_keywords[idx])
 */
export async function dispatchPostSearch(account, postCampaign, keyword) {
  const finalKeyword = keyword
    ?? postCampaign.post_keywords?.[0]
    ?? 'busco recomendación'
  return dispatchCommand(account.id, 'search_posts', {
    postCampaignId: postCampaign.id,
    keywords:       finalKeyword,
    recency:        postCampaign.post_recency ?? 'past-week',
    targetCount:    20,
    maxScrolls:     12,
  }, { expiresInMinutes: 15 })
}

/**
 * Despacha la publicación de un comentario en un post. Expiry dinámico por
 * longitud del comentario (humanTypeContentEditable es lento), igual que
 * dispatchFollowup. El connect NO se despacha aquí — se encadena desde el
 * ingest del comentario exitoso (extension-bridge.ingestCommentPosted).
 * @param {object} account
 * @param {object} opportunity - fila de post_opportunities (status='approved')
 */
export async function dispatchCommentOnPost(account, opportunity) {
  const comment = opportunity.edited_comment ?? opportunity.draft_comment ?? ''
  const msgLen = comment.length
  const hardMs = msgLen > 0 ? Math.min(360_000, msgLen * 550 + 90_000) : 90_000
  const expiresInMinutes = Math.max(4, Math.min(8, Math.ceil((hardMs + 45_000) / 60_000)))
  return dispatchCommand(account.id, 'comment_on_post', {
    opportunityId:  opportunity.id,
    postPermalink:  opportunity.post_permalink,
    postUrn:        opportunity.post_urn,
    comment,
  }, { expiresInMinutes })
}

/**
 * Gate compuesto para post-campañas. Análogo a checkCampaignActiveGates pero
 * usando los campos de post_campaigns. Devuelve null si puede correr, o la razón.
 */
export async function checkPostCampaignActiveGates(postCampaign, account) {
  if (!postCampaign.is_active) return 'post_campaign_inactive'
  if (account.status === 'banned') return 'account_banned'
  // v0.9.13: reflejar la razón REAL de la pausa, no el literal engañoso "by_user"
  // (circuit breaker/banner pausan sin ser humano). Solo se usa para logs/skip-reason.
  if (account.extension_paused) return `extension_paused:${account.extension_paused_reason ?? 'by_user'}`

  const tz = account.timezone || DEFAULT_TZ
  const startHour = postCampaign.schedule_start_hour ?? 9
  const endHour = postCampaign.schedule_end_hour ?? 19
  const days = postCampaign.schedule_days?.length ? postCampaign.schedule_days : DEFAULT_DAYS
  if (!isBusinessHours(startHour, endHour, days, tz)) return 'outside_business_hours'

  const online = await isExtensionOnline(account.id)
  if (!online) return 'extension_offline'

  return null  // OK
}
