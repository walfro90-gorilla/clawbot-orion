export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { randomBytes } from "crypto"

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-orion-api-key",
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

// Devuelve status enriquecido para el popup de la extension.
// Public-ish: requiere apiKey en header — la extension la tiene.
// (Más liviano que hacer auth Supabase desde la extension.)

export async function GET(req: NextRequest) {
  const accountId = req.nextUrl.searchParams.get("accountId")
  const apiKey = req.headers.get("x-orion-api-key") ?? req.nextUrl.searchParams.get("apiKey")
  if (!accountId || !apiKey) {
    return NextResponse.json({ error: "accountId and apiKey required" }, { status: 400, headers: CORS })
  }

  const admin = createAdminClient()
  const { data: account } = await admin
    .from("linkedin_accounts")
    .select("id, label, status, warmup_status, extension_paused, daily_connection_limit, extension_api_key, last_inbox_check_at, last_sent_invites_check_at, extension_last_seen_at")
    .eq("id", accountId)
    .single()

  if (!account || account.extension_api_key !== apiKey) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS })
  }

  const mxDate = new Date(Date.now() - 6 * 3600 * 1000).toISOString().split("T")[0]
  const { data: activity } = await admin
    .from("daily_activity")
    .select("invites_sent, messages_sent, errors")
    .eq("linkedin_account_id", accountId)
    .eq("date", mxDate)
    .maybeSingle()

  // Last completed command
  const { data: lastCmd } = await admin
    .from("extension_commands")
    .select("action, status, completed_at, result, related_lead_id")
    .eq("account_id", accountId)
    .not("completed_at", "is", null)
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  // Pending count (queue)
  const { count: pendingCount } = await admin
    .from("extension_commands")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .in("status", ["pending", "dispatched"])

  // Bridge connection
  let bridgeOnline = false
  try {
    const r = await fetch("http://localhost:4002/health", {
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    })
    const j = await r.json()
    bridgeOnline = (j.connected_accounts ?? []).some((c: any) => c.accountId === accountId)
  } catch {}

  return NextResponse.json({
    account: {
      label: account.label,
      status: account.status,
      warmupStatus: account.warmup_status,
      paused: !!account.extension_paused,
      dailyCap: account.daily_connection_limit,
    },
    today: {
      invites: activity?.invites_sent ?? 0,
      messages: activity?.messages_sent ?? 0,
      errors: activity?.errors ?? 0,
    },
    pendingCommands: pendingCount ?? 0,
    lastCommand: lastCmd ? {
      action: lastCmd.action,
      status: lastCmd.status,
      completedAt: lastCmd.completed_at,
      result: (lastCmd.result as any)?.status ?? null,
      error: (lastCmd.result as any)?.error ?? null,
    } : null,
    bridgeOnline,
    lastInboxCheck: account.last_inbox_check_at,
    lastSentInvitesCheck: account.last_sent_invites_check_at,
  }, { headers: CORS })
}
