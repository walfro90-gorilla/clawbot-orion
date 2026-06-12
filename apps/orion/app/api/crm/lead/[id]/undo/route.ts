// POST /api/crm/lead/[id]/undo
// Body: { audit_id: number }
// Reverte un audit log entry (UPDATE leads con payload_before).
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
  try { body = await req.json() } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }) }
  const auditId = Number(body?.audit_id)
  if (!Number.isFinite(auditId)) return NextResponse.json({ error: "audit_id required" }, { status: 400 })

  const { data: audit } = await auth.admin
    .from("crm_audit_log")
    .select("id, lead_id, action, payload_before, payload_after, reverted_at")
    .eq("id", auditId)
    .maybeSingle()
  if (!audit || audit.lead_id !== leadId) {
    return NextResponse.json({ error: "Audit entry not found" }, { status: 404 })
  }
  if (audit.reverted_at) {
    return NextResponse.json({ error: "Already reverted" }, { status: 409 })
  }

  // Restaurar campos de leads desde payload_before
  const before = audit.payload_before as Record<string, unknown>
  const validFields = ["status", "replied_at", "dead_reason", "lockout_skip_count", "followup_step",
    "last_followup_at", "last_followup2_at", "last_followup3_at", "last_followup4_at", "last_followup5_at",
    "cooldown_until", "quarantined_at", "consecutive_failures", "inmail_revert_count"]
  const restore: Record<string, unknown> = {}
  for (const k of validFields) {
    if (k in before) restore[k] = before[k]
  }
  if (Object.keys(restore).length === 0) {
    return NextResponse.json({ error: "No fields to restore" }, { status: 400 })
  }

  const { error } = await auth.admin.from("leads").update(restore as any).eq("id", leadId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await auth.admin
    .from("crm_audit_log")
    .update({ reverted_at: new Date().toISOString(), reverted_by: auth.userId })
    .eq("id", auditId)

  await logCrmAudit(auth.admin, {
    actor_id: auth.userId, actor_email: auth.email,
    action: `undo:${audit.action}`,
    lead_id: leadId,
    payload_before: audit.payload_after as Record<string, unknown>,
    payload_after: restore,
    reason: `Reverted audit_id=${auditId}`,
  })

  revalidatePath("/dashboard/crm")
  return NextResponse.json({ ok: true, restored: restore })
}
