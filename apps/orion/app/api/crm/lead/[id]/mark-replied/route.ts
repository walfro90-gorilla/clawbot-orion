// POST /api/crm/lead/[id]/mark-replied
// Marca replied + cancela pending FUs + limpia ai_reply_scheduled_at (anti-race adversarial fix).
// Auth: admin.
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
  try { body = await req.json() } catch { /* empty body OK */ }
  const reason = body?.reason ?? "manual_mark_replied"
  const repliedAtIso = body?.replied_at ?? new Date().toISOString()

  const { data: lead } = await auth.admin
    .from("leads")
    .select("id, status, replied_at, conversations(id, ai_reply_scheduled_at, ai_reply_draft)")
    .eq("id", leadId).maybeSingle()
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 })

  const before = {
    status: lead.status,
    replied_at: lead.replied_at,
    ai_reply_scheduled_at: (lead.conversations as any)?.ai_reply_scheduled_at ?? null,
  }

  // 1) Cancel pending FU commands (anti-race con scheduler)
  await auth.admin
    .from("extension_commands")
    .update({ status: "cancelled", error: "cancelled_by_mark_replied" })
    .eq("related_lead_id", leadId)
    .in("action", ["send_followup"])
    .in("status", ["pending", "dispatched"])

  // 2) Clear ai_reply_scheduled_at en conversation (anti-race con auto-reply cron)
  const convId = (lead.conversations as any)?.id
  if (convId) {
    await auth.admin
      .from("conversations")
      .update({ ai_reply_scheduled_at: null, ai_reply_draft: null })
      .eq("id", convId)
  }

  // 3) Update lead status
  const { error } = await auth.admin
    .from("leads")
    .update({ status: "replied", replied_at: repliedAtIso })
    .eq("id", leadId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await logCrmAudit(auth.admin, {
    actor_id: auth.userId, actor_email: auth.email,
    action: "mark_replied", lead_id: leadId,
    payload_before: before,
    payload_after: { status: "replied", replied_at: repliedAtIso },
    reason,
  })

  revalidatePath("/dashboard/crm")
  return NextResponse.json({ ok: true, before, replied_at: repliedAtIso })
}
