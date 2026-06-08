export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-orion-api-key",
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

// GET /api/runtime-config
//   ?key=phase_timeouts  (optional, single key)
//
// Public-ish: no requiere auth porque solo lee config no-sensible (timeouts,
// send order, page_errors_extra). Si quieres protegerlo, agregar header check.
//
// Used by:
//   - content.js MicroPhaseRunner (lee timeouts)
//   - content.js trySend (lee send_method_order)
//   - bridge isPageError (lee page_errors_extra)
export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key")
  const admin = createAdminClient() as any

  if (key) {
    const { data, error } = await admin
      .from("runtime_config")
      .select("key, value, updated_at, updated_by, reason")
      .eq("key", key)
      .maybeSingle()
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500, headers: CORS })
    }
    return NextResponse.json(data ?? { key, value: null }, { headers: CORS })
  }

  // Sin key: devolver TODOS los configs
  const { data, error } = await admin
    .from("runtime_config")
    .select("key, value, updated_at, updated_by")
    .order("key")
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: CORS })
  }
  // Devuelve como objeto {key1: value1, key2: value2, ...} para fácil consumo
  const flat: Record<string, any> = {}
  for (const row of data ?? []) {
    flat[row.key] = row.value
  }
  return NextResponse.json({
    config: flat,
    fetched_at: new Date().toISOString(),
    keys: (data ?? []).map((r: any) => ({ key: r.key, updated_at: r.updated_at, updated_by: r.updated_by })),
  }, { headers: CORS })
}
