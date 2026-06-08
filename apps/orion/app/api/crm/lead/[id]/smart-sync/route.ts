// POST /api/crm/lead/[id]/smart-sync
// Aplica la decisión smart-sync (auto-detecta drift/replied/FU advance).
// Auth: admin.
export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { authorize, UUID_RE } from "@/lib/crm/auth-helper"
import { decideSyncAction, applySyncDecision, logCrmAudit, type LeadOracleRow } from "@/lib/crm/smart-sync"
import { revalidatePath } from "next/cache"

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: leadId } = await params
  if (!UUID_RE.test(leadId)) return NextResponse.json({ error: "Invalid leadId" }, { status: 400 })

  const auth = await authorize("admin", leadId)
  if (!auth.ok) return auth.response

  const { data: lead } = await auth.admin
    .from("v_crm_lead_list")
    .select("*")
    .eq("id", leadId)
    .maybeSingle()
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 })

  const decision = decideSyncAction(lead as LeadOracleRow)
  if (decision.kind === "noop") {
    return NextResponse.json({ ok: false, decision, reason: "no_action_needed" })
  }

  const result = await applySyncDecision(auth.admin, lead as LeadOracleRow, decision)
  await logCrmAudit(auth.admin, {
    actor_id: auth.userId,
    actor_email: auth.email,
    action: `smart_sync:${decision.kind}`,
    lead_id: leadId,
    payload_before: result.before,
    payload_after: result.after,
    reason: decision.reason,
  })

  revalidatePath("/dashboard/crm")
  return NextResponse.json({ ok: result.ok, decision, before: result.before, after: result.after })
}
