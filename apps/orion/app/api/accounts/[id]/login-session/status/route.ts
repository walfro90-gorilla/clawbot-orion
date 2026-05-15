export const runtime = "nodejs"

import { NextRequest, NextResponse }              from "next/server"
import { createAdminClient }                       from "@/lib/supabase/admin"
import { checkSessionAccess, dropSession }         from "@/lib/login-session-store"
import type { Json }                                from "@clawbot/db-types"

const CS_URL    = process.env.COOKIE_SERVER_URL!
const CS_SECRET = process.env.COOKIE_SERVER_SECRET!

// Hot path — polled 1/sec. Cache-only auth. The cache stores the userId, so
// we still know who triggered the save when the cookie is committed.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: accountId } = await params
  const sid = req.nextUrl.searchParams.get("sid")
  if (!sid) return NextResponse.json({ error: "missing sid" }, { status: 400 })

  const userId = checkSessionAccess(sid, accountId)
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const upstream = await fetch(`${CS_URL}/session/${sid}/status`, {
    headers: { "x-secret": CS_SECRET },
    cache:   "no-store",
  })

  if (!upstream.ok) {
    return NextResponse.json({ status: "error", reason: "cookie_server_unreachable" })
  }

  const data = await upstream.json() as {
    status:      string
    pageState:   string
    currentUrl:  string
    error:       string | null
    cookie:      string | null
    fingerprint: Json | null
  }

  // Forward intermediate states (active, cookie_pending, etc.) directly to client.
  if (data.status !== "cookie_stable" || !data.cookie) {
    return NextResponse.json({
      status:    data.status,
      pageState: data.pageState,
      error:     data.error,
    })
  }

  // ── COMMIT PATH (rare — only fires once per successful login) ──────────────
  const admin = createAdminClient()

  const { data: account } = await admin
    .from("linkedin_accounts")
    .select("id, proxy_url, label, fingerprint_json")
    .eq("id", accountId)
    .single()
  if (!account) {
    return NextResponse.json({ status: "error", reason: "account_not_found" }, { status: 404 })
  }

  // Validate cookie in a clean browser context with the SAME fingerprint used
  // to capture it. Prefer the fingerprint reported by the session (matches what
  // the cookie was bound to); fall back to the account's stored fingerprint.
  const validationFp = data.fingerprint ?? account.fingerprint_json ?? null
  const validation = await fetch(`${CS_URL}/validate-cookie`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "x-secret": CS_SECRET },
    body:    JSON.stringify({
      cookie:      data.cookie,
      proxyUrl:    account.proxy_url,
      fingerprint: validationFp,
    }),
  }).then(r => r.json()).catch(() => ({ valid: false, reason: "validator_error" }))

  if (!validation.valid) {
    console.warn(`[login-session] Cookie validation FAILED for account=${accountId}: reason=${validation.reason}`)
    return NextResponse.json({
      status:   "validation_failed",
      reason:   validation.reason,
      finalUrl: validation.finalUrl,
    })
  }

  // Save + reactivate. Persist the fingerprint alongside the cookie so all
  // worker scripts use the SAME UA/viewport as the capture — kills the
  // "same cookie, different browser" bot signal that triggered the May ban.
  await admin.from("linkedin_accounts").update({
    li_at_cookie:            data.cookie,
    li_at_cookie_updated_at: new Date().toISOString(),
    status:                  "active",
    ...(data.fingerprint ? {
      fingerprint_json:      data.fingerprint,
      fingerprint_locked_at: new Date().toISOString(),
    } : {}),
  }).eq("id", accountId)

  await admin.from("account_alerts").update({
    resolved_at: new Date().toISOString(),
    resolved_by: `auto — cookie captured & validated (user ${userId.slice(0, 8)})`,
  })
    .eq("linkedin_account_id", accountId)
    .eq("alert_type", "cookie_expiry")
    .is("resolved_at", null)

  // Close session and drop ownership cache entry
  dropSession(sid)
  await fetch(`${CS_URL}/session/${sid}`, {
    method:  "DELETE",
    headers: { "x-secret": CS_SECRET },
  }).catch(() => {})

  console.log(`[login-session] Cookie SAVED + VALIDATED for account=${accountId} (${account.label}) by user=${userId}`)
  return NextResponse.json({ status: "saved" })
}
