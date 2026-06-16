// GET /api/crm/list — leads filtrable + stage tray + health tray counts
// Query params: account_id, status, health (flag name), search, page, limit
// Auth: user (scoped a su account).
export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { authorize } from "@/lib/crm/auth-helper"

const DEFAULT_LIMIT = 100

export async function GET(req: NextRequest) {
  const auth = await authorize("user")
  if (!auth.ok) return auth.response

  const sp = req.nextUrl.searchParams
  const accountIdQ = sp.get("account_id")
  const statusFilter = sp.get("status")
  const healthFilter = sp.get("health")
  const search = sp.get("search")?.trim()
  const page = Math.max(0, parseInt(sp.get("page") ?? "0"))
  const limit = Math.min(500, Math.max(10, parseInt(sp.get("limit") ?? String(DEFAULT_LIMIT))))

  // Scope: si user (level 2) tiene linkedin_account_id, forzar ese filtro
  const scopedAccountId = auth.level < 3 ? auth.accountId : accountIdQ

  // Fail-closed: un restringido (level<3) SIN cuenta vinculada NO puede ver nada.
  // Sin este guard, scopedAccountId=null saltaría el .eq de abajo (fail-open) y la
  // query via admin client (ignora RLS) devolvería leads de TODAS las cuentas.
  if (auth.level < 3 && !scopedAccountId) {
    return NextResponse.json({
      leads: [], total: 0, page, limit,
      stage_counts: {}, health_counts: { healthy: 0 },
      scope: { account_id: null, role: auth.role },
      fetched_at: new Date().toISOString(),
    })
  }

  let q = (auth.admin as any).from("v_crm_lead_list").select("*", { count: "exact" })
  if (scopedAccountId) q = q.eq("linkedin_account_id", scopedAccountId)
  if (statusFilter) q = q.eq("status", statusFilter)
  if (healthFilter) q = q.contains("health_flags", { [healthFilter]: true })
  if (search) q = q.ilike("full_name", `%${search}%`)

  const { data: leads, count, error } = await q
    .order("health_priority", { ascending: true })
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .range(page * limit, page * limit + limit - 1)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Stage tray + health tray counts (parallel queries)
  const [stageRes, healthRes] = await Promise.all([
    auth.admin
      .from("v_crm_lead_list")
      .select("status")
      .eq(scopedAccountId ? "linkedin_account_id" : "id", scopedAccountId ?? leads?.[0]?.id ?? "no-match"),
    auth.admin
      .from("v_crm_lead_list")
      .select("health_flags")
      .eq(scopedAccountId ? "linkedin_account_id" : "id", scopedAccountId ?? leads?.[0]?.id ?? "no-match"),
  ])

  const stageCounts: Record<string, number> = {}
  for (const r of stageRes.data ?? []) {
    const s = (r as any).status
    if (s) stageCounts[s] = (stageCounts[s] ?? 0) + 1
  }

  const healthCounts: Record<string, number> = { healthy: 0 }
  for (const r of healthRes.data ?? []) {
    const flags = (r as any).health_flags as Record<string, boolean> | null
    if (!flags || Object.keys(flags).length === 0) {
      healthCounts.healthy++
    } else {
      for (const k of Object.keys(flags)) {
        healthCounts[k] = (healthCounts[k] ?? 0) + 1
      }
    }
  }

  return NextResponse.json({
    leads: leads ?? [],
    total: count ?? 0,
    page, limit,
    stage_counts: stageCounts,
    health_counts: healthCounts,
    scope: { account_id: scopedAccountId, role: auth.role },
    fetched_at: new Date().toISOString(),
  })
}
