export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { ROLE_LEVEL } from "@/lib/auth/role"

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const admin = createAdminClient()
  const { data: profile } = await admin.from("profiles").select("role, linkedin_account_id").eq("id", user.id).single()
  const userLevel = ROLE_LEVEL[profile?.role as keyof typeof ROLE_LEVEL] ?? 0
  if (userLevel < 2) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const sp = new URL(req.url).searchParams
  const campaignId = sp.get("campaign")
  const status     = sp.get("status")

  let query = admin
    .from("v_lead_pipeline")
    .select("full_name, linkedin_url, status, campaign_name, sent_at, accepted_at")
    .order("sent_at", { ascending: false })
    .limit(5000)

  // Non-admins: restrict to their account's campaigns
  if (userLevel < 3 && profile?.linkedin_account_id) {
    const { data: acctCampaigns } = await admin
      .from("campaigns")
      .select("id")
      .eq("linkedin_account_id", profile.linkedin_account_id)
    const ids = (acctCampaigns ?? []).map((c: any) => c.id)
    if (ids.length === 0) return new NextResponse("sin leads", { status: 200 })
    query = query.in("campaign_id", ids)
  }

  if (campaignId) query = query.eq("campaign_id", campaignId)
  if (status)     query = query.eq("status", status)

  const { data: leads } = await query

  const rows = leads ?? []
  const headers = ["Nombre", "LinkedIn URL", "Estado", "Campaña", "Enviado", "Aceptado"]
  const csvLines = [
    headers.join(","),
    ...rows.map((l: any) => [
      `"${(l.full_name ?? "").replace(/"/g, '""')}"`,
      `"${l.linkedin_url ?? ""}"`,
      l.status ?? "",
      `"${(l.campaign_name ?? "").replace(/"/g, '""')}"`,
      l.sent_at     ? new Date(l.sent_at).toISOString().slice(0,10)     : "",
      l.accepted_at ? new Date(l.accepted_at).toISOString().slice(0,10) : "",
    ].join(",")),
  ]
  const csv = csvLines.join("\n")

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="leads-${new Date().toISOString().slice(0,10)}.csv"`,
    },
  })
}
