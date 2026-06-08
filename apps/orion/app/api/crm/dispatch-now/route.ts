// POST /api/crm/dispatch-now
// Body: { lead_id, action='send_followup'|'send_invite'|'check_inbox', payload }
// Inserta extension_command con is_stress_test=true bajo stress_test_lock TTL 30s.
// Auth: admin. Precheck: rechaza si hay otro cmd pending/dispatched para el lead.
export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { authorize, UUID_RE } from "@/lib/crm/auth-helper"
import { logCrmAudit } from "@/lib/crm/smart-sync"

const LOCK_TTL_SEC = 30

export async function POST(req: NextRequest) {
  let body: any = null
  try { body = await req.json() } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }) }

  const leadId = body?.lead_id
  const action = body?.action
  const payload = body?.payload ?? {}
  if (!leadId || !UUID_RE.test(leadId)) return NextResponse.json({ error: "lead_id uuid required" }, { status: 400 })
  if (!["send_followup", "send_invite", "check_inbox"].includes(action)) {
    return NextResponse.json({ error: "action invalid" }, { status: 400 })
  }

  const auth = await authorize("admin", leadId)
  if (!auth.ok) return auth.response

  const { data: lead } = await auth.admin
    .from("leads")
    .select("id, campaigns(linkedin_account_id)")
    .eq("id", leadId).maybeSingle()
  const accountId = (lead?.campaigns as any)?.linkedin_account_id
  if (!accountId) return NextResponse.json({ error: "Lead has no account" }, { status: 400 })

  // Precheck: hay otro cmd activo?
  const { count: activeCount } = await auth.admin
    .from("extension_commands")
    .select("id", { count: "exact", head: true })
    .eq("related_lead_id", leadId)
    .in("status", ["pending", "dispatched"])
  if ((activeCount ?? 0) > 0) {
    return NextResponse.json({ error: "Lead has active command", count: activeCount }, { status: 409 })
  }

  // Set stress_test_lock
  const expiresAt = new Date(Date.now() + LOCK_TTL_SEC * 1000).toISOString()
  await auth.admin
    .from("runtime_config")
    .upsert({
      key: "stress_test_lock",
      value: { active: true, account_id: accountId, case_id: `crm:${action}`, expires_at: expiresAt },
      updated_by: `crm-dispatch:${auth.email ?? auth.userId}`,
      updated_at: new Date().toISOString(),
    }, { onConflict: "key" })

  // Insert command
  const enrichedPayload = { ...payload, leadId, is_stress_test: true, dryRun: false }
  const { data: cmd, error: cmdErr } = await auth.admin
    .from("extension_commands")
    .insert({
      account_id: accountId,
      action,
      payload: enrichedPayload,
      status: "pending",
      expires_at: expiresAt,
      related_lead_id: leadId,
    })
    .select("id")
    .single()
  if (cmdErr) return NextResponse.json({ error: cmdErr.message }, { status: 500 })

  await logCrmAudit(auth.admin, {
    actor_id: auth.userId, actor_email: auth.email,
    action: `dispatch_now:${action}`, lead_id: leadId,
    payload_before: {}, payload_after: { command_id: cmd.id, action, expires_at: expiresAt },
    reason: `manual_dispatch_via_crm`,
  })

  return NextResponse.json({ ok: true, command_id: cmd.id, expires_at: expiresAt })
}
