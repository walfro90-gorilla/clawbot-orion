// GET /api/crm/lead/[id]/oracle
// Drawer payload — UN solo query con todo lo que el drawer necesita.
// Auth: user con ownership, admin: any.
export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { authorize, UUID_RE } from "@/lib/crm/auth-helper"
import { decideSyncAction } from "@/lib/crm/smart-sync"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: leadId } = await params
  if (!UUID_RE.test(leadId)) return NextResponse.json({ error: "Invalid leadId" }, { status: 400 })

  const auth = await authorize("user", leadId)
  if (!auth.ok) return auth.response
  const admin = auth.admin

  // 1) lead row from v_crm_lead_list
  const { data: lead, error: leadErr } = await admin
    .from("v_crm_lead_list")
    .select("*")
    .eq("id", leadId)
    .maybeSingle()

  if (leadErr || !lead) {
    return NextResponse.json({ error: "Lead not found", details: leadErr?.message }, { status: 404 })
  }

  // 2) Smart sync recommendation (no apply)
  const decision = decideSyncAction(lead as any)

  // 3) Conversation events (recientes 50)
  const events = lead.conversation_id
    ? (await admin
        .from("conversation_events")
        .select("id, event_type, direction, content, sent_at, sent_via")
        .eq("conversation_id", lead.conversation_id)
        .order("sent_at", { ascending: false })
        .limit(50)).data ?? []
    : []

  // 4) Extension commands (últimos 30)
  const { data: commands } = await admin
    .from("extension_commands")
    .select("id, action, status, error, result, current_phase, phase_log, micro_phase_log, payload, created_at, completed_at")
    .eq("related_lead_id", leadId)
    .order("created_at", { ascending: false })
    .limit(30)

  // 5) Audit log para este lead
  const { data: auditTrail } = await admin
    .from("crm_audit_log")
    .select("id, actor_email, action, payload_before, payload_after, reason, reverted_at, created_at")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .limit(20)

  // 6) Last successful FU command (para diff con último fallido)
  const successCmd = (commands ?? []).find(c =>
    c.action === "send_followup" &&
    (c.result as any)?.status?.startsWith("sent")
  )
  const lastFailCmd = (commands ?? []).find(c =>
    c.action === "send_followup" &&
    (c.status === "error" || (c.result as any)?.status === "error")
  )

  // 7) Scheduler decision card — computado server side
  const schedDecision = computeSchedulerDecision(lead as any)

  return NextResponse.json({
    lead,
    timeline: {
      events,
      commands,
      audit: auditTrail ?? [],
    },
    smart_sync: decision,
    scheduler_decision: schedDecision,
    diff: {
      success_cmd: successCmd ?? null,
      fail_cmd: lastFailCmd ?? null,
    },
    fetched_at: new Date().toISOString(),
  })
}

// Heurística simple para "qué va a hacer el scheduler" en el próximo tick.
function computeSchedulerDecision(lead: any): {
  next_action: string
  will_run: boolean
  reason: string
  recommendation: string | null
} {
  const status = lead.status
  const flags = lead.health_flags ?? {}

  if (status === "dead" || status === "disqualified") {
    return {
      next_action: "none",
      will_run: false,
      reason: `terminal status='${status}'`,
      recommendation: "Revivir como pending si fue error",
    }
  }
  if (flags.quarantined) {
    return {
      next_action: "none",
      will_run: false,
      reason: "quarantined_at set",
      recommendation: "Release vía /api/leads/[id]/release",
    }
  }
  if (flags.cooldown) {
    return {
      next_action: "esperar cooldown",
      will_run: false,
      reason: `cooldown_until=${lead.cooldown_until}`,
      recommendation: null,
    }
  }
  if (flags.reply_pending_sync || flags.inbound_unprocessed) {
    return {
      next_action: "smart-sync mark_replied",
      will_run: false,
      reason: "lead respondió pero status no avanzó",
      recommendation: "Aplicar smart-sync (auto-detecta)",
    }
  }
  if (flags.db_linkedin_drift) {
    return {
      next_action: `smart-sync advance_followup → ${Math.min(lead.outbound_count, 5)}`,
      will_run: false,
      reason: `connected con ${lead.outbound_count} outbound sin avance`,
      recommendation: "Aplicar smart-sync (backfill timestamps)",
    }
  }
  if (status === "connected") {
    return {
      next_action: "dispatchar FU1",
      will_run: true,
      reason: "lead conectado, FU1 due tras delay",
      recommendation: null,
    }
  }
  if (status.startsWith("follow_up_sent")) {
    const step = parseInt(status.replace("follow_up_sent_", "").replace("follow_up_sent", "1")) || 1
    return {
      next_action: step >= 5 ? "esperar 21d → dead" : `dispatchar FU${step + 1}`,
      will_run: step < 5,
      reason: `step=${step}`,
      recommendation: null,
    }
  }
  if (status === "invite_sent") {
    return {
      next_action: "check_inbox para detectar accept",
      will_run: true,
      reason: "esperando aceptación",
      recommendation: null,
    }
  }
  return {
    next_action: "evaluar próximo tick",
    will_run: true,
    reason: status,
    recommendation: null,
  }
}
