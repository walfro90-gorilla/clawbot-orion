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

  const admin = createAdminClient()
  const { data: account } = await admin
    .from("linkedin_accounts")
    .select("id, extension_paused, extension_api_key")
    .eq("id", accountId)
    .single()

  if (!account || account.extension_api_key !== apiKey) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS })
  }

  const newValue = typeof desired === "boolean" ? desired : !account.extension_paused
  const { error } = await admin
    .from("linkedin_accounts")
    .update({ extension_paused: newValue })
    .eq("id", accountId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500, headers: CORS })

  return NextResponse.json({ paused: newValue }, { headers: CORS })
}
