// POST /api/crm/lead/[id]/mark-dead — auth: admin
export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { authorize, UUID_RE } from "@/lib/crm/auth-helper"
import { logCrmAudit } from "@/lib/crm/smart-sync"
import { revalidatePath } from "next/cache"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: leadId } = await params
  if (!UUID_RE.test(leadId)) return NextResponse.json({ error: "Invalid leadId" }, { status: 400 })
  const auth = await authorize("admin", leadId)
  if (!auth.ok) return auth.response

  let body: any = null
  try { body = await req.json() } catch { /* */ }
  const deadReason = body?.dead_reason ?? "manual_mark_dead"

  const { data: lead } = await auth.admin
    .from("leads")
    .select("id, status, dead_reason, conversations(id, ai_reply_scheduled_at)")
    .eq("id", leadId).maybeSingle()
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 })

  const before = { status: lead.status, dead_reason: lead.dead_reason }

  await auth.admin
    .from("extension_commands")
    .update({ status: "cancelled", error: "cancelled_by_mark_dead" })
    .eq("related_lead_id", leadId)
    .in("status", ["pending", "dispatched"])

  const convId = (lead.conversations as any)?.id
  if (convId) {
    await auth.admin.from("conversations")
      .update({ ai_reply_scheduled_at: null, ai_reply_draft: null }).eq("id", convId)
  }

  const { error } = await auth.admin
    .from("leads")
    .update({ status: "dead", dead_reason: deadReason })
    .eq("id", leadId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await logCrmAudit(auth.admin, {
    actor_id: auth.userId, actor_email: auth.email,
    action: "mark_dead", lead_id: leadId,
    payload_before: before, payload_after: { status: "dead", dead_reason: deadReason },
    reason: deadReason,
  })
  revalidatePath("/dashboard/crm")
  return NextResponse.json({ ok: true, before })
}
