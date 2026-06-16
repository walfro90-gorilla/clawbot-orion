// POST /api/crm/lead/[id]/toggle-automation — auth: user (dueño de la cuenta) o admin
// Pausa/reanuda la automatización (auto-reply + follow-ups) para UN contacto.
// No cambia el status del lead ni borra el hilo: solo setea leads.automation_paused.
// Los gates del scheduler (tryAutoReplyForCampaign / tryFollowupsForCampaign) ya
// excluyen leads con automation_paused = true. Reversible.
// authorize("user", leadId) valida que un user solo pueda tocar leads de SU PROPIA
// cuenta (ownership check para level < 3) → un cliente no puede pausar lo de otro.
export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { authorize, UUID_RE } from "@/lib/crm/auth-helper"
import { logCrmAudit } from "@/lib/crm/smart-sync"
import { revalidatePath } from "next/cache"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: leadId } = await params
  if (!UUID_RE.test(leadId)) return NextResponse.json({ error: "Invalid leadId" }, { status: 400 })
  const auth = await authorize("user", leadId)
  if (!auth.ok) return auth.response

  // leads.automation_paused aún no está en los tipos generados (stale) → as any,
  // consistente con el resto del CRM (ver app/api/crm/bulk/route.ts).
  const admin = auth.admin as any

  let body: any = null
  try { body = await req.json() } catch { /* sin body = toggle */ }

  const { data: lead } = await admin
    .from("leads")
    .select("id, automation_paused")
    .eq("id", leadId)
    .maybeSingle()
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 })

  const current = !!lead.automation_paused
  const next = typeof body?.paused === "boolean" ? body.paused : !current

  const { error } = await admin
    .from("leads")
    .update({
      automation_paused: next,
      automation_paused_at: next ? new Date().toISOString() : null,
    })
    .eq("id", leadId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await logCrmAudit(auth.admin, {
    actor_id: auth.userId,
    actor_email: auth.email,
    action: next ? "pause_automation" : "resume_automation",
    lead_id: leadId,
    payload_before: { automation_paused: current },
    payload_after: { automation_paused: next },
    reason: typeof body?.reason === "string" ? body.reason : (next ? "pause_automation" : "resume_automation"),
  })

  revalidatePath("/dashboard/crm")
  return NextResponse.json({ ok: true, automation_paused: next })
}
