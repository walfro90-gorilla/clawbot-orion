export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { checkSessionAccess }        from "@/lib/login-session-store"

const CS_URL    = process.env.COOKIE_SERVER_URL!
const CS_SECRET = process.env.COOKIE_SERVER_SECRET!

// POST /api/accounts/[id]/auto-login/2fa { sid, code }
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: accountId } = await params
  const sid = req.nextUrl.searchParams.get("sid")
  if (!sid) return NextResponse.json({ error: "missing sid" }, { status: 400 })

  if (!checkSessionAccess(sid, accountId)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await req.json()
  const code = (body?.code ?? "").toString().trim()
  if (!/^\d{4,8}$/.test(code)) {
    return NextResponse.json({ error: "invalid_code_format" }, { status: 400 })
  }

  const upstream = await fetch(`${CS_URL}/session/${sid}/submit-2fa`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "x-secret": CS_SECRET },
    body:    JSON.stringify({ code }),
  })

  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.ok ? 200 : 502 })
}
