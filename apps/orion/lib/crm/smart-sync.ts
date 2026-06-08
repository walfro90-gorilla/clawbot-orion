// lib/crm/smart-sync.ts
//
// SMART SYNC core — "inteligencia Orion para inbox"
// Decisión del usuario 2026-06-02: "que sea inteligente Orion para detectar
// cuando alguien contesta y cómo. Pero no fallar por no saber cómo manejar
// el inbox information".
//
// Recibe la fila de v_crm_lead_list (lead + outbound/inbound counts + dates)
// y decide la acción correcta SIN ambigüedad:
//
//   1. Si el lead respondió (inbound > 0 AND last_inbound > last_outbound):
//      → mark replied, replied_at = last_inbound_at
//
//   2. Si ya respondimos al lead (inbound > 0 AND last_outbound > last_inbound):
//      → status = replied (la conversación está en curso, no enviar FU)
//      → replied_at = last_inbound_at (cuando ELLOS contestaron)
//
//   3. Si lead.replied_at existe pero status NO es 'replied' (drift inverso):
//      → mark replied, conserva replied_at
//
//   4. Si status='connected' AND outbound >= 1 AND inbound = 0 (drift real):
//      → mark follow_up_sent_N donde N = min(outbound_count, 5)
//      → backfill last_followupK_at desde conversation_events.sent_at
//
//   5. Si nada aplica: NO ACTION (no debería verse en lista de drift).

import type { SupabaseClient } from "@supabase/supabase-js"

export type LeadOracleRow = {
  id: string
  full_name: string | null
  status: string
  replied_at: string | null
  connected_at: string | null
  last_followup_at: string | null
  last_followup2_at: string | null
  last_followup3_at: string | null
  last_followup4_at: string | null
  last_followup5_at: string | null
  outbound_count: number
  inbound_count: number
  last_outbound_at: string | null
  last_inbound_at: string | null
  conversation_id: string | null
  campaign_id: string | null
}

export type SyncDecision =
  | { kind: "noop"; reason: string }
  | {
      kind: "mark_replied"
      replied_at: string
      reason: string
      update: Record<string, unknown>
      followup_backfill?: Record<string, string> // last_followupN_at backfill
    }
  | {
      kind: "advance_followup"
      new_status: string
      new_step: number
      update: Record<string, unknown>
      reason: string
    }

/**
 * Decide la acción smart-sync para un lead.
 * NO ejecuta — sólo devuelve la decisión. Caller aplica con `applySyncDecision`.
 */
export function decideSyncAction(lead: LeadOracleRow): SyncDecision {
  const outCount = lead.outbound_count ?? 0
  const inCount = lead.inbound_count ?? 0
  const lastIn = lead.last_inbound_at ? new Date(lead.last_inbound_at).getTime() : 0
  const lastOut = lead.last_outbound_at ? new Date(lead.last_outbound_at).getTime() : 0

  // Caso 3: drift inverso — replied_at presente sin status replied
  if (lead.replied_at && lead.status !== "replied" && lead.status !== "dead" && lead.status !== "disqualified") {
    return {
      kind: "mark_replied",
      replied_at: lead.replied_at,
      reason: "reply_pending_sync: replied_at existe pero status no avanzó",
      update: { status: "replied" },
    }
  }

  // Caso 1: lead respondió y aún no procesamos
  if (inCount > 0 && lastIn > lastOut && lead.status !== "replied") {
    return {
      kind: "mark_replied",
      replied_at: lead.last_inbound_at!,
      reason: `inbound_unprocessed: inbound ${new Date(lastIn).toISOString()} > último outbound, marcar replied`,
      update: { status: "replied", replied_at: lead.last_inbound_at },
    }
  }

  // Caso 2: nosotros ya respondimos a su reply — conversación viva, no es drift FU
  if (inCount > 0 && lastOut > lastIn && lead.status !== "replied") {
    return {
      kind: "mark_replied",
      replied_at: lead.last_inbound_at!,
      reason: `inbound_acknowledged: ellos contestaron, nosotros ya respondimos. Lead en conversación`,
      update: { status: "replied", replied_at: lead.last_inbound_at },
    }
  }

  // Caso 4: drift real (status=connected, outbound>=1, inbound=0, sin respuesta del lead)
  if (lead.status === "connected" && outCount >= 1 && inCount === 0) {
    const newStep = Math.min(outCount, 5)
    const newStatus = newStep === 1 ? "follow_up_sent" : `follow_up_sent_${newStep}`
    return {
      kind: "advance_followup",
      new_status: newStatus,
      new_step: newStep,
      update: { status: newStatus },
      reason: `db_linkedin_drift: ${outCount} outbound enviados sin avance. Marcar ${newStatus} y backfill timestamps.`,
    }
  }

  return { kind: "noop", reason: "No applicable rule" }
}

/**
 * Aplica la decisión + backfill de timestamps si advance_followup.
 * NO toca conversations.ai_reply_scheduled_at (caller responsable de cleanup
 * si mark_replied).
 */
export async function applySyncDecision(
  admin: SupabaseClient,
  lead: LeadOracleRow,
  decision: SyncDecision,
): Promise<{ ok: boolean; before: Record<string, unknown>; after: Record<string, unknown> }> {
  // Snapshot before for audit
  const before: Record<string, unknown> = {
    status: lead.status,
    replied_at: lead.replied_at,
    last_followup_at: lead.last_followup_at,
    last_followup2_at: lead.last_followup2_at,
    last_followup3_at: lead.last_followup3_at,
    last_followup4_at: lead.last_followup4_at,
    last_followup5_at: lead.last_followup5_at,
  }

  if (decision.kind === "noop") {
    return { ok: true, before, after: before }
  }

  let update = { ...decision.update } as Record<string, unknown>

  // Para advance_followup: backfill last_followupN_at desde conversation_events
  if (decision.kind === "advance_followup" && lead.conversation_id) {
    const { data: events } = await admin
      .from("conversation_events")
      .select("sent_at, direction, event_type")
      .eq("conversation_id", lead.conversation_id)
      .eq("direction", "outbound")
      .order("sent_at", { ascending: true })

    if (events && events.length > 0) {
      const cap = Math.min(events.length, 5)
      for (let i = 0; i < cap; i++) {
        const field = i === 0 ? "last_followup_at" : `last_followup${i + 1}_at`
        if (!lead[field as keyof LeadOracleRow]) {
          update[field] = events[i].sent_at
        }
      }
    }
  }

  // Para mark_replied: limpiar ai_reply_scheduled_at + cancelar pending FU cmds (anti-race)
  if (decision.kind === "mark_replied") {
    // 1) Cancel any pending FU dispatches for this lead (defensa contra duplicates)
    await admin
      .from("extension_commands")
      .update({ status: "cancelled", error: "cancelled_by_smart_sync_mark_replied" })
      .eq("related_lead_id", lead.id)
      .eq("action", "send_followup")
      .in("status", ["pending", "dispatched"])

    // 2) Clear ai_reply_scheduled_at + ai_reply_draft en la conversación
    if (lead.conversation_id) {
      await admin
        .from("conversations")
        .update({ ai_reply_scheduled_at: null, ai_reply_draft: null })
        .eq("id", lead.conversation_id)
    }
  }

  const { error } = await admin.from("leads").update(update).eq("id", lead.id)
  if (error) {
    return { ok: false, before, after: { error: error.message } }
  }

  return { ok: true, before, after: update }
}

/**
 * Helper para audit log standardizado.
 */
export async function logCrmAudit(
  admin: SupabaseClient,
  args: {
    actor_id: string | null
    actor_email: string | null
    action: string
    lead_id: string
    payload_before: Record<string, unknown>
    payload_after: Record<string, unknown>
    reason?: string
  },
): Promise<number | null> {
  const { data, error } = await admin
    .from("crm_audit_log")
    .insert({
      actor_id: args.actor_id,
      actor_email: args.actor_email,
      action: args.action,
      lead_id: args.lead_id,
      payload_before: args.payload_before,
      payload_after: args.payload_after,
      reason: args.reason ?? null,
    })
    .select("id")
    .single()
  if (error) {
    console.error("[crm_audit_log insert]", error.message)
    return null
  }
  return data?.id ?? null
}
