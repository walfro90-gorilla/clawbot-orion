export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { exec } from "child_process"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"

const PROMETHEUS_DIR = "/root/clawbot/apps/prometheus"

// Cooldowns por tipo de job (ms)
const COOLDOWN_MS: Record<string, number> = {
  inbox:    30 * 60 * 1000,
  batch:     5 * 60 * 1000,
  search:    5 * 60 * 1000,
  followup: 60 * 60 * 1000, // 1h — follow-up no debe dispararse seguido
}

// Debounce en memoria — fallback; DB last_inbox_check_at es el check primario para inbox
const recentRuns = new Map<string, number>()

// Whitelist de jobs permitidos — no usar dinámico para evitar injection
function getScript(jobType: string): string | null {
  if (jobType === "search")   return "search.js"
  if (jobType === "batch")    return "batch.js"
  if (jobType === "inbox")    return "inbox.js"
  if (jobType === "followup") return "followup.js"
  return null
}

const roleLevel: Record<string, number> = { god_admin: 4, admin: 3, user: 2, viewer: 1 }

export async function POST(req: NextRequest) {
  // Auth check
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const admin = createAdminClient()
  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single()
  const userLevel = roleLevel[profile?.role ?? ""] ?? 0

  const body = await req.json()
  const { jobType, campaignId, accountId } = body as {
    jobType: string
    campaignId?: string
    accountId?: string
  }

  const script = getScript(jobType)
  if (!script) {
    return NextResponse.json({ error: "Unknown jobType" }, { status: 400 })
  }

  // inbox puede ser disparado por cualquier usuario (role >= user)
  // batch/search/followup requieren al menos admin
  const minRole = jobType === "inbox" ? 2 : 3
  if (userLevel < minRole) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  if ((jobType === "search" || jobType === "batch" || jobType === "followup") && !campaignId) {
    return NextResponse.json({ error: "campaignId required for this job type" }, { status: 400 })
  }
  if (jobType === "inbox" && !accountId) {
    return NextResponse.json({ error: "accountId required for inbox" }, { status: 400 })
  }

  // Para inbox: validar que el accountId pertenece al usuario (o es admin)
  if (jobType === "inbox" && accountId && userLevel < 3) {
    const { data: acct } = await admin
      .from("linkedin_accounts")
      .select("user_id")
      .eq("id", accountId)
      .single()
    if (acct?.user_id !== user.id) {
      return NextResponse.json({ error: "Forbidden — account does not belong to you" }, { status: 403 })
    }
  }

  // Cooldown primario para inbox: usar last_inbox_check_at de la DB
  const cooldownMs = COOLDOWN_MS[jobType] ?? 5 * 60 * 1000
  if (jobType === "inbox" && accountId) {
    const { data: acct } = await admin
      .from("linkedin_accounts")
      .select("last_inbox_check_at, label")
      .eq("id", accountId)
      .single()

    if (acct?.last_inbox_check_at) {
      const elapsedMs = Date.now() - new Date(acct.last_inbox_check_at).getTime()
      if (elapsedMs < cooldownMs) {
        const waitMin = Math.ceil((cooldownMs - elapsedMs) / 60_000)
        return NextResponse.json(
          { error: `Inbox de "${acct.label}" revisado hace ${Math.floor(elapsedMs / 60_000)} min. Espera ${waitMin} min más.`, cooldownRemaining: Math.ceil((cooldownMs - elapsedMs) / 1000) },
          { status: 429 }
        )
      }
    }
  }

  // Debounce en memoria: protección extra contra doble-click / race
  const debounceKey = `${jobType}:${campaignId ?? accountId}`
  const lastRun = recentRuns.get(debounceKey) ?? 0
  const memElapsed = Date.now() - lastRun
  if (memElapsed < 30_000) {
    return NextResponse.json(
      { error: `Job ${jobType} ya fue disparado. Espera unos segundos.` },
      { status: 429 }
    )
  }
  recentRuns.set(debounceKey, Date.now())

  // Build env vars — values are UUIDs (safe), job validated by whitelist
  const envParts: string[] = ["MANUAL_RUN=true", "DRY_RUN=false", "LIVE_SEND=true"]
  if (campaignId) envParts.push(`CAMPAIGN_ID=${campaignId}`)
  if (accountId)  envParts.push(`ACCOUNT_ID=${accountId}`)
  const envPrefix = envParts.join(" ")

  // Fire and forget — nohup so it outlives the HTTP request
  const cmd = `${envPrefix} nohup node ${script} >> /tmp/manual-run-${jobType}.log 2>&1 &`
  exec(cmd, { cwd: PROMETHEUS_DIR })

  console.log(`[run-job] ${jobType} triggered manually by ${user.email} (account=${accountId ?? campaignId})`)

  return NextResponse.json({ ok: true, jobType, estimatedSeconds: jobType === "inbox" ? 120 : 60 })
}
