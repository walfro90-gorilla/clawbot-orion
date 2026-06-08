// scheduler-extension.js — Smart Hybrid scheduler (Sub-Fase 3)
//
// Reemplaza scheduler.js. En lugar de spawnear scripts Playwright que ya no
// son viables (multi-IP ban), inserta comandos en extension_commands y deja
// que extension-bridge.js los despache a la extension del usuario.
//
// Tick cada 5 min:
//   - Para cada campaña activa: search, invites, inbox, follow-ups
//   - Respeta schedule_hours / paused / gaps / caps / warmup / extension_online
//
// PM2 corre este script en lugar del scheduler.js viejo.

import dotenv from 'dotenv'
import { supabase, logActivity } from './lib/supabase.js'
import {
  mxTime, mxDateStr, minutesSince,
  isBusinessHours, isInboxHours,
  isExtensionOnline, getConnectedAccountIds,
  getEffectiveDailyCap, getDailyActivityToday, getPendingLeadsCount,
  hasInFlightCommand, wasMessageRecentlySent,
  passesTitleFilters,
  dispatchSearch, dispatchInvite, dispatchCheckInbox, dispatchCheckSentInvites, dispatchFollowup,
  dispatchCommand,
  checkCampaignActiveGates,
} from './lib/extension-dispatch.js'
import { generateLinkedInMessage, generateLinkedInReply, personalizeFollowupMessage, hasLeftoverPlaceholder } from './lib/ai-message.js'
import { isSystemLinkedInAccount } from './lib/system-accounts.js'
import { sweepQuarantineTimeout } from './lib/lead-failure.js'

dotenv.config()

const TICK_INTERVAL_MS = parseInt(process.env.TICK_INTERVAL_MS ?? '300000')  // 5 min default
const TICK_TIMEOUT_MS  = parseInt(process.env.TICK_TIMEOUT_MS  ?? '240000')  // 4 min: máx un tick
const HUNG_TIMEOUT_MS  = parseInt(process.env.HUNG_TIMEOUT_MS  ?? '600000')  // 10 min: watchdog mata el proceso
const MAX_DAILY_MESSAGES = parseInt(process.env.MAX_DAILY_MESSAGES ?? '30')  // FU+FM combinado por cuenta/día
const DRY_RUN = process.env.DRY_RUN === 'true'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min

// v0.7.13 — helper para leer runtime_config (single key) y retornar value como
// número con default si no existe o no es número.
async function readRuntimeNumber(key, def) {
  const { data } = await supabase
    .from('runtime_config')
    .select('value')
    .eq('key', key)
    .maybeSingle()
  const v = data?.value
  if (typeof v === 'number') return v
  if (typeof v === 'string' && !isNaN(Number(v))) return Number(v)
  return def
}

// v0.7.13 — también reset lockout_skip_count cuando un FU succeeds.
// (este helper lo llaman handlers de bridge, no scheduler — pero exportable si
// alguien necesita resetear manualmente desde aquí)
async function resetLockoutSkipCount(leadId) {
  if (!leadId) return
  await supabase.from('leads').update({ lockout_skip_count: 0 }).eq('id', leadId)
}

// v0.7.13 stress test harness — si runtime_config.stress_test_lock está activo
// y no expirado, retorna account_id afectado. Scheduler skippea esa cuenta el tick.
async function readStressTestLock() {
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

// ── Watchdog: detecta scheduler hung (no tick en N min) ──────────────────────
// Cada tick exitoso actualiza lastTickAt. Si pasa más de HUNG_TIMEOUT_MS sin
// tick, mata el proceso y deja que PM2 lo restartee.
let lastTickAt = Date.now()
let tickInFlight = false

function watchdog() {
  const sinceTick = Date.now() - lastTickAt
  if (sinceTick > HUNG_TIMEOUT_MS) {
    console.error(`[SCH-EXT] 🔴 WATCHDOG: scheduler hung — sin tick desde hace ${Math.floor(sinceTick/1000)}s. Matando proceso para que PM2 reinicie.`)
    process.exit(1)
  }
  // Si hay un tick que lleva más de TICK_TIMEOUT_MS in-flight, también es señal
  if (tickInFlight && sinceTick > TICK_TIMEOUT_MS) {
    console.error(`[SCH-EXT] 🔴 WATCHDOG: tick en flight desde hace ${Math.floor(sinceTick/1000)}s (>${TICK_TIMEOUT_MS/1000}s). Matando proceso.`)
    process.exit(1)
  }
}

// Race wrapper para abortar ticks que tarden demasiado
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms)),
  ])
}

// ── Job logging ──────────────────────────────────────────────────────────────

async function logJob({ campaignId, accountId, jobType, status, skipReason, leadsFound, leadsSent, details }) {
  await supabase.from('scheduler_log').insert({
    campaign_id: campaignId ?? null,
    account_id:  accountId ?? null,
    job_type:    jobType,
    status,
    skip_reason: skipReason ?? null,
    leads_found: leadsFound ?? null,
    leads_sent:  leadsSent ?? null,
    details:     details ?? {},
  })
}

// ── Search trigger ───────────────────────────────────────────────────────────
// Dispara search si: !search_paused + gap respetado + pending_leads bajo + connected

async function trySearchForCampaign(campaign, account) {
  if (campaign.search_paused) {
    return { skipped: true, reason: 'search_paused' }
  }

  const searchGapHours = campaign.search_gap_hours ?? 24
  const minsSince = minutesSince(campaign.last_searched_at)

  // Floor override: si el queue de invitables se agotó, forzar search ignorando gap
  // (cap a 1 forzado por hora para no abusar de LinkedIn)
  let droughtOverride = false
  try {
    const { count: scrapedCount } = await supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaign.id)
      .eq('status', 'scraped')
      .is('last_followup_at', null)
    const target = campaign.daily_invite_target ?? 10
    if ((scrapedCount ?? 0) < Math.max(1, Math.floor(target / 2)) && minsSince > 60) {
      droughtOverride = true
      console.log(`[SCH-EXT]   ⚡ drought override active for ${campaign.name}: scraped=${scrapedCount}, target=${target}`)
    }
  } catch (e) {
    console.warn(`[SCH-EXT]   drought-check error:`, e?.message)
  }

  if (!droughtOverride && minsSince < searchGapHours * 60) {
    return { skipped: true, reason: 'search_gap_not_met', minsSince: Math.floor(minsSince) }
  }

  const minPending = campaign.min_pending_threshold ?? 10
  const pendingCount = await getPendingLeadsCount(campaign.id)
  if (pendingCount >= minPending) {
    return { skipped: true, reason: 'enough_pending_leads', pendingCount, minPending }
  }

  // Rotación per-search (fix 29-may-2026): antes usaba hour-of-day como índice,
  // pero si search corre 1×/día siempre cae en la misma hora → siempre misma keyword.
  // Ahora usamos last_search_keyword_idx persistente: cada search incrementa idx mod N.
  // Eso garantiza que las 13 keywords configuradas SE USEN TODAS, no solo la primera.
  const kws = campaign.search_keywords ?? []
  if (kws.length === 0) {
    return { skipped: true, reason: 'no_search_keywords' }
  }
  const curIdx = campaign.last_search_keyword_idx ?? 0
  const idx = curIdx % kws.length
  const keyword = kws[idx]
  const nextIdx = (idx + 1) % kws.length

  if (DRY_RUN) {
    console.log(`[SCH-EXT] DRY_RUN search "${campaign.name}" keyword="${keyword}"`)
    return { dispatched: false, dryRun: true, keyword }
  }

  const cmdId = await dispatchSearch(account, campaign, keyword)
  if (!cmdId) {
    return { skipped: true, reason: 'dispatch_failed' }
  }

  await supabase.from('campaigns')
    .update({
      last_searched_at: new Date().toISOString(),
      last_search_keyword_idx: nextIdx,  // rotación persistente
    })
    .eq('id', campaign.id)

  await logJob({
    campaignId: campaign.id, accountId: account.id, jobType: 'search',
    status: 'dispatched',
    details: { commandId: cmdId, keyword, pendingBefore: pendingCount },
  })

  return { dispatched: true, commandId: cmdId, keyword }
}

// ── Invite trigger (3.3) ─────────────────────────────────────────────────────
// 1 invite por tick cuando: !batch_paused, gap respetado, bajo cap diario,
// hay leads scraped que pasan whitelist/blacklist.

async function tryInvitesForCampaign(campaign, account) {
  if (campaign.batch_paused) {
    return { skipped: true, reason: 'batch_paused' }
  }

  const gapMin = campaign.min_batch_gap_min ?? 30
  const minsSince = minutesSince(campaign.last_batch_at)
  if (minsSince < gapMin) {
    return { skipped: true, reason: 'batch_gap_not_met', minsSince: Math.floor(minsSince), gapMin }
  }

  const cap = getEffectiveDailyCap(account, campaign)
  const today = await getDailyActivityToday(account.id, account.timezone)
  // BUG FIX: el cap de invites debe contar SOLO invites, no invites+mensajes. Antes
  // sumaba messages_sent → las respuestas/FU (que tienen su PROPIO cap MAX_DAILY_MESSAGES)
  // se comían el presupuesto de invites y bloqueaban los connects (caso Wal: 1 invite +
  // 7 mensajes = 8 → cap_reached con solo 1 invite). Los invites son la acción que
  // LinkedIn limita estricto; las respuestas son a contactos ya conectados (bajo riesgo).
  const invitesToday = today.invites_sent
  if (invitesToday >= cap) {
    return { skipped: true, reason: 'daily_cap_reached', invitesToday, cap }
  }

  // Buscar próximo lead recién scrapeado por la extension que pase whitelist/blacklist.
  // Excluímos 'pending' explícitamente — son leads viejos de pipelines anteriores
  // que pueden tener linkedin_url stale, perfiles ya conectados, o estar
  // inactivos. 'scraped' es la status que setea ingestSearch del extension.
  const nowIsoForCooldown = new Date().toISOString()
  const { data: candidates } = await supabase
    .from('leads')
    .select('id, full_name, linkedin_url, profile_data, scraped_at, consecutive_failures, cooldown_until, quarantined_at, last_attempt_at')
    .eq('campaign_id', campaign.id)
    .eq('status', 'scraped')
    .not('linkedin_url', 'is', null)
    .is('quarantined_at', null)
    .or(`cooldown_until.is.null,cooldown_until.lt.${nowIsoForCooldown}`)
    .order('consecutive_failures', { ascending: true })
    .order('last_attempt_at', { ascending: true, nullsFirst: true })
    .order('scraped_at', { ascending: false })
    .limit(10)

  if (!candidates || candidates.length === 0) {
    return { skipped: true, reason: 'no_pending_leads' }
  }

  const whitelisted = candidates.filter(l =>
    passesTitleFilters(l.profile_data?.headline ?? '', campaign.title_whitelist, campaign.title_blacklist)
  )
  if (whitelisted.length === 0) {
    return { skipped: true, reason: 'no_leads_pass_whitelist', candidatesChecked: candidates.length }
  }

  // Pick aleatorio entre top 5 para humanización
  const pool = whitelisted.slice(0, 5)
  const lead = pool[Math.floor(Math.random() * pool.length)]

  // Decisión con/sin nota:
  // - campaign.invite_with_note=false (default) → SIEMPRE sin nota (mejor accept rate)
  // - campaign.invite_with_note=true → AI gen via gemini_system_prompt
  // - Override safety: cold warmup ignora invite_with_note y siempre sin nota
  //   (los primeros días LinkedIn observa con escrutinio extra)
  const useNota = !!campaign.invite_with_note &&
                  account.warmup_status !== 'cold' &&
                  !!campaign.gemini_system_prompt &&
                  campaign.gemini_system_prompt.trim().length > 20

  let message = null
  if (useNota) {
    const aiRes = await generateLinkedInMessage(campaign, lead, 'invite')
    if (aiRes.error) {
      console.warn(`[SCH-EXT]   AI gen failed: ${aiRes.error} — fallback sin nota`)
    } else {
      message = aiRes.message
    }
  }

  if (DRY_RUN) {
    console.log(`[SCH-EXT] DRY_RUN invite to "${lead.full_name}" — message: ${message ? `"${message}"` : '(sin nota)'}`)
    return { dispatched: false, dryRun: true, leadId: lead.id }
  }

  const cmdId = await dispatchInvite(account, lead, { message, dryRun: false })
  if (!cmdId) {
    return { skipped: true, reason: 'dispatch_failed' }
  }

  // No marcamos lead.status='processing': el gate min_batch_gap_min ya previene
  // duplicados entre ticks. Si el comando falla, el lead sigue 'scraped' y se
  // re-intentará en el próximo gap — retry implícito.
  await supabase.from('campaigns')
    .update({ last_batch_at: new Date().toISOString() })
    .eq('id', campaign.id)

  await logJob({
    campaignId: campaign.id, accountId: account.id, jobType: 'batch',
    status: 'dispatched',
    details: {
      commandId: cmdId,
      leadId: lead.id,
      leadName: lead.full_name,
      withNote: !!message,
      messageLength: message?.length ?? 0,
      capUsage: `${usedToday + 1}/${cap}`,
    },
  })

  return {
    dispatched: 1,
    commandId: cmdId,
    leadName: lead.full_name,
    withNote: !!message,
    capUsage: `${usedToday + 1}/${cap}`,
  }
}

// ── Follow-up trigger (3.4) ──────────────────────────────────────────────────
// Sweep de leads listos para próximo step de FU. Plantilla > AI gen.

// Hash determinístico de un string → unsigned int. Usado para jitter per-lead
// reproducible (mismo lead = mismo offset siempre).
function hashStringToInt(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i)
    h |= 0  // force i32
  }
  return Math.abs(h)
}

function substituteTemplate(template, lead, account) {
  if (!template) return null
  const first = (lead.full_name ?? '').split(/\s+/)[0]
  const fullName = lead.full_name ?? ''
  const company = lead.profile_data?.currentCompany ?? lead.profile_data?.company ?? ''
  const headline = lead.profile_data?.headline ?? ''
  const calUrl = account?.cal_com_url ?? ''

  // Substituir SIN sensitive case-sensitivity para soportar tanto:
  // - {placeholder} (formato nuevo Wal)
  // - [Placeholder] (formato legacy Josh server-proxy)
  // - [PLACEHOLDER] (también variantes)
  const subs = {
    nombre:           first,
    first_name:       first,
    nombre_completo:  fullName,
    full_name:        fullName,
    empresa:          company,
    company:          company,
    headline:         headline,
    cal_url:          calUrl,
    cal_com:          calUrl,
    calendly:         calUrl,
  }

  let out = template
  for (const [key, value] of Object.entries(subs)) {
    // {key} variants
    out = out.replace(new RegExp(`\\{${key}\\}`, 'gi'), value)
    // [Key] / [KEY] variants
    out = out.replace(new RegExp(`\\[${key}\\]`, 'gi'), value)
  }
  return out
}

const FU_STEPS = [
  { num: 1, statusFrom: ['connected'],          statusTo: 'follow_up_sent',   delayField: 'follow_up_delay_days',         delayUnit: 'days',  tplField: 'follow_up_message',         lastField: 'last_followup_at' },
  { num: 2, statusFrom: ['follow_up_sent'],     statusTo: 'follow_up_sent_2', delayField: 'follow_up_step2_delay_hours', delayUnit: 'hours', tplField: 'follow_up_step2_message',  lastField: 'last_followup2_at' },
  { num: 3, statusFrom: ['follow_up_sent_2'],   statusTo: 'follow_up_sent_3', delayField: 'follow_up_step3_delay_hours', delayUnit: 'hours', tplField: 'follow_up_step3_message',  lastField: 'last_followup3_at' },
  { num: 4, statusFrom: ['follow_up_sent_3'],   statusTo: 'follow_up_sent_4', delayField: 'follow_up_step4_delay_hours', delayUnit: 'hours', tplField: 'follow_up_step4_message',  lastField: 'last_followup4_at' },
  { num: 5, statusFrom: ['follow_up_sent_4'],   statusTo: 'follow_up_sent_5', delayField: 'follow_up_step5_delay_hours', delayUnit: 'hours', tplField: 'follow_up_step5_message',  lastField: 'last_followup5_at' },
]

// v0.7.8: status terminal-pero-revivible que el scheduler NUNCA debe dispatchear
// como FU. El sweep diario (sweepAwaitingResponseTimeout) los mata si pasan 21d
// sin volver a estar listos para envío.
const FU_DISPATCH_EXCLUDED_STATUSES = ['awaiting_response', 'dead', 'replied', 'failed', 'disqualified']

// v0.7.8: pasados N días en 'awaiting_response' sin volver al pipeline → dead.
// Configurable via env AWAITING_RESPONSE_KILL_DAYS, default 21d.
const AWAITING_RESPONSE_KILL_DAYS = parseInt(process.env.AWAITING_RESPONSE_KILL_DAYS ?? '21')

// Quarantine: leads con quarantined_at > N días sin liberación humana → dead.
// Configurable via env QUARANTINE_KILL_DAYS, default 7d.
const QUARANTINE_KILL_DAYS = parseInt(process.env.QUARANTINE_KILL_DAYS ?? '7')

async function sweepAwaitingResponseTimeout() {
  const cutoffIso = new Date(Date.now() - AWAITING_RESPONSE_KILL_DAYS * 86_400_000).toISOString()
  const { data: stale, error } = await supabase
    .from('leads')
    .select('id, full_name, awaiting_response_since, awaiting_response_reason')
    .eq('status', 'awaiting_response')
    .lt('awaiting_response_since', cutoffIso)
    .limit(200)
  if (error) {
    console.error(`[SCH-EXT] sweepAwaitingResponse query failed:`, error.message)
    return { swept: 0 }
  }
  if (!stale || stale.length === 0) return { swept: 0 }
  let swept = 0
  for (const lead of stale) {
    const { error: updErr } = await supabase.from('leads').update({
      status: 'dead',
      dead_reason: `no_reply_window_${AWAITING_RESPONSE_KILL_DAYS}d`,
    }).eq('id', lead.id)
    if (updErr) {
      console.error(`[SCH-EXT] sweepAwaitingResponse update lead ${lead.id.slice(0,8)} failed:`, updErr.message)
      continue
    }
    swept++
    console.log(`[SCH-EXT] 💀 awaiting_response → dead: ${lead.full_name || lead.id.slice(0,8)} (${AWAITING_RESPONSE_KILL_DAYS}d sin reply)`)
  }
  return { swept }
}

async function tryFollowupsForCampaign(campaign, account) {
  if (campaign.follow_up_paused) {
    return { skipped: true, reason: 'follow_up_paused' }
  }

  // Cap diario de mensajes (FU+FM combinado) — protege contra blasts
  const todayActivity = await getDailyActivityToday(account.id, account.timezone)
  const msgsToday = todayActivity.messages_sent ?? 0
  if (msgsToday >= MAX_DAILY_MESSAGES) {
    return { skipped: true, reason: 'daily_messages_cap_reached', msgsToday, cap: MAX_DAILY_MESSAGES }
  }

  // Priorizamos steps avanzados (FU5 > FU4 > ... > FU1) para evitar que un backlog
  // grande en FU1 starve a los FUs avanzados. Leads más profundos en el funnel
  // están más cerca de meeting → progresarlos primero tiene mayor ROI.
  // Más Fisher-Yates shuffle ligero para humanización (no siempre mismo orden).
  const stepsOrdered = [...FU_STEPS].reverse()
  if (Math.random() < 0.3) {  // 30% de ticks: random shuffle (anti-pattern detection)
    for (let i = stepsOrdered.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[stepsOrdered[i], stepsOrdered[j]] = [stepsOrdered[j], stepsOrdered[i]]
    }
  }

  for (const step of stepsOrdered) {
    const template = campaign[step.tplField]
    const hasAiFallback = !!campaign.gemini_system_prompt &&
                          campaign.gemini_system_prompt.trim().length > 20
    if (!template && !hasAiFallback) continue  // ni template ni gemini prompt → skip

    // FU1 puede usar follow_up_delay_hours (override) o follow_up_delay_days.
    // Si el campo HOURS está set en la campaña, lo preferimos sobre días.
    let delay
    let effectiveUnit
    if (step.num === 1 && campaign.follow_up_delay_hours != null) {
      delay = campaign.follow_up_delay_hours
      effectiveUnit = 'hours'
    } else {
      delay = campaign[step.delayField]
      effectiveUnit = step.delayUnit
    }
    if (!delay && delay !== 0) continue  // sin delay = step deshabilitado

    // ¿Cuánto tiempo desde el último step para este lead?
    const baseCutoffMs = effectiveUnit === 'days' ? delay * 86_400_000 : delay * 3_600_000
    // Jitter per-lead: usamos hash de lead.id para tener delay consistente por lead
    // pero distribuido aleatoriamente para no levantar bandera en LinkedIn por uniformidad
    // v0.7.16: jitter por step. step1 usa campaign.follow_up_jitter_hours (legacy).
    // step2-5 ahora aplican un % del delay base (jitter_pct_fu_delay desde
    // runtime_config, default 0.35). Evita ZERO jitter en FU2-5 sin schema change.
    const jitterPctFu = await readRuntimeNumber('jitter_pct_fu_delay', 0.35)
    const stepJitterHours = step.num === 1
      ? (campaign.follow_up_jitter_hours ?? 0)
      : Math.max(campaign[`follow_up_step${step.num}_jitter_hours`] ?? 0, delay * jitterPctFu)
    const jitterHours = stepJitterHours
    const jitterMs = jitterHours * 3_600_000
    // Query usa el cutoff INFERIOR (más laxo) para traer candidates;
    // el filter individual por lead después aplica el jitter exacto
    const cutoffMs = baseCutoffMs - jitterMs
    const cutoffIso = new Date(Date.now() - cutoffMs).toISOString()
    const prevTimeField = step.num === 1 ? 'connected_at' : FU_STEPS[step.num - 2].lastField

    // Safety gate: skip leads cuya prev step timestamp es muy antigua
    // (típicamente leads históricos de batches viejos). Por default 30 días.
    // Configurable via campaign.fu_max_age_days o env FU_MAX_AGE_DAYS.
    const maxAgeDays = campaign.fu_max_age_days ?? parseInt(process.env.FU_MAX_AGE_DAYS ?? '30')
    const tooOldIso = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString()

    // LEFT JOIN: traemos leads con O sin thread_id — para invites sin nota
    // el lead conectado NO tiene thread hasta que enviemos el primer mensaje.
    // Sub-Fase 3.8: content.js maneja ambos casos (compose-new desde perfil
    // si no hay thread, o reply en thread si existe).
    // v0.7.8: defensa adicional — aunque .in('status', step.statusFrom) ya excluye
    // awaiting_response por construcción (no aparece en ningún statusFrom), añadimos
    // un guard explícito por si alguien edita FU_STEPS y mete un status erróneo.
    const safeStatusFrom = step.statusFrom.filter(s => !FU_DISPATCH_EXCLUDED_STATUSES.includes(s))
    if (safeStatusFrom.length === 0) continue
    const nowIsoForCooldown = new Date().toISOString()
    const { data: due } = await supabase
      .from('leads')
      .select(`id, full_name, linkedin_url, status, profile_data, ${prevTimeField},
               consecutive_failures, cooldown_until, quarantined_at, last_attempt_at,
               lockout_skip_count,
               conversations(linkedin_thread_id, linkedin_account_id)`)
      .eq('campaign_id', campaign.id)
      .in('status', safeStatusFrom)
      .lt(prevTimeField, cutoffIso)
      .gte(prevTimeField, tooOldIso)
      .not('linkedin_url', 'is', null)  // necesitamos URL del perfil
      .is('quarantined_at', null)
      .or(`cooldown_until.is.null,cooldown_until.lt.${nowIsoForCooldown}`)
      .order('consecutive_failures', { ascending: true })
      .order('last_attempt_at', { ascending: true, nullsFirst: true })
      .limit(3)

    if (!due || due.length === 0) continue

    // auto_dead_after_days: si lead lleva más de X días sin reply, marcar dead
    if (campaign.auto_dead_after_days) {
      const deadCutoffIso = new Date(Date.now() - campaign.auto_dead_after_days * 86_400_000).toISOString()
      for (const lead of due) {
        if (lead[prevTimeField] < deadCutoffIso) {
          await supabase.from('leads').update({ status: 'dead', dead_reason: 'auto_dead_no_reply' }).eq('id', lead.id)
          console.log(`[SCH-EXT]   💀 lead ${lead.id.slice(0,8)} (${lead.full_name}) auto-dead: ${campaign.auto_dead_after_days}d sin reply`)
        }
      }
    }

    // Per-lead jitter check: filtrar leads cuyo delay personal no se cumplió aún
    const dueWithJitter = jitterHours > 0
      ? due.filter(lead => {
          // Hash determinístico del lead.id → offset entre -jitterMs y +jitterMs
          const h = hashStringToInt(lead.id)
          const offset = (h % (2 * jitterMs + 1)) - jitterMs  // [-jitterMs, +jitterMs]
          const leadCutoffMs = baseCutoffMs + offset
          const leadCutoffIso = new Date(Date.now() - leadCutoffMs).toISOString()
          return lead[prevTimeField] <= leadCutoffIso
        })
      : due

    if (dueWithJitter.length === 0) continue  // ningún lead cumple su delay personal aún

    // BUG FIX: cuentas de sistema de LinkedIn no son contestables → no FU, marcar dead.
    for (const l of dueWithJitter) {
      if (isSystemLinkedInAccount(l.full_name)) {
        await supabase.from('leads').update({ status: 'dead', dead_reason: 'system_account_not_messageable' }).eq('id', l.id)
        console.log(`[SCH-EXT] 🚫 lead sistema descartado de FU: ${l.full_name} → dead`)
      }
    }
    const dueHumans = dueWithJitter.filter(l => !isSystemLinkedInAccount(l.full_name))
    if (dueHumans.length === 0) continue

    // Lead-level dedup: si el primer candidato ya tiene comando en flight,
    // intentar con el siguiente. Previene zombies de doble-dispatch.
    let lead = null
    for (const candidate of dueHumans) {
      const inFlight = await hasInFlightCommand(candidate.id, 'send_followup')
      if (!inFlight) { lead = candidate; break }
      console.log(`[SCH-EXT]   ⏭️  FU skip ${candidate.full_name} — cmd en flight`)
    }
    if (!lead) continue  // todos los candidates del step ya tienen cmd activo

    let message = null

    if (template && hasAiFallback) {
      // ★ MODO HÍBRIDO: template como intención + Gemini personaliza al lead
      const persRes = await personalizeFollowupMessage(
        campaign, lead, template, step.num, account.cal_com_url ?? null,
        { toneDirective: campaign.followup_tone_directive ?? undefined }
      )
      if (persRes.error) {
        console.warn(`[SCH-EXT]   AI personalize failed (FU${step.num}): ${persRes.error} — fallback a template literal`)
        message = substituteTemplate(template, lead, account)
      } else {
        message = persRes.message
      }
    } else if (template) {
      // Solo template, sin gemini_system_prompt → substitución literal
      message = substituteTemplate(template, lead, account)
    } else if (hasAiFallback) {
      // Solo AI, sin template → gen completo
      const aiRes = await generateLinkedInMessage(campaign, lead, `follow_up_${step.num}`)
      if (aiRes.error) {
        // v0.7.13 P0-2: si Gemini falla, NO skipear silencio — usar safe template.
        // Antes esto causaba que leads de campañas AI-only nunca recibieran FU
        // cuando había problema con Gemini (403, timeout, etc.).
        console.warn(`[SCH-EXT]   AI FU gen failed: ${aiRes.error} — fallback safe template`)
        const safeFallback = `Hola ${lead.full_name ?? ''}, retomando el hilo — ¿podemos coordinar una llamada breve esta semana?`
        message = safeFallback
        // Stamp insight para visibility en dashboard
        try {
          await supabase.from('phase_insights').insert({
            category: 'ai_fallback_used',
            severity: String(aiRes.error).includes('403') ? 'critical' : 'warning',
            phase_name: null,
            account_id: account.id,
            details: { error: String(aiRes.error).slice(0, 500), step: step.num, lead_name: lead.full_name },
          })
        } catch {}
      } else {
        message = aiRes.message
      }
    }

    if (!message) continue

    // 🛡️ GUARD FINAL pre-envío (FU): NUNCA enviar un mensaje con placeholders sin
    // resolver ("[Nombre]", "[menciona algo]", "{nombre}"). Si se cuela, saltamos
    // este lead este tick (mejor no enviar que enviar basura). Se reintenta luego.
    if (hasLeftoverPlaceholder(message)) {
      console.warn(`[SCH-EXT] 🚫 FU${step.num} a ${lead.full_name} BLOQUEADO por placeholder sin resolver: ${message.match(/\[[^\]]*\]|\{[^}]*\}/)?.[0]?.slice(0,40)}`)
      continue
    }

    // Sub-Fase 3.8: si hay thread_id (lead respondió o invite con nota),
    // usar threadUrl directo. Si NO (invite sin nota), pasar profileUrl.
    // Supabase devuelve conversations como array si hay múltiples o como objeto si LEFT JOIN single — normalizamos.
    // GUARDA DEFENSIVA: si el shape es raro, loggea contexto en vez de crashear todo el tick.
    let threadId = null
    try {
      const raw = lead.conversations
      const conversationsArr = Array.isArray(raw)
        ? raw
        : (raw && typeof raw === 'object' ? [raw] : [])
      // Verificación final: asegurar que sea array antes de .find
      if (Array.isArray(conversationsArr) && typeof conversationsArr.find === 'function') {
        threadId = conversationsArr.find(c => c?.linkedin_account_id === account.id)?.linkedin_thread_id ?? null
      } else {
        console.warn(`[SCH-EXT] ⚠️  conversations shape raro lead=${lead.id?.slice(0,8)} type=${typeof raw} isArray=${Array.isArray(raw)} val=${JSON.stringify(raw)?.slice(0,200)}`)
      }
    } catch (convErr) {
      console.error(`[SCH-EXT] 💥 conversations.find crash lead=${lead.id?.slice(0,8)} campaign=${campaign.id?.slice(0,8)}: ${convErr.message}`)
      console.error(`[SCH-EXT] shape: type=${typeof lead.conversations} isArray=${Array.isArray(lead.conversations)} val=${JSON.stringify(lead.conversations)?.slice(0,300)}`)
      if (convErr.stack) console.error(`[SCH-EXT] stack: ${convErr.stack.split('\n').slice(0,5).join('\n')}`)
      // No abortamos el tick — seguimos con threadId=null (caerá a profileUrl path)
    }
    const threadUrl = threadId ? `https://www.linkedin.com/messaging/thread/${threadId}/` : null
    const profileUrl = lead.linkedin_url
    const navUrl = threadUrl ?? profileUrl

    if (DRY_RUN) {
      console.log(`[SCH-EXT] DRY_RUN FU${step.num} → "${lead.full_name}" (${navUrl}) thread=${!!threadId}`)
      return { dispatched: false, dryRun: true, step: step.num }
    }

    // Content dedup: si ya enviamos este mismo texto a este lead en últimas 4h,
    // asume que la send pasada fue real y avanza status. Evita duplicados aún
    // si hasInFlightCommand no atajó (e.g., cmd completado pero ingest falló).
    if (await wasMessageRecentlySent(lead.id, message, 4)) {
      console.warn(`[SCH-EXT]   ⚠️  FU dedup: mensaje idéntico ya enviado a ${lead.full_name} en últimas 4h — forzando advance status`)
      await supabase.from('leads').update({
        status: step.statusTo,
        [step.lastField]: new Date().toISOString(),
      }).eq('id', lead.id)
      return { skipped: true, reason: 'content_dedup', leadName: lead.full_name }
    }

    // v0.7.11 lockout 24h — REWRITE (root cause: completed_at NULL en históricos):
    // El v0.7.10 filtraba por status='timeout' AND error='extension_did_not_respond'
    // AND completed_at >= cutoff. Pero el bridge cleanupExpired NUNCA seteaba completed_at
    // (NULL >= X → false en Postgres) → lockout efectivamente disabled.
    // Fix A1 (bridge) ya rellena completed_at; aquí también usamos created_at como
    // backstop (siempre populated) para cubrir rows NULL históricas. Y ampliamos
    // la cobertura a TODOS los timeout-flavors + thread_not_found_in_inbox
    // (loop pattern Wilder: send_followup repetido cada 4-5min hasta error).
    {
      const lockoutCutoffIso = new Date(Date.now() - 24 * 3600_000).toISOString()
      // Patrones que indican fallo persistente del side de la extensión/thread,
      // donde re-dispatch <24h sólo añade ruido sin posibilidad real de éxito.
      const TIMEOUT_ERROR_CODES = [
        'extension_did_not_respond',  // legacy (pre-Opción B); rows históricas
        'content_died_mid_work',      // Opción B: content.js recibió pero murió mid-work
        'thread_not_found_in_inbox',
      ]
      // NOTA: 'content_unreachable' (Opción B) se OMITE a propósito — es infra
      // (SW killed / no inyectado / WS), NO culpa del lead. No debe lockearlo,
      // igual que 'expired_in_queue'.
      // v0.7.13 P1-2: la versión anterior usaba .in('status', ['timeout','error'])
      // pero algunos commands con error se persisten como status='completed' +
      // error!=NULL (cuando el cmd devolvió result pero con error code).
      // Ahora capturamos AMBOS shapes.
      // exec_hard_timeout_send_followup_* (varias variantes con suffix ms) → like
      const { count: ndrCount, error: ndrErr } = await supabase
        .from('extension_commands')
        .select('id', { count: 'exact', head: true })
        .eq('related_lead_id', lead.id)
        .eq('action', 'send_followup')
        .or('status.in.(timeout,error),and(status.eq.completed,error.not.is.null)')
        .or([
          `error.in.(${TIMEOUT_ERROR_CODES.join(',')})`,
          'error.like.exec_hard_timeout_send_followup_%',
        ].join(','))
        .gte('created_at', lockoutCutoffIso)
      if (ndrErr) {
        console.warn(`[SCH-EXT]   ⚠️  no-response lockout query failed: ${ndrErr.message} — proceeding (fail-open)`)
      } else if ((ndrCount ?? 0) > 0) {
        // v0.7.13 P0-4: incrementar lockout_skip_count y escalar a dead post N skips.
        // Antes el lockout bloqueaba indefinidamente sin escalar — Wilder con
        // 39 timeouts se quedaba en pipeline rebotando cada 24h. Fix:
        // contar cuántas veces hemos skippeado este lead por lockout y, después
        // de runtime_config.dead_after_lockouts (default 3), marcar dead.
        const deadCap = await readRuntimeNumber('dead_after_lockouts', 3)
        const newCount = (lead.lockout_skip_count ?? 0) + 1
        if (newCount >= deadCap) {
          console.warn(`[SCH-EXT]   💀 FU dead-after-lockouts ${lead.full_name} — ${newCount}× lockout skips ≥ cap ${deadCap}`)
          await supabase
            .from('leads')
            .update({
              status: 'dead',
              dead_reason: 'lockout_dead_no_thread',
              lockout_skip_count: newCount,
            })
            .eq('id', lead.id)
        } else {
          console.warn(`[SCH-EXT]   🔒 FU lockout 24h ${lead.full_name} — ${ndrCount}× timeout/hard-error, skip ${newCount}/${deadCap}`)
          await supabase
            .from('leads')
            .update({ lockout_skip_count: newCount })
            .eq('id', lead.id)
        }
        continue
      }
    }

    // v0.7.14 Fix 3: dedup cross-day por (lead_id, step) — evita duplicados aun
    // cuando bridge no ingestó el cmd anterior (cmd quedó 'completed' sin
    // avanzar lead.status). Caso Rodrigo Centeno: 28-may × 3 FU2 en 10 min,
    // 25-may + 01-jun + 02-jun mismo FU1. Regla: si un cmd send_followup mismo
    // step se dispatched/completed para este lead en últimas 48h, skip.
    {
      const dedupCutoff = new Date(Date.now() - 48 * 3600_000).toISOString()
      const { count: dupCount } = await supabase
        .from('extension_commands')
        .select('id', { count: 'exact', head: true })
        .eq('related_lead_id', lead.id)
        .eq('action', 'send_followup')
        .eq('payload->>step', String(step.num))
        .in('status', ['pending', 'dispatched', 'completed'])
        .gte('created_at', dedupCutoff)
      if ((dupCount ?? 0) > 0) {
        console.warn(`[SCH-EXT]   ⏭️  step-dedup ${lead.full_name} FU${step.num} — ${dupCount}× cmds últimas 48h, skip`)
        continue
      }
    }

    const cmdId = await dispatchFollowup(account, lead, step.num, message, threadUrl, profileUrl)
    if (!cmdId) continue

    await logJob({
      campaignId: campaign.id, accountId: account.id, jobType: `followup_${step.num}`,
      status: 'dispatched',
      details: { commandId: cmdId, leadId: lead.id, step: step.num, threadUrl },
    })

    return { dispatched: 1, step: step.num, commandId: cmdId, leadName: lead.full_name }
  }

  return { skipped: true, reason: 'no_followups_due' }
}

// ── Auto-reply trigger (3.6) ─────────────────────────────────────────────────
// Cuando un lead responde, el ingest lo marca status='replied' y la cadena FU
// se pausa automáticamente (porque FU_STEPS solo procesa connected/follow_up_sent_*).
// Este trigger detecta esos replied y genera una respuesta AI personalizada.

async function tryAutoReplyForCampaign(campaign, account) {
  const mode = campaign.auto_reply_mode ?? 'manual'
  if (mode === 'off' || mode === 'manual') {
    return { skipped: true, reason: `auto_reply_mode_${mode}` }
  }

  // Cap diario de mensajes (FU+FM combinado)
  const todayActivity = await getDailyActivityToday(account.id, account.timezone)
  const msgsToday = todayActivity.messages_sent ?? 0
  if (msgsToday >= MAX_DAILY_MESSAGES) {
    return { skipped: true, reason: 'daily_messages_cap_reached', msgsToday, cap: MAX_DAILY_MESSAGES }
  }

  // Safety gate: solo procesar replies recientes — los históricos viejos
  // probablemente ya se respondieron manualmente o quedaron en olvido.
  const maxAgeDays = campaign.fm_max_age_days ?? parseInt(process.env.FM_MAX_AGE_DAYS ?? '7')
  const tooOldIso = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString()

  // Orden DESC (replies MÁS RECIENTES primero) — antes era ASC limit 5, lo que
  // procesaba los 5 más viejos (ya respondidos) y nunca llegaba a los nuevos.
  // Incluimos leads SIN thread_id: content.js hace compose-new desde el perfil.
  const nowIsoForCooldown = new Date().toISOString()
  const { data: replied } = await supabase
    .from('leads')
    .select(`id, full_name, replied_at, profile_data, linkedin_url,
             consecutive_failures, cooldown_until, quarantined_at, last_attempt_at,
             conversations!inner(id, linkedin_thread_id, last_message_text, last_message_at, linkedin_account_id)`)
    .eq('campaign_id', campaign.id)
    .eq('conversations.linkedin_account_id', account.id)
    .eq('status', 'replied')
    .gte('replied_at', tooOldIso)  // ★ safety: no procesar replies >7d
    .is('quarantined_at', null)
    .or(`cooldown_until.is.null,cooldown_until.lt.${nowIsoForCooldown}`)
    .order('consecutive_failures', { ascending: true })
    .order('last_attempt_at', { ascending: true, nullsFirst: true })
    .order('replied_at', { ascending: false })
    .limit(10)

  if (!replied || replied.length === 0) {
    return { skipped: true, reason: 'no_replies_pending' }
  }

  // BUG FIX: cuentas de SISTEMA de LinkedIn (Talent Solutions, etc.) NO son personas —
  // mandan notificaciones que se ingestan como "reply" → auto-reply intenta responder
  // → thread_editor_not_found en loop. Las sacamos del pipeline y las marcamos dead.
  for (const lead of replied) {
    if (isSystemLinkedInAccount(lead.full_name)) {
      await supabase.from('leads')
        .update({ status: 'dead', dead_reason: 'system_account_not_messageable' })
        .eq('id', lead.id)
      console.log(`[SCH-EXT] 🚫 lead sistema descartado de auto-reply: ${lead.full_name} → dead`)
    }
  }
  const repliedHumans = replied.filter(l => !isSystemLinkedInAccount(l.full_name))
  if (repliedHumans.length === 0) {
    return { skipped: true, reason: 'only_system_accounts' }
  }

  // Filter: solo leads donde el último outbound es ANTERIOR al último inbound
  // (i.e., todavía no respondimos al último mensaje del lead)
  for (const lead of repliedHumans) {
    // Supabase devuelve conversations como OBJETO (1:1 por UNIQUE lead_id) o
    // como ARRAY según el shape del join. Normalizamos para soportar ambos.
    const conv = Array.isArray(lead.conversations)
      ? lead.conversations[0]
      : lead.conversations
    if (!conv) continue

    // v0.6.45 (29-may): conv.last_message_at se actualiza por AMBAS direcciones,
    // así que era max(inbound,outbound) — provocaba duplicados (caso Juan Segura).
    // Queremos comparar LAST_INBOUND real vs LAST_OUTBOUND real desde events.
    const { data: lastOutbound } = await supabase
      .from('conversation_events')
      .select('sent_at')
      .eq('conversation_id', conv.id)
      .eq('direction', 'outbound')
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const { data: lastInbound } = await supabase
      .from('conversation_events')
      .select('sent_at')
      .eq('conversation_id', conv.id)
      .eq('direction', 'inbound')
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const lastInboundAt = lastInbound?.sent_at ? new Date(lastInbound.sent_at).getTime() : 0
    const lastOutAt = lastOutbound?.sent_at ? new Date(lastOutbound.sent_at).getTime() : 0
    if (lastOutAt >= lastInboundAt) continue  // ya respondimos a este reply (>= por seguridad)

    // Lead-level dedup: si hay cmd en flight para este lead, skip (evita doble-reply)
    if (await hasInFlightCommand(lead.id, 'send_followup')) {
      console.log(`[SCH-EXT]   ⏭️  AI reply skip ${lead.full_name} — cmd en flight`)
      continue
    }

    // Delay aleatorio entre detección y respuesta (humanización)
    const delayMin = account.reply_delay_min ?? campaign.auto_reply_delay_min ?? 1
    const delayMax = account.reply_delay_max ?? campaign.auto_reply_delay_max ?? 5
    const minutesSinceReply = (Date.now() - lastInboundAt) / 60_000
    if (minutesSinceReply < randInt(delayMin, delayMax)) {
      console.log(`[SCH-EXT]   ⏸️  AI reply para ${lead.full_name}: aguardando humanization delay (${delayMin}-${delayMax}min)`)
      continue
    }

    // Determinar qué FM step usar: cuenta replies AI previos (event_type='reply_sent')
    // Acepta 'auto_reply' por backward-compat con events antes del fix de constraint.
    const { count: autoReplyCount } = await supabase
      .from('conversation_events')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conv.id)
      .in('event_type', ['reply_sent', 'auto_reply'])
    const fmStep = Math.min((autoReplyCount ?? 0) + 1, 3)  // FM1, FM2, FM3 max

    // Fetch conversation history completa (todos los events del thread).
    // Fix 2026-05-29: traemos hasta 40 events. Si la conversación es larga (>20),
    // tomamos los 5 más antiguos (contexto inicial: invite + FU1 + FU2) + 15
    // más recientes para que Gemini no pierda el "por qué" original ni la
    // actividad reciente. Sin esto, en convos largas Gemini contesta "¿de qué hablas?".
    const { data: eventsAsc } = await supabase
      .from('conversation_events')
      .select('direction, content, sent_at, event_type')
      .eq('conversation_id', conv.id)
      .order('sent_at', { ascending: true })
      .limit(40)
    const allEv = eventsAsc ?? []
    const events = allEv.length <= 20
      ? allEv
      : [...allEv.slice(0, 5), ...allEv.slice(-15)]

    const conversationHistory = events.map(e => ({
      direction: e.direction,
      content:   e.content,
      sent_at:   e.sent_at,
    }))

    // Identificar el ÚLTIMO FU template que se envió a este lead → pasarlo como
    // "intención previa" para que el AI mantenga coherencia con el mensaje de
    // seguimiento en el que la conversación está, mientras responde al historial.
    const lastFuEvent = [...(events ?? [])]
      .reverse()
      .find(e => /^follow_up_sent/.test(e.event_type ?? ''))
    let lastFuStepNum = null
    if (lastFuEvent) {
      const m = lastFuEvent.event_type.match(/follow_up_sent(?:_(\d))?/)
      lastFuStepNum = m ? (m[1] ? parseInt(m[1]) : 1) : null
    }
    const lastFuTemplate = lastFuStepNum
      ? campaign[`follow_up_${lastFuStepNum === 1 ? '' : 'step' + lastFuStepNum + '_'}message`]
      : null

    // Generar respuesta vía AI con conversation history + cal_url + FU template guía
    const aiType = `fm_reply_${fmStep}`
    const aiRes = await generateLinkedInReply(campaign, lead, {
      conversationHistory,
      calUrl: account.cal_com_url ?? null,
      fmStep,
      lastFuTemplate,
      lastFuStepNum,
    })
    if (aiRes.error) {
      // Gemini timeout retry (2026-05-29 fix): timeout es transitorio, no permanente.
      // En lugar de skip-final, dejamos el lead en 'replied' para que próximo tick
      // retome. Después de 3 fails seguidos para el mismo lead, escalamos a dead.
      const isTransient = /timeout|fetch.*fail|network|503|429|ECONN|RESET/i.test(aiRes.error)
      if (isTransient) {
        const stuckKey = `ai_retry:${lead.id}`
        const prevCount = _aiRetryMap.get(stuckKey) ?? 0
        const nextCount = prevCount + 1
        _aiRetryMap.set(stuckKey, nextCount)
        if (nextCount >= 3) {
          console.warn(`[SCH-EXT]   ⚠️  AI reply ${lead.full_name}: ${nextCount}× fails transient — marcando dead`)
          await supabase.from('leads').update({
            status: 'dead',
            dead_reason: 'gemini_unreachable_after_3_retries',
          }).eq('id', lead.id)
          _aiRetryMap.delete(stuckKey)
        } else {
          console.warn(`[SCH-EXT]   ⏭️  AI reply ${lead.full_name}: ${aiRes.error} (retry ${nextCount}/3 next tick)`)
        }
        continue  // próximo tick re-procesa este lead sin gastar gate
      }
      console.warn(`[SCH-EXT]   AI reply gen failed (permanent): ${aiRes.error}`)
      // v0.7.13 P0-2: stamp insight para visibility — 403 perma no debe ser silencioso
      try {
        await supabase.from('phase_insights').insert({
          category: 'ai_fallback_used',
          severity: String(aiRes.error).includes('403') ? 'critical' : 'warning',
          phase_name: null,
          account_id: account.id,
          details: { error: String(aiRes.error).slice(0, 500), kind: 'auto_reply_perm', lead_name: lead.full_name },
        })
      } catch {}
      continue
    }

    if (DRY_RUN) {
      console.log(`[SCH-EXT] DRY_RUN ${aiType} → ${lead.full_name}: "${aiRes.message.slice(0, 80)}..."`)
      return { dispatched: false, dryRun: true }
    }

    // 🛡️ GUARD FINAL pre-envío (auto-reply): NUNCA responder con placeholders sin
    // resolver ("[menciona algo de su perfil]" se le envió a Jose Cruz). Mejor no
    // responder que enviar basura — el lead se queda 'replied' y se reintenta.
    if (hasLeftoverPlaceholder(aiRes.message)) {
      console.warn(`[SCH-EXT] 🚫 auto-reply a ${lead.full_name} BLOQUEADO por placeholder: ${aiRes.message.match(/\[[^\]]*\]|\{[^}]*\}/)?.[0]?.slice(0,40)}`)
      continue
    }

    // Content dedup: si el AI generó el mismo texto que ya enviamos antes, skip
    if (await wasMessageRecentlySent(lead.id, aiRes.message, 4)) {
      console.warn(`[SCH-EXT]   ⚠️  AI reply dedup: mismo texto ya enviado a ${lead.full_name} — skip`)
      continue
    }

    // Si hay thread_id → thread directo. Si NO (lead respondió a invite sin nota
    // y nunca capturamos thread) → pasar profileUrl: content.js navega al perfil,
    // abre compose y responde igual que el flujo FU compose-new.
    const threadUrl  = conv.linkedin_thread_id
      ? `https://www.linkedin.com/messaging/thread/${conv.linkedin_thread_id}/`
      : null
    const profileUrl = lead.linkedin_url ?? null
    if (!threadUrl && !profileUrl) {
      console.warn(`[SCH-EXT]   AI reply skip ${lead.full_name}: sin thread_id ni profileUrl`)
      continue
    }
    const cmdId = await dispatchCommand(account.id, 'send_followup', {
      threadUrl,
      profileUrl,
      leadId:   lead.id,
      leadName: lead.full_name,
      message:  aiRes.message,
      step:     0,        // FM no es FU
      kind:     'reply',  // ingestSendFollowup respeta esto para no cambiar status
    }, { relatedLeadId: lead.id, expiresInMinutes: 3 })

    if (!cmdId) continue

    await logJob({
      campaignId: campaign.id, accountId: account.id, jobType: aiType,
      status: 'dispatched',
      details: { commandId: cmdId, leadId: lead.id, fmStep, replyTo: conv.last_message_text?.slice(0, 100) },
    })

    return {
      dispatched: 1,
      leadName: lead.full_name,
      fmStep,
      commandId: cmdId,
      messagePreview: aiRes.message.slice(0, 60),
    }
  }

  return { skipped: true, reason: 'no_replies_due' }
}

// (legacy removed — ahora usamos generateLinkedInReply con conversation history)
async function _generateAIReply_DEPRECATED(campaign, lead, leadReplyText, fmStep) {
  // Mantenida solo como referencia. NO LLAMAR.
  return await generateLinkedInMessage(campaign, lead, `follow_up_${fmStep}`)
}

// ── Inbox trigger (3.4) ──────────────────────────────────────────────────────

async function tryInboxForAccount(account) {
  if (account.inbox_paused) {
    return { skipped: true, reason: 'inbox_paused' }
  }

  const gapMin = account.inbox_gap_min ?? 60
  const minsSince = minutesSince(account.last_inbox_check_at)
  if (minsSince < gapMin) {
    return { skipped: true, reason: 'inbox_gap_not_met', minsSince: Math.floor(minsSince), gapMin }
  }

  if (DRY_RUN) {
    console.log(`[SCH-EXT] DRY_RUN check_inbox for ${account.label}`)
    return { dispatched: false, dryRun: true }
  }

  const cmdId = await dispatchCheckInbox(account)
  if (!cmdId) return { skipped: true, reason: 'dispatch_failed' }

  await supabase.from('linkedin_accounts')
    .update({ last_inbox_check_at: new Date().toISOString() })
    .eq('id', account.id)

  await logJob({
    accountId: account.id, jobType: 'inbox',
    status: 'dispatched',
    details: { commandId: cmdId },
  })

  return { dispatched: true, commandId: cmdId }
}

// ── Check Sent Invites trigger (3.5) ─────────────────────────────────────────
// Scrapea /mynetwork/invitation-manager/sent/ para detectar accepts sin nota.
// Más espaciado que inbox (default 6h) — los accepts no necesitan detección rápida.

async function tryCheckSentInvitesForAccount(account) {
  const gapMin = account.sent_invites_gap_min ?? 360
  const minsSince = minutesSince(account.last_sent_invites_check_at)
  if (minsSince < gapMin) {
    return { skipped: true, reason: 'sent_invites_gap_not_met', minsSince: Math.floor(minsSince), gapMin }
  }

  if (DRY_RUN) {
    console.log(`[SCH-EXT] DRY_RUN check_sent_invites for ${account.label}`)
    return { dispatched: false, dryRun: true }
  }

  const cmdId = await dispatchCheckSentInvites(account)
  if (!cmdId) return { skipped: true, reason: 'dispatch_failed' }

  await supabase.from('linkedin_accounts')
    .update({ last_sent_invites_check_at: new Date().toISOString() })
    .eq('id', account.id)

  await logJob({
    accountId: account.id, jobType: 'check_sent_invites',
    status: 'dispatched',
    details: { commandId: cmdId },
  })

  return { dispatched: true, commandId: cmdId }
}

// ── Main tick ────────────────────────────────────────────────────────────────

// ── Connectivity health check ───────────────────────────────────────────────
// Cada tick durante business hours: si una cuenta NO está conectada al bridge
// pero debería estarlo, crea alerta + log. Debounce: 1 alerta por hora por cuenta.
const _lastHealthAlert = new Map()  // accountId → timestamp
const _lastUnstableAlert = new Map()  // accountId → timestamp
const _aiRetryMap = new Map()  // 'ai_retry:<leadId>' → count of transient fails (fix 2026-05-29)
async function runConnectivityHealthCheck(connectedIds) {
  try {
    const { data: accounts } = await supabase
      .from('linkedin_accounts')
      .select('id, label, timezone, extension_paused')
    if (!accounts) return

    for (const acc of accounts) {
      // ── AUTO-RESOLUCIÓN de alertas cuya condición ya no aplica ──
      // Evita banners rojos fantasma: si la cuenta NO está pausada, resolver
      // cualquier error_spike abierto. Si está conectada, resolver offline/unstable.
      if (!acc.extension_paused) {
        await supabase.from('account_alerts')
          .update({ resolved_at: new Date().toISOString(), resolved_by: 'auto:account_no_longer_paused' })
          .eq('linkedin_account_id', acc.id)
          .eq('alert_type', 'error_spike')
          .is('resolved_at', null)
      }
      if (connectedIds.has(acc.id)) {
        await supabase.from('account_alerts')
          .update({ resolved_at: new Date().toISOString(), resolved_by: 'auto:reconnected' })
          .eq('linkedin_account_id', acc.id)
          .in('alert_type', ['ext_offline_business_hours'])
          .is('resolved_at', null)
      }

      if (acc.extension_paused) continue
      // Check business hours en TZ del usuario
      // BUG fix: isBusinessHours espera días como strings ('lunes'..'viernes'),
      // no como numbers. Pasamos undefined → usa DEFAULT_DAYS internamente.
      const tz = acc.timezone ?? 'America/Mexico_City'
      const inBH = isBusinessHours(9, 19, undefined, tz)
      if (!inBH) continue

      // ── Detector de CONEXIÓN INESTABLE (infiere background mode OFF) ──
      // No hay API para leer chrome://settings/system, pero SÍ podemos inferir:
      // muchos disconnects en pocas horas = SW muriéndose = background mode off.
      // Umbral: ≥4 disconnects en 6h. Debounce alerta 3h.
      const lastUnstable = _lastUnstableAlert.get(acc.id) ?? 0
      if (Date.now() - lastUnstable > 3 * 60 * 60_000) {
        const since6h = new Date(Date.now() - 6 * 3600_000).toISOString()
        const { count: discCount } = await supabase
          .from('account_connectivity_log')
          .select('id', { count: 'exact', head: true })
          .eq('linkedin_account_id', acc.id)
          .eq('event_type', 'disconnected')
          .gte('created_at', since6h)
        if ((discCount ?? 0) < 4) {
          // Estable de nuevo → resolver cualquier connection_unstable abierta
          await supabase.from('account_alerts')
            .update({ resolved_at: new Date().toISOString(), resolved_by: 'auto:connection_stable_again' })
            .eq('linkedin_account_id', acc.id)
            .eq('alert_type', 'connection_unstable')
            .is('resolved_at', null)
        }
        if ((discCount ?? 0) >= 4) {
          _lastUnstableAlert.set(acc.id, Date.now())
          await supabase.from('account_alerts')
            .update({ resolved_at: new Date().toISOString(), resolved_by: 'auto:superseded' })
            .eq('linkedin_account_id', acc.id)
            .eq('alert_type', 'connection_unstable')
            .is('resolved_at', null)
          await supabase.from('account_alerts').insert({
            linkedin_account_id: acc.id,
            alert_type: 'connection_unstable',
            severity: 'warning',
            message: `🔌 Extension de "${acc.label}" se desconecta seguido (${discCount} veces en 6h). Probable causa: "Continuar en segundo plano" DESACTIVADO en chrome://settings/system. Actívalo para conexión estable.`,
            details: { disconnects_6h: discCount, likely_cause: 'background_mode_off', fix: 'chrome://settings/system → Continue running background apps = ON' },
          })
          console.log(`[SCH-EXT] 🔌 ${acc.label}: conexión inestable (${discCount} disconnects/6h) — probable background mode off`)
        }
      }

      const isConnected = connectedIds.has(acc.id)
      if (isConnected) continue  // todo bien

      // OFFLINE durante business hours. Debounce 60min.
      const lastAlert = _lastHealthAlert.get(acc.id) ?? 0
      if (Date.now() - lastAlert < 60 * 60_000) continue
      _lastHealthAlert.set(acc.id, Date.now())

      // Log + alerta (deduplicada por alert_type+accountId via dashboard filter)
      await supabase.from('account_connectivity_log').insert({
        linkedin_account_id: acc.id,
        event_type:          'health_check_offline',
        details:             { tz, business_hours: '9-19' },
      })
      // Resolve duplicate antes de crear nueva
      await supabase.from('account_alerts')
        .update({ resolved_at: new Date().toISOString(), resolved_by: 'auto:superseded' })
        .eq('linkedin_account_id', acc.id)
        .eq('alert_type', 'ext_offline_business_hours')
        .is('resolved_at', null)
      await supabase.from('account_alerts').insert({
        linkedin_account_id: acc.id,
        alert_type: 'ext_offline_business_hours',
        severity:   'warning',
        message:    `⚠️ Extension de "${acc.label}" no conectada durante horario laboral (${tz}, 9-19h). Abre Chrome y haz click en la extensión.`,
        details:    { tz },
      })
      console.log(`[SCH-EXT] ⚠️  Health check: ${acc.label} offline durante BH (${tz})`)
    }
  } catch (err) {
    console.warn('[SCH-EXT] runConnectivityHealthCheck error:', err.message)
  }
}

async function tick() {
  const { mxDate, mxHour } = mxTime()
  console.log(`\n[SCH-EXT] ════════════════════════════`)
  console.log(`[SCH-EXT] Tick @ ${mxDate} CDMX`)

  // Pre-fetch connected accounts (cached 5s)
  const connectedIds = await getConnectedAccountIds()
  console.log(`[SCH-EXT] Bridge connected accounts: ${connectedIds.size} [${[...connectedIds].map(id => id.slice(0,8)).join(', ')}]`)

  // Health check (runs every tick, debounced 60min per account)
  await runConnectivityHealthCheck(connectedIds)

  if (connectedIds.size === 0) {
    console.log(`[SCH-EXT] Nadie conectado — skip tick`)
    await logJob({ jobType: 'tick', status: 'skipped', skipReason: 'no_extensions_connected' })
    return
  }

  // Load active campaigns + their accounts
  const { data: campaigns, error } = await supabase
    .from('campaigns')
    .select(`
      id, name, is_active,
      search_paused, batch_paused, follow_up_paused,
      search_keywords, search_location, search_count, search_2nd_degree_only,
      search_company_names, search_min_employees,
      title_whitelist, title_blacklist,
      invite_with_note,
      auto_reply_mode, auto_reply_delay_min, auto_reply_delay_max,
      fm1_example_reply, fm2_example_reply, fm3_example_reply,
      min_pending_threshold, daily_invite_target, min_batch_gap_min, search_gap_hours,
      schedule_start_hour, schedule_end_hour, schedule_days,
      last_searched_at, last_batch_at,
      last_followup_at, last_followup2_at, last_followup3_at, last_followup4_at, last_followup5_at,
      follow_up_message, follow_up_delay_days, follow_up_delay_hours,
      follow_up_step2_message, follow_up_step2_delay_hours,
      follow_up_step3_message, follow_up_step3_delay_hours,
      follow_up_step4_message, follow_up_step4_delay_hours,
      follow_up_step5_message, follow_up_step5_delay_hours,
      followup_tone_directive,
      auto_dead_after_days,
      gemini_system_prompt, target_audience, ai_tone, ai_sender_persona, ai_company_context,
      linkedin_account_id,
      linkedin_accounts (
        id, label, status, daily_connection_limit,
        warmup_status, warmup_started_at,
        inbox_gap_min, inbox_paused, last_inbox_check_at,
        sent_invites_gap_min, last_sent_invites_check_at,
        reply_delay_min, reply_delay_max,
        extension_paused, extension_paused_until, timezone, cal_com_url,
        extension_last_seen_at
      )
    `)
    .eq('is_active', true)

  if (error || !campaigns?.length) {
    console.log('[SCH-EXT] No hay campañas activas')
    return
  }

  console.log(`[SCH-EXT] ${campaigns.length} campañas activas`)
  await logJob({ jobType: 'tick', status: 'started', details: { campaigns: campaigns.length, connected: connectedIds.size } })

  // v0.7.8: sweep de awaiting_response → dead tras 21d sin volver al pipeline.
  // Barato (1 query indexada, límite 200), no necesita gate ni cuenta — corre 1× por tick.
  try {
    const sweepRes = await sweepAwaitingResponseTimeout()
    if (sweepRes.swept > 0) console.log(`[SCH-EXT] sweepAwaitingResponse: ${sweepRes.swept} leads → dead`)
  } catch (err) {
    console.error(`[SCH-EXT] sweepAwaitingResponse threw:`, err.message)
  }

  // Quarantine cleanup: leads con quarantined_at > QUARANTINE_KILL_DAYS sin
  // liberación humana (botón Liberar en UI) → dead. Mismo patrón que el
  // sweep de awaiting_response: barato, limit 200, idempotente.
  try {
    const qRes = await sweepQuarantineTimeout(QUARANTINE_KILL_DAYS)
    if (qRes.swept > 0) console.log(`[SCH-EXT] sweepQuarantine: ${qRes.swept} leads → dead`)
  } catch (err) {
    console.error(`[SCH-EXT] sweepQuarantine threw:`, err.message)
  }

  // Per-account inbox dedup (varias campañas, una cuenta)
  const accountsSeen = new Map()

  // v0.7.13: stress_test_lock — si un caso está corriendo contra una cuenta,
  // skippeamos esa cuenta este tick para no race. El lock auto-expira con TTL.
  const stressLockedAccount = await readStressTestLock()
  if (stressLockedAccount) {
    console.log(`[SCH-EXT] stress_test_lock activo para ${stressLockedAccount.slice(0,8)} — esa cuenta skip`)
  }

  for (const campaign of campaigns) {
    const account = campaign.linkedin_accounts
    if (!account) {
      console.log(`[SCH-EXT] Campaña "${campaign.name}" sin cuenta — skip`)
      continue
    }
    if (!connectedIds.has(account.id)) {
      console.log(`[SCH-EXT] Campaña "${campaign.name}" — cuenta ${account.label} desconectada — skip`)
      continue
    }
    if (account.id === stressLockedAccount) {
      console.log(`[SCH-EXT] "${campaign.name}" — cuenta ${account.label} bajo stress_test_lock — skip`)
      continue
    }
    accountsSeen.set(account.id, account)

    const skipReason = await checkCampaignActiveGates(campaign, account)
    if (skipReason) {
      console.log(`[SCH-EXT] "${campaign.name}" — gate skip: ${skipReason}`)
      await logJob({ campaignId: campaign.id, accountId: account.id, jobType: 'tick',
        status: 'skipped', skipReason })
      continue
    }

    console.log(`[SCH-EXT] ━━ "${campaign.name}" (${account.label}) ━━`)

    // SEARCH (3.2)
    const searchRes = await trySearchForCampaign(campaign, account)
    if (searchRes.dispatched) {
      console.log(`[SCH-EXT]   ✅ search dispatched (cmd ${searchRes.commandId.slice(0,8)}, "${searchRes.keyword}")`)
    } else {
      console.log(`[SCH-EXT]   ⏭️  search: ${searchRes.reason}`)
    }

    // INVITES (3.3 — stub)
    const inviteRes = await tryInvitesForCampaign(campaign, account)
    if (inviteRes.dispatched) {
      console.log(`[SCH-EXT]   ✅ ${inviteRes.dispatched} invites dispatched`)
    } else {
      console.log(`[SCH-EXT]   ⏭️  invites: ${inviteRes.reason}`)
    }

    // AUTO-REPLY / FM (3.6) — antes que FU para no spamear con FU si ya respondió
    const replyRes = await tryAutoReplyForCampaign(campaign, account)
    if (replyRes.dispatched) {
      console.log(`[SCH-EXT]   💬 AI reply FM${replyRes.fmStep} dispatched to ${replyRes.leadName}: "${replyRes.messagePreview}..."`)
    } else if (replyRes.reason !== 'no_replies_pending' && replyRes.reason !== 'auto_reply_mode_off' && replyRes.reason !== 'auto_reply_mode_manual') {
      console.log(`[SCH-EXT]   ⏭️  auto-reply: ${replyRes.reason}`)
    }

    // FOLLOWUPS (3.4)
    const fuRes = await tryFollowupsForCampaign(campaign, account)
    if (fuRes.dispatched) {
      console.log(`[SCH-EXT]   ✅ ${fuRes.dispatched} follow-ups dispatched`)
    } else {
      console.log(`[SCH-EXT]   ⏭️  follow-ups: ${fuRes.reason}`)
    }

    // Pequeño jitter entre campañas (no ráfaga)
    await sleep(randInt(1000, 3000))
  }

  // INBOX + CHECK_SENT_INVITES per-account (only in inbox hours, per account TZ)
  for (const account of accountsSeen.values()) {
    if (!connectedIds.has(account.id)) continue
    // v0.7.26 BUG extension_did_not_respond fix B1: gate extension_paused +
    // extension_paused_until. Antes este loop solo checaba inbox_paused (en
    // tryInboxForAccount) → si la cuenta estaba extension_paused pero connected,
    // creaba check_inbox/check_sent_invites que quedaban en cola y EXPIRABAN
    // (bridge skip paused) → marcados extension_did_not_respond. 58/66 de los
    // check_inbox did_not_respond eran esto (expired_in_pending).
    if (account.extension_paused) {
      console.log(`[SCH-EXT] ${account.label} extension_paused — skip inbox/sent (evita cmd huérfano en cola)`)
      continue
    }
    const pausedUntilMs = account.extension_paused_until ? new Date(account.extension_paused_until).getTime() : 0
    if (pausedUntilMs > Date.now()) {
      console.log(`[SCH-EXT] ${account.label} paused_until ${Math.round((pausedUntilMs-Date.now())/60000)}min — skip inbox/sent`)
      continue
    }
    if (!isInboxHours(undefined, account.timezone)) continue  // fuera de inbox hours en TZ de cuenta

    const inboxRes = await tryInboxForAccount(account)
    if (inboxRes.dispatched) {
      console.log(`[SCH-EXT]   ✅ inbox dispatched for ${account.label}`)
    }

    // No despachar dos comandos al mismo tab en el mismo tick
    if (inboxRes.dispatched) continue

    const sentRes = await tryCheckSentInvitesForAccount(account)
    if (sentRes.dispatched) {
      console.log(`[SCH-EXT]   ✅ check_sent_invites dispatched for ${account.label}`)
    }
  }

  console.log(`[SCH-EXT] Tick done @ ${mxTime().mxDate}`)
}

// ── Main loop ────────────────────────────────────────────────────────────────

async function runTickSafely() {
  if (tickInFlight) {
    console.warn(`[SCH-EXT] ⚠️  tick anterior aún en flight — skipeando este ciclo`)
    return
  }
  tickInFlight = true
  const start = Date.now()
  try {
    await withTimeout(tick(), TICK_TIMEOUT_MS, 'tick')
    lastTickAt = Date.now()
    const dur = Date.now() - start
    if (dur > 30_000) console.warn(`[SCH-EXT] ⚠️  tick lento: ${dur}ms`)
  } catch (err) {
    console.error(`[SCH-EXT] Tick error: ${err?.message ?? err}`)
    console.error(`[SCH-EXT] Err shape: type=${typeof err} isError=${err instanceof Error} ctor=${err?.constructor?.name} keys=${err && typeof err === 'object' ? Object.keys(err).join(',') : 'n/a'}`)
    if (err?.stack) console.error(`[SCH-EXT] Stack: ${err.stack.split('\n').slice(0, 8).join('\n')}`)
    else console.error(`[SCH-EXT] Err raw: ${JSON.stringify(err, Object.getOwnPropertyNames(err ?? {})).slice(0, 500)}`)
    // Si fue por timeout, watchdog matará si se repite — pero sí actualizamos
    // lastTickAt para no doble-matar por el mismo tick lento
    lastTickAt = Date.now()
  } finally {
    tickInFlight = false
  }
}

async function run() {
  console.log(`[SCH-EXT] 🚀 Scheduler-extension iniciando (tick=${TICK_INTERVAL_MS/1000}s, tickTimeout=${TICK_TIMEOUT_MS/1000}s, hungTimeout=${HUNG_TIMEOUT_MS/1000}s, DRY_RUN=${DRY_RUN})`)
  // Watchdog cada 60s
  setInterval(watchdog, 60_000)
  // Heartbeat to log file for external monitoring (e.g., bash `tail`)
  setInterval(() => {
    console.log(`[SCH-EXT] ♥ heartbeat — lastTickAt ${Math.floor((Date.now()-lastTickAt)/1000)}s ago, tickInFlight=${tickInFlight}`)
  }, 120_000)
  // First tick immediate
  runTickSafely()
  // Then on interval
  setInterval(runTickSafely, TICK_INTERVAL_MS)
}

// Handlers para que crash logs sean visibles
process.on('uncaughtException', (err) => {
  console.error(`[SCH-EXT] 💥 uncaughtException: ${err.stack ?? err.message ?? err}`)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  console.error(`[SCH-EXT] 💥 unhandledRejection: ${reason?.stack ?? reason?.message ?? reason}`)
  process.exit(1)
})

run()
