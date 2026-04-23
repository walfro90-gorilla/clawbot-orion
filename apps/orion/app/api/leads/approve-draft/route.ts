export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { exec } from "child_process"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"

const PROMETHEUS_DIR = "/root/clawbot/apps/prometheus"

const roleLevel: Record<string, number> = { god_admin: 4, admin: 3, user: 2, viewer: 1 }

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const admin = createAdminClient()
  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single()
  const userLevel = roleLevel[profile?.role ?? ""] ?? 0
  if (userLevel < 2) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await req.json()
  const { leadId, message } = body as { leadId: string; message: string }

  if (!leadId || !message?.trim()) {
    return NextResponse.json({ error: "leadId and message are required" }, { status: 400 })
  }
  if (message.trim().length > 2000) {
    return NextResponse.json({ error: "Message too long (max 2000 chars)" }, { status: 400 })
  }

  // Validate lead ownership for restricted roles
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

  // Read current conversation_turn before clearing draft
  const { data: conv } = await admin
    .from("conversations")
    .select("conversation_turn")
    .eq("lead_id", leadId)
    .maybeSingle()

  // Clear draft + increment turn counter + cancel any pending scheduled send
  await admin
    .from("conversations")
    .update({
      ai_reply_draft:        null,
      ai_draft_generated_at: null,
      ai_reply_scheduled_at: null,
      conversation_turn:     ((conv?.conversation_turn ?? 0) + 1),
    })
    .eq("lead_id", leadId)

  // Trigger reply.js — background process with 2-min timeout
  const env = {
    ...process.env,
    LEAD_ID:       leadId,
    REPLY_MESSAGE: message.trim(),
    DRY_RUN:       "false",
    LIVE_SEND:     "true",
  }

  const cmd = `node ${PROMETHEUS_DIR}/reply.js`
  exec(cmd, { env, timeout: 120_000 }, (err, _stdout, stderr) => {
    if (err) {
      const reason = err.killed ? "timeout (120s)" : `exit code ${err.code}`
      console.error(`[approve-draft] reply.js failed (${reason}) for lead=${leadId}:`, stderr?.slice(0, 500))
    } else {
      console.log(`[approve-draft] reply.js completed for lead=${leadId}`)
    }
  })

  console.log(`[approve-draft] Draft approved and reply triggered for lead=${leadId} by ${user.email}`)
  return NextResponse.json({ ok: true, estimatedSeconds: 90 })
}
