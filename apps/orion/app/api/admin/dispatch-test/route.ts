export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"

// POST /api/admin/dispatch-test
// Header: x-orion-admin-key (env ORION_ADMIN_KEY)
// Body: {
//   caseId: 'T03',
//   accountId: uuid,
//   leadId?: uuid,
//   action: 'send_followup' | 'send_invite' | 'search' | 'check_inbox',
//   payload: object,
//   dryRun?: true,
//   takeSnapshot?: true,
//   lockTtlSec?: 300
// }
//
// v0.7.13 stress test harness — endpoint para que dashboard/admin pueda
// disparar casos sin entrar al servidor. Replica lo esencial de
// tools/stress-driver.mjs en formato request/response.
export async function POST(req: NextRequest) {
  const adminKey = req.headers.get("x-orion-admin-key")
  const expected = process.env.ORION_ADMIN_KEY
  if (!expected || adminKey !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  let body: any = null
  try { body = await req.json() } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 })
  }
  const { caseId, accountId, leadId, action, payload, dryRun = true, takeSnapshot = true, lockTtlSec = 300 } = body ?? {}
  if (!caseId || !accountId || !action) {
    return NextResponse.json({ error: "caseId+accountId+action required" }, { status: 400 })
  }

  const admin = createAdminClient() as any

  // 1. snapshot (si hay lead)
  let snapshotId: number | null = null
  if (takeSnapshot && leadId) {
    const { data: lead } = await admin.from("leads").select("*").eq("id", leadId).maybeSingle()
    const { data: lastCmd } = await admin
      .from("extension_commands")
      .select("id, action, status, error, result, payload, current_phase, created_at, completed_at")
      .eq("related_lead_id", leadId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle()
    const { data: ins } = await admin
      .from("stress_snapshots")
      .insert({ case_id: caseId, lead_id: leadId, account_id: accountId, before: { lead, lastCmd }, notes: "via /api/admin/dispatch-test" })
      .select("id").single()
    snapshotId = ins?.id ?? null
  }

  // 2. set stress lock
  const lockExpiresAt = new Date(Date.now() + lockTtlSec * 1000).toISOString()
  await admin
    .from("runtime_config")
    .upsert({
      key: "stress_test_lock",
      value: { active: true, account_id: accountId, case_id: caseId, expires_at: lockExpiresAt },
      updated_by: `endpoint:${caseId}`,
      updated_at: new Date().toISOString(),
    }, { onConflict: "key" })

  // 3. insert command
  const enrichedPayload = { ...(payload ?? {}), is_stress_test: true, dryRun }
  const { data: cmd, error: cmdErr } = await admin
    .from("extension_commands")
    .insert({
      account_id: accountId,
      action,
      payload: enrichedPayload,
      status: "pending",
      expires_at: new Date(Date.now() + lockTtlSec * 1000).toISOString(),
      related_lead_id: leadId ?? null,
    })
    .select("id")
    .single()
  if (cmdErr) {
    return NextResponse.json({ error: `insert_failed: ${cmdErr.message}` }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    commandId: cmd.id,
    snapshotId,
    lockExpiresAt,
    pollUrl: `/api/extension-commands/${cmd.id}`,
    note: "Lock auto-expira en " + lockTtlSec + "s. Llamar DELETE /api/admin/dispatch-test/lock para liberar antes.",
  })
}

// DELETE /api/admin/dispatch-test/lock — libera stress_test_lock manualmente
export async function DELETE(req: NextRequest) {
  const adminKey = req.headers.get("x-orion-admin-key")
  if (!process.env.ORION_ADMIN_KEY || adminKey !== process.env.ORION_ADMIN_KEY) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }
  const admin = createAdminClient() as any
  await admin
    .from("runtime_config")
    .upsert({
      key: "stress_test_lock",
      value: { active: false },
      updated_by: "endpoint:cleared",
      updated_at: new Date().toISOString(),
    }, { onConflict: "key" })
  return NextResponse.json({ ok: true })
}
