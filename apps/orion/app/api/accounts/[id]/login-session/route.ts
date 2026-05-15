export const runtime = "nodejs"

import { NextRequest, NextResponse }                 from "next/server"
import { randomUUID }                                 from "crypto"
import { createClient }                               from "@/lib/supabase/server"
import { createAdminClient }                          from "@/lib/supabase/admin"
import { ROLE_LEVEL }                                 from "@/lib/auth/role"
import { registerSession, dropSession }               from "@/lib/login-session-store"

const CS_URL    = process.env.COOKIE_SERVER_URL!
const CS_SECRET = process.env.COOKIE_SERVER_SECRET!

// Returns user if authorized: owner of account OR admin/god_admin
async function requireAccountAccess(accountId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const admin = createAdminClient()
  const { data: profile } = await admin
    .from("profiles")
    .select("role, linkedin_account_id")
    .eq("id", user.id)
    .single()
  const level = ROLE_LEVEL[profile?.role as keyof typeof ROLE_LEVEL] ?? 0
  if (level >= 3) return user                                  // admin or god_admin → all accounts
  if (profile?.linkedin_account_id === accountId) return user  // owner → only own account
  return null
}

// POST — start a new browser session, returns { sessionId }
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: accountId } = await params
  const user = await requireAccountAccess(accountId)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const flow = body?.flow === "google" ? "google" : undefined  // whitelist flow values

  const admin = createAdminClient()

  const { data: account } = await admin
    .from("linkedin_accounts")
    .select("id, proxy_url, label, fingerprint_json")
    .eq("id", accountId)
    .single()

  if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 })

  const sessionId = randomUUID()

  // Pass the account's stored fingerprint so the cookie-server uses the SAME
  // UA/viewport that previous sessions used. If null, cookie-server mints a
  // fresh one and we persist it on cookie save (status route).
  const upstream = await fetch(`${CS_URL}/session`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "x-secret": CS_SECRET },
    body:    JSON.stringify({
      sessionId,
      proxyUrl:    account.proxy_url,
      accountId,
      flow,
      fingerprint: account.fingerprint_json ?? null,
    }),
  })

  if (!upstream.ok) {
    const err = await upstream.json().catch(() => ({}))
    return NextResponse.json({ error: (err as any).error ?? "cookie-server error" }, { status: 502 })
  }

  // Register ownership so /frame, /status, /input can skip the per-request auth roundtrip.
  registerSession(sessionId, user.id, accountId)

  return NextResponse.json({ sessionId })
}

// DELETE — close session
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: accountId } = await params
  const user = await requireAccountAccess(accountId)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const sid = req.nextUrl.searchParams.get("sid")
  if (sid) {
    dropSession(sid)
    await fetch(`${CS_URL}/session/${sid}`, {
      method:  "DELETE",
      headers: { "x-secret": CS_SECRET },
    }).catch(() => {})
  }

  return NextResponse.json({ ok: true })
}
