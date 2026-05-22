export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { randomBytes } from "crypto"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { ROLE_LEVEL } from "@/lib/auth/role"

// Genera (o regenera) la API key de la extension para una cuenta LinkedIn.
// Solo admins o el dueño de la cuenta pueden generarla.

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const accountId = body.accountId as string | undefined
  if (!accountId) return NextResponse.json({ error: "accountId required" }, { status: 400 })

  const admin = createAdminClient()
  const { data: profile } = await admin
    .from("profiles")
    .select("role, linkedin_account_id")
    .eq("id", user.id)
    .single()

  const userLevel = ROLE_LEVEL[profile?.role as keyof typeof ROLE_LEVEL] ?? 0
  const isAdmin = userLevel >= ROLE_LEVEL.admin
  const isOwner = profile?.linkedin_account_id === accountId
  if (!isAdmin && !isOwner) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 })
  }

  const apiKey = "orion_sk_" + randomBytes(16).toString("hex")
  const { error } = await admin
    .from("linkedin_accounts")
    .update({ extension_api_key: apiKey })
    .eq("id", accountId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ apiKey })
}
