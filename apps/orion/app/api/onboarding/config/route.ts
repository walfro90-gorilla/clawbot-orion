export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"

// Guarda la config mínima de campaña desde el wizard self-serve.
// SCOPING: deriva el accountId de la SESIÓN (profile.linkedin_account_id), NUNCA del body
// → un cliente solo puede configurar SU propia cuenta. Escribe a columnas de campaigns
// (NO account_config → no lockea el auto-learning).

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const admin = createAdminClient()
  const { data: profile } = await admin
    .from("profiles")
    .select("linkedin_account_id")
    .eq("id", user.id)
    .single()
  const accountId = profile?.linkedin_account_id
  if (!accountId) return NextResponse.json({ error: "no_account" }, { status: 400 })

  const { data: camps } = await admin
    .from("campaigns")
    .select("id")
    .eq("linkedin_account_id", accountId)
    .order("created_at", { ascending: false })
  const campId = camps?.[0]?.id
  if (!campId) return NextResponse.json({ error: "no_campaign" }, { status: 400 })

  const body = await req.json().catch(() => ({}))
  const parseList = (v: unknown): string[] =>
    typeof v === "string" ? v.split(",").map(s => s.trim()).filter(Boolean)
    : Array.isArray(v) ? v.filter(Boolean) as string[]
    : []

  const upd: Record<string, unknown> = {}
  if (body.search_keywords !== undefined)    upd.search_keywords    = parseList(body.search_keywords)
  if (body.search_location !== undefined)    upd.search_location    = (body.search_location as string) || null
  if (body.title_whitelist !== undefined)    upd.title_whitelist    = parseList(body.title_whitelist)
  if (body.ai_sender_persona !== undefined)  upd.ai_sender_persona  = (body.ai_sender_persona as string) || null
  if (body.target_audience !== undefined)    upd.target_audience    = (body.target_audience as string) || null
  if (body.daily_invite_target !== undefined)
    upd.daily_invite_target = Math.max(1, Math.min(30, Number(body.daily_invite_target) || 8))

  if (Object.keys(upd).length === 0) return NextResponse.json({ ok: true, noop: true })

  const { error } = await admin.from("campaigns").update(upd as never).eq("id", campId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
