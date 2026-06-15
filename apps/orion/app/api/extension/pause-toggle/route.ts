export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-orion-api-key",
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const accountId = body.accountId as string | undefined
  const apiKey = req.headers.get("x-orion-api-key") ?? body.apiKey
  const desired = body.paused as boolean | undefined

  if (!accountId || !apiKey) {
    return NextResponse.json({ error: "accountId and apiKey required" }, { status: 400, headers: CORS })
  }

  // `as any`: extension_paused_reason existe en la DB pero los tipos generados
  // están stale (mismo caso que automation_paused en el CRM). NO borres el
  // labeling de reason para callar el type error — regenera los tipos o deja el
  // cast. Ese labeling es el fix de los "pausers silenciosos" (reason=NULL).
  const admin = createAdminClient() as any
  const { data: account } = await admin
    .from("linkedin_accounts")
    .select("id, extension_paused, extension_api_key")
    .eq("id", accountId)
    .single()

  if (!account || account.extension_api_key !== apiKey) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS })
  }

  const newValue = typeof desired === "boolean" ? desired : !account.extension_paused
  // v0.8 observabilidad: etiquetar el ORIGEN de la pausa para no dejar "pausers
  // silenciosos" (reason=NULL que se confunde con el circuit breaker). El caller
  // (extensión Chrome o dashboard) puede mandar body.reason; default neutro.
  // Al despausar se limpia el reason. Hace VISIBLE de dónde viene cada pausa.
  const reason = newValue
    ? (typeof body.reason === "string" && body.reason ? body.reason.slice(0, 64) : "manual_toggle")
    : null
  const { error } = await admin
    .from("linkedin_accounts")
    .update({ extension_paused: newValue, extension_paused_reason: reason })
    .eq("id", accountId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500, headers: CORS })

  return NextResponse.json({ paused: newValue }, { headers: CORS })
}
