// POST /api/crm/bulk
// Body: { lead_ids: string[], action: 'smart_sync'|'reset_skip'|'mark_dead' }
// Auth: admin. Aplica acción a múltiples leads.
export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { authorize, UUID_RE } from "@/lib/crm/auth-helper"
import { decideSyncAction, applySyncDecision, logCrmAudit, type LeadOracleRow } from "@/lib/crm/smart-sync"
import { revalidatePath } from "next/cache"

const MAX_BULK = 100

export async function POST(req: NextRequest) {
  const auth = await authorize("admin")
  if (!auth.ok) return auth.response

  let body: any = null
  try { body = await req.json() } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }) }

  const leadIds: string[] = Array.isArray(body?.lead_ids) ? body.lead_ids : []
  const action = body?.action

  if (leadIds.length === 0) return NextResponse.json({ error: "lead_ids empty" }, { status: 400 })
  if (leadIds.length > MAX_BULK) return NextResponse.json({ error: `Max ${MAX_BULK} per bulk` }, { status: 400 })
  for (const id of leadIds) {
    if (!UUID_RE.test(id)) return NextResponse.json({ error: `Invalid leadId ${id}` }, { status: 400 })
  }
  if (!["smart_sync", "reset_skip", "mark_dead"].includes(action)) {
    return NextResponse.json({ error: "action invalid" }, { status: 400 })
  }

  const results: Array<{ lead_id: string; ok: boolean; detail?: any }> = []

  for (const leadId of leadIds) {
    try {
      if (action === "smart_sync") {
        const { data: lead } = await (auth.admin as any).from("v_crm_lead_list").select("*").eq("id", leadId).maybeSingle()
        if (!lead) { results.push({ lead_id: leadId, ok: false, detail: "not_found" }); continue }
        const decision = decideSyncAction(lead as LeadOracleRow)
        if (decision.kind === "noop") {
          results.push({ lead_id: leadId, ok: false, detail: "noop" })
          continue
        }
        const r = await applySyncDecision(auth.admin, lead as LeadOracleRow, decision)
        await logCrmAudit(auth.admin, {
          actor_id: auth.userId, actor_email: auth.email,
          action: `bulk:smart_sync:${decision.kind}`, lead_id: leadId,
          payload_before: r.before, payload_after: r.after, reason: decision.reason,
        })
        results.push({ lead_id: leadId, ok: r.ok, detail: decision.kind })
      } else if (action === "reset_skip") {
        const { data: before } = await auth.admin.from("leads").select("lockout_skip_count, status, dead_reason").eq("id", leadId).maybeSingle()
        const patch: Record<string, unknown> = { lockout_skip_count: 0 }
        if (before?.status === "dead" && before?.dead_reason === "lockout_dead_no_thread") {
          patch.status = "connected"; patch.dead_reason = null
        }
        await auth.admin.from("leads").update(patch as any).eq("id", leadId)
        await logCrmAudit(auth.admin, {
          actor_id: auth.userId, actor_email: auth.email,
          action: "bulk:reset_skip", lead_id: leadId,
          payload_before: before ?? {}, payload_after: patch, reason: "bulk_reset",
        })
        results.push({ lead_id: leadId, ok: true })
      } else if (action === "mark_dead") {
        const { data: before } = await auth.admin.from("leads").select("status, dead_reason").eq("id", leadId).maybeSingle()
        await auth.admin.from("extension_commands").update({ status: "cancelled", error: "bulk_mark_dead" })
          .eq("related_lead_id", leadId).in("status", ["pending", "dispatched"])
        await auth.admin.from("leads").update({ status: "dead", dead_reason: body.reason ?? "bulk_mark_dead" }).eq("id", leadId)
        await logCrmAudit(auth.admin, {
          actor_id: auth.userId, actor_email: auth.email,
          action: "bulk:mark_dead", lead_id: leadId,
          payload_before: before ?? {}, payload_after: { status: "dead" }, reason: body.reason ?? "bulk",
        })
        results.push({ lead_id: leadId, ok: true })
      }
    } catch (err: any) {
      results.push({ lead_id: leadId, ok: false, detail: err?.message ?? "error" })
    }
  }

  revalidatePath("/dashboard/crm")
  const okCount = results.filter(r => r.ok).length
  return NextResponse.json({ ok: true, total: leadIds.length, success: okCount, results })
}
