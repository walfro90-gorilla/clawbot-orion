export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-orion-api-key",
}
export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }) }

// GET /api/extension/connectivity?accountId=...
// Devuelve events últimos 24h + uptime% aproximado
export async function GET(req: NextRequest) {
  const accountId = req.nextUrl.searchParams.get("accountId")
  const apiKey = req.headers.get("x-orion-api-key") ?? req.nextUrl.searchParams.get("apiKey")
  if (!accountId || !apiKey) {
    return NextResponse.json({ error: "accountId and apiKey required" }, { status: 400, headers: CORS })
  }

  const admin = createAdminClient()
  const { data: account } = await admin
    .from("linkedin_accounts")
    .select("id, extension_api_key, extension_last_seen_at")
    .eq("id", accountId)
    .single()
  if (!account || account.extension_api_key !== apiKey) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS })
  }

  // Events últimos 24h
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const { data: events } = await admin
    .from("account_connectivity_log")
    .select("event_type, created_at")
    .eq("linkedin_account_id", accountId)
    .gte("created_at", since)
    .order("created_at", { ascending: true })

  // Calcula 24 buckets de 1h (más reciente = índice 23)
  const buckets: Array<"up" | "down" | "unknown"> = Array(24).fill("unknown")
  const now = Date.now()
  // Reconstruir timeline: ordenado, asumir entre connect y disconnect = up
  let isUp = false
  let prevTs: number | null = null
  const ordered = (events ?? []).slice()
  for (let i = 0; i < ordered.length; i++) {
    const ts = new Date(ordered[i].created_at as string).getTime()
    const evt = ordered[i].event_type as string
    if (prevTs !== null) {
      // entre prevTs y ts, estaba isUp
      fillBuckets(buckets, prevTs, ts, isUp, now)
    } else {
      // Antes del primer evento: marcar unknown (ya está unknown)
    }
    if (evt === "connected") isUp = true
    else if (evt === "disconnected") isUp = false
    prevTs = ts
  }
  // Desde último evento hasta NOW
  if (prevTs !== null) {
    fillBuckets(buckets, prevTs, now, isUp, now)
  }

  const upCount = buckets.filter(b => b === "up").length
  const knownCount = buckets.filter(b => b !== "unknown").length
  const uptimePct = knownCount > 0 ? Math.round((upCount / knownCount) * 100) : null

  // Último connect timestamp
  const lastConnect = (events ?? []).filter(e => e.event_type === "connected").pop()?.created_at ?? null

  // Desconexiones (indicador de inestabilidad = background mode probablemente off)
  const disconnects24h = (events ?? []).filter(e => e.event_type === "disconnected").length
  const unstable = disconnects24h >= 4

  return NextResponse.json({
    ok: true,
    buckets,
    uptimePct,
    lastConnect,
    disconnects24h,
    unstable,
    eventsCount: events?.length ?? 0,
  }, { headers: { ...CORS, "Cache-Control": "public, max-age=30" } })
}

function fillBuckets(
  buckets: Array<"up" | "down" | "unknown">,
  fromTs: number,
  toTs: number,
  wasUp: boolean,
  now: number,
) {
  for (let h = 0; h < 24; h++) {
    const bucketStart = now - (24 - h) * 3600_000
    const bucketEnd   = now - (23 - h) * 3600_000
    if (toTs < bucketStart || fromTs > bucketEnd) continue
    const overlapStart = Math.max(fromTs, bucketStart)
    const overlapEnd   = Math.min(toTs, bucketEnd)
    const overlapFrac  = (overlapEnd - overlapStart) / 3600_000
    if (overlapFrac <= 0) continue
    // Si el bucket ya tiene up, no degradar a down (cualquier "up" en el hr cuenta)
    if (buckets[h] === "up") continue
    if (wasUp && overlapFrac >= 0.05) buckets[h] = "up"
    else if (!wasUp && buckets[h] === "unknown") buckets[h] = "down"
  }
}
