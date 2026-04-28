export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { exec } from "child_process"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { ROLE_LEVEL } from "@/lib/auth/role"

const PROMETHEUS_DIR = "/root/clawbot/apps/prometheus"
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const admin = createAdminClient()
  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single()
  const userLevel = ROLE_LEVEL[profile?.role as keyof typeof ROLE_LEVEL] ?? 0
  if (userLevel < 2) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await req.json()
  const { leadId, message } = body as { leadId: string; message: string }

  if (!leadId || !message?.trim()) {
    return NextResponse.json({ error: "leadId and message are required" }, { status: 400 })
  }
  if (!UUID_RE.test(leadId)) {
    return NextResponse.json({ error: "Invalid leadId" }, { status: 400 })
  }
  if (message.trim().length > 2000) {
    return NextResponse.json({ error: "Message too long (max 2000 chars)" }, { status: 400 })
  }

  // Validate lead belongs to user's account (for role=user)
  if (userLevel < 3) {
    const { data: me } = await admin.from("profiles").select("linkedin_account_id").eq("id", user.id).single()
    const { data: lead } = await admin
      .from("leads")
      .select("campaign_id, campaigns(linkedin_account_id)")
      .eq("id", leadId)
      .single()
    const leadAccountId = (lead?.campaigns as any)?.linkedin_account_id
    if (leadAccountId !== me?.linkedin_account_id) {
      return NextResponse.json({ error: "Forbidden — lead does not belong to your account" }, { status: 403 })
    }
  }

  const env = {
    ...process.env,
    LEAD_ID:       leadId,
    REPLY_MESSAGE: message.trim(),
    DRY_RUN:       "false",
    LIVE_SEND:     "true",
  }

  // stdout only — no /tmp file accumulation
  exec(`node reply.js`, { cwd: PROMETHEUS_DIR, env, timeout: 120_000 }, (err, _stdout, stderr) => {
    if (err) console.error(`[reply-api] reply.js failed for lead=${leadId}:`, stderr?.slice(0, 500))
    else     console.log(`[reply-api] reply.js completed for lead=${leadId}`)
  })

  console.log(`[reply-api] Reply triggered for lead=${leadId} by ${user.email}`)
  return NextResponse.json({ ok: true, estimatedSeconds: 90 })
}
