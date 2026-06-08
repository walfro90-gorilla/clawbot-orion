export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
// Note: cast `admin as any` cuando uses tablas nuevas (phase_insights, runtime_config, learned_selectors) — TS types desactualizados respecto a las migrations recientes

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-orion-api-key",
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

// GET /api/dashboard/phase-analytics
//   ?accountId=<uuid>  (optional, filter by account)
//   ?windowHours=24   (default 24)
//
// Returns:
//   {
//     summary: { total_cmds_24h, sent_count, success_pct, by_status },
//     reliability: [{ phase_name, success_pct, p95_ms, occurrences }],
//     drift: [{ phase_name, p95_24h, p95_7d, drift_ratio }],
//     send_methods: [{ send_method, sent_count, success_pct }],
//     stuck_leads: [{ lead_name, stuck_at, occurrences }],
//     insights: [{ id, severity, category, phase_name, message, recommended_action, ... }]
//   }
export async function GET(req: NextRequest) {
  const accountId = req.nextUrl.searchParams.get("accountId")
  const windowHours = parseInt(req.nextUrl.searchParams.get("windowHours") ?? "24")

  // Auth: usar service role (este endpoint es para el dashboard interno)
  const admin = createAdminClient()
  const cutoff = new Date(Date.now() - windowHours * 3600_000).toISOString()

  // 1. Summary global
  let summaryQuery = admin
    .from("extension_commands")
    .select("status, result, account_id")
    .eq("action", "send_followup")
    .gte("created_at", cutoff)
  if (accountId) summaryQuery = summaryQuery.eq("account_id", accountId)
  const { data: cmds } = await summaryQuery

  const summary = {
    total_cmds: cmds?.length ?? 0,
    sent_count: cmds?.filter(c => {
      const s = (c.result as any)?.status
      return s === "sent_confirmed" || s === "sent_unconfirmed"
    }).length ?? 0,
    sent_confirmed: cmds?.filter(c => (c.result as any)?.status === "sent_confirmed").length ?? 0,
    sent_unconfirmed: cmds?.filter(c => (c.result as any)?.status === "sent_unconfirmed").length ?? 0,
    by_status: {} as Record<string, number>,
  }
  for (const c of cmds ?? []) {
    summary.by_status[c.status] = (summary.by_status[c.status] ?? 0) + 1
  }
  const success_pct = summary.total_cmds > 0
    ? Math.round((summary.sent_count / summary.total_cmds) * 1000) / 10
    : 0

  // 2. Reliability per phase (24h) — views nuevos no están en TS types, cast a any
  const adm = admin as any
  let relQuery = adm.from("v_phase_success_rate_24h").select("*")
  if (accountId) relQuery = relQuery.eq("account_id", accountId)
  const { data: reliability } = await relQuery

  // 3. Drift
  let driftQuery = adm.from("v_timeout_drift_24h_vs_7d").select("*").gte("drift_ratio", 1.5)
  if (accountId) driftQuery = driftQuery.eq("account_id", accountId)
  const { data: drift } = await driftQuery

  // 4. Send methods (siempre rolling 7d para tener señal)
  const { data: sendMethods } = await adm.from("v_send_method_distribution_7d").select("*")

  // 5. Stuck leads
  let stuckQuery = adm.from("v_lead_phase_stuck").select("*")
  if (accountId) stuckQuery = stuckQuery.eq("account_id", accountId)
  const { data: stuck } = await stuckQuery

  // 6. Top unacknowledged insights
  let insightsQuery = adm
    .from("v_phase_insights_unacknowledged")
    .select("*")
    .limit(20)
  if (accountId) insightsQuery = insightsQuery.eq("account_id", accountId)
  const { data: insights } = await insightsQuery

  // 7. Recent micro_phase_log timeline (top 5 cmds) — cast a any (cols nuevas no en TS types)
  let timelineQuery = (admin as any)
    .from("extension_commands")
    .select("id, created_at, current_phase, payload, result, micro_phase_log")
    .eq("action", "send_followup")
    .not("micro_phase_log", "is", null)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(5)
  if (accountId) timelineQuery = timelineQuery.eq("account_id", accountId)
  const { data: timelines } = await timelineQuery as { data: any[] | null }

  return NextResponse.json({
    summary: { ...summary, success_pct },
    reliability: reliability ?? [],
    drift: drift ?? [],
    send_methods: sendMethods ?? [],
    stuck_leads: stuck ?? [],
    insights: insights ?? [],
    recent_timelines: (timelines ?? []).map(t => ({
      id: t.id,
      created_at: t.created_at,
      current_phase: t.current_phase,
      lead_name: (t.payload as any)?.leadName,
      result_status: (t.result as any)?.status,
      phase_count: Array.isArray(t.micro_phase_log) ? t.micro_phase_log.length : 0,
      timeline: t.micro_phase_log,
    })),
    generated_at: new Date().toISOString(),
    window_hours: windowHours,
  }, { headers: CORS })
}

// POST /api/dashboard/phase-analytics/acknowledge
// Body: { insightId: number, by?: string }
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const { insightId, by } = body
  if (!insightId) {
    return NextResponse.json({ error: "insightId required" }, { status: 400, headers: CORS })
  }
  const admin = createAdminClient()
  const { error } = await (admin as any)
    .from("phase_insights")
    .update({
      acknowledged: true,
      acknowledged_at: new Date().toISOString(),
      acknowledged_by: by ?? "dashboard",
    })
    .eq("id", insightId)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: CORS })
  }
  return NextResponse.json({ ok: true, acknowledged: insightId }, { headers: CORS })
}
