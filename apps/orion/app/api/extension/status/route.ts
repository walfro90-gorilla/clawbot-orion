export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"

// Devuelve si una cuenta tiene la extension conectada en el bridge.
// Consulta el endpoint /health del bridge (puerto 4002 local).

export async function GET(req: NextRequest) {
  const accountId = req.nextUrl.searchParams.get("accountId")
  if (!accountId) {
    return NextResponse.json({ error: "accountId required" }, { status: 400 })
  }

  try {
    const r = await fetch("http://localhost:4002/health", {
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    })
    if (!r.ok) {
      return NextResponse.json({ connected: false, error: "bridge_unhealthy" })
    }
    const data = await r.json()
    const match = (data.connected_accounts ?? []).find((c: any) => c.accountId === accountId)
    return NextResponse.json({
      connected: !!match,
      lastSeen:  match?.lastSeen ?? null,
      label:     match?.label ?? null,
    })
  } catch (err) {
    return NextResponse.json({ connected: false, error: (err as Error).message })
  }
}
