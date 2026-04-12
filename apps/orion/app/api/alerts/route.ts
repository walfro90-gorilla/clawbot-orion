export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"

// PATCH /api/alerts — resolve an alert
export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const admin = createAdminClient()
  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single()
  const roleLevel: Record<string, number> = { god_admin: 4, admin: 3, user: 2, viewer: 1 }
  if ((roleLevel[profile?.role ?? ""] ?? 0) < 2) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const body = await req.json()
  const { alertId } = body as { alertId: number }
  if (!alertId) return NextResponse.json({ error: "alertId required" }, { status: 400 })

  // Use RLS-scoped client — user can only resolve their own alerts
  const { error } = await supabase
    .from("account_alerts")
    .update({ resolved_at: new Date().toISOString(), resolved_by: user.email })
    .eq("id", alertId)
    .is("resolved_at", null)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

// POST /api/alerts/resolve-all — resolve all unresolved alerts
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const admin = createAdminClient()
  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single()
  if ((roleLevel[profile?.role ?? ""] ?? 0) < 3) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { error } = await supabase
    .from("account_alerts")
    .update({ resolved_at: new Date().toISOString(), resolved_by: user.email })
    .is("resolved_at", null)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

const roleLevel: Record<string, number> = { god_admin: 4, admin: 3, user: 2, viewer: 1 }
