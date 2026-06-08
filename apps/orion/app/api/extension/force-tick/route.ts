export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-orion-api-key",
}
export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }) }

// POST /api/extension/force-tick
// Body: { accountId, action?: 'check_inbox' | 'check_sent_invites' }
// Auth: x-orion-api-key
//
// Inserta un cmd inmediato en extension_commands. Bridge lo dispatcha en
// próximos segundos (no tiene que esperar el tick 90s del scheduler).
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const { accountId, action = "check_inbox" } = body
  const apiKey = req.headers.get("x-orion-api-key")
  if (!accountId || !apiKey) {
    return NextResponse.json({ error: "accountId+apiKey required" }, { status: 400, headers: CORS })
  }
  const admin = createAdminClient() as any
  const { data: account } = await admin
    .from("linkedin_accounts")
    .select("id, label, extension_api_key")
    .eq("id", accountId).single()
  if (!account || account.extension_api_key !== apiKey) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS })
  }

  const validActions = ["check_inbox", "check_sent_invites"]
  if (!validActions.includes(action)) {
    return NextResponse.json({ error: `action must be one of ${validActions.join("|")}` }, { status: 400, headers: CORS })
  }

  // Payload mínimo para cada action
  const payload: any =
    action === "check_inbox"
      ? { deepScrape: true, daysWindow: 7, limit: 30, captureThreads: true, maxCaptures: 15 }
      : {}

  // Expires 5min (corto — es ad-hoc, no esperamos esperas largas)
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString()

  const { data: cmd, error } = await admin
    .from("extension_commands")
    .insert({
      account_id: accountId,
      action,
      payload,
      status: "pending",
      expires_at: expiresAt,
    })
    .select("id, created_at")
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500, headers: CORS })

  return NextResponse.json({
    ok: true,
    cmd_id: cmd.id,
    action,
    note: "El bridge lo dispatcha en próximos 1-5s al next tick interno.",
  }, { headers: CORS })
}
