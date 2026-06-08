export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

// POST /api/runtime-config/heartbeat
//
// Body: {
//   account_id: string (uuid),
//   ext_version: string (e.g. "0.7.12"),
//   phase_timeouts: object,
//   send_method_order: array,
//   page_errors_extra: array
// }
//
// Llamado por content.js después de loadRuntimeConfig() exitoso. Persiste
// en runtime_config_heartbeat (upsert por account_id) para que phase-analyzer
// detecte drift (P2-2) y T13 verifique que content.js leyó la config nueva.
//
// v0.7.13 P0-1 verification + P2-2 drift detection.
export async function POST(req: NextRequest) {
  let body: any = null
  try { body = await req.json() } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS })
  }
  if (!body?.account_id) {
    return NextResponse.json({ error: "account_id_required" }, { status: 400, headers: CORS })
  }

  const admin = createAdminClient() as any
  const { error } = await admin
    .from("runtime_config_heartbeat")
    .upsert({
      account_id: body.account_id,
      reported_at: new Date().toISOString(),
      ext_version: body.ext_version ?? null,
      phase_timeouts: body.phase_timeouts ?? null,
      send_method_order: body.send_method_order ?? null,
      page_errors_extra: body.page_errors_extra ?? null,
    }, { onConflict: "account_id" })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: CORS })
  }
  return NextResponse.json({ ok: true }, { headers: CORS })
}
