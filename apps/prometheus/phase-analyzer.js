// ═══════════════════════════════════════════════════════════════════════════
// L1 Phase Reliability Analyzer (v0.7.2)
//
// Lee micro_phase_log y views derivadas, detecta patterns, inserta insights
// en phase_insights. Se ejecuta cada hora via pm2.
//
// Insights que detecta:
//   1. Selector drift: timeout_pct > 25% en >5 ocurrencias
//   2. Latency drift: p95 24h > 2x p95 7d
//   3. Timeout too tight: p95 > 70% del timeout actual configurado
//   4. Send method shift: humanClick success_pct < 60% O hay método ganador (>80%)
//   5. Lead stuck pattern: mismo lead se atora ≥3 veces en misma phase
//   6. Critical: success_pct global de envíos < 50% en últimas 24h
//
// Cada insight puede tener auto-action (e.g., auto-tune timeout) si confidence alta.
// ═══════════════════════════════════════════════════════════════════════════

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

const TICK_MS = parseInt(process.env.PHASE_ANALYZER_TICK_MS ?? '3600000')  // 1h default

// ── Helpers ────────────────────────────────────────────────────────────────

async function insertInsight(insight) {
  // Dedup: no duplicar insight idéntico (mismo category+phase+account) en últimas 2h
  const dedupCutoff = new Date(Date.now() - 2 * 3600_000).toISOString()
  const { data: existing } = await supabase
    .from('phase_insights')
    .select('id')
    .eq('category', insight.category)
    .eq('phase_name', insight.phase_name ?? null)
    .eq('account_id', insight.account_id ?? null)
    .gte('detected_at', dedupCutoff)
    .limit(1)
    .maybeSingle()
  if (existing) return { skipped: 'dedup', existingId: existing.id }

  const { data, error } = await supabase
    .from('phase_insights')
    .insert(insight)
    .select('id')
    .single()
  if (error) {
    console.error(`[phase-analyzer] insertInsight error:`, error.message)
    return { error: error.message }
  }
  console.log(`[phase-analyzer] 💡 insight ${data.id} (${insight.severity}): ${insight.message}`)
  return { inserted: data.id }
}

// ── Detectores ──────────────────────────────────────────────────────────────

// Detector 1: Selector drift — phases que timean >25%
async function detectSelectorDrift() {
  const { data: rows } = await supabase
    .from('v_phase_success_rate_24h')
    .select('*')
    .gt('timeout_pct', 25)
    .gte('total', 5)
  if (!rows) return 0
  let inserted = 0
  for (const r of rows) {
    const sev = r.timeout_pct > 50 ? 'critical' : 'warning'
    const res = await insertInsight({
      category: 'selector_drift',
      severity: sev,
      phase_name: r.phase_name,
      account_id: r.account_id,
      metric_value: r.timeout_pct,
      window_hours: 24,
      sample_size: r.total,
      message: `Phase "${r.phase_name}" está timing-out ${r.timeout_pct}% de las veces (${r.timeout_count}/${r.total}). Probable cambio en selectores LinkedIn.`,
      details: { ok_count: r.ok_count, timeout_count: r.timeout_count },
      recommended_action: `Revisar selectores usados en phase "${r.phase_name}" en content.js — LinkedIn puede haber cambiado class names o estructura DOM.`,
    })
    if (res.inserted) inserted++
    // v0.7.10 L6 audit log: cuando un drift CRÍTICO se detecta, dejar huella
    // explícita de que el capture pipeline NO está wireado server-side. La
    // captura visual (screenshot+DOM snapshot) requiere content.js corriendo;
    // hoy depende del threshold per-tab (3× en 60min sobre la MISMA tab/SW),
    // que casi nunca se acumula porque los timeouts dispersan entre cuentas
    // y SW restarts. Followup PR: invocar /api/visual-learning/capture-server
    // con metadata sólo (sin screenshot) para crear ticket en cola.
    if (sev === 'critical' && res.inserted) {
      console.warn(
        `[phase-analyzer] [L6] selector_drift critical for phase="${r.phase_name}" ` +
        `account=${r.account_id ? r.account_id.slice(0,8) : 'GLOBAL'} timeout_pct=${r.timeout_pct}% ` +
        `n=${r.total} insight=${res.inserted}`
      )
      // v0.7.13 P0-3: server-side fallback ticket. Si no hay open ticket para
      // esta phase en las últimas 24h, INSERT un selector_ticket con
      // source='server_fallback' + dom_snapshot del último micro_phase_log.
      // Esto resuelve el bug histórico de "per-tab/SW threshold disperso" que
      // hizo que 0 tickets se crearan pese a 14 selector_drift critical.
      const fallbackEnabled = await isFlagEnabled('l6_server_fallback_enabled', true)
      if (fallbackEnabled) {
        try {
          await ensureServerFallbackTicket({
            phaseName: r.phase_name,
            accountId: r.account_id,
            timeoutPct: r.timeout_pct,
            insightId: res.inserted,
          })
        } catch (err) {
          console.error(`[phase-analyzer] [L6] server fallback ticket failed: ${err?.message ?? err}`)
        }
      }
    }
  }
  return inserted
}

// v0.7.13 P0-3: helper para crear selector_ticket server-side cuando L6 client-side
// no acumuló threshold. Dedup: skip si hay ticket abierto en últimas 24h para la
// misma phase. Cap: 10 tickets por phase total (evita inundar dashboard).
async function ensureServerFallbackTicket({ phaseName, accountId, timeoutPct, insightId }) {
  const since24h = new Date(Date.now() - 24 * 3600_000).toISOString()
  const { data: existing } = await supabase
    .from('selector_tickets')
    .select('id')
    .eq('phase_name', phaseName)
    .eq('status', 'open')
    .gte('created_at', since24h)
    .limit(1)
  if (existing && existing.length > 0) return null

  const { count: totalForPhase } = await supabase
    .from('selector_tickets')
    .select('id', { count: 'exact', head: true })
    .eq('phase_name', phaseName)
  if ((totalForPhase ?? 0) >= 10) {
    console.warn(`[phase-analyzer] [L6] cap reached (10 tickets/phase) for ${phaseName} — skip`)
    return null
  }

  // Tomar último micro_phase_log entry de un command con esta phase + account
  let domSnapshot = null
  if (accountId) {
    const { data: recentCmd } = await supabase
      .from('extension_commands')
      .select('id, micro_phase_log')
      .eq('account_id', accountId)
      .not('micro_phase_log', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (recentCmd?.micro_phase_log) {
      const entries = Array.isArray(recentCmd.micro_phase_log) ? recentCmd.micro_phase_log : []
      const match = entries.find(e => e.phase_name === phaseName && e.dom_snapshot)
      domSnapshot = match?.dom_snapshot ?? null
    }
  }

  const { data: ticket, error } = await supabase
    .from('selector_tickets')
    .insert({
      phase_name: phaseName,
      account_id: accountId,
      trigger_source: 'server_fallback',
      status: 'open',
      insight_id: insightId ?? null,
      dom_snapshot: domSnapshot,
      screenshot_url: null,
      resolution_note: `server_fallback: timeout_pct=${timeoutPct}% l6_per_tab_threshold_dispersed`,
    })
    .select('id')
    .single()
  if (error) {
    console.error(`[phase-analyzer] [L6] insert selector_ticket failed: ${error.message}`)
    return null
  }
  console.log(`[phase-analyzer] [L6] server_fallback ticket created #${ticket.id} for phase=${phaseName}`)
  return ticket.id
}

// Helper para leer runtime_config bool flags (default si no existe)
async function isFlagEnabled(key, def = false) {
  const { data } = await supabase
    .from('runtime_config')
    .select('value')
    .eq(`key`, key)
    .maybeSingle()
  if (data?.value === undefined || data?.value === null) return def
  return data.value === true
}

// Detector 2: Latency drift — p95 24h > 2x p95 7d
async function detectLatencyDrift() {
  const { data: rows } = await supabase
    .from('v_timeout_drift_24h_vs_7d')
    .select('*')
    .gte('drift_ratio', 2.0)
  if (!rows) return 0
  let inserted = 0
  for (const r of rows) {
    const sev = r.drift_ratio > 3 ? 'critical' : 'warning'
    const res = await insertInsight({
      category: 'latency_drift',
      severity: sev,
      phase_name: r.phase_name,
      account_id: r.account_id,
      metric_value: r.drift_ratio,
      window_hours: 24,
      message: `Phase "${r.phase_name}" tardando ${r.drift_ratio}x más en 24h vs 7d (p95: ${r.p95_24h}ms vs baseline ${r.p95_7d}ms).`,
      details: { p95_24h: r.p95_24h, p95_7d: r.p95_7d },
      recommended_action: `Aumentar timeout de phase "${r.phase_name}" a ~${Math.ceil(r.p95_24h * 1.5)}ms en MicroPhaseRunner. O investigar por qué LinkedIn está más lento.`,
    })
    if (res.inserted) inserted++
  }
  return inserted
}

// Detector 3: Send method analytics — auto-recomendar método primario
async function detectSendMethodShift() {
  const { data: rows } = await supabase
    .from('v_send_method_distribution_7d')
    .select('*')
  if (!rows || rows.length === 0) return 0
  let inserted = 0
  const total = rows.reduce((s, r) => s + (r.sent_count ?? 0), 0)
  if (total < 10) return 0

  // Identificar el método dominante
  const top = rows.sort((a, b) => (b.sent_count ?? 0) - (a.sent_count ?? 0))[0]
  if (top.send_method === 'humanClick') return 0  // ya es el default

  const topPct = (top.sent_count / total) * 100
  if (topPct < 50) return 0  // no claro winner

  const res = await insertInsight({
    category: 'send_method_shift',
    severity: 'warning',
    phase_name: null,
    metric_value: topPct,
    window_hours: 168,
    sample_size: total,
    message: `Send method "${top.send_method}" tiene ${Math.round(topPct)}% de los envíos exitosos (${top.sent_count}/${total}). humanClick no es el más confiable.`,
    details: { distribution: rows },
    recommended_action: `Considerar mover "${top.send_method}" como método PRIMARIO en sendFollowup fallback chain. Editar content.js trySend order.`,
  })
  if (res.inserted) inserted++
  return inserted
}

// Detector 4: Lead stuck pattern — mismo lead atorado ≥3 veces
async function detectLeadStuckPattern() {
  const { data: rows } = await supabase
    .from('v_lead_phase_stuck')
    .select('*')
    .gte('occurrences', 3)
  if (!rows) return 0
  let inserted = 0
  for (const r of rows) {
    const res = await insertInsight({
      category: 'lead_stuck',
      severity: 'warning',
      phase_name: r.stuck_at,
      account_id: r.account_id,
      metric_value: r.occurrences,
      window_hours: 24,
      message: `Lead "${r.lead_name}" se atoró ${r.occurrences} veces en phase "${r.stuck_at}". Possible: thread inaccesible, lead no es 1er grado, o UI bug específico.`,
      details: { last_seen: r.last_seen },
      recommended_action: `Investigar lead "${r.lead_name}": verificar status real en LinkedIn, considerar mark-as-dead o reset thread_id.`,
    })
    if (res.inserted) inserted++
  }
  return inserted
}

// Detector 5: Global send success rate <50% → critical alert
async function detectCriticalLowSuccess() {
  const cutoff24h = new Date(Date.now() - 24 * 3600_000).toISOString()
  const { data: stats } = await supabase
    .from('extension_commands')
    .select('result, account_id')
    .eq('action', 'send_followup')
    .gte('created_at', cutoff24h)
  if (!stats || stats.length < 20) return 0

  // Per account
  const byAccount = new Map()
  for (const s of stats) {
    const acc = s.account_id
    if (!byAccount.has(acc)) byAccount.set(acc, { sent: 0, total: 0 })
    const a = byAccount.get(acc)
    a.total++
    if (s.result?.status === 'sent_confirmed' || s.result?.status === 'sent_unconfirmed') a.sent++
  }
  let inserted = 0
  for (const [accId, a] of byAccount) {
    const pct = (a.sent / a.total) * 100
    if (a.total >= 10 && pct < 50) {
      const res = await insertInsight({
        category: 'low_send_success',
        severity: 'critical',
        account_id: accId,
        metric_value: pct,
        window_hours: 24,
        sample_size: a.total,
        message: `Cuenta con success rate ${Math.round(pct)}% (${a.sent}/${a.total}) en últimas 24h. Crítico — investigar root cause.`,
        details: { sent: a.sent, total: a.total },
        recommended_action: 'Revisar phase_insights con category=selector_drift o lead_stuck para misma cuenta. Considerar pausar dispatching hasta resolver.',
      })
      if (res.inserted) inserted++
    }
  }
  return inserted
}

// Detector 6: Timeout too tight — p95 muy cerca de timeout configurado
// Lee timeouts desde runtime_config (dinámicos, no hardcoded). Auto-applies si confidence alta.
async function getRuntimeConfig(key, fallback) {
  const { data } = await supabase.from('runtime_config').select('value').eq('key', key).maybeSingle()
  return data?.value ?? fallback
}

// v0.7.21 P2-5: floor mínimo por phase para reduction path (evita timeouts
// agresivamente cortos que rompen el flujo). Si una phase no está listada
// usamos DEFAULT_PHASE_FLOOR_MS como salvaguarda.
const PHASE_TIMEOUT_FLOOR_MS = {
  typing_complete: 3000,
  message_in_dom: 5000,
  editor_focused: 2000,
  send_button_enabled: 3000,
  editor_cleared_via_ctrl_enter: 2000,
  editor_cleared_via_humanClick: 2000,
  editor_cleared_via_form_submit: 2000,
  editor_cleared_via_plain_enter: 2000,
}
const DEFAULT_PHASE_FLOOR_MS = 3000

// v0.8 cap por phase: techo máximo al que el auto-tune (L3) puede inflar cada
// timeout. Evita el runaway que llevó typing_complete a 30000ms (4000→15000→30000):
// el tecleo se atasca por throttling de pestaña en background, el analyzer veía p95
// alto y subía el timeout hasta el cap global (max_timeout_ms=30000), alargando cada
// fallo a 30s antes de cuarentena. Con techo por phase el auto-tune queda acotado.
// Si una phase no está listada se usa analyzerCfg.max_timeout_ms (cap global).
const PHASE_TIMEOUT_CAP_MS = {
  typing_complete: 15000,
  editor_focused: 8000,
  send_button_enabled: 10000,
  message_in_dom: 22000,
  editor_cleared_via_ctrl_enter: 10000,
  editor_cleared_via_humanClick: 10000,
  editor_cleared_via_form_submit: 10000,
  editor_cleared_via_plain_enter: 10000,
}

async function setRuntimeConfig(key, value, updatedBy, reason, insightId, previousValue) {
  const { error } = await supabase.from('runtime_config').upsert({
    key, value, updated_by: updatedBy, reason,
    insight_id: insightId,
    previous_value: previousValue,
    updated_at: new Date().toISOString(),
  })
  if (error) console.error(`[phase-analyzer] setRuntimeConfig(${key}) failed: ${error.message}`)
  else console.log(`[phase-analyzer] 🔧 runtime_config.${key} updated by ${updatedBy}: ${reason}`)
}
async function detectTimeoutsTooTight() {
  const timeouts = await getRuntimeConfig('phase_timeouts', {})
  const analyzerCfg = await getRuntimeConfig('analyzer_config', {
    min_sample_for_auto_apply: 30,
    confidence_threshold: 0.90,
    timeout_safety_multiplier: 2.5,
    max_timeout_ms: 30000,
  })
  const { data: rows } = await supabase
    .from('v_phase_reliability_24h')
    .select('*')
    .eq('phase_state', 'ok')
    .gte('occurrences', 10)
  if (!rows) return 0
  let inserted = 0
  for (const r of rows) {
    const configured = timeouts[r.phase_name]
    if (!configured) continue
    const safetyMargin = r.p95_ms / configured
    if (safetyMargin <= 0.7) continue

    // Techo por phase (PHASE_TIMEOUT_CAP_MS) además del cap global, para que el
    // auto-tune no vuelva a inflar p.ej. typing_complete hasta 30s.
    const phaseCap = Math.min(
      analyzerCfg.max_timeout_ms,
      PHASE_TIMEOUT_CAP_MS[r.phase_name] ?? analyzerCfg.max_timeout_ms
    )
    const recommended = Math.min(
      phaseCap,
      Math.ceil(r.p95_ms * analyzerCfg.timeout_safety_multiplier)
    )
    // L3 AUTO-APPLY: si sample suficientemente grande, aplicamos automáticamente
    const autoApply = r.occurrences >= analyzerCfg.min_sample_for_auto_apply
                      && recommended > configured
                      && recommended <= analyzerCfg.max_timeout_ms
    const confidence = Math.min(1, r.occurrences / 100)
    const res = await insertInsight({
      category: 'timeout_too_tight',
      severity: 'warning',
      phase_name: r.phase_name,
      account_id: r.account_id,
      metric_value: safetyMargin,
      window_hours: 24,
      sample_size: r.occurrences,
      confidence_score: confidence,
      message: `Phase "${r.phase_name}" p95 es ${r.p95_ms}ms (${Math.round(safetyMargin*100)}% del timeout ${configured}ms). Riesgo false timeouts.`,
      details: { p95_ms: r.p95_ms, p99_ms: r.p99_ms, configured_timeout_ms: configured, recommended_timeout_ms: recommended },
      recommended_action: `Aumentar "${r.phase_name}" de ${configured}ms a ${recommended}ms.`,
      auto_applied: autoApply,
      applied_value: autoApply ? { [r.phase_name]: recommended } : null,
      rollback_value: autoApply ? { [r.phase_name]: configured } : null,
      applied_at: autoApply ? new Date().toISOString() : null,
    })
    if (res.inserted) inserted++
    // L3 AUTO-APPLY: escribir nuevo timeout en runtime_config
    if (autoApply && res.inserted) {
      const newTimeouts = { ...timeouts, [r.phase_name]: recommended }
      await setRuntimeConfig(
        'phase_timeouts',
        newTimeouts,
        'phase-analyzer:L3',
        `${r.phase_name}: ${configured}ms → ${recommended}ms (p95=${r.p95_ms}ms, n=${r.occurrences})`,
        res.inserted,
        timeouts
      )
    }
  }
  return inserted
}

// v0.7.21 P2-5 L3 reduction path: si phase p95 << configured de forma
// CONSISTENTE por reduction_window_days → bajar timeout con guardrail floor.
// Evita inflación runaway de timeouts cuando LinkedIn vuelve rápido.
async function detectTimeoutsTooLoose() {
  const timeouts = await getRuntimeConfig('phase_timeouts', {})
  const cfg = await getRuntimeConfig('analyzer_config', {})
  const windowDays = cfg.reduction_window_days ?? 3
  const minSample = cfg.min_sample_for_auto_apply_reduction ?? 100
  const p95ThresholdPct = (cfg.reduction_p95_threshold_pct ?? 30) / 100  // 0.30

  // Mirar reliability sobre ventana extendida (use 7d view + filter por días)
  const { data: rows } = await supabase
    .from('v_phase_reliability_7d')
    .select('*')
    .eq('phase_state', 'ok')
    .gte('occurrences', minSample)
  if (!rows) return 0

  let inserted = 0
  for (const r of rows) {
    const configured = timeouts[r.phase_name]
    if (!configured) continue
    const p95Pct = r.p95_ms / configured
    if (p95Pct >= p95ThresholdPct) continue   // no es too loose

    const floor = PHASE_TIMEOUT_FLOOR_MS[r.phase_name] ?? DEFAULT_PHASE_FLOOR_MS
    const proposed = Math.max(floor, Math.ceil(r.p95_ms * 1.5))
    if (proposed >= configured) continue       // ya está en floor o cerca

    const confidence = Math.min(1, r.occurrences / (minSample * 3))
    const res = await insertInsight({
      category: 'timeout_too_loose',
      severity: 'info',
      phase_name: r.phase_name,
      account_id: r.account_id,
      metric_value: p95Pct,
      window_hours: windowDays * 24,
      sample_size: r.occurrences,
      confidence_score: confidence,
      message: `Phase "${r.phase_name}" p95 es ${r.p95_ms}ms (${Math.round(p95Pct*100)}% del timeout ${configured}ms). Timeout inflado — proponer reducir a ${proposed}ms (floor=${floor}).`,
      details: { p95_ms: r.p95_ms, p99_ms: r.p99_ms, configured_timeout_ms: configured, proposed_timeout_ms: proposed, floor_ms: floor },
      recommended_action: `Reducir "${r.phase_name}" de ${configured}ms a ${proposed}ms.`,
      auto_applied: true,
      applied_value: { [r.phase_name]: proposed },
      rollback_value: { [r.phase_name]: configured },
      applied_at: new Date().toISOString(),
    })
    if (res.inserted) {
      inserted++
      const newTimeouts = { ...timeouts, [r.phase_name]: proposed }
      await setRuntimeConfig(
        'phase_timeouts',
        newTimeouts,
        'phase-analyzer:L3-reduce',
        `${r.phase_name}: ${configured}ms → ${proposed}ms (p95=${r.p95_ms}ms over ${windowDays}d, n=${r.occurrences}, floor=${floor})`,
        res.inserted,
        timeouts
      )
    }
  }
  return inserted
}

// ── L2: Selector Suggestion Engine ─────────────────────────────────────────
// Cuando detectamos selector_drift, buscamos evidence de cmds exitosos para
// sugerir alternativas. Esto NO auto-aplica (requiere review humano de selectores),
// pero anexa al insight la lista de "elementos que SÍ funcionaron".
async function detectSelectorSuggestions() {
  const { data: driftRows } = await supabase
    .from('v_phase_success_rate_24h')
    .select('*')
    .gt('timeout_pct', 25)
    .gte('total', 5)
  if (!driftRows || driftRows.length === 0) return 0
  let inserted = 0
  for (const drift of driftRows) {
    // Buscar evidence de cmds exitosos en esta misma phase
    const { data: evidences } = await supabase
      .from('v_selector_evidence_for_drift')
      .select('*')
      .eq('phase_name', drift.phase_name)
      .limit(5)
    if (!evidences || evidences.length === 0) continue
    const res = await insertInsight({
      category: 'selector_suggestion',
      severity: 'info',
      phase_name: drift.phase_name,
      account_id: drift.account_id,
      metric_value: drift.timeout_pct,
      window_hours: 168,  // 7 días para buscar evidence
      sample_size: evidences.reduce((s, e) => s + (e.occurrences ?? 0), 0),
      message: `Phase "${drift.phase_name}" tiene ${drift.timeout_pct}% timeouts. Top evidence de runs exitosos: ${evidences.length} patterns.`,
      details: { top_evidence: evidences.slice(0, 3) },
      recommended_action: `Revisar 'top_evidence' en details — son los elementos DOM que MATCHEARON en runs exitosos. Usar esos atributos para construir selectores alternativos en content.js.`,
    })
    if (res.inserted) inserted++
  }
  return inserted
}

// ── L4: Send Method Auto-Reorder ───────────────────────────────────────────
// Si un método de send no-default está ganando consistentemente, reordenar
// el fallback chain. Auto-apply solo si gap >25 puntos pct.
async function detectAndApplySendMethodReorder() {
  const { data: rows } = await supabase
    .from('v_send_method_distribution_7d')
    .select('*')
  if (!rows || rows.length < 2) return 0
  const totalSent = rows.reduce((s, r) => s + (r.sent_count ?? 0), 0)
  if (totalSent < 20) return 0

  // Filtrar 'unknown' (cmds pre-v0.7.2 sin sendMethod en result)
  const known = rows.filter(r => r.send_method && r.send_method !== 'unknown' && r.send_method !== 'null')
  if (known.length < 2) return 0

  const sorted = [...known].sort((a, b) => (b.sent_count ?? 0) - (a.sent_count ?? 0))
  const top = sorted[0]
  const second = sorted[1]
  const knownTotal = known.reduce((s, r) => s + (r.sent_count ?? 0), 0)
  const topPct = (top.sent_count / knownTotal) * 100
  const secondPct = (second.sent_count / knownTotal) * 100

  const currentOrder = await getRuntimeConfig('send_method_order', ['humanClick','ctrl_enter','plain_enter','form_submit'])
  if (currentOrder[0] === top.send_method) return 0  // ya es primero

  // L4 AUTO-APPLY: solo si gap >25 puntos pct Y al menos 20 sends del ganador
  const gap = topPct - secondPct
  const analyzerCfg = await getRuntimeConfig('analyzer_config', {})
  const autoApply = gap >= 25 && top.sent_count >= (analyzerCfg.min_sample_for_auto_apply ?? 30)
  const newOrder = [top.send_method, ...currentOrder.filter(m => m !== top.send_method)]

  const res = await insertInsight({
    category: 'send_method_auto_reorder',
    severity: autoApply ? 'warning' : 'info',
    phase_name: null,
    metric_value: topPct,
    window_hours: 168,
    sample_size: knownTotal,
    confidence_score: Math.min(1, gap / 50),
    message: `Send method "${top.send_method}" gana con ${Math.round(topPct)}% vs "${second.send_method}" ${Math.round(secondPct)}%. Gap ${Math.round(gap)}pp.`,
    details: { current_order: currentOrder, recommended_order: newOrder, distribution: rows },
    recommended_action: `Reordenar fallback chain a [${newOrder.join(', ')}]. content.js leerá del runtime_config en próximo init.`,
    auto_applied: autoApply,
    applied_value: autoApply ? newOrder : null,
    rollback_value: autoApply ? currentOrder : null,
    applied_at: autoApply ? new Date().toISOString() : null,
  })
  if (res.inserted && autoApply) {
    await setRuntimeConfig(
      'send_method_order',
      newOrder,
      'phase-analyzer:L4',
      `Top method "${top.send_method}" ${Math.round(topPct)}% (gap ${Math.round(gap)}pp)`,
      res.inserted,
      currentOrder
    )
    return 1
  }
  return res.inserted ? 1 : 0
}

// ── L5: PAGE_ERRORS Auto-Classification ─────────────────────────────────────
// Errores en phases tempranas que aparecen en ≥2 leads distintos son
// candidatos a PAGE_ERRORS (no matar leads por estos).
// SAFETY: solo agregar, nunca remover. Bridge debe leer de runtime_config.
async function detectAndAddPageErrors() {
  const { data: patterns } = await supabase
    .from('v_phase_error_pattern_classification')
    .select('*')
  if (!patterns || patterns.length === 0) return 0
  const currentExtras = await getRuntimeConfig('page_errors_extra', [])
  let added = 0
  for (const p of patterns) {
    // Sanitizar: extraer el nombre del error sin sufijo dinámico (timestamps, char counts)
    let errKey = (p.error_msg ?? '').toLowerCase()
    // Normalizar: micro_phase_X_timeout_NNNms → micro_phase_X_timeout_*
    errKey = errKey.replace(/_\d+ms$/, '_*ms')
                   .replace(/_at_char_\d+_of_\d+/, '_at_char_*_of_*')
                   .replace(/\b\d{6,}\b/g, '*')
    if (currentExtras.includes(errKey)) continue
    const autoApply = p.distinct_leads >= 3 && p.occurrences >= 5
    const res = await insertInsight({
      category: 'page_error_auto_classify',
      severity: 'info',
      phase_name: p.phase_name,
      metric_value: p.occurrences,
      window_hours: 24,
      sample_size: p.occurrences,
      message: `Error "${errKey}" en phase "${p.phase_name}" aparece en ${p.distinct_leads} leads distintos (${p.occurrences} veces). Probable page-error.`,
      details: { error_msg: p.error_msg, leads_sample: p.leads_sample, occurrences: p.occurrences, distinct_leads: p.distinct_leads },
      recommended_action: `Agregar "${errKey}" a PAGE_ERRORS (no matar leads por esto). Auto-aplicado en runtime_config.page_errors_extra.`,
      auto_applied: autoApply,
      applied_value: autoApply ? errKey : null,
    })
    if (autoApply && res.inserted) {
      const newExtras = [...currentExtras, errKey]
      await setRuntimeConfig(
        'page_errors_extra',
        newExtras,
        'phase-analyzer:L5',
        `Auto-classify "${errKey}" as page-error (${p.distinct_leads} leads, ${p.occurrences} occ)`,
        res.inserted,
        currentExtras
      )
      added++
    } else if (res.inserted) {
      added++
    }
  }
  return added
}

// ── Main loop ──────────────────────────────────────────────────────────────

// v0.7.13 P1-3: auto-cleanup insights stale + dedup colapse.
// Background: backlog hoy 164 insights sin ack porque dedup-window era 2h
// y reglas como low_send_success se reinsertan cada hora. Solución:
//   1. Auto-ack rows >7d (acknowledged_by='auto:age_7d')
//   2. Collapse duplicates: si misma (category, phase_name, account_id) ocurre
//      >=3 veces en últimas 24h sin ack, mantener solo el más reciente.
async function cleanupOldInsights() {
  let acked = 0
  let collapsed = 0
  try {
    const ttlDays = await readRuntimeNumberSafe('insights_auto_ack_days', 7)
    const cutoff = new Date(Date.now() - ttlDays * 86400_000).toISOString()
    const { data: stale } = await supabase
      .from('phase_insights')
      .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: 'auto:age_7d' })
      .is('acknowledged_at', null)
      .lt('detected_at', cutoff)
      .select('id')
    acked = stale?.length ?? 0

    // Collapse dups en últimas 24h
    const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString()
    const { data: groups } = await supabase
      .from('phase_insights')
      .select('id, category, phase_name, account_id, severity, detected_at')
      .is('acknowledged_at', null)
      .gte('detected_at', dayAgo)
      .order('detected_at', { ascending: false })
    if (groups && groups.length) {
      const seen = new Map()
      const toAck = []
      for (const g of groups) {
        const key = `${g.category}|${g.phase_name ?? ''}|${g.account_id ?? ''}|${g.severity}`
        const prev = seen.get(key) ?? 0
        if (prev >= 1) toAck.push(g.id)  // skip newest (first via DESC), ack rest
        seen.set(key, prev + 1)
      }
      if (toAck.length) {
        const { data: c } = await supabase
          .from('phase_insights')
          .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: 'auto:collapse_dup_24h' })
          .in('id', toAck)
          .select('id')
        collapsed = c?.length ?? 0
      }
    }
  } catch (err) {
    console.error(`[phase-analyzer] cleanupOldInsights error: ${err?.message ?? err}`)
  }
  return { acked, collapsed }
}

async function readRuntimeNumberSafe(key, def) {
  const { data } = await supabase.from('runtime_config').select('value').eq('key', key).maybeSingle()
  const v = data?.value
  if (typeof v === 'number') return v
  if (typeof v === 'string' && !isNaN(Number(v))) return Number(v)
  return def
}

// v0.7.13 P2-2: runtime_config drift detector. Compara canonical (runtime_config.phase_timeouts)
// vs cada heartbeat reciente; si >10% accounts difieren → critical insight runtime_config_drift.
async function detectRuntimeConfigDrift() {
  try {
    const { data: canonical } = await supabase
      .from('runtime_config').select('value').eq('key', 'phase_timeouts').maybeSingle()
    if (!canonical?.value || typeof canonical.value !== 'object') return 0
    const c = canonical.value

    // Solo heartbeats reportados en últimas 24h (stale = considered drifted by absence)
    const recentCutoff = new Date(Date.now() - 24 * 3600_000).toISOString()
    const { data: hbs } = await supabase
      .from('runtime_config_heartbeat')
      .select('account_id, ext_version, phase_timeouts, reported_at')
      .gte('reported_at', recentCutoff)
    if (!hbs || hbs.length === 0) return 0

    let drifted = 0
    const driftDetails = []
    for (const hb of hbs) {
      const pt = hb.phase_timeouts ?? {}
      const mismatches = {}
      for (const k of Object.keys(c)) {
        if (pt[k] !== c[k]) mismatches[k] = { canonical: c[k], extension: pt[k] ?? null }
      }
      if (Object.keys(mismatches).length > 0) {
        drifted++
        driftDetails.push({ account_id: hb.account_id, ext_version: hb.ext_version, mismatches })
      }
    }
    const driftPct = (drifted / hbs.length) * 100
    if (driftPct >= 10) {
      const sev = driftPct >= 50 ? 'critical' : 'warning'
      await insertInsight({
        category: 'runtime_config_drift',
        severity: sev,
        phase_name: null,
        account_id: null,
        metric_value: driftPct,
        window_hours: 24,
        details: { drift_pct: driftPct, drifted, total: hbs.length, examples: driftDetails.slice(0, 5) },
        message: `${drifted}/${hbs.length} accounts (${driftPct.toFixed(1)}%) reportan phase_timeouts distintos al canonical`,
      })
      return 1
    }
  } catch (err) {
    console.error(`[phase-analyzer] detectRuntimeConfigDrift error: ${err?.message ?? err}`)
  }
  return 0
}

async function analyze() {
  const start = Date.now()
  console.log(`[phase-analyzer] 🔍 Analyze tick @ ${new Date().toISOString()}`)
  let totalInserted = 0
  try {
    totalInserted += await detectSelectorDrift()
    totalInserted += await detectLatencyDrift()
    totalInserted += await detectSendMethodShift()
    totalInserted += await detectLeadStuckPattern()
    totalInserted += await detectCriticalLowSuccess()
    totalInserted += await detectTimeoutsTooTight()        // L3: auto-tune timeouts UP
    totalInserted += await detectTimeoutsTooLoose()        // L3 v0.7.21: auto-reduce DOWN with floor
    totalInserted += await detectSelectorSuggestions()     // L2: suggest selectors
    totalInserted += await detectAndApplySendMethodReorder()  // L4: auto-reorder send chain
    totalInserted += await detectAndAddPageErrors()        // L5: auto-classify page errors
    totalInserted += await detectRuntimeConfigDrift()      // v0.7.13 P2-2
    const cleanup = await cleanupOldInsights()             // v0.7.13 P1-3
    const ms = Date.now() - start
    console.log(`[phase-analyzer] ✅ Done in ${ms}ms — ${totalInserted} new, cleanup: ${cleanup.acked} acked_stale + ${cleanup.collapsed} collapsed_dup`)
  } catch (err) {
    console.error(`[phase-analyzer] tick error:`, err.message)
  }
}

// Initial run + interval
analyze()
setInterval(analyze, TICK_MS)

console.log(`[phase-analyzer] 🚀 Started (tick=${TICK_MS/1000}s)`)
