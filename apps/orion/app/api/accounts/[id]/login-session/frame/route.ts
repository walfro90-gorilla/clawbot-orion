export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { checkSessionAccess }        from "@/lib/login-session-store"

const CS_URL    = process.env.COOKIE_SERVER_URL!
const CS_SECRET = process.env.COOKIE_SERVER_SECRET!

// Hot path — fires ~8x/sec. We avoid the full Supabase auth + profiles lookup by
// trusting the in-memory ownership cache populated by POST /login-session.
// The sid itself is unguessable; combined with accountId, only the owner can hit this.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: accountId } = await params
  const sid = req.nextUrl.searchParams.get("sid")
  if (!sid) return new NextResponse(null, { status: 400 })

  if (!checkSessionAccess(sid, accountId)) {
    return new NextResponse(null, { status: 401 })
  }

  const upstream = await fetch(`${CS_URL}/session/${sid}/frame`, {
    headers: { "x-secret": CS_SECRET },
    cache:   "no-store",
  })

  if (upstream.status === 204) return new NextResponse(null, { status: 204 })
  if (!upstream.ok)            return new NextResponse(null, { status: 502 })

  const buffer = await upstream.arrayBuffer()
  return new NextResponse(buffer, {
    headers: {
      "Content-Type":  "image/jpeg",
      "Cache-Control": "no-store",
    },
  })
}
