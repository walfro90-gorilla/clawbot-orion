// stress-tail.mjs — observador en vivo de un extension_command + phases + insights
// Poll cada 1s hasta que command sea terminal o timeout.

import { supabase } from '../lib/supabase.js'

const TERMINAL_STATUSES = new Set(['completed', 'error', 'timeout', 'cancelled'])

function tsMx(ts) {
  if (!ts) return '—'
  try {
    return new Date(ts).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', hour12: false })
  } catch { return ts }
}

/**
 * Live-tail un command. Imprime cada cambio de status/phase/micro_phase.
 * Retorna {finalCmd, elapsedMs, newInsights}.
 */
export async function tailCommand(commandId, { timeoutMs = 180_000, pollMs = 1000, silent = false } = {}) {
  const t0 = Date.now()
  const startIso = new Date(t0).toISOString()
  let lastStatus = null, lastPhase = null, lastMicroLen = 0
  let cmd = null

  while (Date.now() - t0 < timeoutMs) {
    const { data } = await supabase
      .from('extension_commands')
      .select('id, account_id, related_lead_id, action, status, error, result, current_phase, phase_log, micro_phase_log, payload, created_at, completed_at')
      .eq('id', commandId)
      .maybeSingle()
    cmd = data

    if (!cmd) {
      if (!silent) console.log(`[tail] cmd ${commandId} no existe aún…`)
    } else {
      // Status change?
      if (cmd.status !== lastStatus) {
        if (!silent) console.log(`[${tsMx(new Date())}] status=${cmd.status} phase=${cmd.current_phase ?? '—'} error=${cmd.error ?? '—'}`)
        lastStatus = cmd.status
      }
      // Phase change?
      if (cmd.current_phase !== lastPhase) {
        if (!silent && cmd.current_phase) console.log(`  ▸ phase → ${cmd.current_phase}`)
        lastPhase = cmd.current_phase
      }
      // New micro_phase entries?
      const microLen = Array.isArray(cmd.micro_phase_log) ? cmd.micro_phase_log.length : 0
      if (microLen > lastMicroLen) {
        if (!silent) {
          for (let i = lastMicroLen; i < microLen; i++) {
            const mp = cmd.micro_phase_log[i]
            console.log(`  · μ[${i}] ${mp.phase_name ?? '?'} = ${mp.outcome ?? mp.status ?? '?'} (${mp.elapsed_ms ?? '?'}ms)`)
          }
        }
        lastMicroLen = microLen
      }
      // Terminal?
      if (TERMINAL_STATUSES.has(cmd.status)) break
    }
    await new Promise(r => setTimeout(r, pollMs))
  }

  const elapsedMs = Date.now() - t0

  // Insights nuevos durante este test
  const { data: newInsights } = await supabase
    .from('phase_insights')
    .select('id, category, severity, phase_name, account_id, detected_at, details')
    .gte('detected_at', startIso)
    .order('detected_at', { ascending: true })

  return { finalCmd: cmd, elapsedMs, newInsights: newInsights ?? [] }
}

/**
 * Print resumen compacto post-tail.
 */
export function summarize(label, tail) {
  const { finalCmd: c, elapsedMs, newInsights } = tail
  console.log(`\n━━━ ${label} ━━━`)
  console.log(`  status:     ${c?.status ?? '(no cmd)'}`)
  console.log(`  current_phase: ${c?.current_phase ?? '—'}`)
  console.log(`  error:      ${c?.error ?? '—'}`)
  console.log(`  elapsed:    ${elapsedMs}ms`)
  console.log(`  result:     ${c?.result ? JSON.stringify(c.result).slice(0, 200) : '—'}`)
  if (Array.isArray(c?.phase_log) && c.phase_log.length) {
    console.log(`  phase_log:  ${c.phase_log.map(p => p.state ?? p.phase).join(' → ')}`)
  }
  if (Array.isArray(c?.micro_phase_log) && c.micro_phase_log.length) {
    console.log(`  micro: ${c.micro_phase_log.length} steps`)
    for (const mp of c.micro_phase_log) {
      console.log(`    · ${mp.phase_name} = ${mp.outcome ?? mp.status} (${mp.elapsed_ms ?? '?'}ms)`)
    }
  }
  if (newInsights.length) {
    console.log(`  NEW insights during test: ${newInsights.length}`)
    for (const ins of newInsights) {
      console.log(`    ⚠ ${ins.severity} ${ins.category} ${ins.phase_name ?? ''}`)
    }
  }
  console.log(`━━━━━━━━━━━━━━`)
}
