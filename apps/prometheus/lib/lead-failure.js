// lib/lead-failure.js — FIFO + cooldown + quarantine fault-tolerance helpers
//
// Centraliza el cálculo del cooldown exponencial y la transición de estado
// de fault-tolerance de un lead (consecutive_failures, last_attempt_at,
// last_failure_at, last_failure_reason, cooldown_until, quarantined_at).
//
// Importado por:
//   - extension-bridge.js (ingest success/error en handleCommandResult)
//   - scheduler-extension.js (sweepQuarantineTimeout + stamp last_attempt_at
//     post-dispatch via stampLastAttempt)
//
// IMPORTANTE: si editas este archivo, restartea AMBOS procesos PM2 — es shared.

import { supabase } from './supabase.js'

// Escalera de cooldown PRODUCCIÓN: 5min → 30min → 2h → 8h → 24h.
// failures=1 → 5min ; failures=2 → 30min ; failures=3 → 2h ;
// failures=4 → 8h  ; failures>=5 → 24h (y quarantine).
// Default hardcoded. Override en runtime_config.cooldown_ladder_ms (array de minutos)
// refrescado cada 5min — mismo patrón que page_errors_extra. Doble seguro:
// si DB cae al startup, los procesos arrancan con producción NO con TEST MODE.
const COOLDOWN_LADDER_DEFAULT_MIN = [5, 30, 120, 480, 1440]
let _cooldownLadderMs = COOLDOWN_LADDER_DEFAULT_MIN.map(m => m * 60_000)
let _cooldownLadderLastFetch = 0

async function refreshCooldownLadder() {
  if (Date.now() - _cooldownLadderLastFetch < 5 * 60_000) return
  _cooldownLadderLastFetch = Date.now()
  try {
    const { data } = await supabase
      .from('runtime_config')
      .select('value')
      .eq('key', 'cooldown_ladder_ms')
      .maybeSingle()
    if (Array.isArray(data?.value) && data.value.length > 0 && data.value.every(n => typeof n === 'number' && n > 0)) {
      _cooldownLadderMs = data.value.map(m => m * 60_000)
      console.log(`[lead-failure] cooldown_ladder_ms override aplicado: [${data.value.join(', ')}] min`)
    }
  } catch (err) {
    console.error(`[lead-failure] refreshCooldownLadder failed: ${err.message}`)
  }
}
refreshCooldownLadder()
setInterval(refreshCooldownLadder, 5 * 60_000).unref?.()

export const QUARANTINE_AT_FAILURES = 5

/**
 * Devuelve cuántos ms de cooldown aplicar tras N fallos consecutivos.
 * @param {number} failures - consecutive_failures POST-incremento (>=1).
 */
export function cooldownMs(failures) {
  if (!failures || failures < 1) return 0
  const idx = Math.min(failures - 1, _cooldownLadderMs.length - 1)
  return _cooldownLadderMs[idx]
}

/**
 * Errores que NO deben contar como fault del lead (son terminales/manejados
 * por handlers específicos, o son señal de LinkedIn no de problema del lead).
 * - awaiting_response: ban window de LinkedIn; el lead está sano.
 * - lead_not_first_degree / lead_invite_still_pending: revert a invite_sent.
 * - profile_not_found: lead ya marcado dead en handler dedicado.
 * - lead_not_messageable: handler dedicado (revert o dead).
 */
const NON_FAULT_ERRORS = new Set([
  'awaiting_response',
  'lead_not_first_degree',
  'lead_invite_still_pending',
  'profile_not_found',
  'lead_not_messageable',
  'linkedin_security_check',  // v0.7.16 — banner detectado, lead no falló
])

export function isNonFaultError(errCode) {
  if (!errCode) return false
  return NON_FAULT_ERRORS.has(String(errCode))
}

/**
 * Calcula el delta a aplicar a un lead tras un resultado de comando.
 * @param {object} args
 * @param {number} args.currentFailures - consecutive_failures actual del lead.
 * @param {'success'|'failure'} args.outcome
 * @param {string|null} args.errorCode - result.error si outcome='failure'.
 * @returns {object|null} objeto listo para .update(...), o null si no hay que tocar lead.
 */
export function computeNextLeadFailureState({ currentFailures = 0, outcome, errorCode = null }) {
  const nowIso = new Date().toISOString()

  if (outcome === 'success') {
    return {
      consecutive_failures: 0,
      last_attempt_at:      nowIso,
      last_failure_at:      null,
      last_failure_reason:  null,
      cooldown_until:       null,
      // NOTA: quarantined_at NO se limpia automáticamente en success — requiere
      // intervención humana (botón Liberar) o sweep de quarantine timeout.
    }
  }

  if (outcome === 'failure') {
    if (isNonFaultError(errorCode)) return null  // no contamos
    const failures = (currentFailures ?? 0) + 1
    const cool = cooldownMs(failures)
    const cooldownUntilIso = cool > 0 ? new Date(Date.now() + cool).toISOString() : null
    const update = {
      consecutive_failures: failures,
      last_attempt_at:      nowIso,
      last_failure_at:      nowIso,
      last_failure_reason:  errorCode ? String(errorCode).slice(0, 100) : 'unknown',
      cooldown_until:       cooldownUntilIso,
    }
    if (failures >= QUARANTINE_AT_FAILURES) {
      update.quarantined_at = nowIso
    }
    return update
  }

  return null
}

/**
 * Aplica el state de fault-tolerance a un lead tras un command_result.
 * Lee consecutive_failures actual (1 SELECT) y hace 1 UPDATE.
 * @param {string} leadId
 * @param {'success'|'failure'} outcome
 * @param {string|null} errorCode
 * @returns {Promise<{updated: boolean, failures?: number, quarantined?: boolean}>}
 */
export async function applyLeadAttemptOutcome(leadId, outcome, errorCode = null) {
  if (!leadId) return { updated: false }
  const { data: lead, error: selErr } = await supabase
    .from('leads')
    .select('consecutive_failures, quarantined_at')
    .eq('id', leadId)
    .maybeSingle()
  if (selErr) {
    console.error(`[lead-failure] select lead ${leadId.slice(0,8)} failed: ${selErr.message}`)
    return { updated: false }
  }
  const update = computeNextLeadFailureState({
    currentFailures: lead?.consecutive_failures ?? 0,
    outcome,
    errorCode,
  })
  if (!update) return { updated: false }
  const { error: updErr } = await supabase.from('leads').update(update).eq('id', leadId)
  if (updErr) {
    console.error(`[lead-failure] update lead ${leadId.slice(0,8)} failed: ${updErr.message}`)
    return { updated: false }
  }
  const quarantined = !!update.quarantined_at && !lead?.quarantined_at
  if (quarantined) {
    console.warn(`[lead-failure] 🔒 lead ${leadId.slice(0,8)} QUARANTINED (failures=${update.consecutive_failures}, reason=${update.last_failure_reason})`)
    try {
      await supabase.from('phase_insights').insert({
        severity:    'critical',
        category:    'lead_quarantined',
        sample_size: update.consecutive_failures,
        details: {
          lead_id:        leadId,
          failure_reason: update.last_failure_reason,
          quarantined_at: update.quarantined_at,
        },
      })
    } catch (err) {
      console.error(`[lead-failure] phase_insights insert failed: ${err.message}`)
    }
  }
  return { updated: true, failures: update.consecutive_failures, quarantined }
}

/**
 * Marca last_attempt_at = NOW() AL MOMENTO DE DISPATCH (no al recibir result).
 * Esto es lo que hace funcionar el ORDER BY last_attempt_at NULLS FIRST — sin
 * esto, un lead que falla y queda en cooldown sigue con last_attempt_at viejo
 * y compite por prioridad con leads sanos no atendidos.
 *
 * Llamado desde dispatchCommand (extension-dispatch.js) cuando relatedLeadId.
 */
export async function stampLastAttempt(leadId) {
  if (!leadId) return
  const { error } = await supabase.from('leads')
    .update({ last_attempt_at: new Date().toISOString() })
    .eq('id', leadId)
  if (error) console.error(`[lead-failure] stampLastAttempt ${leadId.slice(0,8)} failed: ${error.message}`)
}

/**
 * Sweep: leads con quarantined_at más viejo que N días sin liberación → dead.
 * Pensado para correr 1×/tick desde scheduler-extension.js tick().
 */
export async function sweepQuarantineTimeout(killDays = 7) {
  const cutoffIso = new Date(Date.now() - killDays * 86_400_000).toISOString()
  const { data: stale, error } = await supabase
    .from('leads')
    .select('id, full_name, quarantined_at, last_failure_reason, consecutive_failures')
    .not('quarantined_at', 'is', null)
    .lt('quarantined_at', cutoffIso)
    .neq('status', 'dead')
    .limit(200)
  if (error) {
    console.error(`[lead-failure] sweepQuarantine query failed: ${error.message}`)
    return { swept: 0 }
  }
  if (!stale || stale.length === 0) return { swept: 0 }
  let swept = 0
  for (const lead of stale) {
    const { error: updErr } = await supabase.from('leads').update({
      status:      'dead',
      dead_reason: `quarantined_no_review_${killDays}d`,
    }).eq('id', lead.id)
    if (updErr) {
      console.error(`[lead-failure] sweepQuarantine update ${lead.id.slice(0,8)} failed: ${updErr.message}`)
      continue
    }
    swept++
    console.log(`[lead-failure] 💀 quarantine → dead: ${lead.full_name || lead.id.slice(0,8)} (failures=${lead.consecutive_failures}, reason=${lead.last_failure_reason})`)
  }
  return { swept }
}
