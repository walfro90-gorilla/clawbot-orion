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
import fs from 'fs'
import { supabase, logActivity, setTickSignal } from './lib/supabase.js'
import { notifyOps } from './lib/notify-ops.js'
import {
  mxTime, mxDateStr, minutesSince,
  isBusinessHours, isInboxHours,
  isExtensionOnline, getConnectedAccountIds,
  getEffectiveDailyCap, getDailyActivityToday, getPendingLeadsCount,
  hasInFlightCommand, wasMessageRecentlySent,
  passesTitleFilters, seniorityRank,
  dispatchSearch, dispatchInvite, dispatchCheckInbox, dispatchCheckSentInvites, dispatchCheckConnections, dispatchFollowup,
  dispatchCommand, dispatchResolveCompanies, COMPANY_SCOPED_MIN_VERSION, CONTACT_INFO_MIN_VERSION, WITHDRAW_INVITES_MIN_VERSION, meetsVersion,
  checkCampaignActiveGates,
  dispatchPostSearch, dispatchCommentOnPost, checkPostCampaignActiveGates,
  getDailyCommentsToday, getEffectiveCommentCap,
} from './lib/extension-dispatch.js'
import { generateLinkedInMessage, generateLinkedInReply, personalizeFollowupMessage, hasLeftoverPlaceholder, qualifyPost, generatePostComment, extractCompaniesFromHeadlines, detectExitIntent } from './lib/ai-message.js'
import { generatePostCopy, generateDailyPost } from './lib/daily-publish.js'
import { uploadGeneratedImage } from './lib/gemini-image.js'
import { isSystemLinkedInAccount } from './lib/system-accounts.js'
import { isGroupConversationName } from './lib/group-conversation.js'
import { sweepQuarantineTimeout } from './lib/lead-failure.js'
import { maybeSendDailyDigest, maybeSendCampaignDigests } from './lib/daily-digest.js'

dotenv.config()

const TICK_INTERVAL_MS = parseInt(process.env.TICK_INTERVAL_MS ?? '300000')  // 5 min default
const TICK_TIMEOUT_MS  = parseInt(process.env.TICK_TIMEOUT_MS  ?? '240000')  // 4 min: umbral del watchdog (HARD kill) — backstop si el soft falla
// v0.8: timeout SOFT del tick (withTimeout) — MÁS CORTO que el watchdog para que el tick
// aborte SOLO (graceful, sin restart) antes del hard-kill. Cubre cualquier cuelgue (DB/bridge/Gemini).
const TICK_SOFT_TIMEOUT_MS = parseInt(process.env.TICK_SOFT_TIMEOUT_MS ?? '120000')  // 2 min
const HUNG_TIMEOUT_MS  = parseInt(process.env.HUNG_TIMEOUT_MS  ?? '600000')  // 10 min: watchdog mata el proceso
const MAX_DAILY_MESSAGES = parseInt(process.env.MAX_DAILY_MESSAGES ?? '30')  // FU+FM combinado por cuenta/día
const CONNECTIONS_CHECK_GAP_MIN = parseInt(process.env.CONNECTIONS_CHECK_GAP_MIN ?? '240')  // check_connections backstop cada ~4h
const DRY_RUN = process.env.DRY_RUN === 'true'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min

// v0.7.13 — helper para leer runtime_config (single key) y retornar value como
// número con default si no existe o no es número.
// v0.7.47 — accountId opcional: si se pasa, account_config[account_id][key] GANA sobre el
// runtime_config global. Null-safe: sin accountId o sin fila → cae al global (idéntico a hoy).
// ── Caché TTL en proceso para config casi-estática (post-mortem 2026-07-03) ──────
// runtime_config/account_config cambian rara vez pero se leían cientos de veces por
// tick — round-trips puros que, bajo starvation de IO en el tier Nano, eran carga sin
// valor que ayudó a wedgear la DB. Caché con TTL corto: un cambio de config surte
// efecto en ≤TTL. Solo cachea LECTURAS de config estática (readRuntimeNumber /
// getAccountConfigRaw); NO se toca readStressTestLock ni flags de pausa (time-sensitive,
// leídos por otras vías). Ver docs/postmortem-2026-07-03-db-outage.md §5 (P1 #9).
const CONFIG_CACHE_TTL_MS = parseInt(process.env.CONFIG_CACHE_TTL_MS ?? '60000')
const _configCache = new Map()  // cacheKey → { val, exp }
function _cfgGet(k) {
  const e = _configCache.get(k)
  if (e && e.exp > Date.now()) return e
  if (e) _configCache.delete(k)
  return null
}
function _cfgSet(k, val) { _configCache.set(k, { val, exp: Date.now() + CONFIG_CACHE_TTL_MS }) }

async function readRuntimeNumber(key, def, accountId = null) {
  // Cachea el valor RESUELTO crudo (número o null=no-encontrado), NO el def:
  // así cada caller aplica su propio default sobre un hit compartido.
  const ck = `rn:${accountId ?? '-'}:${key}`
  const hit = _cfgGet(ck)
  if (hit) return hit.val ?? def
  let resolved = null
  if (accountId) {
    const { data: acc } = await supabase
      .from('account_config')
      .select('value')
      .eq('account_id', accountId)
      .eq('key', key)
      .maybeSingle()
    const av = acc?.value
    if (typeof av === 'number') resolved = av
    else if (typeof av === 'string' && !isNaN(Number(av))) resolved = Number(av)
  }
  if (resolved === null) {
    const { data } = await supabase
      .from('runtime_config')
      .select('value')
      .eq('key', key)
      .maybeSingle()
    const v = data?.value
    if (typeof v === 'number') resolved = v
    else if (typeof v === 'string' && !isNaN(Number(v))) resolved = Number(v)
  }
  _cfgSet(ck, resolved)
  return resolved ?? def
}

// v0.7.47 — lee un valor CRUDO de account_config (objeto/array/escalar) para esa cuenta.
// Null si no hay fila. Para overrides no-numéricos (p.ej. inbox_hours {start,end}).
async function getAccountConfigRaw(accountId, key) {
  if (!accountId) return null
  const ck = `ac:${accountId}:${key}`
  const hit = _cfgGet(ck)
  if (hit) return hit.val
  const { data } = await supabase
    .from('account_config')
    .select('value')
    .eq('account_id', accountId)
    .eq('key', key)
    .maybeSingle()
  const val = data?.value ?? null
  _cfgSet(ck, val)
  return val
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
let tickStartedAt = 0  // v0.8: timestamp de cuándo arrancó el tick ACTUAL (el watchdog mide ESTO)
// v0.9.x (post-mortem 2026-07-03): rachas para backoff dinámico + alerta out-of-band.
let consecutiveTickFailures = 0
let slowTickStreak = 0

function watchdog() {
  const sinceTick = Date.now() - lastTickAt
  if (sinceTick > HUNG_TIMEOUT_MS) {
    console.error(`[SCH-EXT] 🔴 WATCHDOG: scheduler hung — sin tick desde hace ${Math.floor(sinceTick/1000)}s. Matando proceso para que PM2 reinicie.`)
    process.exit(1)
  }
  // v0.8 FIX: medir cuánto lleva corriendo el tick ACTUAL (Date.now()-tickStartedAt),
  // NO sinceTick (que es tiempo desde el último tick COMPLETADO ≈ el intervalo de 300s).
  // El bug previo: como intervalo(300s) > TICK_TIMEOUT(240s), todo tick arrancaba ya
  // "vencido" (sinceTick~298>240) → un tick lento (30-40s por IO) quedaba en vuelo lo
  // suficiente para que el watchdog le cayera y lo matara, creyendo que estaba colgado.
  const tickRunningMs = tickInFlight ? Date.now() - tickStartedAt : 0
  if (tickInFlight && tickRunningMs > TICK_TIMEOUT_MS) {
    console.error(`[SCH-EXT] 🔴 WATCHDOG: tick en flight desde hace ${Math.floor(tickRunningMs/1000)}s (>${TICK_TIMEOUT_MS/1000}s). Matando proceso.`)
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
  // NO fire-and-forget: durante meses los CHECK cerrados de scheduler_log rechazaban
  // todo job_type/status fuera del set (fm_reply_*, followup_N, check_*, 'dispatched'…)
  // y este insert se tragaba el error → telemetría muerta sin que nadie se enterara.
  // Constraints ya dropeados (17-jul); este log es el guard que lo habría cazado.
  const { error } = await supabase.from('scheduler_log').insert({
    campaign_id: campaignId ?? null,
    account_id:  accountId ?? null,
    job_type:    jobType,
    status,
    skip_reason: skipReason ?? null,
    leads_found: leadsFound ?? null,
    leads_sent:  leadsSent ?? null,
    details:     details ?? {},
  })
  if (error) console.warn(`[logJob] drop ${jobType}/${status}: ${error.message}`)
}

// IO: motivo de skip por campaña, para loguear a scheduler_log SOLO en transiciones
// (no en cada tick). Memoria del proceso; al reiniciar se acepta un re-log inicial.
const lastSkipReason = new Map()

// ── Search trigger ───────────────────────────────────────────────────────────
// Dispara search si: !search_paused + gap respetado + pending_leads bajo + connected

// v0.7.46: cuenta leads scraped/pending que PASAN el filtro de títulos (ejecutivos reales
// invitables), no el conteo crudo. Sin esto, un pool lleno de junk del company-scoped
// bloqueaba nuevas búsquedas. El pool scraped suele ser <50, así que el fetch es barato.
async function getEligiblePendingCount(campaign) {
  // Solo se necesita el headline para passesTitleFilters — extraerlo server-side con
  // ->>headline en vez de traer el profile_data JSON completo (payload sin valor por
  // tick por campaña). Post-mortem 2026-07-03 §5 (P2).
  const { data } = await supabase
    .from('leads')
    .select('hl:profile_data->>headline, tc:profile_data->>targetCompany')
    .eq('campaign_id', campaign.id)
    .in('status', ['scraped', 'pending'])
  // 2-ago: en campaña con lista de empresas, el pool VIEJO (búsquedas por título de
  // antes) no cuenta como abastecimiento. Contarlo hacía que el scheduler se creyera
  // surtido y no buscara: la cuenta de Josh se quedó en 0 leads de la lista y 19
  // heredados, así que pasó el día invitando gente fuera de la lista mientras sus 324
  // empresas esperaban. Ahora "surtido" significa surtido DE LA LISTA; el pool viejo
  // sigue disponible para invitar, solo que ya no bloquea las búsquedas.
  const listMode = Array.isArray(campaign.search_company_names)
    && campaign.search_company_names.filter(Boolean).length > 0
  let n = 0
  for (const l of (data ?? [])) {
    if (listMode && !l.tc) continue
    if (passesTitleFilters(l.hl ?? '', campaign.title_whitelist, campaign.title_blacklist)) n++
  }
  return n
}

// ── v0.10.0 — cursor de empresas objetivo (campaign_target_companies) ────────
// La lista que el usuario edita sigue siendo campaigns.search_company_names (sin UI
// nueva); estas filas son el CURSOR (qué empresa toca) + la caché del company URN.
// Lote chico a propósito: el comando ocupa la pestaña ~1-2min (una navegación por
// empresa) y un invite en cola expira a los 10min. 12 × ~5s ≈ 1min de ocupación.
const COMPANY_RESOLVE_BATCH  = 12      // empresas por comando resolve_companies
const COMPANY_RESOLVE_MAX_TRIES = 3
const COMPANY_RESOLVE_RETRY_H = 24
// Puestos que se barren en una empresa antes de pasar a la siguiente. El cursor de
// títulos es POR EMPRESA y persiste, así que la próxima vuelta retoma donde se quedó.
// Subirlo = más profundidad por empresa; bajarlo = recorrer la lista más rápido.
const COMPANY_TITLES_PER_PASS = 6

// Sincroniza search_company_names → filas. Inserta las nuevas, borra las que el
// usuario quitó de la lista. Idempotente (unique index por campaign+lower(name)).
// IO: la lista cambia rara vez y el tick corre cada 5min → TTL en proceso para no
// releer 200 filas 288 veces al día (post-mortem 2026-07-03).
const COMPANY_SYNC_TTL_MS = 30 * 60_000
const lastCompanySync = new Map()

async function syncTargetCompanies(campaignId, names) {
  const last = lastCompanySync.get(campaignId) ?? 0
  if (Date.now() - last < COMPANY_SYNC_TTL_MS) return
  lastCompanySync.set(campaignId, Date.now())

  const { data: rows } = await supabase
    .from('campaign_target_companies')
    .select('id, name, sort_order')
    .eq('campaign_id', campaignId)
  const have = new Map((rows ?? []).map(r => [r.name.toLowerCase(), r]))
  // sort_order = posición en la lista del usuario. Sin esto, la primera vuelta iba en
  // orden arbitrario (todas con last_searched_at NULL y el mismo created_at del INSERT
  // en bloque) y "la 1era empresa de la lista" no era la primera en buscarse.
  const want = new Map(names.map((n, i) => [n.toLowerCase(), { name: n, pos: i }]))

  const toInsert = [...want].filter(([k]) => !have.has(k))
    .map(([, v]) => ({ campaign_id: campaignId, name: v.name, sort_order: v.pos }))
  if (toInsert.length) {
    const { error } = await supabase.from('campaign_target_companies').insert(toInsert)
    if (error) console.warn(`[SCH-EXT] syncTargetCompanies insert: ${error.message}`)
    else console.log(`[SCH-EXT]   🏢 +${toInsert.length} empresas objetivo nuevas`)
  }
  const toDelete = [...have].filter(([k]) => !want.has(k)).map(([, r]) => r.id)
  if (toDelete.length) {
    await supabase.from('campaign_target_companies').delete().in('id', toDelete)
    console.log(`[SCH-EXT]   🏢 -${toDelete.length} empresas fuera de la lista`)
  }
  // Reordenar solo lo que cambió de posición (el usuario movió la lista).
  for (const [k, v] of want) {
    const row = have.get(k)
    if (row && row.sort_order !== v.pos) {
      await supabase.from('campaign_target_companies')
        .update({ sort_order: v.pos }).eq('id', row.id)
    }
  }
}

// Empresas sin URN todavía resolvible (nunca intentadas, o reintentables tras 24h).
async function pendingResolveCompanies(campaignId, limit) {
  const retryIso = new Date(Date.now() - COMPANY_RESOLVE_RETRY_H * 3_600_000).toISOString()
  const { data } = await supabase
    .from('campaign_target_companies')
    .select('id, name, resolve_attempts, resolve_attempted_at')
    .eq('campaign_id', campaignId)
    .eq('status', 'pending')
    .lt('resolve_attempts', COMPANY_RESOLVE_MAX_TRIES)
    .or(`resolve_attempted_at.is.null,resolve_attempted_at.lt.${retryIso}`)
    .order('resolve_attempts', { ascending: true })
    .order('sort_order', { ascending: true })   // el primer lote resuelve el inicio de la lista
    .limit(limit)
  return data ?? []
}

// Cursor: la empresa lista (o degradada) que lleva más tiempo sin visitarse.
// nulls first ⇒ primero las que nunca se buscaron → una vuelta completa a la lista
// antes de repetir ninguna.
async function pickNextTargetCompany(campaignId) {
  const { data } = await supabase
    .from('campaign_target_companies')
    .select('id, name, linkedin_urn, slug, status, last_searched_at, title_idx')
    .eq('campaign_id', campaignId)
    .in('status', ['ready', 'unresolved'])
    .order('last_searched_at', { ascending: true, nullsFirst: true })
    .order('sort_order', { ascending: true })   // primera vuelta = orden de la lista del usuario
    .limit(1)
    .maybeSingle()
  return data ?? null
}

// 31-jul: el grupo booleano ("A" OR "B" OR "C") NO funciona en el buscador free —
// LinkedIn lo trata como texto literal, no como operador: Mondelēz + 3 títulos con OR
// devolvió "No se han encontrado resultados" con la empresa correcta en el facet.
// Volvemos a UN puesto por búsqueda (sin comillas, como las búsquedas que sí rendían),
// y el barrido de los 20-30 puestos se hace VISITA A VISITA sobre la misma empresa:
// cada empresa lleva su propio cursor de títulos (title_idx) y se queda seleccionada
// hasta completar COMPANY_TITLES_PER_PASS puestos; luego pasa la siguiente empresa y
// retoma donde iba en la próxima vuelta.
function nextTitleForCompany(kws, target) {
  const idx = (target.title_idx ?? 0) % kws.length
  const nextIdx = (idx + 1) % kws.length
  // Fin de pase: completó su tanda de títulos, o dio la vuelta a la lista completa.
  const passDone = nextIdx === 0 || nextIdx % COMPANY_TITLES_PER_PASS === 0
  return { keyword: kws[idx], idx, nextIdx, passDone }
}

async function trySearchForCampaign(campaign, account) {
  if (campaign.search_paused) {
    return { skipped: true, reason: 'search_paused' }
  }

  // ── Modo company-scoped (v0.10.0) ──────────────────────────────────────────
  // Requiere ext ≥0.10.0: una ext vieja ignora companyUrn y buscaría por título en
  // TODO LinkedIn (el bug que reportó Josh). Sin la versión, degradamos a title-only.
  const companyNames = Array.isArray(campaign.search_company_names)
    ? campaign.search_company_names.filter(Boolean) : []
  const extReady = meetsVersion(account.ext_version, COMPANY_SCOPED_MIN_VERSION)
  const companyMode = companyNames.length > 0 && extReady
  if (companyNames.length > 0 && !extReady) {
    console.warn(`[SCH-EXT]   ⚠️  "${campaign.name}": ${companyNames.length} empresas configuradas pero ext ${account.ext_version ?? '?'} <${COMPANY_SCOPED_MIN_VERSION} — recarga la extensión. Búsqueda title-only mientras tanto.`)
  }

  // Resolución de URNs: NO pasa por el gap de búsqueda (si no, 182 empresas = meses).
  // Un comando resuelve un lote entero; a ~1 lote por tick la lista queda lista en <1h.
  if (companyMode) {
    await syncTargetCompanies(campaign.id, companyNames)
    const toResolve = await pendingResolveCompanies(campaign.id, COMPANY_RESOLVE_BATCH)
    if (toResolve.length > 0) {
      if (DRY_RUN) {
        console.log(`[SCH-EXT] DRY_RUN resolve_companies ×${toResolve.length}`)
        return { dispatched: false, dryRun: true, keyword: `resolve×${toResolve.length}` }
      }
      const cmdId = await dispatchResolveCompanies(account, toResolve)
      if (cmdId) {
        // Stamp del intento AL DESPACHAR: si el comando se pierde, el lote no se
        // reintenta hasta dentro de 24h en vez de martillarse cada tick.
        const nowIso = new Date().toISOString()
        await Promise.all(toResolve.map(c =>
          supabase.from('campaign_target_companies')
            .update({ resolve_attempts: (c.resolve_attempts ?? 0) + 1, resolve_attempted_at: nowIso })
            .eq('id', c.id)))
        await logJob({
          campaignId: campaign.id, accountId: account.id, jobType: 'search',
          status: 'dispatched', details: { commandId: cmdId, mode: 'resolve_companies', count: toResolve.length },
        })
        return { dispatched: true, commandId: cmdId, keyword: `resolve×${toResolve.length}` }
      }
    }
  }

  const searchGapHours = campaign.search_gap_hours ?? 24
  const minsSince = minutesSince(campaign.last_searched_at)

  // v0.7.48: reabastecer por CONTEO DE EJECUTIVOS ELEGIBLES, no por tiempo. Objetivo del
  // usuario: que la cuenta NUNCA se quede con poco/nada de cuentas donde conectar. Lógica:
  //   - eligibleCount >= minPending          → suficiente, no busca.
  //   - eligibleCount <= critical (drought)  → busca YA, ignora el gap de horas (solo respeta
  //                                            un piso anti-spam de 30min entre búsquedas).
  //   - critical < eligibleCount < minPending → busca a cadencia normal (gap de horas).
  // (antes el drought usaba scrapedCount CRUDO incl. junk del company-scoped → no detectaba
  //  la escasez de ejecutivos reales y la cuenta se secaba.)
  const minPending = campaign.min_pending_threshold ?? 10
  const criticalPending = Math.max(3, Math.floor(minPending / 3))   // ~6 si minPending=18
  const CRIT_FLOOR_MIN = 30                                          // piso entre búsquedas en drought crítico
  const eligibleCount = await getEligiblePendingCount(campaign)
  if (eligibleCount >= minPending) {
    return { skipped: true, reason: 'enough_eligible_leads', eligibleCount, minPending }
  }
  const criticalDrought = eligibleCount <= criticalPending
  // #3 (2026-07-03): backoff yield-aware del piso de drought. Si las últimas búsquedas
  // vinieron SECAS (dry_search_streak, seteado en ingestSearch al no traer leads netos),
  // multiplicamos el piso para no martillar un pool agotado cada 30min: 30→60→120→240→cap
  // 360min. Se resetea a 0 en cuanto una búsqueda trae leads netos nuevos.
  const dryStreak = campaign.dry_search_streak ?? 0
  const critFloorMin = Math.min(CRIT_FLOOR_MIN * (2 ** Math.min(dryStreak, 4)), 360)
  const effGapMin = criticalDrought ? critFloorMin : searchGapHours * 60
  if (minsSince < effGapMin) {
    return { skipped: true, reason: criticalDrought ? 'search_crit_floor_not_met' : 'search_gap_not_met', eligibleCount, minsSince: Math.floor(minsSince), dryStreak, effGapMin: Math.round(effGapMin) }
  }
  if (criticalDrought) console.log(`[SCH-EXT]   ⚡ drought CRÍTICO ${campaign.name}: ${eligibleCount} elegibles (≤${criticalPending}), dryStreak=${dryStreak} → piso ${effGapMin}min, búsqueda forzada`)

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

  // v0.10.0: la válvula anti-sequía YA NO borra la lista de empresas (era un bucle que
  // anulaba la feature). Tenía un escape: tras dry_search_streak≥5, UNA búsqueda title-only
  // de reabastecimiento.
  // (10-ago-2026) ESCAPE title-only DESACTIVADO en company-scoped. La búsqueda title-only
  // TIRA el filtro de empresa → surfacea perfiles de empresas FUERA de la lista, y en
  // SalesNav (buildSalesNavSearchUrl ignora la geo) de OTROS PAÍSES. Josh reportó un founder
  // de India (competidor, "hace lo mismo que nosotros") que entró así (lead 'disqualified'
  // pero visible en su navegador + gasta búsquedas). El cliente quiere SOLO su lista: mejor
  // menos leads de su lista que basura fuera de parámetros. companyMode SIEMPRE busca una
  // empresa de la lista; si todas están recién buscadas, el cursor toma la más vieja.
  const target = companyMode ? await pickNextTargetCompany(campaign.id) : null

  // (14-ago-2026) Sin empresa seleccionable NO se busca. El escape title-only estaba
  // eliminado arriba, pero quedaba esta puerta: con la lista ENTERA en 'pending' (el
  // resolver de la ext dejó de sacar el URN el 12-ago, LinkedIn cambió el markup de
  // /search/results/companies) pickNextTargetCompany devuelve null y la búsqueda salía
  // title-only igual → Aduanas Infinity invitó a MAHLE, Grupo Nexos, Serviacero y juntó
  // 19 leads de fuera de la lista (incluidas agencias aduanales = competencia).
  if (companyMode && !target) {
    return { skipped: true, reason: 'no_company_target', companies: companyNames.length }
  }

  // Con empresa: UN puesto por búsqueda, desde el cursor propio de esa empresa.
  // Sin empresa: 1 keyword rotado por la campaña, comportamiento de siempre.
  const tt = target ? nextTitleForCompany(kws, target) : null
  const keyword = target ? tt.keyword : kws[idx]
  const nextIdx = (idx + 1) % kws.length

  if (DRY_RUN) {
    console.log(`[SCH-EXT] DRY_RUN search "${campaign.name}" keyword="${keyword}"${target ? ` @${target.name}` : ''}`)
    return { dispatched: false, dryRun: true, keyword }
  }

  if (target) {
    console.log(`[SCH-EXT]   🏢 ${campaign.name}: "${target.name}"${target.linkedin_urn ? ` (urn ${target.linkedin_urn})` : ' (sin urn — match por nombre)'} → puesto ${tt.idx + 1}/${kws.length} "${keyword}"${tt.passDone ? ' (último del pase → siguiente empresa)' : ''}`)
  }

  const cmdId = await dispatchSearch(account, campaign, keyword, { targetCompany: target })
  if (!cmdId) {
    return { skipped: true, reason: 'dispatch_failed' }
  }

  // Cursor: stamp AL DESPACHAR (no al ingest) — si la búsqueda falla o vuelve vacía,
  // el cursor igual avanza en vez de atascarse. El título avanza SIEMPRE (un puesto que
  // no existe en esa empresa no debe bloquear los demás); `last_searched_at` solo se
  // sella al cerrar el pase, y como el cursor ordena por él (nulls first), la empresa
  // sigue seleccionada mientras barre sus puestos.
  if (target) {
    const upd = { title_idx: tt.nextIdx }
    if (tt.passDone) {
      upd.last_searched_at = new Date().toISOString()
      // Autocuración (31-jul): si tras un pase COMPLETO la empresa no dio NI UN lead,
      // lo más probable es que el URN apunte a una página DUPLICADA/fantasma de esa
      // empresa (LinkedIn tiene varias; "mondelez internacional" resolvía a una con 4
      // empleados alcanzables mientras la real es otra). La devolvemos a la cola de
      // resolución para que el scorer por seguidores elija de nuevo. resolve_attempts
      // NO se reinicia → como mucho 3 intentos y luego queda 'unresolved' (búsqueda
      // por nombre), sin bucle infinito.
      const { data: row } = await supabase
        .from('campaign_target_companies')
        .select('leads_found, resolve_attempts')
        .eq('id', target.id).maybeSingle()
      if ((row?.leads_found ?? 0) === 0 && (row?.resolve_attempts ?? 0) < COMPANY_RESOLVE_MAX_TRIES) {
        upd.status = 'pending'
        upd.linkedin_urn = null
        upd.resolve_attempted_at = null
        console.log(`[SCH-EXT]   ♻️  "${target.name}": pase completo sin un solo lead → re-resolver URN (intento ${(row?.resolve_attempts ?? 0) + 1}/${COMPANY_RESOLVE_MAX_TRIES})`)
      }
    }
    await supabase.from('campaign_target_companies').update(upd).eq('id', target.id)
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
    details: { commandId: cmdId, keyword, pendingBefore: eligibleCount, company: target?.name ?? null },
  })

  return { dispatched: true, commandId: cmdId, keyword }
}

// ── Junk reaper (06-jul): mantiene 'scraped' limpio de leads que NUNCA pasarán el whitelist ──
// El search company-scoped rinde ~1 ejecutivo por decenas de empleados; el junk que falla el
// whitelist se quedaba en 'scraped' para siempre (nunca se invita) y, al acumularse, TAPABA la
// ventana de selección de invites (limit) → starving a ejecutivos válidos más viejos (caso Josh
// 06-jul: top-10 = puro Procurement/Consultant mientras Director General/CEO esperaban >15 rank).
// Barremos junk CON headline y >2 días → disqualified. Headline vacío PASA (passesTitleFilters),
// así que nunca tocamos leads sin headline. Idempotente y barato (el pool 'scraped' es chico).
async function sweepJunkScraped(campaign) {
  try {
    const staleIso = new Date(Date.now() - 2 * 86_400_000).toISOString()
    const { data } = await supabase
      .from('leads')
      .select('id, hl:profile_data->>headline')
      .eq('campaign_id', campaign.id)
      .eq('status', 'scraped')
      .lt('scraped_at', staleIso)
    if (!data?.length) return 0
    const junkIds = data
      .filter(l => !passesTitleFilters(l.hl ?? '', campaign.title_whitelist, campaign.title_blacklist))
      .map(l => l.id)
    if (!junkIds.length) return 0
    await supabase.from('leads')
      .update({ status: 'disqualified', dead_reason: 'not_whitelist_junk' })
      .in('id', junkIds)
    return junkIds.length
  } catch (e) {
    console.warn(`[SCH-EXT] sweepJunkScraped error (${campaign.name}):`, e?.message)
    return 0
  }
}

// ── Invite trigger (3.3) ─────────────────────────────────────────────────────
// 1 invite por tick cuando: !batch_paused, gap respetado, bajo cap diario,
// hay leads scraped que pasan whitelist/blacklist.

async function tryInvitesForCampaign(campaign, account) {
  if (campaign.batch_paused) {
    return { skipped: true, reason: 'batch_paused' }
  }

  // v0.8: gap de invite DINÁMICO — reparte el daily target en la ventana activa del día,
  // con piso anti-ban + jitter. El TARGET configurado manda la cadencia: target 20 + ventana
  // 6-21h (15h) → ~45min entre invites → ~20/día. Cambias el target y se recalcula solo.
  // min_batch_gap_min > 0 = override manual conservador; 0 = dinámico (recomendado).
  const cap = getEffectiveDailyCap(account, campaign)
  const ANTIBAN_FLOOR_MIN = 25  // nunca más rápido que 1 invite/25min, pase lo que pase
  let baseGapMin
  if (campaign.min_batch_gap_min > 0) {
    baseGapMin = Math.max(ANTIBAN_FLOOR_MIN, campaign.min_batch_gap_min)
  } else {
    const windowMin = Math.max(60, ((campaign.schedule_end_hour ?? 21) - (campaign.schedule_start_hour ?? 6)) * 60)
    baseGapMin = Math.max(ANTIBAN_FLOOR_MIN, Math.round(windowMin / Math.max(1, cap)))
  }
  const gapMin = Math.max(ANTIBAN_FLOOR_MIN, Math.round(baseGapMin * (0.85 + Math.random() * 0.30)))  // jitter anti-ban ±15%
  const minsSince = minutesSince(campaign.last_batch_at)
  if (minsSince < gapMin) {
    return { skipped: true, reason: 'batch_gap_not_met', minsSince: Math.floor(minsSince), gapMin }
  }

  // (09-ago) PISO DE INVITE POR-CUENTA. El gap de arriba es POR-CAMPAÑA; con una cuenta que
  // tiene 2+ campañas activas, ambas pueden pasar su gap y disparar en el MISMO tick → 2
  // invites con segundos de diferencia (medido: Wal Tech+Transporte a 4s = patrón de bot).
  // LinkedIn limita por VOLUMEN y por PATRÓN; ningún humano manda 2 solicitudes en 4s.
  // Este piso mira el invite MÁS RECIENTE de CUALQUIER campaña de la cuenta y bloquea si
  // fue hace <ACCOUNT_INVITE_FLOOR_MIN; el invitado se reintenta en el próximo tick. Como
  // el piso (~6min) es mucho menor que el gap por-campaña (25-45min), solo muerde en la
  // colisión de mismo-tick — no afecta la cadencia normal de una campaña sola.
  const ACCOUNT_INVITE_FLOOR_MIN = 6
  const { data: acctCamps } = await supabase
    .from('campaigns')
    .select('last_batch_at')
    .eq('linkedin_account_id', account.id)
    .not('last_batch_at', 'is', null)
  const lastAcctInvite = (acctCamps ?? []).map(c => c.last_batch_at).filter(Boolean).sort().pop()
  if (lastAcctInvite && minutesSince(lastAcctInvite) < ACCOUNT_INVITE_FLOOR_MIN) {
    return { skipped: true, reason: 'account_invite_floor_not_met', minsSince: Math.floor(minutesSince(lastAcctInvite)), floorMin: ACCOUNT_INVITE_FLOOR_MIN }
  }

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
    // (06-jul) limit 10→100: el whitelist se filtra EN MEMORIA después del fetch, así que un
    // limit chico dejaba fuera de la ventana a ejecutivos válidos cuando el junk (más nuevo)
    // copaba el top. El pool 'scraped' es <50 por diseño + el reaper lo mantiene chico → 100
    // trae el pool completo y el filtro siempre ve a los válidos. Fetch sigue barato.
    .limit(100)

  if (!candidates || candidates.length === 0) {
    return { skipped: true, reason: 'no_pending_leads' }
  }

  const whitelisted = candidates.filter(l =>
    passesTitleFilters(l.profile_data?.headline ?? '', campaign.title_whitelist, campaign.title_blacklist)
  )
  if (whitelisted.length === 0) {
    return { skipped: true, reason: 'no_leads_pass_whitelist', candidatesChecked: candidates.length }
  }

  // Fase 2 (27-jul): ordenar por PESO DE RESPONSABILIDAD antes de elegir. El whitelist
  // es plano (pasa/no pasa) → un Coordinador de Compras competía de igual a igual con el
  // Director General y, como el desempate era FIFO, el ejecutivo top esperaba días
  // (caso Josh 06-jul). Ahora: rank desc, y dentro del mismo rank se conserva el orden
  // FIFO del SELECT (sort estable) para no romper la equidad ni el cooldown.
  // Se mantiene el pick aleatorio para humanizar, pero sobre el top 3 ya rankeado.
  // 31-jul: en una campaña con lista de empresas, el lead que VIENE de la lista gana
  // SIEMPRE al del pool genérico viejo, aunque el viejo sea un CEO. El cliente paga por
  // que abordemos SU lista; un "President of Builds and Buys" que entró por una búsqueda
  // por título de hace semanas no puede quitarle el turno al Director de Estafeta.
  // Dentro de cada grupo manda el peso de responsabilidad. Sin lista de empresas
  // configurada, fromList es false para todos y el orden queda idéntico al anterior.
  const listMode = Array.isArray(campaign.search_company_names)
    && campaign.search_company_names.filter(Boolean).length > 0
  const ranked = whitelisted
    .map(l => ({
      l,
      rank: seniorityRank(l.profile_data?.headline ?? ''),
      fromList: listMode && !!l.profile_data?.targetCompany,
    }))
    .sort((a, b) => (Number(b.fromList) - Number(a.fromList)) || (b.rank - a.rank))
  const pool = ranked.slice(0, 3)
  const pick = pool[Math.floor(Math.random() * pool.length)]
  const lead = pick.l

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
      capUsage: `${invitesToday + 1}/${cap}`,
      seniorityRank: pick.rank,
      fromTargetList: pick.fromList,
      company: lead.profile_data?.targetCompany ?? lead.profile_data?.currentCompany ?? null,
    },
  })

  return {
    dispatched: 1,
    commandId: cmdId,
    leadName: lead.full_name,
    withNote: !!message,
    capUsage: `${invitesToday + 1}/${cap}`,
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
  // La ruta viva NO extrae la empresa (currentCompany ~siempre null: 0/298 en Josh) y el headline
  // no la da de forma fiable (extraerla arriesga usar el CARGO como empresa, §7/§10). Sin dato →
  // "tu empresa" (encaja en "aplica para tu empresa?", "crecimiento de tu empresa?", etc.) en vez
  // de dejar {empresa}→"" que producía "para ?". || (no ??) para atrapar también string vacío.
  const company = (lead.profile_data?.currentCompany || lead.profile_data?.company || '').trim() || 'tu empresa'
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

// v0.8 FU dinámico: la secuencia de follow-ups ya no está hardcodeada a 5 pasos.
// Cada campaña define 1..20 pasos en la tabla campaign_followups. El "paso" en el
// que va un lead se lleva en leads.followup_step (contador), NO en el status —
// todos los leads en cadena de FU comparten el status genérico 'follow_up_sent'.
//   próximo paso a enviar = followup_step + 1
//   prevTime = followup_step === 0 ? connected_at : last_followup_at
export async function loadFollowupSteps(campaignId) {
  const { data, error } = await supabase
    .from('campaign_followups')
    .select('step, message, delay_value, delay_unit, jitter_hours, enabled')
    .eq('campaign_id', campaignId)
    .eq('enabled', true)
    .order('step', { ascending: true })
  if (error) {
    console.error(`[SCH-EXT] loadFollowupSteps failed campaign=${campaignId?.slice(0,8)}: ${error.message}`)
    return []
  }
  return data ?? []
}

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

// v0.8 (2026-07-04): leads 'replied' rancios → dead. Un lead que respondió pero lleva N días
// sin nuevo inbound quedaba en LIMBO: auto-reply lo ignora (safety gate fm_max_age=7d) y ningún
// sweep lo tocaba (auto_dead_after_days corre DENTRO del flujo FU, y 'replied' está en
// FU_DISPATCH_EXCLUDED_STATUSES → nunca entra). Se acumulaban indefinidamente (caso Tech de Wal:
// 60+ replied rancios). replied_at se REFRESCA en cada inbound nuevo (extension-bridge.js) → un
// lead en conversación activa nunca envejece; solo los genuinamente callados cruzan el umbral.
// Espejo de sweepAwaitingResponseTimeout. Configurable via env, default 21d.
const REPLIED_STALE_KILL_DAYS = parseInt(process.env.REPLIED_STALE_KILL_DAYS ?? '21')

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

// v0.8 (2026-07-04): reaper de leads 'replied' rancios (ver REPLIED_STALE_KILL_DAYS).
// Excluye automation_paused=true (respeta holds manuales: un lead que respondió y un humano
// pausó a propósito NO debe morir por timeout). Barato, indexado, idempotente (al morir sale
// del filtro). dead_reason auditable y revivible desde el CRM.
async function sweepRepliedTimeout() {
  const cutoffIso = new Date(Date.now() - REPLIED_STALE_KILL_DAYS * 86_400_000).toISOString()
  const { data: stale, error } = await supabase
    .from('leads')
    .select('id, full_name, replied_at')
    .eq('status', 'replied')
    .eq('automation_paused', false)
    .lt('replied_at', cutoffIso)
    .limit(200)
  if (error) {
    console.error(`[SCH-EXT] sweepReplied query failed:`, error.message)
    return { swept: 0 }
  }
  if (!stale || stale.length === 0) return { swept: 0 }
  let swept = 0
  for (const lead of stale) {
    const { error: updErr } = await supabase.from('leads').update({
      status: 'dead',
      dead_reason: `replied_no_action_${REPLIED_STALE_KILL_DAYS}d`,
    }).eq('id', lead.id)
    if (updErr) {
      console.error(`[SCH-EXT] sweepReplied update lead ${lead.id.slice(0,8)} failed:`, updErr.message)
      continue
    }
    swept++
    console.log(`[SCH-EXT] 💀 replied → dead: ${lead.full_name || lead.id.slice(0,8)} (${REPLIED_STALE_KILL_DAYS}d sin nuevo inbound)`)
  }
  return { swept }
}

export async function tryFollowupsForCampaign(campaign, account) {
  if (campaign.follow_up_paused) {
    return { skipped: true, reason: 'follow_up_paused' }
  }

  // Cap diario de mensajes (FU+FM combinado) — protege contra blasts
  // v0.7.47: override per-account (account_config.max_daily_messages) > env MAX_DAILY_MESSAGES.
  const maxMsgs = await readRuntimeNumber('max_daily_messages', MAX_DAILY_MESSAGES, account.id)
  const todayActivity = await getDailyActivityToday(account.id, account.timezone)
  const msgsToday = todayActivity.messages_sent ?? 0
  if (msgsToday >= maxMsgs) {
    return { skipped: true, reason: 'daily_messages_cap_reached', msgsToday, cap: maxMsgs }
  }

  // (2026-07-04) FU1 = PRIMER toque a una conexión nueva = lo MÁS valioso; NO debe starve
  // detrás de FUs avanzados (era el bug de Josh: recién-conectados sin FU1 por días porque el
  // motor priorizaba pasos altos + cap diario). → FU1 va PRIMERO; el resto (FU2+) de mayor a
  // menor (leads más profundos, más cerca de meeting) con shuffle ligero anti-pattern. Como los
  // leads FU1-due son pocos (conexiones nuevas/día) y el cap diario limita el total, esto NO
  // starve a los avanzados: FU1 consume unos pocos slots y el resto queda para FU2+.
  const fuSteps = await loadFollowupSteps(campaign.id)
  if (fuSteps.length === 0) return { skipped: true, reason: 'no_followup_steps_configured' }
  const step1 = fuSteps.find(s => s.step === 1)
  const rest = fuSteps.filter(s => s.step !== 1).reverse()
  if (Math.random() < 0.3) {  // 30% de ticks: shuffle del resto (anti-pattern detection)
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[rest[i], rest[j]] = [rest[j], rest[i]]
    }
  }
  const stepsOrdered = step1 ? [step1, ...rest] : rest

  for (const step of stepsOrdered) {
    const stepNum = step.step
    const statusFromArr = stepNum === 1 ? ['connected'] : ['follow_up_sent']
    const prevTimeField = stepNum === 1 ? 'connected_at' : 'last_followup_at'
    const template = step.message
    const hasAiFallback = !!campaign.gemini_system_prompt &&
                          campaign.gemini_system_prompt.trim().length > 20
    if (!template && !hasAiFallback) continue  // ni template ni gemini prompt → skip

    // Delay y unidad vienen de la fila de campaign_followups (días u horas).
    const delay = step.delay_value
    const effectiveUnit = step.delay_unit
    if (!delay && delay !== 0) continue  // sin delay = step deshabilitado

    // ¿Cuánto tiempo desde el último step para este lead?
    const baseCutoffMs = effectiveUnit === 'days' ? delay * 86_400_000 : delay * 3_600_000
    // Jitter per-lead: usamos hash de lead.id para tener delay consistente por lead
    // pero distribuido aleatoriamente para no levantar bandera en LinkedIn por uniformidad
    // v0.7.16: jitter por step. step1 usa campaign.follow_up_jitter_hours (legacy).
    // step2-5 ahora aplican un % del delay base (jitter_pct_fu_delay desde
    // runtime_config, default 0.35). Evita ZERO jitter en FU2-5 sin schema change.
    const jitterPctFu = await readRuntimeNumber('jitter_pct_fu_delay', 0.35, account.id)
    const stepJitterHours = stepNum === 1
      ? (step.jitter_hours ?? 0)
      : Math.max(step.jitter_hours ?? 0, delay * jitterPctFu)
    const jitterHours = stepJitterHours
    const jitterMs = jitterHours * 3_600_000
    // Query usa el cutoff INFERIOR (más laxo) para traer candidates;
    // el filter individual por lead después aplica el jitter exacto
    const cutoffMs = baseCutoffMs - jitterMs
    const cutoffIso = new Date(Date.now() - cutoffMs).toISOString()

    // Safety gate: skip leads cuya prev step timestamp es muy antigua
    // (típicamente leads históricos de batches viejos). Por default 30 días.
    // Knob GLOBAL vía env FU_MAX_AGE_DAYS; no hay columna por-campaña (la lectura
    // campaign.fu_max_age_days era fantasma: la columna no existe → siempre undefined).
    const maxAgeDays = parseInt(process.env.FU_MAX_AGE_DAYS ?? '30')
    const tooOldIso = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString()

    // LEFT JOIN: traemos leads con O sin thread_id — para invites sin nota
    // el lead conectado NO tiene thread hasta que enviemos el primer mensaje.
    // Sub-Fase 3.8: content.js maneja ambos casos (compose-new desde perfil
    // si no hay thread, o reply en thread si existe).
    // v0.7.8: defensa adicional — aunque .in('status', statusFromArr) ya excluye
    // awaiting_response por construcción (no aparece en ningún statusFrom), añadimos
    // un guard explícito por si la derivación de statusFromArr mete un status erróneo.
    const safeStatusFrom = statusFromArr.filter(s => !FU_DISPATCH_EXCLUDED_STATUSES.includes(s))
    if (safeStatusFrom.length === 0) continue
    const nowIsoForCooldown = new Date().toISOString()
    const { data: due } = await supabase
      .from('leads')
      .select(`id, full_name, linkedin_url, status, followup_step, profile_data, ${prevTimeField},
               consecutive_failures, cooldown_until, quarantined_at, last_attempt_at,
               lockout_skip_count,
               conversations(linkedin_thread_id, linkedin_account_id)`)
      .eq('campaign_id', campaign.id)
      .eq('followup_step', stepNum - 1)
      .in('status', safeStatusFrom)
      .eq('automation_paused', false)   // v0.8 pausa por contacto: excluir leads pausados manualmente
      .lt(prevTimeField, cutoffIso)
      .gte(prevTimeField, tooOldIso)
      .not('linkedin_url', 'is', null)  // necesitamos URL del perfil
      .is('quarantined_at', null)
      .or(`cooldown_until.is.null,cooldown_until.lt.${nowIsoForCooldown}`)
      // (2026-07-06) GAP-3 defensa-en-profundidad: excluye del despacho de FU cualquier lead
      // flagged detected_not_first_degree (2do-grado confirmado por un FU previo), aunque algún
      // detector le haya volteado el status a connected. null-safe (.neq es NULL para filas null,
      // por eso el .or con is.null). Neutraliza en el chokepoint cualquier fuga de accept-detection.
      .or('dead_reason.is.null,dead_reason.neq.detected_not_first_degree')
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
    const dueHumans = dueWithJitter.filter(l => !isSystemLinkedInAccount(l.full_name) && !isGroupConversationName(l.full_name))
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

    // v0.7.43: NO disparar FU si el contacto YA nos escribió y no le hemos respondido.
    // Caso "conecta + escribe primero": evita mandar el FU genérico ("un gusto conectar…")
    // por encima de un mensaje entrante real. Si el último evento de la conversación es
    // inbound, marcamos el lead 'replied' → el auto-reply lo contesta con contexto en vez
    // del FU canned. Cierra la ventana de carrera FU-vs-check_inbox (fail-open ante error).
    try {
      const { data: conv } = await supabase
        .from('conversations').select('id').eq('lead_id', lead.id).maybeSingle()
      if (conv?.id) {
        const { data: lastEv } = await supabase
          .from('conversation_events').select('direction')
          .eq('conversation_id', conv.id)
          .order('created_at', { ascending: false }).limit(1).maybeSingle()
        if (lastEv?.direction === 'inbound') {
          await supabase.from('leads')
            .update({ status: 'replied', replied_at: new Date().toISOString() })
            .eq('id', lead.id)
          console.log(`[SCH-EXT]   ⏭️  FU suprimido ${lead.full_name} — inbound sin contestar → status='replied' (auto-reply lo toma)`)
          continue
        }
      }
    } catch (e) {
      console.warn(`[SCH-EXT]   FU inbound-check falló para ${lead.full_name}: ${e.message} — continúo con FU`)
    }

    let message = null

    if (template && hasAiFallback) {
      // ★ MODO HÍBRIDO: template como intención + Gemini personaliza al lead
      const persRes = await personalizeFollowupMessage(
        campaign, lead, template, stepNum, account.cal_com_url ?? null,
        { toneDirective: campaign.followup_tone_directive ?? undefined }
      )
      if (persRes.error) {
        console.warn(`[SCH-EXT]   AI personalize failed (FU${stepNum}): ${persRes.error} — fallback a template literal`)
        message = substituteTemplate(template, lead, account)
      } else {
        message = persRes.message
      }
    } else if (template) {
      // Solo template, sin gemini_system_prompt → substitución literal
      message = substituteTemplate(template, lead, account)
    } else if (hasAiFallback) {
      // Solo AI, sin template → gen completo
      const aiRes = await generateLinkedInMessage(campaign, lead, `follow_up_${stepNum}`)
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
            details: { error: String(aiRes.error).slice(0, 500), step: stepNum, lead_name: lead.full_name },
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
      console.warn(`[SCH-EXT] 🚫 FU${stepNum} a ${lead.full_name} BLOQUEADO por placeholder sin resolver: ${message.match(/\[[^\]]*\]|\{[^}]*\}/)?.[0]?.slice(0,40)}`)
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
      console.log(`[SCH-EXT] DRY_RUN FU${stepNum} → "${lead.full_name}" (${navUrl}) thread=${!!threadId}`)
      return { dispatched: false, dryRun: true, step: stepNum }
    }

    // Content dedup: si ya enviamos este mismo texto a este lead en últimas 4h,
    // asume que la send pasada fue real y avanza status. Evita duplicados aún
    // si hasInFlightCommand no atajó (e.g., cmd completado pero ingest falló).
    if (await wasMessageRecentlySent(lead.id, message, 4)) {
      console.warn(`[SCH-EXT]   ⚠️  FU dedup: mensaje idéntico ya enviado a ${lead.full_name} en últimas 4h — forzando advance status`)
      await supabase.from('leads').update({
        status: 'follow_up_sent',
        followup_step: stepNum,
        last_followup_at: new Date().toISOString(),
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
        const deadCap = await readRuntimeNumber('dead_after_lockouts', 3, account.id)
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
        .eq('payload->>step', String(stepNum))
        .in('status', ['pending', 'dispatched', 'completed'])
        .gte('created_at', dedupCutoff)
      if ((dupCount ?? 0) > 0) {
        console.warn(`[SCH-EXT]   ⏭️  step-dedup ${lead.full_name} FU${stepNum} — ${dupCount}× cmds últimas 48h, skip`)
        continue
      }
    }

    const cmdId = await dispatchFollowup(account, lead, stepNum, message, threadUrl, profileUrl)
    if (!cmdId) continue

    await logJob({
      campaignId: campaign.id, accountId: account.id, jobType: `followup_${stepNum}`,
      status: 'dispatched',
      details: { commandId: cmdId, leadId: lead.id, step: stepNum, threadUrl },
    })

    return { dispatched: 1, step: stepNum, commandId: cmdId, leadName: lead.full_name }
  }

  return { skipped: true, reason: 'no_followups_due' }
}

// v0.8 — Guard anti-loop de auto-reply (caso Martina Meniconi / InMail Arbolus).
// Algunos "inbound" NO son respuestas humanas: InMails/notificaciones automáticas
// (ej "InMail Arbolus - Oportunidad...") y mensajes borrados se re-capturan en cada
// inbox check como un "reply" nuevo → el gate cree que hay algo sin contestar → manda
// otra respuesta → loop infinito (Martina recibió 25 msgs). Filtramos por CONTENIDO
// del último inbound + rompe-loops por conteo de outbound. Ver incident memory.
const AUTO_REPLY_LOOP_CAP = 8  // outbound máx a un hilo antes de declararlo loop y matar el lead

// 🚪 Cierre cortés cuando el sensor de salida detecta rechazo definitivo. FIJO a propósito:
// pedirle el cierre al LLM arriesga que re-pitchee a alguien que ya dijo que no.
// ponytail: constante global. Si una campaña lo necesita en otro idioma/tono → campaigns.exit_message.
const EXIT_MESSAGE = 'Te entiendo, y muchas gracias. Quedamos atentos a cualquier duda. ¡Saludos!'

function isDeletedInboundMessage(text) {
  const t = (text || '').toLowerCase()
  return t.includes('se ha eliminado este mensaje')
      || t.includes('mensaje eliminado')
      || t.includes('this message was deleted')
      || t.includes('message was deleted')
}

function isAutomatedInboundMessage(text) {
  const t = (text || '').trim()
  if (!t) return false
  // Solo si EMPIEZA con "InMail" (prefijo de notificación de LinkedIn). No matcheamos
  // "inmail" a media frase para no matar a un humano que escriba "vi tu InMail".
  if (/^inmail\b/i.test(t)) return true
  return false
}

// ── Auto-reply trigger (3.6) ─────────────────────────────────────────────────
// Cuando un lead responde, el ingest lo marca status='replied' y la cadena FU
// se pausa automáticamente (porque el motor de FU solo procesa status connected/follow_up_sent).
// Este trigger detecta esos replied y genera una respuesta AI personalizada.

async function tryAutoReplyForCampaign(campaign, account) {
  const mode = campaign.auto_reply_mode ?? 'manual'
  if (mode === 'off' || mode === 'manual') {
    return { skipped: true, reason: `auto_reply_mode_${mode}` }
  }

  // Cap diario de mensajes (FU+FM combinado)
  // v0.7.47: override per-account (account_config.max_daily_messages) > env MAX_DAILY_MESSAGES.
  const maxMsgs = await readRuntimeNumber('max_daily_messages', MAX_DAILY_MESSAGES, account.id)
  const todayActivity = await getDailyActivityToday(account.id, account.timezone)
  const msgsToday = todayActivity.messages_sent ?? 0
  if (msgsToday >= maxMsgs) {
    return { skipped: true, reason: 'daily_messages_cap_reached', msgsToday, cap: maxMsgs }
  }

  // Safety gate: solo procesar replies recientes — los históricos viejos
  // probablemente ya se respondieron manualmente o quedaron en olvido.
  // Knob GLOBAL vía env FM_MAX_AGE_DAYS; no hay columna por-campaña (la lectura
  // campaign.fm_max_age_days era fantasma: la columna no existe → siempre undefined).
  const maxAgeDays = parseInt(process.env.FM_MAX_AGE_DAYS ?? '7')
  const tooOldIso = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString()

  // Orden DESC (replies MÁS RECIENTES primero) — antes era ASC limit 5, lo que
  // procesaba los 5 más viejos (ya respondidos) y nunca llegaba a los nuevos.
  // Incluimos leads SIN thread_id: content.js hace compose-new desde el perfil.
  const nowIsoForCooldown = new Date().toISOString()
  const { data: replied } = await supabase
    .from('leads')
    .select(`id, full_name, replied_at, profile_data, linkedin_url, followup_step,
             consecutive_failures, cooldown_until, quarantined_at, last_attempt_at,
             conversations!inner(id, linkedin_thread_id, last_message_text, last_message_at, linkedin_account_id)`)
    .eq('campaign_id', campaign.id)
    .eq('conversations.linkedin_account_id', account.id)
    .eq('status', 'replied')
    .eq('automation_paused', false)   // v0.8 pausa por contacto: excluir leads pausados manualmente
    .gte('replied_at', tooOldIso)  // ★ safety: no procesar replies >7d
    .is('quarantined_at', null)
    .or(`cooldown_until.is.null,cooldown_until.lt.${nowIsoForCooldown}`)
    // (2026-07-06) GAP-3b: mismo guard fail-closed que el lane de FU. Un homónimo flagged
    // detected_not_first_degree que cae en 'replied' (fuzzy-match de un inbound ajeno) NO debe
    // recibir auto-reply hacia un contacto 2do-grado confirmado. null-safe (.neq es NULL para
    // filas null → se necesita el is.null). Backstop final del composer en la extensión aparte.
    .or('dead_reason.is.null,dead_reason.neq.detected_not_first_degree')
    // v0.8 P1 FIX: replied_at DESC PRIMARIO (replies más recientes = los sin-contestar).
    // Antes consecutive_failures/last_attempt_at dominaban → con backlog grande de
    // contestados (Wal: 61 replied/7d), el limit(10) devolvía solo CONTESTADOS y los
    // sin-contestar quedaban enterrados → gate 'no_replies_due' eterno → leads sin respuesta.
    // Límite 40 para cubrir el set reciente; el filtro in-memory descarta los ya contestados.
    .order('replied_at', { ascending: false })
    .order('consecutive_failures', { ascending: true })
    .limit(40)

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
  const repliedHumans = replied.filter(l => !isSystemLinkedInAccount(l.full_name) && !isGroupConversationName(l.full_name))
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
      .select('sent_at, content')   // content: contexto para el sensor de salida (¿el "no" es a qué?)
      .eq('conversation_id', conv.id)
      .eq('direction', 'outbound')
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const { data: lastInbound } = await supabase
      .from('conversation_events')
      .select('sent_at, content')
      .eq('conversation_id', conv.id)
      .eq('direction', 'inbound')
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const lastInboundAt = lastInbound?.sent_at ? new Date(lastInbound.sent_at).getTime() : 0
    const lastOutAt = lastOutbound?.sent_at ? new Date(lastOutbound.sent_at).getTime() : 0
    if (lastOutAt >= lastInboundAt) continue  // ya respondimos a este reply (>= por seguridad)

    // v0.8 FIX (Martina Meniconi): NO auto-responder a inbound AUTOMÁTICOS.
    const lastInText = (lastInbound?.content || '').trim()
    if (isDeletedInboundMessage(lastInText)) {
      console.log(`[SCH-EXT]   ⏭️  AI reply skip ${lead.full_name} — último inbound es mensaje borrado`)
      continue  // no respondemos a un borrado; no matamos el lead (puede reenviar)
    }
    if (isAutomatedInboundMessage(lastInText)) {
      await supabase.from('leads')
        .update({ status: 'dead', dead_reason: 'inbound_automated_inmail' })
        .eq('id', lead.id)
      console.log(`[SCH-EXT]   🚫 ${lead.full_name} → dead: inbound automático/InMail (no es respuesta humana)`)
      continue
    }
    // Rompe-loops de seguridad: un humano real no deja que le mandemos AUTO_REPLY_LOOP_CAP
    // respuestas a un mismo hilo sin avanzar. Si pasa, es un loop → matar el lead.
    const { count: convOutbound } = await supabase
      .from('conversation_events')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conv.id)
      .eq('direction', 'outbound')
    if ((convOutbound ?? 0) >= AUTO_REPLY_LOOP_CAP) {
      // PAUSAR (no matar): puede ser una conversación real atascada. Reversible y
      // visible en CRM (badge "AUTOMATIZACIÓN PAUSADA") para que el humano revise.
      await supabase.from('leads')
        .update({ automation_paused: true, automation_paused_at: new Date().toISOString() })
        .eq('id', lead.id)
      console.log(`[SCH-EXT]   🛑 ${lead.full_name} → automation_paused: auto-reply loop (${convOutbound} outbound a un hilo) — revisar en CRM`)
      continue
    }

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

    // Si hay thread_id → thread directo. Si NO (lead respondió a invite sin nota
    // y nunca capturamos thread) → pasar profileUrl: content.js navega al perfil,
    // abre compose y responde igual que el flujo FU compose-new.
    // (Resuelto ANTES del sensor de salida: el cierre cortés viaja por la misma ruta.)
    const threadUrl  = conv.linkedin_thread_id
      ? `https://www.linkedin.com/messaging/thread/${conv.linkedin_thread_id}/`
      : null
    const profileUrl = lead.linkedin_url ?? null
    if (!threadUrl && !profileUrl) {
      console.warn(`[SCH-EXT]   AI reply skip ${lead.full_name}: sin thread_id ni profileUrl`)
      continue
    }

    // 🚪 SENSOR DE SALIDA: si el lead cerró la puerta, NO le contestamos con un pitch.
    // Cierre cortés + fuera del pipeline. Corre aquí (tras el delay de humanización y el
    // dedup de cmd en vuelo) para gastar 1 sola clasificación cuando de verdad vamos a
    // escribir, y para cortocircuitar el fetch de historial + la generación del FM.
    const exitRes = await detectExitIntent(lastInText, lastOutbound?.content ?? '')
    if (exitRes.error) {
      // FAIL-OPEN: el LLM falló → seguimos al FM normal. Matar un lead vivo es peor.
      console.warn(`[SCH-EXT]   ⚠️  exit sensor falló (${lead.full_name}): ${exitRes.error} — sigo flujo normal`)
    } else if (exitRes.exit) {
      if (DRY_RUN) {
        console.log(`[SCH-EXT] DRY_RUN 🚪 EXIT → ${lead.full_name}: "${exitRes.reason}"`)
        return { dispatched: false, dryRun: true, exit: true, leadName: lead.full_name }
      }
      const exitCmdId = await dispatchCommand(account.id, 'send_followup', {
        threadUrl,
        profileUrl,
        leadId:   lead.id,
        leadName: lead.full_name,
        message:  EXIT_MESSAGE,
        step:       0,        // no es FU
        kind:       'reply',  // ingestSendFollowup NO toca leads.status → nuestro 'dead' sobrevive
        // …pero el upsert de conversations SÍ escribe status: sin esto, el ingest de ESTE mismo
        // mensaje pisaría el closed_lost con 'active' → el contacto que dijo "no" saldría verde
        // en el CRM. Que el ingest RE-AFIRME el cierre en vez de deshacerlo.
        convStatus: 'closed_lost',
        // TTL 10 min (no 3 como el FM): el FM reintenta el próximo tick porque el lead sigue
        // 'replied', pero el lead cerrado ya es 'dead' → nadie lo re-selecciona. Sin retry, el
        // comando debe ser el MÁS paciente, no el menos. El texto es constante: no caduca.
      }, { relatedLeadId: lead.id, expiresInMinutes: 10 })
      // Sin comando no marcamos nada: el próximo tick reintenta (el lead sigue 'replied').
      if (!exitCmdId) continue

      // Marcamos AL DESPACHAR (no al confirmar): si esperáramos al ingest, el próximo tick
      // re-clasificaría y re-despacharía → doble cierre. hasInFlightCommand cubre la ventana.
      const { error: exitLeadErr } = await supabase.from('leads').update({
        status:      'dead',
        dead_reason: 'not_interested',
      }).eq('id', lead.id)
      if (exitLeadErr) console.error(`[SCH-EXT] ❌ exit leads.update ${lead.id.slice(0,8)}: ${exitLeadErr.message}`)
      const { error: exitConvErr } = await supabase.from('conversations').update({ status: 'closed_lost' }).eq('id', conv.id)
      if (exitConvErr) console.error(`[SCH-EXT] ❌ exit conversations.update ${conv.id.slice(0,8)}: ${exitConvErr.message}`)

      console.log(`[SCH-EXT]   🚪 EXIT ${lead.full_name} → dead/not_interested + closed_lost — "${exitRes.reason}"`)
      return {
        dispatched: 1, exit: true, leadName: lead.full_name,
        commandId: exitCmdId, reason: exitRes.reason,
      }
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
    // v0.8 FU dinámico: el paso lo lleva lead.followup_step (contador), y el template
    // de ese paso vive en campaign_followups (no en columnas fijas de la campaña).
    const lastFuStepNum = lead.followup_step && lead.followup_step > 0 ? lead.followup_step : null
    let lastFuTemplate = null
    if (lastFuStepNum) {
      const fuSteps = await loadFollowupSteps(campaign.id)
      lastFuTemplate = fuSteps.find(s => s.step === lastFuStepNum)?.message ?? null
    }

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

// v0.7.45: deep sweep periódico para recuperar inbounds sepultados. Dispatcha un
// check_inbox con deepScrape (carga hasta 500 convos, scroll 30×) máx 1×/día por cuenta.
// Estado en runtime_config.deep_sweep_last (map accountId→iso). Devuelve true si dispatchó.
const DEEP_SWEEP_GAP_H = 20
async function maybeDispatchDeepSweep(account) {
  if (DRY_RUN) return false
  try {
    const { data: rc } = await supabase.from('runtime_config').select('value').eq('key', 'deep_sweep_last').maybeSingle()
    const map = (rc?.value && typeof rc.value === 'object') ? rc.value : {}
    const lastMs = map[account.id] ? new Date(map[account.id]).getTime() : 0
    // v0.7.47: gap per-account (account_config.deep_sweep_gap_h) > default 20h. Null-safe.
    const gapH = await readRuntimeNumber('deep_sweep_gap_h', DEEP_SWEEP_GAP_H, account.id)
    if (Date.now() - lastMs < gapH * 3_600_000) return false
    // no encolar si ya hay un check_inbox en vuelo (mismo guard que tryInboxForAccount)
    const { count } = await supabase.from('extension_commands')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', account.id).eq('action', 'check_inbox')
      .in('status', ['pending', 'dispatched']).gt('expires_at', new Date().toISOString())
    if (count > 0) return false
    const id = await dispatchCommand(account.id, 'check_inbox', {
      deepScrape: true, daysWindow: 30, captureThreads: true, maxCaptures: 20,
    }, { expiresInMinutes: 25 })
    if (!id) return false
    map[account.id] = new Date().toISOString()
    // v0.7.50 BUG FIX: runtime_config.updated_by es NOT NULL sin default. El upsert original
    // solo mandaba {key, value} → violaba el constraint → FALLABA SILENCIOSO (error no chequeado)
    // → el row deep_sweep_last NUNCA se creaba → lastMs=0 SIEMPRE → deep sweep en LOOP cada tick
    // → starvaba check_sent_invites (las aceptaciones no se detectaban → leads sin FU1).
    const { error: dsErr } = await supabase.from('runtime_config')
      .upsert({ key: 'deep_sweep_last', value: map, updated_by: 'scheduler:deep_sweep' }, { onConflict: 'key' })
    if (dsErr) { console.warn(`[SCH-EXT]   deep_sweep_last upsert falló: ${dsErr.message}`); return false }
    return true
  } catch (e) {
    console.warn(`[SCH-EXT]   deep sweep falló para ${account.label}: ${e.message}`)
    return false
  }
}

// ── Contact-info scrape (digest diario) ──────────────────────────────────────
// Visita el overlay /overlay/contact-info/ de leads YA conectados (1er grado) para
// capturar email/teléfono. Prioridad MÁS BAJA del loop per-account: solo corre si
// el tick no despachó nada más para la cuenta (la extensión serializa 1 comando).
// Anti-ban: 1 comando/tick, cap diario (default 20, override contact_info_daily_cap),
// dentro de inbox hours (gate del loop). Orden connected_at DESC → los accepts de
// ayer quedan scrapeados antes del digest de mañana; el backlog histórico drena solo.
// Un intento por lead: el bridge escribe contact_info (ok O {error}) → sale de la
// cola. Comando expirado (ext ausente) no escribe → retry natural.
async function tryContactInfoScrape(account) {
  if (DRY_RUN) return { skipped: true, reason: 'dry_run' }
  if (!meetsVersion(account.ext_version, CONTACT_INFO_MIN_VERSION)) {
    return { skipped: true, reason: 'ext_version' }  // silencioso: dispatchCommand ya alerta si se fuerza
  }
  try {
    // guard in-flight (mismo patrón que deep sweep)
    const { count: inFlight } = await supabase.from('extension_commands')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', account.id).eq('action', 'get_contact_info')
      .in('status', ['pending', 'dispatched']).gt('expires_at', new Date().toISOString())
    if (inFlight > 0) return { skipped: true, reason: 'in_flight' }

    // cap diario — ventana rodante de 24h (más simple que medianoche tz y equivalente como throttle)
    const cap = await readRuntimeNumber('contact_info_daily_cap', 20, account.id)
    const { count: today } = await supabase.from('extension_commands')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', account.id).eq('action', 'get_contact_info')
      .gt('created_at', new Date(Date.now() - 86_400_000).toISOString())
    if ((today ?? 0) >= cap) return { skipped: true, reason: 'daily_cap' }

    // elegible: lead conectado de esta cuenta sin contact_info (NULL = nunca visitado)
    const { data: lead } = await supabase.from('leads')
      .select('id, full_name, linkedin_url, campaigns!inner(linkedin_account_id)')
      .eq('campaigns.linkedin_account_id', account.id)
      .is('contact_info', null).not('connected_at', 'is', null)
      .not('linkedin_url', 'is', null)
      .order('connected_at', { ascending: false })
      .limit(1).maybeSingle()
    if (!lead) return { skipped: true, reason: 'no_candidates' }

    const cmdId = await dispatchCommand(account.id, 'get_contact_info',
      { profileUrl: lead.linkedin_url, leadId: lead.id },
      { relatedLeadId: lead.id, expiresInMinutes: 10 })
    if (!cmdId) return { skipped: true, reason: 'dispatch_failed' }
    return { dispatched: true, leadName: lead.full_name }
  } catch (e) {
    console.warn(`[SCH-EXT]   contact-info scrape falló para ${account.label}: ${e.message}`)
    return { skipped: true, reason: e.message }
  }
}

// ── Retiro de invitaciones viejas VÍA PERFIL (v0.10.23) ──────────────────────
// Higiene anti-límite-semanal: un backlog grande de pending (Josh: 492 el 13-ago-2026)
// endurece los límites de invitación de LinkedIn. Candidatos = leads DB en invite_sent
// con sent_at >30d (no se scrapea la lista /sent/ — su anchor Retirar checa isTrusted).
// 1 lead por tick, cap 15/día por cuenta (ventana 24h), última prioridad del loop.
// El bridge marca los retirados dead(invite_withdrawn) — LinkedIn bloquea re-invitar
// al mismo perfil ~3 semanas tras retirar, NUNCA regresarlos a scraped. Errores
// (pending_button_not_found etc.) ponen cooldown_until +7d para no reintentar en loop.
const WITHDRAW_MIN_AGE_DAYS = 30
const WITHDRAW_DAILY_CAP = 15

async function tryWithdrawOldInvites(account) {
  if (DRY_RUN) return { skipped: true, reason: 'dry_run' }
  if (!meetsVersion(account.ext_version, WITHDRAW_INVITES_MIN_VERSION)) {
    return { skipped: true, reason: 'ext_version' }  // silencioso, igual que contact-info
  }
  try {
    // cap diario — ventana rodante 24h (mismo patrón que contact-info)
    const { count: today } = await supabase.from('extension_commands')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', account.id).eq('action', 'withdraw_invite_profile')
      .gt('created_at', new Date(Date.now() - 86_400_000).toISOString())
    if ((today ?? 0) >= WITHDRAW_DAILY_CAP) return { skipped: true, reason: 'daily_cap' }

    // in-flight guard
    const { count: inFlight } = await supabase.from('extension_commands')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', account.id).eq('action', 'withdraw_invite_profile')
      .in('status', ['pending', 'dispatched']).gt('expires_at', new Date().toISOString())
    if (inFlight > 0) return { skipped: true, reason: 'in_flight' }

    // lead elegible: invite viejo, sin cooldown (los errores de retiro ponen +7d)
    const cutoff = new Date(Date.now() - WITHDRAW_MIN_AGE_DAYS * 86_400_000).toISOString()
    const { data: lead } = await supabase.from('leads')
      .select('id, full_name, linkedin_url, sent_at, campaigns!inner(linkedin_account_id)')
      .eq('campaigns.linkedin_account_id', account.id)
      .eq('status', 'invite_sent')
      .lt('sent_at', cutoff)
      .not('linkedin_url', 'is', null)
      .or(`cooldown_until.is.null,cooldown_until.lt.${new Date().toISOString()}`)
      .order('sent_at', { ascending: true })
      .limit(1).maybeSingle()
    if (!lead) return { skipped: true, reason: 'no_candidates' }

    const cmdId = await dispatchCommand(account.id, 'withdraw_invite_profile',
      { profileUrl: lead.linkedin_url, leadId: lead.id },
      { relatedLeadId: lead.id, expiresInMinutes: 10 })
    if (!cmdId) return { skipped: true, reason: 'dispatch_failed' }
    return { dispatched: true, leadName: lead.full_name }
  } catch (e) {
    console.warn(`[SCH-EXT]   withdraw_invite_profile falló para ${account.label}: ${e.message}`)
    return { skipped: true, reason: e.message }
  }
}

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

  // v0.7.45: no encolar un check_inbox nuevo si ya hay uno EN VUELO (pending/dispatched
  // sin expirar). Antes, si la cuenta se desconectaba tras el dispatch, el comando quedaba
  // en cola; al cumplirse el gap se encolaba OTRO → ambos expiraban (expired_in_queue, el
  // #1 error de check_inbox: 59/7d). Con el guard esperamos a que el previo resuelva/expire.
  const { count: inboxInFlight } = await supabase
    .from('extension_commands')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', account.id)
    .eq('action', 'check_inbox')
    .in('status', ['pending', 'dispatched'])
    .gt('expires_at', new Date().toISOString())
  if (inboxInFlight > 0) {
    return { skipped: true, reason: 'check_inbox_already_in_flight' }
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

// (2026-07-04) Accept-detection POSITIVA (backstop): scrapea la lista de conexiones y marca
// connected por PRESENCIA. Cierra las zonas ciegas de check_sent_invites (que infiere por ausencia).
async function tryCheckConnectionsForAccount(account) {
  const gapMin = CONNECTIONS_CHECK_GAP_MIN
  const minsSince = minutesSince(account.last_connections_check_at)
  if (minsSince < gapMin) {
    return { skipped: true, reason: 'connections_gap_not_met', minsSince: Math.floor(minsSince), gapMin }
  }
  if (DRY_RUN) {
    console.log(`[SCH-EXT] DRY_RUN check_connections for ${account.label}`)
    return { dispatched: false, dryRun: true }
  }
  const cmdId = await dispatchCheckConnections(account)
  if (!cmdId) return { skipped: true, reason: 'dispatch_failed' }
  await supabase.from('linkedin_accounts')
    .update({ last_connections_check_at: new Date().toISOString() })
    .eq('id', account.id)
  await logJob({
    accountId: account.id, jobType: 'check_connections',
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

    // v0.8 (2026-07-04): ventana "debería estar online" POR CUENTA = unión de los schedules de
    // sus campañas activas (min start, max end, unión de días). Antes 6-21/7d hardcodeado para
    // TODAS; ahora respeta el horario real de cada cuenta (p.ej. Wal 8-22). Fallback 6-21/7d si
    // la cuenta no tiene campañas activas con schedule.
    const { data: schedRows } = await supabase
      .from('campaigns')
      .select('linkedin_account_id, schedule_start_hour, schedule_end_hour, schedule_days')
      .eq('is_active', true)
    const schedByAccount = new Map()
    for (const r of (schedRows ?? [])) {
      const cur = schedByAccount.get(r.linkedin_account_id) ?? { start: null, end: null, days: new Set() }
      if (r.schedule_start_hour != null) cur.start = cur.start == null ? r.schedule_start_hour : Math.min(cur.start, r.schedule_start_hour)
      if (r.schedule_end_hour != null)   cur.end   = cur.end   == null ? r.schedule_end_hour   : Math.max(cur.end,   r.schedule_end_hour)
      for (const d of (r.schedule_days ?? [])) cur.days.add(d)
      schedByAccount.set(r.linkedin_account_id, cur)
    }

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
      // Check "debería estar online" en TZ del usuario.
      // v0.8 FIX: antes isBusinessHours(9,19,undefined) → días default lun-vie + ventana
      // 9-19 → NO alertaba offline en SÁBADO/DOMINGO ni 6-9/19-21, aunque las cuentas
      // ahora corren 6-21h LOS 7 DÍAS (el gate de dispatch sí usa campaign.schedule_days).
      // Resultado: si el Chrome del cliente moría un finde, nadie se enteraba. Ampliado a
      // 7 días + 6-21h para que la caída SÍ genere ext_offline_business_hours (debounce 60min).
      const tz = acc.timezone ?? 'America/Mexico_City'
      const ALL_DAYS_7 = ['lunes','martes','miércoles','jueves','viernes','sábado','domingo']
      const _sch = schedByAccount.get(acc.id)
      const _startH = _sch?.start ?? 6
      const _endH   = _sch?.end   ?? 21
      const _days   = (_sch && _sch.days.size > 0) ? [..._sch.days] : ALL_DAYS_7
      const inBH = isBusinessHours(_startH, _endH, _days, tz)
      if (!inBH) continue

      // ── Detector de CONEXIÓN INESTABLE (infiere background mode OFF) ──
      // No hay API para leer chrome://settings/system, pero SÍ podemos inferir:
      // muchos disconnects en pocas horas = SW muriéndose = background mode off.
      // Umbral: ≥4 disconnects en 6h. Debounce alerta 3h.
      const lastUnstable = _lastUnstableAlert.get(acc.id) ?? 0
      if (Date.now() - lastUnstable > 3 * 60 * 60_000) {
        const since6h = new Date(Date.now() - 6 * 3600_000).toISOString()
        // v0.7.46: contar solo desconexiones REALES (gap >90s antes de reconectar), NO el
        // micro-churn de MV3 (el SW muere a 30s idle y revive en 1-2s — normal, no es falla).
        // Antes contaba TODO disconnect → daba un diagnóstico falso de "background mode off"
        // aunque estuviera ON (mediana de reconexión real: 2s = puro churn). El ping de 20s
        // del bridge ya previene ese churn; aquí solo alertamos de outages genuinos.
        const { data: cevents } = await supabase
          .from('account_connectivity_log')
          .select('event_type, created_at')
          .eq('linkedin_account_id', acc.id)
          .in('event_type', ['disconnected', 'connected'])
          .gte('created_at', since6h)
          .order('created_at', { ascending: true })
        let sustained = 0, lastDisc = null
        for (const e of (cevents ?? [])) {
          const t = new Date(e.created_at).getTime()
          if (e.event_type === 'disconnected') lastDisc = t
          else if (e.event_type === 'connected' && lastDisc != null) {
            if (t - lastDisc > 90_000) sustained++   // outage real >90s (no micro-churn)
            lastDisc = null
          }
        }
        // disconnect colgado sin reconectar hace >90s también cuenta
        if (lastDisc != null && Date.now() - lastDisc > 90_000) sustained++

        if (sustained < 4) {
          // Estable (o solo micro-churn) → resolver cualquier connection_unstable abierta
          await supabase.from('account_alerts')
            .update({ resolved_at: new Date().toISOString(), resolved_by: 'auto:connection_stable_again' })
            .eq('linkedin_account_id', acc.id)
            .eq('alert_type', 'connection_unstable')
            .is('resolved_at', null)
        }
        if (sustained >= 4) {
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
            message: `🔌 Extension de "${acc.label}" tuvo ${sustained} desconexiones REALES (>90s) en 6h. Posibles causas: laptop suspendiéndose, red inestable, o Chrome cerrándose. (El micro-churn normal del SW ya no se cuenta.)`,
            details: { sustained_outages_6h: sustained, note: 'solo cuenta gaps >90s, no micro-churn MV3' },
          })
          console.log(`[SCH-EXT] 🔌 ${acc.label}: ${sustained} desconexiones reales (>90s) /6h`)
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
        details:             { tz, business_hours: '6-21' },
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
        message:    `⚠️ Extension de "${acc.label}" no conectada durante horario laboral (${tz}, 6-21h, 7 días). Abre Chrome y haz click en la extensión.`,
        details:    { tz },
      })
      console.log(`[SCH-EXT] ⚠️  Health check: ${acc.label} offline durante BH (${tz})`)
    }
  } catch (err) {
    console.warn('[SCH-EXT] runConnectivityHealthCheck error:', err.message)
  }
}

// ── Post-Prospecting (v0.9) ───────────────────────────────────────────────────
// Agente nuevo: busca POSTS donde alguien pide un servicio, califica con IA,
// redacta un comentario value-first, y tras aprobación humana lo publica + conecta.
// Tres pasos por tick (espejo de search / invites): buscar, calificar, comentar.

// Cuántas oportunidades 'scraped' califica por tick por campaña. Cada una son ~2
// llamadas Gemini (qualify + comment) con timeout propio de 30s — capamos bajo
// para no acercarnos al soft-timeout del tick (120s).
const POST_QUALIFY_BATCH = parseInt(process.env.POST_QUALIFY_BATCH ?? '2')
// Enriquecimiento de empresa (currentCompany) desde headline vía LLM, por tick. Lote pequeño:
// max_tokens=300 en la ruta JSON → ~16 items caben; 10 es seguro contra truncación.
const COMPANY_ENRICH_BATCH = parseInt(process.env.COMPANY_ENRICH_BATCH ?? '10')

async function tryPostSearchForCampaign(postCampaign, account) {
  if (postCampaign.post_search_paused) {
    return { skipped: true, reason: 'post_search_paused' }
  }

  // Reabastecer por CONTEO de oportunidades aún sin procesar (scraped) o esperando
  // revisión (pending_review). Si hay suficientes, no buscamos más (no saturar la cola).
  const { count: pendingCount } = await supabase
    .from('post_opportunities')
    .select('id', { count: 'exact', head: true })
    .eq('post_campaign_id', postCampaign.id)
    .in('status', ['scraped', 'qualifying', 'pending_review'])
  const minPending = postCampaign.min_pending_threshold ?? 8
  if ((pendingCount ?? 0) >= minPending) {
    return { skipped: true, reason: 'enough_pending_opportunities', pendingCount, minPending }
  }

  const searchGapHours = postCampaign.search_gap_hours ?? 12
  const minsSince = minutesSince(postCampaign.last_searched_at)
  if (minsSince < searchGapHours * 60) {
    return { skipped: true, reason: 'post_search_gap_not_met', minsSince: Math.floor(minsSince) }
  }

  const kws = postCampaign.post_keywords ?? []
  if (kws.length === 0) {
    return { skipped: true, reason: 'no_post_keywords' }
  }
  const idx = (postCampaign.last_search_keyword_idx ?? 0) % kws.length
  const keyword = kws[idx]
  const nextIdx = (idx + 1) % kws.length

  if (DRY_RUN) {
    console.log(`[SCH-EXT] DRY_RUN post_search "${postCampaign.name}" keyword="${keyword}"`)
    return { dispatched: false, dryRun: true, keyword }
  }

  const cmdId = await dispatchPostSearch(account, postCampaign, keyword)
  if (!cmdId) return { skipped: true, reason: 'dispatch_failed' }

  await supabase.from('post_campaigns')
    .update({ last_searched_at: new Date().toISOString(), last_search_keyword_idx: nextIdx })
    .eq('id', postCampaign.id)

  await logJob({
    campaignId: postCampaign.shadow_campaign_id ?? null, accountId: account.id, jobType: 'post_search',
    status: 'dispatched',
    details: { commandId: cmdId, keyword, postCampaignId: postCampaign.id, pendingBefore: pendingCount ?? 0 },
  })
  return { dispatched: true, commandId: cmdId, keyword }
}

// Califica oportunidades 'scraped' con IA y redacta el comentario value-first.
// Las que pasan el umbral → pending_review (esperan aprobación humana); las que no
// → disqualified. Corre en el scheduler (no en el WS handler del bridge) para no
// bloquear el dispatch de otros comandos.
async function tryQualifyPostOpportunities(postCampaign) {
  const { data: opps } = await supabase
    .from('post_opportunities')
    .select('id, post_text, author_name, author_headline')
    .eq('post_campaign_id', postCampaign.id)
    .eq('status', 'scraped')
    .order('created_at', { ascending: true })
    .limit(POST_QUALIFY_BATCH)
  if (!opps || opps.length === 0) return { qualified: 0 }

  const minScore = postCampaign.qualify_min_score ?? 6
  let qualified = 0, disqualified = 0, errored = 0
  for (const opp of opps) {
    // Lock optimista: marca 'qualifying' para que un tick concurrente no la re-tome.
    await supabase.from('post_opportunities').update({ status: 'qualifying' }).eq('id', opp.id)

    const q = await qualifyPost(opp.post_text, postCampaign.service_description)
    if (q.error) {
      errored++
      // Devolver a 'scraped' para reintentar en otro tick.
      await supabase.from('post_opportunities').update({ status: 'scraped' }).eq('id', opp.id)
      continue
    }
    if (!q.relevant || q.score < minScore) {
      disqualified++
      await supabase.from('post_opportunities').update({
        status: 'disqualified',
        qualify_relevant: q.relevant, qualify_score: q.score, qualify_reason: q.reason,
        updated_at: new Date().toISOString(),
      }).eq('id', opp.id)
      continue
    }

    // Relevante → redactar comentario value-first (NUNCA recibe el pitch_note).
    const c = await generatePostComment(opp, postCampaign)
    if (c.error || !c.message) {
      errored++
      await supabase.from('post_opportunities').update({ status: 'scraped' }).eq('id', opp.id)
      continue
    }
    qualified++
    await supabase.from('post_opportunities').update({
      status: 'pending_review',
      qualify_relevant: true, qualify_score: q.score, qualify_reason: q.reason,
      draft_comment: c.message,
      updated_at: new Date().toISOString(),
    }).eq('id', opp.id)
  }
  return { qualified, disqualified, errored }
}

// (2026) Enriquece profile_data.currentCompany extrayendo la empresa del headline con el LLM.
// Global (no requiere extensión conectada; solo headline + LLM). El centinela '' = "revisado, sin
// empresa": sale del set de candidatos (query pide currentCompany IS NULL) Y ya renderiza como
// "tu empresa" en substituteTemplate. Self-draining, idempotente. Corre en el scheduler (no en la
// ingesta) para no bloquear el WS handler y poder reintentar en el próximo tick si el LLM falla.
async function tryEnrichCompanies() {
  const { data: leads } = await supabase
    .from('leads')
    .select('id, profile_data')
    .filter('profile_data->>headline', 'not.is', null)         // headline presente
    .filter('profile_data->>currentCompany', 'is', null)       // '' (centinela) NO es null → excluido
    .limit(COMPANY_ENRICH_BATCH)
  // Defensa: solo los que REALMENTE faltan empresa (por si el filtro JSON deja pasar algo)
  const todo = (leads ?? []).filter(l => l.profile_data?.headline && l.profile_data?.currentCompany == null)
  if (todo.length === 0) return { enriched: 0 }

  const out = await extractCompaniesFromHeadlines(todo.map(l => ({ key: l.id, headline: l.profile_data.headline })))
  if (out.error) return { error: out.error }   // reintenta próximo tick, sin escribir centinela

  let withCompany = 0
  for (const { key, company } of out) {
    const lead = todo.find(l => l.id === key)
    if (!lead) continue
    // ponytail: read-modify-write del blob profile_data; leads recién scrapeados sin escritores
    // concurrentes de este campo + ticks en serie (watchdog anti-solape) → sin lock.
    const { error } = await supabase.from('leads')
      .update({ profile_data: { ...lead.profile_data, currentCompany: company ?? '' } })
      .eq('id', key)
    if (!error && company) withCompany++
  }
  return { enriched: todo.length, withCompany }
}

// Despacha el comentario de UNA oportunidad aprobada por el humano (1 por tick).
// El connect NO se dispara aquí — se encadena desde ingestCommentPosted al confirmarse
// el comentario, garantizando el orden comenta → conecta.
async function tryPostCommentsForCampaign(postCampaign, account) {
  // Cap diario de comentarios (separado del de invites) + warmup.
  const cap = getEffectiveCommentCap(account, postCampaign)
  const commentsToday = await getDailyCommentsToday(account.id, account.timezone)
  if (commentsToday >= cap) {
    return { skipped: true, reason: 'daily_comment_cap_reached', commentsToday, cap }
  }

  // Gap dinámico entre comentarios (reparte el cap en la ventana activa) + jitter ±15%,
  // con piso anti-ban. min_comment_gap_min > 0 = override manual.
  const ANTIBAN_FLOOR_MIN = 30
  let baseGapMin
  if (postCampaign.min_comment_gap_min > 0) {
    baseGapMin = Math.max(ANTIBAN_FLOOR_MIN, postCampaign.min_comment_gap_min)
  } else {
    const windowMin = Math.max(60, ((postCampaign.schedule_end_hour ?? 19) - (postCampaign.schedule_start_hour ?? 9)) * 60)
    baseGapMin = Math.max(ANTIBAN_FLOOR_MIN, Math.round(windowMin / Math.max(1, cap)))
  }
  const gapMin = Math.max(ANTIBAN_FLOOR_MIN, Math.round(baseGapMin * (0.85 + Math.random() * 0.30)))
  const minsSince = minutesSince(postCampaign.last_commented_at)
  if (minsSince < gapMin) {
    return { skipped: true, reason: 'comment_gap_not_met', minsSince: Math.floor(minsSince), gapMin }
  }

  const { data: opps } = await supabase
    .from('post_opportunities')
    .select('id, post_permalink, post_urn, draft_comment, edited_comment')
    .eq('post_campaign_id', postCampaign.id)
    .eq('status', 'approved')
    .order('approved_at', { ascending: true })
    .limit(1)
  if (!opps || opps.length === 0) {
    return { skipped: true, reason: 'no_approved_opportunities' }
  }
  const opp = opps[0]

  if (DRY_RUN) {
    console.log(`[SCH-EXT] DRY_RUN comment_on_post opp=${opp.id.slice(0,8)} "${(opp.edited_comment ?? opp.draft_comment ?? '').slice(0,60)}"`)
    return { dispatched: false, dryRun: true, opportunityId: opp.id }
  }

  const cmdId = await dispatchCommentOnPost(account, opp)
  if (!cmdId) return { skipped: true, reason: 'dispatch_failed' }

  await supabase.from('post_opportunities')
    .update({ status: 'dispatched', command_id: cmdId, updated_at: new Date().toISOString() })
    .eq('id', opp.id)
  await supabase.from('post_campaigns')
    .update({ last_commented_at: new Date().toISOString() })
    .eq('id', postCampaign.id)

  await logJob({
    campaignId: postCampaign.shadow_campaign_id ?? null, accountId: account.id, jobType: 'post_comment',
    status: 'dispatched',
    details: { commandId: cmdId, opportunityId: opp.id, postCampaignId: postCampaign.id, capUsage: `${commentsToday + 1}/${cap}` },
  })
  return { dispatched: 1, commandId: cmdId, opportunityId: opp.id, capUsage: `${commentsToday + 1}/${cap}` }
}

// Carga post-campañas activas con su cuenta joineada. Devuelve [] si la tabla no
// existe aún (migración pendiente) — el agente queda inerte sin romper el tick.
async function loadActivePostCampaigns() {
  const { data, error } = await supabase
    .from('post_campaigns')
    .select(`
      id, name, is_active, post_search_paused, shadow_campaign_id,
      linkedin_account_id,
      post_keywords, post_recency,
      service_description, comment_rules, pitch_note, gemini_system_prompt, qualify_min_score,
      daily_comment_target, min_comment_gap_min, search_gap_hours, min_pending_threshold,
      schedule_start_hour, schedule_end_hour, schedule_days,
      last_searched_at, last_commented_at, last_search_keyword_idx,
      linkedin_accounts (
        id, label, status, warmup_status, warmup_started_at,
        extension_paused, extension_paused_reason, extension_paused_until, timezone, cal_com_url,
        extension_last_seen_at, search_mode
      )
    `)
    .eq('is_active', true)
  if (error) {
    // 42P01 = tabla inexistente. Cualquier error → loguea y sigue (no rompe el tick).
    if (!/relation .* does not exist|42P01/i.test(error.message ?? '')) {
      console.error(`[SCH-EXT] loadActivePostCampaigns error: ${error.message}`)
    }
    return []
  }
  return data ?? []
}

async function runPostCampaigns(connectedIds, stressLockedAccount) {
  const postCampaigns = await loadActivePostCampaigns()
  if (postCampaigns.length === 0) return
  console.log(`[SCH-EXT] ${postCampaigns.length} post-campañas activas`)

  for (const pc of postCampaigns) {
    const account = pc.linkedin_accounts
    if (!account) { console.log(`[SCH-EXT] Post-campaña "${pc.name}" sin cuenta — skip`); continue }
    if (!connectedIds.has(account.id)) continue
    if (account.id === stressLockedAccount) continue

    const skipReason = await checkPostCampaignActiveGates(pc, account)
    if (skipReason) {
      const key = `post:${pc.id}`
      if (lastSkipReason.get(key) !== skipReason) {
        lastSkipReason.set(key, skipReason)
        console.log(`[SCH-EXT] post "${pc.name}" — gate skip: ${skipReason}`)
      }
      continue
    }
    lastSkipReason.delete(`post:${pc.id}`)

    console.log(`[SCH-EXT] ━━ 📝 "${pc.name}" (${account.label}) ━━`)

    const searchRes = await tryPostSearchForCampaign(pc, account)
    if (searchRes.dispatched) console.log(`[SCH-EXT]   ✅ post_search dispatched ("${searchRes.keyword}")`)
    else console.log(`[SCH-EXT]   ⏭️  post_search: ${searchRes.reason}`)

    try {
      const qRes = await tryQualifyPostOpportunities(pc)
      if (qRes.qualified || qRes.disqualified || qRes.errored) {
        console.log(`[SCH-EXT]   🧠 qualify: ${qRes.qualified} pending_review, ${qRes.disqualified} descartadas, ${qRes.errored} err`)
      }
    } catch (err) {
      console.error(`[SCH-EXT]   qualify threw: ${err.message}`)
    }

    const commentRes = await tryPostCommentsForCampaign(pc, account)
    if (commentRes.dispatched) console.log(`[SCH-EXT]   ✅ comment_on_post dispatched (${commentRes.capUsage})`)
    else console.log(`[SCH-EXT]   ⏭️  comments: ${commentRes.reason}`)

    await sleep(randInt(1000, 3000))
  }
}

// ── PUBLISH AGENT (v0.9): contenido diario en el perfil propio ───────────────
// Genera el COPY del post (Groq/Gemini) y lo deja como borrador pending_review
// para que el admin lo apruebe/edite en Orion. La imagen (fase B) y la
// publicación (manual o fase C) van aparte. 1 post/día por agente.
const PUB_DEFAULT_DAYS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes']

async function loadActivePublishAgents() {
  const { data, error } = await supabase
    .from('publish_agents')
    .select(`
      id, name, is_active, linkedin_account_id,
      business_context, ideas, tone, do_dont, gemini_system_prompt,
      schedule_start_hour, schedule_end_hour, schedule_days,
      last_generated_for_date, last_generated_at,
      linkedin_accounts ( id, label, status, timezone )
    `)
    .eq('is_active', true)
  if (error) {
    if (!/relation .* does not exist|42P01/i.test(error.message ?? '')) {
      console.error(`[SCH-EXT] loadActivePublishAgents error: ${error.message}`)
    }
    return []
  }
  return data ?? []
}

async function tryDailyGenerateForAgent(agent, account) {
  const tz = account?.timezone ?? 'America/Mexico_City'
  const today = mxDateStr(tz)

  if (agent.last_generated_for_date === today) return { skipped: true, reason: 'already_generated_today' }
  const days = (agent.schedule_days && agent.schedule_days.length) ? agent.schedule_days : PUB_DEFAULT_DAYS
  if (!isBusinessHours(agent.schedule_start_hour ?? 9, agent.schedule_end_hour ?? 19, days, tz)) {
    return { skipped: true, reason: 'outside_schedule' }
  }

  let gen
  try {
    gen = await generateDailyPost(agent)
  } catch (e) {
    return { skipped: true, reason: 'gen_failed_' + String(e.message ?? e).slice(0, 60) }
  }

  const { data, error } = await supabase
    .from('generated_posts')
    .insert({
      agent_id: agent.id,
      linkedin_account_id: agent.linkedin_account_id,
      draft_text: gen.text,
      image_prompt: gen.imagePrompt,
      source_news: gen.sourceNews,
      status: 'pending_review',
      scheduled_for: today,
    })
    .select('id')
    .maybeSingle()

  // Marca el agente como generado-hoy pase lo que pase (evita reintentos en bucle).
  await supabase.from('publish_agents')
    .update({ last_generated_for_date: today, last_generated_at: new Date().toISOString() })
    .eq('id', agent.id)

  if (error) {
    if (/duplicate key|unique/i.test(error.message ?? '')) return { skipped: true, reason: 'already_exists_today' }
    return { skipped: true, reason: 'insert_failed_' + String(error.message).slice(0, 60) }
  }

  // Imagen (best-effort): sube al bucket y actualiza la fila con la URL pública.
  if (data?.id && gen.imageBase64) {
    try {
      const url = await uploadGeneratedImage(gen.imageBase64, gen.imageMime, agent.linkedin_account_id, data.id)
      await supabase.from('generated_posts').update({ image_url: url }).eq('id', data.id)
    } catch (e) {
      console.warn(`[SCH-EXT] publish-agent image upload failed: ${String(e.message).slice(0, 80)}`)
    }
  }

  return { generated: true, postId: data?.id, provider: gen.provider, warn: gen.warn }
}

async function runDailyPublishAgents() {
  const agents = await loadActivePublishAgents()
  if (agents.length === 0) return
  console.log(`[SCH-EXT] ${agents.length} publish-agents activos`)
  for (const ag of agents) {
    const account = ag.linkedin_accounts
    if (!account) continue
    try {
      const res = await tryDailyGenerateForAgent(ag, account)
      if (res.generated) {
        console.log(`[SCH-EXT] 📣 "${ag.name}" (${account.label}) → borrador generado (${res.provider}${res.warn ? ', warn: ' + res.warn : ''})`)
      } else {
        const key = `pub:${ag.id}`
        if (lastSkipReason.get(key) !== res.reason) {
          lastSkipReason.set(key, res.reason)
          console.log(`[SCH-EXT] 📣 "${ag.name}" — ${res.reason}`)
        }
      }
    } catch (err) {
      console.error(`[SCH-EXT] publish-agent "${ag.name}" threw: ${err.message}`)
    }
    await sleep(randInt(500, 1500))
  }
}

// (2026-07-06) A2: resolver alertas scheduler_dead stale una vez por arranque (proof-of-life
// tras recuperación). heartbeat-check.js (su creador/resolvedor) fue reemplazado por watchdog.js
// (webhook, no toca account_alerts) → sin esto el banner rojo queda para siempre.
let _staleSchedulerAlertsResolved = false

async function tick() {
  const { mxDate, mxHour } = mxTime()
  console.log(`\n[SCH-EXT] ════════════════════════════`)
  console.log(`[SCH-EXT] Tick @ ${mxDate} CDMX`)

  if (!_staleSchedulerAlertsResolved) {
    _staleSchedulerAlertsResolved = true
    supabase.from('account_alerts').update({ resolved_at: new Date().toISOString() })
      .eq('alert_type', 'scheduler_dead').is('resolved_at', null)
      .then(({ error }) => { if (!error) console.log('[SCH-EXT] ✅ alertas scheduler_dead stale resueltas (proof-of-life)') })
      .catch(() => {})
  }

  // Pre-fetch connected accounts (cached 5s)
  const connectedIds = await getConnectedAccountIds()
  console.log(`[SCH-EXT] Bridge connected accounts: ${connectedIds.size} [${[...connectedIds].map(id => id.slice(0,8)).join(', ')}]`)

  // Health check (runs every tick, debounced 60min per account)
  await runConnectivityHealthCheck(connectedIds)

  // Enriquecimiento de empresa (currentCompany desde headline) — global, ANTES del early-return
  // para drenar el backlog aunque no haya extensión conectada. Barato: si no hay candidatos, 0 LLM.
  try {
    const compRes = await tryEnrichCompanies()
    if (compRes.enriched) console.log(`[SCH-EXT] 🏢 companies: ${compRes.withCompany}/${compRes.enriched} enriquecidos`)
    else if (compRes.error) console.warn(`[SCH-EXT] 🏢 company enrich: ${compRes.error} (reintenta)`)
  } catch (err) {
    console.error(`[SCH-EXT] tryEnrichCompanies threw:`, err.message)
  }

  // Digest diario de conexiones (lib/daily-digest.js) — también ANTES del early-return:
  // no depende de la extensión y debe salir aunque nadie esté conectado (catch-up).
  try {
    const digRes = await maybeSendDailyDigest()
    if (digRes?.sent) console.log(`[SCH-EXT] 📧 digest enviado: ${digRes.total} conexiones → ${digRes.recipients} destinatarios`)
    else if (digRes?.reason?.startsWith('send_failed')) console.warn(`[SCH-EXT] 📧 digest: ${digRes.reason} (reintenta próximo tick)`)
  } catch (err) {
    console.error(`[SCH-EXT] maybeSendDailyDigest threw:`, err.message)
  }

  // Digests POR-CAMPAÑA (lib/daily-digest.js) — independientes del global; se activan por
  // campaigns.digest_recipients. También antes del early-return (catch-up sin extensión).
  try {
    const campRes = await maybeSendCampaignDigests()
    if (campRes?.sent) console.log(`[SCH-EXT] 📇 digests por-campaña enviados: ${campRes.sent}/${campRes.processed} (skip ${campRes.skipped})`)
  } catch (err) {
    console.error(`[SCH-EXT] maybeSendCampaignDigests threw:`, err.message)
  }

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
      last_searched_at, last_batch_at, last_search_keyword_idx, dry_search_streak,
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
        id, label, status, daily_connection_limit, invites_paused_until,
        warmup_status, warmup_started_at,
        inbox_gap_min, inbox_paused, last_inbox_check_at,
        sent_invites_gap_min, last_sent_invites_check_at, last_connections_check_at,
        reply_delay_min, reply_delay_max,
        extension_paused, extension_paused_reason, extension_paused_until, timezone, cal_com_url,
        extension_last_seen_at, search_mode, ext_version
      )
    `)
    .eq('is_active', true)

  if (error || !campaigns?.length) {
    console.log('[SCH-EXT] No hay campañas activas')
    return
  }

  console.log(`[SCH-EXT] ${campaigns.length} campañas activas`)
  // IO: no persistimos un row 'tick started' por tick (288/día de ruido; el heartbeat
  // ya registra liveness). Solo consola.
  console.log(`[SCH-EXT] tick: ${campaigns.length} campañas, ${connectedIds.size} conectadas`)

  // v0.7.8: sweep de awaiting_response → dead tras 21d sin volver al pipeline.
  // Barato (1 query indexada, límite 200), no necesita gate ni cuenta — corre 1× por tick.
  try {
    const sweepRes = await sweepAwaitingResponseTimeout()
    if (sweepRes.swept > 0) console.log(`[SCH-EXT] sweepAwaitingResponse: ${sweepRes.swept} leads → dead`)
  } catch (err) {
    console.error(`[SCH-EXT] sweepAwaitingResponse threw:`, err.message)
  }

  // v0.8 (04-jul): sweep de 'replied' rancios → dead tras N días sin nuevo inbound.
  // Cierra el hueco: auto-reply ignora replies >7d (fm_max_age) y ningún otro sweep los tocaba.
  try {
    const sweepReplRes = await sweepRepliedTimeout()
    if (sweepReplRes.swept > 0) console.log(`[SCH-EXT] sweepReplied: ${sweepReplRes.swept} leads → dead`)
  } catch (err) {
    console.error(`[SCH-EXT] sweepReplied threw:`, err.message)
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
      // IO: antes se insertaba un row 'skipped' por campaña EN CADA tick (~864/día del
      // mismo skip repetido). Ahora solo logueamos cuando el motivo CAMBIA (transición).
      if (lastSkipReason.get(campaign.id) !== skipReason) {
        lastSkipReason.set(campaign.id, skipReason)
        await logJob({ campaignId: campaign.id, accountId: account.id, jobType: 'tick',
          status: 'skipped', skipReason })
      }
      continue
    }
    lastSkipReason.delete(campaign.id)  // campaña volvió a estar activa → su próximo skip se re-loguea

    console.log(`[SCH-EXT] ━━ "${campaign.name}" (${account.label}) ━━`)

    // try/catch por campaña (17-jul): antes un throw inesperado en cualquier job abortaba el TICK
    // COMPLETO → las campañas siguientes perdían su turno (~5min). Ahora el error se aísla, se
    // registra como scheduler_log status='error' (el tile "Errores hoy" deja de mentir) y el loop
    // sigue con la próxima campaña. Cada tryXForCampaign ya maneja sus fallos esperados (return
    // {reason}); esto captura solo lo inesperado.
    try {
    // SEARCH (3.2)
    const searchRes = await trySearchForCampaign(campaign, account)
    if (searchRes.dispatched) {
      console.log(`[SCH-EXT]   ✅ search dispatched (cmd ${searchRes.commandId.slice(0,8)}, "${searchRes.keyword}")`)
    } else {
      console.log(`[SCH-EXT]   ⏭️  search: ${searchRes.reason}`)
    }

    // JUNK REAPER (06-jul): limpia 'scraped' no-whitelist viejo ANTES de invites, para no
    // starvar la ventana de selección con junk acumulado (company-scoped rinde mucho junk).
    const reaped = await sweepJunkScraped(campaign)
    if (reaped > 0) console.log(`[SCH-EXT]   🧹 junk reaper: ${reaped} scraped no-whitelist → disqualified`)

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
    } catch (err) {
      // ⚠️ NO tragarse abort/timeout: el soft-timeout del tick aborta la señal para CANCELAR las
      // queries en vuelo y matar el tick zombie de raíz (post-mortem 03-jul). Si lo atrapáramos,
      // el tick huérfano seguiría iterando campañas (cada una abortando al instante) en vez de
      // morir en la primera → se anula el diseño anti-pile-up. Estos SÍ se propagan.
      const msg = String(err?.message ?? err)
      if (err?.name === 'AbortError' || /tick_soft_timeout|supabase_query_timeout|aborted/i.test(msg)) throw err
      console.error(`[SCH-EXT] ❌ "${campaign.name}" (${account.label}) falló: ${msg}`)
      await logJob({ campaignId: campaign.id, accountId: account.id, jobType: 'tick',
        status: 'error', skipReason: msg.slice(0, 300) })
      // resto: error de lógica de ESA campaña → aislado, el tick sigue con la próxima
    }
  }

  // POST-PROSPECTING (v0.9): agente nuevo, corre junto a los demás. Inerte si no
  // hay post-campañas activas o si la tabla aún no existe (migración pendiente).
  try {
    await runPostCampaigns(connectedIds, stressLockedAccount)
  } catch (err) {
    console.error(`[SCH-EXT] runPostCampaigns threw: ${err.message}`)
  }

  // PUBLISH AGENT (v0.9): genera el borrador del post diario (perfil propio).
  // Inerte si no hay agentes activos o si la tabla aún no existe (migración pendiente).
  try {
    await runDailyPublishAgents()
  } catch (err) {
    console.error(`[SCH-EXT] runDailyPublishAgents threw: ${err.message}`)
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
    // v0.7.47: inbox hours override per-account (account_config.inbox_hours {start,end}). Null-safe → 8-21.
    const ih = await getAccountConfigRaw(account.id, 'inbox_hours')
    if (!isInboxHours(undefined, account.timezone, ih?.start ?? 8, ih?.end ?? 21)) continue  // fuera de inbox hours en TZ

    // v0.7.45: deep sweep periódico (1×/día) ANTES del check normal. El check_inbox
    // regular solo ve las top ~18 conversaciones → los inbounds de prospectos viejos
    // quedan sepultados y sin responder (caso Daigo Tanaka, Alejandro Arena: escribieron
    // pero nadie contestó). El deepScrape carga hasta 500 (scroll 30×) → captura sus
    // threads → bridge auto-promueve → auto-reply. Si dispara, no encola el check normal.
    const deepDispatched = await maybeDispatchDeepSweep(account)
    if (deepDispatched) {
      console.log(`[SCH-EXT]   🔍 deep sweep dispatched for ${account.label} (recupera inbounds sepultados)`)
      continue
    }

    // v0.7.50: check_sent_invites tiene PRIORIDAD cuando está DUE. Antes corría DESPUÉS del
    // inbox y, como el inbox dispatcha cada inbox_gap (15-30min), lo STARVABA por días — las
    // aceptaciones quedaban sin detectar → leads stuck en invite_sent → SIN FU1 (caso 8-jun:
    // 8 personas aceptaron y nunca recibieron mensaje). Como su gap (90min) >> inbox gap,
    // preempta el inbox solo de vez en cuando (impacto mínimo en la responsividad de replies).
    // Un solo comando por tab por tick (restricción de serialización del SW).
    const sentDue = minutesSince(account.last_sent_invites_check_at) >= (account.sent_invites_gap_min ?? 360)
    if (sentDue) {
      const sentRes = await tryCheckSentInvitesForAccount(account)
      if (sentRes.dispatched) {
        console.log(`[SCH-EXT]   ✅ check_sent_invites dispatched for ${account.label} (prioridad — detecta aceptaciones)`)
        continue
      }
    }

    // check_connections: backstop de accept-detection por PRESENCIA (cada ~4h). Corre cuando
    // check_sent_invites NO está due (para no competir por el único worker de la extensión).
    const connDue = minutesSince(account.last_connections_check_at) >= CONNECTIONS_CHECK_GAP_MIN
    if (connDue) {
      const connRes = await tryCheckConnectionsForAccount(account)
      if (connRes.dispatched) {
        console.log(`[SCH-EXT]   ✅ check_connections dispatched for ${account.label} (accept-detection positiva)`)
        continue
      }
    }

    const inboxRes = await tryInboxForAccount(account)
    if (inboxRes.dispatched) {
      console.log(`[SCH-EXT]   ✅ inbox dispatched for ${account.label}`)
      continue
    }

    // Contact-info scrape (digest): SOLO si nada más se despachó para esta cuenta
    // en este tick (deep sweep / sent invites / connections / inbox hicieron continue).
    const ciRes = await tryContactInfoScrape(account)
    if (ciRes.dispatched) {
      console.log(`[SCH-EXT]   📇 get_contact_info dispatched for ${account.label} (${ciRes.leadName})`)
      continue
    }

    // Retiro de invitaciones viejas (v0.10.23, vía perfil): higiene anti-límite-semanal,
    // última prioridad del loop, 1 lead/tick, cap 15/día por cuenta.
    const wRes = await tryWithdrawOldInvites(account)
    if (wRes.dispatched) {
      console.log(`[SCH-EXT]   🧹 withdraw_invite_profile dispatched for ${account.label} (${wRes.leadName})`)
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
  tickStartedAt = start  // v0.8: el watchdog mide cuánto lleva ESTE tick, no sinceTick
  // Post-mortem 2026-07-03: señal de tick → si el tick hace soft-timeout, la abortamos y se
  // CANCELAN todas las queries en vuelo (mata los zombie ticks que se apilaban y martillaban).
  const ctrl = new AbortController()
  setTickSignal(ctrl.signal)
  try {
    await withTimeout(tick(), TICK_SOFT_TIMEOUT_MS, 'tick')
    lastTickAt = Date.now()
    consecutiveTickFailures = 0
    const dur = Date.now() - start
    if (dur > 30_000) { slowTickStreak++; console.warn(`[SCH-EXT] ⚠️  tick lento: ${dur}ms (racha ${slowTickStreak})`) }
    else slowTickStreak = 0
    if (slowTickStreak >= 3) notifyOps('scheduler_slow', `Scheduler lento: ${slowTickStreak} ticks >30s consecutivos (¿DB degradada?).`).catch(() => {})
    setTickSignal(null)  // ÉXITO: limpia la señal (en FALLO se deja ABORTADA, ver catch)
  } catch (err) {
    consecutiveTickFailures++
    // Deja la señal ABORTADA (no la nulifica): así TODA query futura del tick huérfano aborta
    // al instante en vez de correr 20s c/u → mata el pile-up de zombie ticks de raíz. El
    // siguiente tick setea una señal fresca al arrancar, para cuando el zombie ya terminó.
    ctrl.abort(new Error('tick_soft_timeout'))
    console.error(`[SCH-EXT] Tick error (${consecutiveTickFailures} consecutivos): ${err?.message ?? err}`)
    if (err?.stack) console.error(`[SCH-EXT] Stack: ${err.stack.split('\n').slice(0, 6).join('\n')}`)
    lastTickAt = Date.now()  // el watchdog HUNG no debe doble-matar por el mismo tick lento
    // Visibilidad en el tile "Errores hoy". OJO con el orden: la señal que acabamos de abortar
    // mataría este insert — fetchWithTimeout la ve .aborted y aborta ANTES del fetch
    // (lib/supabase.js:51), postgrest devuelve {data:null,error} (NO lanza, así que un .catch no
    // salva) y la fila nunca existe. La desinstalamos solo para esta query y la re-instalamos
    // ABORTADA → el kill-switch anti-zombie queda intacto. El await es necesario: sin él,
    // setTickSignal(ctrl.signal) correría antes de que el fetch arranque y el insert volvería a morir
    // (y un tick nuevo podría instalar su señal fresca y quedar envenenado por la vieja).
    setTickSignal(null)
    await logJob({ jobType: 'tick', status: 'error', skipReason: String(err?.message ?? err).slice(0, 300) }).catch(() => {})
    setTickSignal(ctrl.signal)
    if (consecutiveTickFailures >= 3) notifyOps('scheduler_tick_fail', `Scheduler: ${consecutiveTickFailures} ticks fallidos consecutivos (último: ${err?.message ?? err}).`).catch(() => {})
  } finally {
    tickInFlight = false
  }
}

// Post-mortem 2026-07-03: delay + jitter antes del PRIMER tick (no martillar la DB al bootear)
// + detección de crash-loop (N boots en 10 min → backoff largo + alerta out-of-band).
function computeBootDelay() {
  const jitter = randInt(5_000, 30_000)
  const BOOT_FILE = process.env.SCHED_BOOTS_FILE || '/root/.pm2/sched-boots.json'
  try {
    const now = Date.now()
    let boots = []
    try { boots = JSON.parse(fs.readFileSync(BOOT_FILE, 'utf8')) } catch { boots = [] }
    boots = boots.filter(t => now - t < 10 * 60_000)
    boots.push(now)
    fs.writeFileSync(BOOT_FILE, JSON.stringify(boots))
    if (boots.length >= 5) {
      console.error(`[SCH-EXT] 🔴 CRASH-LOOP: ${boots.length} arranques en 10 min → backoff de boot`)
      notifyOps('scheduler_crash_loop', `Scheduler en CRASH-LOOP: ${boots.length} arranques en 10 min.`).catch(() => {})
      return 90_000 + jitter   // deja respirar a la DB antes del primer tick
    }
  } catch { /* best-effort */ }
  return jitter
}

// Self-scheduling con backoff en fallos consecutivos (reemplaza el setInterval fijo): una DB
// lenta hace al scheduler IR MÁS LENTO en vez de seguir martillando a cadencia fija.
async function scheduleTickLoop() {
  await runTickSafely()
  const backoff = consecutiveTickFailures > 0
    ? Math.min(TICK_INTERVAL_MS * (2 ** Math.min(consecutiveTickFailures, 4)), 30 * 60_000)
    : TICK_INTERVAL_MS
  if (consecutiveTickFailures > 0) console.warn(`[SCH-EXT] backoff: próximo tick en ${Math.round(backoff/1000)}s (${consecutiveTickFailures} fallos consecutivos)`)
  setTimeout(scheduleTickLoop, backoff)
}

async function run() {
  console.log(`[SCH-EXT] 🚀 Scheduler-extension iniciando (tick=${TICK_INTERVAL_MS/1000}s, tickTimeout=${TICK_TIMEOUT_MS/1000}s, hungTimeout=${HUNG_TIMEOUT_MS/1000}s, DRY_RUN=${DRY_RUN})`)
  setInterval(watchdog, 60_000)
  setInterval(() => {
    console.log(`[SCH-EXT] ♥ heartbeat — lastTickAt ${Math.floor((Date.now()-lastTickAt)/1000)}s ago, tickInFlight=${tickInFlight}`)
  }, 120_000)
  const bootDelay = computeBootDelay()
  console.log(`[SCH-EXT] primer tick en ${Math.round(bootDelay/1000)}s (jitter/backoff de boot)`)
  setTimeout(scheduleTickLoop, bootDelay)
}

// Handlers. Post-mortem 2026-07-03: un unhandledRejection transitorio NO debe crash-loopear
// (una promesa flotante que rechaza no corrompe el proceso) → solo loguea + alerta. El
// uncaughtException SÍ deja estado indefinido → salir, pero tras un delay corto (deja salir la
// alerta), y el jitter/backoff de boot evita el re-martilleo instantáneo al reiniciar PM2.
process.on('unhandledRejection', (reason) => {
  console.error(`[SCH-EXT] ⚠️ unhandledRejection (no fatal): ${reason?.stack ?? reason?.message ?? reason}`)
  notifyOps('scheduler_rejection', `Scheduler unhandledRejection: ${reason?.message ?? reason}`).catch(() => {})
})
process.on('uncaughtException', (err) => {
  console.error(`[SCH-EXT] 💥 uncaughtException: ${err.stack ?? err.message ?? err}`)
  notifyOps('scheduler_uncaught', `Scheduler uncaughtException (reiniciando): ${err.message ?? err}`).catch(() => {})
  setTimeout(() => process.exit(1), 1500)
})

// Auto-arranque salvo en modo test (un harness puede importar funciones sin arrancar el loop).
// pm2 no setea SCHED_NO_AUTORUN → corre normal.
if (process.env.SCHED_NO_AUTORUN !== 'true') run()
