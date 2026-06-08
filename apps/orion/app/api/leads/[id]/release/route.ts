export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { ROLE_LEVEL } from "@/lib/auth/role"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const admin = createAdminClient()
  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single()
  const userLevel = ROLE_LEVEL[profile?.role as keyof typeof ROLE_LEVEL] ?? 0
  // Requiere admin (≥2). El usuario que liberaría manualmente debería ser staff,
  // no operador final; ajustar si la policy cambia.
  if (userLevel < 2) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id: leadId } = await params
  if (!UUID_RE.test(leadId)) {
    return NextResponse.json({ error: "Invalid leadId" }, { status: 400 })
  }

  // Validar ownership para roles restringidos (mismo patrón que cancel-auto-reply)
  if (userLevel < 3) {
    const { data: me } = await admin.from("profiles").select("linkedin_account_id").eq("id", user.id).single()
    const { data: lead } = await admin
      .from("leads")
      .select("campaign_id, campaigns(linkedin_account_id)")
      .eq("id", leadId)
      .single()
    const leadAccountId = lead?.campaigns?.linkedin_account_id
    if (leadAccountId !== me?.linkedin_account_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }
  }

  const { error } = await admin.from("leads").update({
    consecutive_failures: 0,
    cooldown_until:       null,
    quarantined_at:       null,
    last_failure_at:      null,
    last_failure_reason:  null,
  }).eq("id", leadId)

  if (error) {
    console.error(`[release] lead ${leadId} failed: ${error.message}`)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  console.log(`[release] Lead ${leadId} released by ${user.email}`)
  return NextResponse.json({ ok: true })
}
