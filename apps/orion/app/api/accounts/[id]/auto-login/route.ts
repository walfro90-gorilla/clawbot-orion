export const runtime = "nodejs"

import { NextRequest, NextResponse }    from "next/server"
import { randomUUID }                    from "crypto"
import { createClient }                  from "@/lib/supabase/server"
import { createAdminClient }             from "@/lib/supabase/admin"
import { ROLE_LEVEL }                    from "@/lib/auth/role"
import { registerSession }               from "@/lib/login-session-store"

const CS_URL    = process.env.COOKIE_SERVER_URL!
const CS_SECRET = process.env.COOKIE_SERVER_SECRET!

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
  if (level >= 3) return user
  if (profile?.linkedin_account_id === accountId) return user
  return null
}

// POST — kick off programmatic LinkedIn login with the user's credentials.
// Returns { sessionId } that the modal then polls via /status.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: accountId } = await params
  const user = await requireAccountAccess(accountId)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json()
  const email    = (body?.email    ?? "").toString().trim()
  const password = (body?.password ?? "").toString()

  // Basic input shape — actual validation is delegated to LinkedIn
  if (!email || !email.includes("@") || !password || password.length < 4) {
    return NextResponse.json({ error: "invalid_credentials_format" }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data: account } = await admin
    .from("linkedin_accounts")
    .select("id, proxy_url, fingerprint_json")
    .eq("id", accountId)
    .single()
  if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 })

  const sessionId = randomUUID()

  // Forward to cookie-server (credentials transit only over localhost).
  // Include the account's stored fingerprint so capture uses the same UA the
  // workers will use; cookie-server mints + returns a fresh one if null.
  const upstream = await fetch(`${CS_URL}/auto-login`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "x-secret": CS_SECRET },
    body:    JSON.stringify({
      sessionId,
      accountId,
      proxyUrl:    account.proxy_url,
      email,
      password,
      fingerprint: account.fingerprint_json ?? null,
    }),
  })

  if (!upstream.ok) {
    const err = await upstream.json().catch(() => ({}))
    return NextResponse.json({ error: (err as any).error ?? "cookie-server error" }, { status: 502 })
  }

  registerSession(sessionId, user.id, accountId)

  // Never log credentials
  console.log(`[auto-login] Session ${sessionId.slice(0, 8)}… started for account=${accountId} by ${user.email}`)
  return NextResponse.json({ sessionId })
}
