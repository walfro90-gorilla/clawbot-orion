// POST /api/crm/lead/[id]/reset-skip
// Reset lockout_skip_count → 0. Auth: admin.
export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { authorize, UUID_RE } from "@/lib/crm/auth-helper"
import { logCrmAudit } from "@/lib/crm/smart-sync"
import { revalidatePath } from "next/cache"

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: leadId } = await params
  if (!UUID_RE.test(leadId)) return NextResponse.json({ error: "Invalid leadId" }, { status: 400 })

  const auth = await authorize("admin", leadId)
  if (!auth.ok) return auth.response

  const { data: before } = await auth.admin
    .from("leads")
    .select("lockout_skip_count, status, dead_reason")
    .eq("id", leadId).maybeSingle()
  if (!before) return NextResponse.json({ error: "Lead not found" }, { status: 404 })

  const patch: Record<string, unknown> = { lockout_skip_count: 0 }
  // Si el lead estaba dead por lockout_dead_no_thread, revivir a connected
  if (before.status === "dead" && before.dead_reason === "lockout_dead_no_thread") {
    patch.status = "connected"
    patch.dead_reason = null
  }

  const { error } = await auth.admin.from("leads").update(patch as any).eq("id", leadId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await logCrmAudit(auth.admin, {
    actor_id: auth.userId, actor_email: auth.email,
    action: "reset_skip", lead_id: leadId,
    payload_before: before, payload_after: patch,
    reason: "manual_reset_lockout_skip_count",
  })

  revalidatePath("/dashboard/crm")
  return NextResponse.json({ ok: true, before, after: patch })
}
