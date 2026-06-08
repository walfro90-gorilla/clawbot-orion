// stress-snapshot.mjs — snapshot/restore helpers para stress test harness
// v0.7.13 sprint "reloj suizo self-healing" 2026-06-02

import { supabase } from '../lib/supabase.js'

const LEAD_FIELDS = [
  'id', 'campaign_id', 'full_name', 'linkedin_url', 'profile_data',
  'status', 'dead_reason',
  'scraped_at', 'sent_at', 'connected_at',
  'last_followup_at', 'last_followup2_at', 'last_followup3_at',
  'last_followup4_at', 'last_followup5_at',
  'replied_at', 'last_attempt_at', 'last_failure_at', 'last_failure_reason',
  'consecutive_failures', 'cooldown_until', 'quarantined_at',
  'awaiting_response_since', 'awaiting_response_reason',
  'lockout_skip_count', 'inmail_revert_count',
].join(',')

/**
 * Toma snapshot del lead + último command relacionado.
 * Persiste en stress_snapshots tabla. Retorna {snapshotId, lead, lastCmd}.
 */
export async function takeSnapshot(caseId, leadId, accountId, notes = null) {
  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .select(LEAD_FIELDS)
    .eq('id', leadId)
    .maybeSingle()
  if (leadErr) throw new Error(`takeSnapshot lead: ${leadErr.message}`)
  if (!lead) throw new Error(`takeSnapshot: lead ${leadId} no existe`)

  const { data: lastCmd } = await supabase
    .from('extension_commands')
    .select('id, action, status, error, result, payload, current_phase, created_at, completed_at')
    .eq('related_lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: ins, error: insErr } = await supabase
    .from('stress_snapshots')
    .insert({
      case_id: caseId,
      lead_id: leadId,
      account_id: accountId,
      before: { lead, lastCmd },
      notes,
    })
    .select('id')
    .single()
  if (insErr) throw new Error(`takeSnapshot persist: ${insErr.message}`)

  return { snapshotId: ins.id, lead, lastCmd }
}

/**
 * Restaura lead row al estado del snapshot. NO toca extension_commands
 * (esos son historia, no rollback-eables).
 */
export async function restoreSnapshot(snapshotId, opts = {}) {
  const { data: snap, error: snapErr } = await supabase
    .from('stress_snapshots')
    .select('id, lead_id, before, restored_at')
    .eq('id', snapshotId)
    .maybeSingle()
  if (snapErr) throw new Error(`restoreSnapshot fetch: ${snapErr.message}`)
  if (!snap) throw new Error(`restoreSnapshot: snapshot ${snapshotId} no existe`)
  if (snap.restored_at && !opts.force) {
    return { skipped: true, reason: 'already_restored', restoredAt: snap.restored_at }
  }

  const beforeLead = snap.before?.lead
  if (!beforeLead) throw new Error('restoreSnapshot: snapshot.before.lead missing')

  // Drop id del payload (no actualizamos la PK) + restaurar todo lo demás
  const { id: _id, ...restorePayload } = beforeLead
  const { error: upErr } = await supabase
    .from('leads')
    .update(restorePayload)
    .eq('id', snap.lead_id)
  if (upErr) throw new Error(`restoreSnapshot update: ${upErr.message}`)

  await supabase
    .from('stress_snapshots')
    .update({ restored_at: new Date().toISOString() })
    .eq('id', snapshotId)

  return { restored: true, leadId: snap.lead_id }
}

/**
 * Persiste resultado (after + pass + result) en stress_snapshots.
 */
export async function recordOutcome(snapshotId, { after, result, pass, notes }) {
  await supabase
    .from('stress_snapshots')
    .update({ after, result, pass, notes: notes ?? null })
    .eq('id', snapshotId)
}

/**
 * Mutate precondición — UPDATE el lead con fields específicos del test.
 * Retorna el lead actualizado.
 */
export async function setPrecondition(leadId, patch) {
  const { data, error } = await supabase
    .from('leads')
    .update(patch)
    .eq('id', leadId)
    .select(LEAD_FIELDS)
    .single()
  if (error) throw new Error(`setPrecondition: ${error.message}`)
  return data
}

/**
 * Diff útil para imprimir: solo campos que cambiaron.
 */
export function leadDiff(before, after) {
  const out = {}
  for (const k of Object.keys(before || {})) {
    const a = JSON.stringify(before[k])
    const b = JSON.stringify(after?.[k])
    if (a !== b) out[k] = { before: before[k], after: after?.[k] }
  }
  return out
}
