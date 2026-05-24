// extension-dispatch.js — utilidades para que el scheduler inserte comandos
// en extension_commands en lugar de spawnear scripts Playwright.
//
// Diseño: cada función dispatch* (a) valida gates relevantes y (b) inserta
// el comando en la queue. El bridge polea y despacha a la extension del
// usuario. Las gates duplicadas con scheduler.js se reusan acá.

import { supabase } from './supabase.js'

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

export function isInboxHours(days = ALL_DAYS, tz = DEFAULT_TZ) {
  const { mxHour, mxDay } = mxTime(tz)
  return days.some(d => mxDay.includes(d)) && mxHour >= 8 && mxHour < 21
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
    const t = setTimeout(() => ctrl.abort(), 3000)
    const r = await fetch(BRIDGE_HEALTH_URL, { signal: ctrl.signal })
    clearTimeout(t)
    const j = await r.json()
    const ids = new Set((j.connected_accounts ?? []).map(a => a.accountId))
    _healthCache = { ts: now, data: ids }
    return ids
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

// ── Title whitelist/blacklist filter ─────────────────────────────────────────

export function passesTitleFilters(headline, whitelist = [], blacklist = []) {
  const h = (headline ?? '').toLowerCase()
  if (blacklist?.length) {
    if (blacklist.some(b => h.includes(b.toLowerCase()))) return false
  }
  if (whitelist?.length) {
    if (!whitelist.some(w => h.includes(w.toLowerCase()))) return false
  }
  return true
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
  console.log(`[ext-dispatch] queued ${action} ${data.id.slice(0,8)} for ${accountId.slice(0,8)}`)
  return data.id
}

// ── Convenience wrappers ─────────────────────────────────────────────────────

export async function dispatchSearch(account, campaign, keywords) {
  return dispatchCommand(account.id, 'search', {
    campaignId:       campaign.id,
    keywords:         keywords ?? campaign.search_keywords?.[0] ?? 'Director',
    location:         campaign.search_location ?? null,
    secondDegreeOnly: campaign.search_2nd_degree_only !== false,
    minEmployees:     campaign.search_min_employees ?? null,
    companyNames:     campaign.search_company_names ?? null,
    targetCount:      Math.min(campaign.search_count ?? 25, 50),
    maxPages:         4,
  }, { expiresInMinutes: 15 })
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
  return dispatchCommand(account.id, 'check_inbox', { limit: 30 }, {
    expiresInMinutes: 10,
  })
}

export async function dispatchCheckSentInvites(account) {
  return dispatchCommand(account.id, 'check_sent_invites', {}, {
    expiresInMinutes: 10,
  })
}

export async function dispatchFollowup(account, lead, step, message, threadUrl) {
  return dispatchCommand(account.id, 'send_followup', {
    threadUrl,
    leadId:   lead.id,
    leadName: lead.full_name,
    message,
    step,
  }, { relatedLeadId: lead.id, expiresInMinutes: 10 })
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
  if (account.extension_paused) return 'extension_paused_by_user'

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
