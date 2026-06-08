export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-orion-api-key",
}
export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }) }

// GET /api/visual-learning/tickets?status=open&limit=20
// Lista de tickets para el dashboard.
export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status") ?? "open"
  const limit = parseInt(req.nextUrl.searchParams.get("limit") ?? "20")
  const admin = createAdminClient() as any
  const { data, error } = await admin
    .from("v_selector_tickets_open")
    .select("*")
    .limit(limit)
  if (error) return NextResponse.json({ error: error.message }, { status: 500, headers: CORS })
  return NextResponse.json({ tickets: data ?? [], count: data?.length ?? 0 }, { headers: CORS })
}
