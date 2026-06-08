export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { ROLE_LEVEL } from "@/lib/auth/role"

// POST { accountId?: string }
// Dispatcha un check_inbox con deepScrape:true para barrer hasta 15 días atrás.
// Las conversaciones que NO matchean un lead en Orion se logan en orphan_conversations.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const admin = createAdminClient()
  const { data: profile } = await admin
    .from("profiles")
    .select("role, linkedin_account_id")
    .eq("id", user.id)
    .single()
  const userLevel = ROLE_LEVEL[profile?.role as keyof typeof ROLE_LEVEL] ?? 0
  const isAdmin = userLevel >= ROLE_LEVEL.admin

  let body: { accountId?: string } = {}
  try { body = await req.json() } catch {}

  // Determinar accountId(s) target
  let accountIds: string[] = []
  if (isAdmin && body.accountId) {
    accountIds = [body.accountId]
  } else if (isAdmin && !body.accountId) {
    const { data: all } = await admin.from("linkedin_accounts").select("id")
    accountIds = (all ?? []).map(a => a.id)
  } else {
    if (!profile?.linkedin_account_id) {
      return NextResponse.json({ error: "no_account_linked" }, { status: 400 })
    }
    accountIds = [profile.linkedin_account_id]
  }

  if (accountIds.length === 0) {
    return NextResponse.json({ error: "no_target_accounts" }, { status: 400 })
  }

  // Insertar 1 cmd por cuenta. Bridge poll los disparará en su próximo ciclo.
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString()  // 15min TTL (deep scrape tarda)
  const rows = accountIds.map(accountId => ({
    account_id: accountId,
    action:     "check_inbox" as const,
    payload:    { deepScrape: true, daysWindow: 15, limit: 500, captureThreads: true, maxCaptures: 15 },
    status:     "pending" as const,
    expires_at: expiresAt,
  }))

  const { data: inserted, error } = await admin
    .from("extension_commands")
    .insert(rows)
    .select("id, account_id")

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    dispatched: inserted?.length ?? 0,
    commandIds: (inserted ?? []).map(r => r.id),
  })
}
