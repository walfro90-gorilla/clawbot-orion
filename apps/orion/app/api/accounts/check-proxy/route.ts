import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import { ROLE_LEVEL } from "@/lib/auth/role"
import * as http from "node:http"
import * as https from "node:https"
import * as url from "node:url"

// Makes a GET request through an HTTP proxy and returns the response body.
// Uses CONNECT tunneling for HTTPS targets, direct for HTTP targets.
function requestThroughProxy(
  proxyUrl: string,
  targetUrl: string,
  timeoutMs = 10_000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proxy  = new url.URL(proxyUrl)
    const target = new url.URL(targetUrl)
    const timer  = setTimeout(() => reject(new Error("Proxy timeout")), timeoutMs)

    const cleanup = (fn: () => void) => { clearTimeout(timer); fn() }

    if (target.protocol === "https:") {
      // CONNECT tunnel
      const connectReq = http.request({
        host: proxy.hostname,
        port: parseInt(proxy.port) || 80,
        method: "CONNECT",
        path: `${target.hostname}:443`,
        headers: proxy.username
          ? { "Proxy-Authorization": `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}` }
          : {},
      })
      connectReq.on("connect", (_res, socket) => {
        const req = https.request({
          host: target.hostname,
          path: target.pathname + target.search,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          socket: socket as any,
          agent: false,
          headers: { "User-Agent": "Mozilla/5.0", Host: target.hostname },
        } as any)
        req.on("response", (res) => {
          let data = ""
          res.on("data", (d) => (data += d))
          res.on("end", () => cleanup(() => resolve(data)))
        })
        req.on("error", (e) => cleanup(() => reject(e)))
        req.end()
      })
      connectReq.on("error", (e) => cleanup(() => reject(e)))
      connectReq.end()
    } else {
      // Direct HTTP through proxy
      const authHeader = proxy.username
        ? { "Proxy-Authorization": `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}` }
        : {}
      const req = http.request({
        host: proxy.hostname,
        port: parseInt(proxy.port) || 80,
        method: "GET",
        path: targetUrl,
        headers: { "User-Agent": "Mozilla/5.0", Host: target.hostname, ...authHeader },
      })
      req.on("response", (res) => {
        let data = ""
        res.on("data", (d) => (data += d))
        res.on("end", () => cleanup(() => resolve(data)))
      })
      req.on("error", (e) => cleanup(() => reject(e)))
      req.end()
    }
  })
}

export async function POST(req: NextRequest) {
  // Auth check
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const admin = createAdminClient()
  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single()
  const role = (profile?.role ?? "viewer") as keyof typeof ROLE_LEVEL

  const { accountId } = await req.json()
  if (!accountId) return NextResponse.json({ error: "accountId required" }, { status: 400 })

  const { data: account } = await admin
    .from("linkedin_accounts")
    .select("id, label, proxy_url, user_id")
    .eq("id", accountId)
    .single()

  // Allow admins OR the account owner
  const isAdmin = (ROLE_LEVEL[role] ?? 0) >= 3
  const isOwner = account?.user_id === user.id
  if (!isAdmin && !isOwner) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  if (!account?.proxy_url) {
    return NextResponse.json({ error: "No proxy configured for this account" }, { status: 400 })
  }

  try {
    // Use ip-api.com (HTTP, free, no key needed)
    const raw = await requestThroughProxy(account.proxy_url, "http://ip-api.com/json/?fields=status,country,countryCode,city,query")
    const geo = JSON.parse(raw)

    if (geo.status !== "success") {
      return NextResponse.json({ error: "ip-api returned failure", raw }, { status: 502 })
    }

    const now = new Date().toISOString()
    await admin.from("linkedin_accounts").update({
      proxy_ip:           geo.query,
      proxy_country_code: geo.countryCode,
      proxy_country_name: geo.country,
      proxy_city:         geo.city,
      proxy_checked_at:   now,
    }).eq("id", accountId)

    return NextResponse.json({
      ip:          geo.query,
      countryCode: geo.countryCode,
      country:     geo.country,
      city:        geo.city,
      checkedAt:   now,
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 502 })
  }
}
