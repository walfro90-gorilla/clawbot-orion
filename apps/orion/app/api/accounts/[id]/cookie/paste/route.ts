export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createClient }               from "@/lib/supabase/server"
import { createAdminClient }          from "@/lib/supabase/admin"
import { ROLE_LEVEL }                 from "@/lib/auth/role"

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

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/accounts/[id]/cookie/paste
//
// Manual cookie paste flow — fastest path to renew a LinkedIn cookie when the
// streaming OAuth dance is too slow (Google login, MS login, etc.). The user
// logs in normally in their own browser, copies the `li_at` cookie value, and
// pastes it here. We validate it via cookie-server's /validate-cookie endpoint
// (which mounts the cookie in a clean Playwright context behind the account's
// proxy + fingerprint) and persist if it actually authenticates.
//
// Body: { li_at: string }
//   - Accepts a raw cookie value OR a "Cookie: li_at=..." string OR even a
//     `Set-Cookie` header — we extract the value below.
//
// Returns:
//   200 { ok: true }                                      — saved + activated
//   400 { error: "invalid_format" }                       — couldn't parse cookie
//   422 { error: "validation_failed", reason: "..." }     — LinkedIn rejected it
//   401/404 { error }                                     — auth/permission
// ──────────────────────────────────────────────────────────────────────────────
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: accountId } = await params
  const user = await requireAccountAccess(accountId)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const raw  = (body?.li_at ?? "").toString().trim()

  // Extract the actual cookie value from common paste formats
  const liAt = extractLiAt(raw)
  if (!liAt) {
    return NextResponse.json({ error: "invalid_format" }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data: account } = await admin
    .from("linkedin_accounts")
    .select("id, label, proxy_url, fingerprint_json")
    .eq("id", accountId)
    .single()
  if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 })

  // Validate against LinkedIn via the same fingerprint+proxy combo used by
  // the workers. If the validator says "valid", the cookie actually
  // authenticates (no redirect loop, no captcha redirect).
  const validation = await fetch(`${CS_URL}/validate-cookie`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "x-secret": CS_SECRET },
    body:    JSON.stringify({
      cookie:      liAt,
      proxyUrl:    account.proxy_url,
      fingerprint: account.fingerprint_json ?? null,
    }),
  }).then(r => r.json()).catch(() => ({ valid: false, reason: "validator_error" }))

  if (!validation.valid) {
    console.warn(`[paste-cookie] Validation FAILED for account=${accountId}: reason=${validation.reason}`)
    return NextResponse.json({
      error:    "validation_failed",
      reason:   validation.reason,
      finalUrl: validation.finalUrl,
    }, { status: 422 })
  }

  // Save. Keep the existing fingerprint — we did NOT capture a new one because
  // the cookie was minted on the user's local browser. The validation above
  // proved the existing fingerprint still passes LinkedIn's check.
  await admin.from("linkedin_accounts").update({
    li_at_cookie:            liAt,
    li_at_cookie_updated_at: new Date().toISOString(),
    status:                  "active",
  }).eq("id", accountId)

  // Auto-resolve any active cookie_expiry alerts for this account.
  await admin.from("account_alerts").update({
    resolved_at: new Date().toISOString(),
    resolved_by: `auto — cookie pasted manually (user ${user.id.slice(0, 8)})`,
  })
    .eq("linkedin_account_id", accountId)
    .eq("alert_type", "cookie_expiry")
    .is("resolved_at", null)

  console.log(`[paste-cookie] Cookie pasted + validated + saved for account=${accountId} (${account.label}) by ${user.email}`)
  return NextResponse.json({ ok: true })
}

// Accepts:
//   - "AQEDARxtQb8...rd"                             ← bare value
//   - "li_at=AQEDARxtQb8...rd"                       ← name=value
//   - "Cookie: li_at=AQED...rd; bcookie=...; ..."    ← Cookie header
//   - "li_at=AQED...rd; Path=/; Secure; HttpOnly"    ← Set-Cookie format
//
// LinkedIn's li_at cookie starts with "AQED" and is ~150 chars of base64-ish.
// We're permissive on input but strict on what we accept as final value:
// must look cookie-shaped (no spaces, no quotes, length sane).
function extractLiAt(input: string): string | null {
  if (!input) return null

  let v = input.trim()

  // Strip surrounding quotes
  v = v.replace(/^["']+|["']+$/g, "")

  // If contains "li_at=" anywhere, pull from there to ; or end
  const m = v.match(/li_at\s*=\s*([^;\s]+)/i)
  if (m) v = m[1]

  // Strip wrapping quotes again (Set-Cookie sometimes wraps values)
  v = v.replace(/^["']+|["']+$/g, "")

  // Sanity check: must be ~100+ chars, no whitespace, base64-ish chars
  if (v.length < 80 || v.length > 500) return null
  if (/\s/.test(v)) return null
  if (!/^[A-Za-z0-9_\-=+/.]+$/.test(v)) return null

  return v
}
