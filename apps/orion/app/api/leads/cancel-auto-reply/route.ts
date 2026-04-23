export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"

const roleLevel: Record<string, number> = { god_admin: 4, admin: 3, user: 2, viewer: 1 }

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const admin = createAdminClient()
  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single()
  const userLevel = roleLevel[profile?.role ?? ""] ?? 0
  if (userLevel < 2) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await req.json()
  const { leadId } = body as { leadId: string }
  if (!leadId) return NextResponse.json({ error: "leadId is required" }, { status: 400 })

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!UUID_RE.test(leadId)) return NextResponse.json({ error: "Invalid leadId" }, { status: 400 })

  // Validate lead ownership for restricted roles
  if (userLevel < 3) {
    const { data: me } = await admin.from("profiles").select("linkedin_account_id").eq("id", user.id).single()
    const { data: lead } = await admin
      .from("leads")
      .select("campaign_id, campaigns(linkedin_account_id)")
      .eq("id", leadId)
      .single()
    const leadAccountId = (lead?.campaigns as any)?.linkedin_account_id
    if (leadAccountId !== me?.linkedin_account_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }
  }

  // Cancel the scheduled send — keep the draft for manual review
  await admin
    .from("conversations")
    .update({ ai_reply_scheduled_at: null })
    .eq("lead_id", leadId)

  console.log(`[cancel-auto-reply] Scheduled send cancelled for lead=${leadId} by ${user.email}`)
  return NextResponse.json({ ok: true })
}
