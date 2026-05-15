export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { checkSessionAccess }        from "@/lib/login-session-store"

const CS_URL    = process.env.COOKIE_SERVER_URL!
const CS_SECRET = process.env.COOKIE_SERVER_SECRET!

// Hot path — fires on every keystroke / click batch. Cache-only auth.
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

  // Whitelist input types — refuse anything else
  if (!["click", "type", "key"].includes(body?.type)) {
    return NextResponse.json({ error: "invalid input type" }, { status: 400 })
  }

  const upstream = await fetch(`${CS_URL}/session/${sid}/input`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "x-secret": CS_SECRET },
    body:    JSON.stringify(body),
  })

  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.ok ? 200 : 502 })
}
