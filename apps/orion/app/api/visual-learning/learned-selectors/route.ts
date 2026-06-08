export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}
export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }) }

// GET /api/visual-learning/learned-selectors
// Lista de selectores aprendidos (filtros optional ?label=, ?phase=).
// Esto lo lee la extension cada N min para poblar el override.
export async function GET(req: NextRequest) {
  const label = req.nextUrl.searchParams.get("label")
  const phase = req.nextUrl.searchParams.get("phase")
  const admin = createAdminClient() as any

  let query = admin
    .from("learned_selectors")
    .select("id, label, phase_name, selector, selector_alternatives, priority, hit_count, miss_count, enabled")
    .eq("enabled", true)
    .order("priority", { ascending: false })
  if (label) query = query.eq("label", label)
  if (phase) query = query.eq("phase_name", phase)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500, headers: CORS })

  // Agrupar por label para fácil consumo
  const byLabel: Record<string, any[]> = {}
  for (const ls of data ?? []) {
    if (!byLabel[ls.label]) byLabel[ls.label] = []
    byLabel[ls.label].push(ls)
  }
  return NextResponse.json({
    selectors: data ?? [],
    byLabel,
    fetched_at: new Date().toISOString(),
  }, { headers: CORS })
}

// POST /api/visual-learning/learned-selectors/stats
// Body: { selectorId, hit: boolean }
// La extension reporta hits/misses para track health.
export async function POST(req: NextRequest) {
  const { selectorId, hit } = await req.json().catch(() => ({}))
  if (!selectorId || typeof hit !== "boolean") {
    return NextResponse.json({ error: "missing_fields" }, { status: 400, headers: CORS })
  }
  const admin = createAdminClient() as any
  const field = hit ? "hit_count" : "miss_count"
  const tsField = hit ? "last_hit_at" : "last_miss_at"

  // Increment + timestamp
  const { data: cur } = await admin
    .from("learned_selectors")
    .select(`id, ${field}, miss_count, enabled`)
    .eq("id", selectorId)
    .single()
  if (!cur) return NextResponse.json({ error: "not_found" }, { status: 404, headers: CORS })

  const newCount = ((cur as any)[field] ?? 0) + 1
  const updates: any = { [field]: newCount, [tsField]: new Date().toISOString(), updated_at: new Date().toISOString() }

  // Auto-disable si miss_count >= 10 AND hit_rate < 30%
  if (!hit) {
    const newMisses = newCount  // we just incremented miss_count
    const { data: full } = await admin
      .from("learned_selectors")
      .select("hit_count")
      .eq("id", selectorId)
      .single()
    const hits = full?.hit_count ?? 0
    const total = hits + newMisses
    if (newMisses >= 10 && total > 0 && (hits / total) < 0.3) {
      updates.enabled = false
      updates.disabled_at = new Date().toISOString()
      updates.disabled_reason = `auto_too_many_misses (${newMisses}/${total})`
    }
  }

  const { error } = await admin.from("learned_selectors").update(updates).eq("id", selectorId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500, headers: CORS })
  return NextResponse.json({ ok: true, updates }, { headers: CORS })
}
