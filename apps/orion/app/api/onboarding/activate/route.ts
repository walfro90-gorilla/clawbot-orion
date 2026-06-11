export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { ROLE_LEVEL } from "@/lib/auth/role"

// Activación de onboarding de una cuenta nueva.
//   GET  ?accountId=  → devuelve el checklist en vivo (read-only) para el panel de activación.
//   POST { accountId } → HARD-GATE: si TODO el checklist pasa, activa (status='active' +
//                        campaign.is_active=true + profile.onboarding_step='done'). Si falta
//                        algo → 409 con los ítems faltantes. Idempotente.
//
// Esta es la ÚNICA defensa contra disparar comandos sobre cuentas a medio-onboardear: el
// scheduler NO gatea por cookie/status (solo 'banned'), por eso la campaña nace is_active=false
// y SOLO este endpoint la pone is_active=true tras validar.
//
// Scoping owner-or-admin REPLICADO de generate-key (authorize() NO valida ownership por cuenta).

type Checklist = {
  extensionConnected: boolean
  campaignExists: boolean
  hasKeywords: boolean
  hasTarget: boolean
}

async function authorizeAccount(req: NextRequest, accountId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, status: 401, error: "unauthorized" }

  const admin = createAdminClient()
  const { data: profile } = await admin
    .from("profiles")
    .select("role, linkedin_account_id")
    .eq("id", user.id)
    .single()

  const userLevel = ROLE_LEVEL[profile?.role as keyof typeof ROLE_LEVEL] ?? 0
  const isAdmin = userLevel >= ROLE_LEVEL.admin
  const isOwner = profile?.linkedin_account_id === accountId
  if (!isAdmin && !isOwner) return { ok: false as const, status: 403, error: "forbidden" }
  return { ok: true as const, admin, isAdmin }
}

async function computeState(admin: ReturnType<typeof createAdminClient>, accountId: string) {
  const { data: account } = await admin
    .from("linkedin_accounts")
    .select("id, status, extension_last_seen_at")
    .eq("id", accountId)
    .single()
  if (!account) return null

  // Campaña a activar: la más reciente de la cuenta (el onboarding crea solo una).
  const { data: campaigns } = await admin
    .from("campaigns")
    .select("id, is_active, search_keywords, daily_invite_target, name")
    .eq("linkedin_account_id", accountId)
    .order("created_at", { ascending: false })
  const campaign = campaigns?.[0] ?? null

  // "Extensión conectada" = en bridge /health (WS vivo) O heartbeat fresco (<5min).
  const seenMs = account.extension_last_seen_at
    ? Date.now() - new Date(account.extension_last_seen_at).getTime()
    : Infinity
  let bridgeConnected = false
  try {
    const r = await fetch("http://localhost:4002/health", { cache: "no-store", signal: AbortSignal.timeout(2000) })
    const j = await r.json()
    bridgeConnected = (j.connected_accounts ?? []).some((c: any) => c.accountId === accountId)
  } catch {}
  const extensionConnected = bridgeConnected || seenMs < 5 * 60 * 1000

  const keywords = Array.isArray(campaign?.search_keywords)
    ? (campaign!.search_keywords as string[]).filter(Boolean)
    : []
  const checklist: Checklist = {
    extensionConnected,
    campaignExists: !!campaign,
    hasKeywords: keywords.length > 0,
    hasTarget: (campaign?.daily_invite_target ?? 0) > 0,
  }
  const ready = checklist.extensionConnected && checklist.campaignExists && checklist.hasKeywords && checklist.hasTarget
  return { account, campaign, checklist, ready }
}

const LABELS: Record<keyof Checklist, string> = {
  extensionConnected: "Extensión instalada y conectada",
  campaignExists: "Campaña creada",
  hasKeywords: "Keywords de búsqueda configuradas",
  hasTarget: "Cap diario de invitaciones > 0",
}

export async function GET(req: NextRequest) {
  const accountId = req.nextUrl.searchParams.get("accountId")
  if (!accountId) return NextResponse.json({ error: "accountId required" }, { status: 400 })

  const auth = await authorizeAccount(req, accountId)
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const state = await computeState(auth.admin, accountId)
  if (!state) return NextResponse.json({ error: "account_not_found" }, { status: 404 })

  return NextResponse.json({
    accountId,
    status: state.account.status,
    campaignActive: state.campaign?.is_active ?? false,
    checklist: state.checklist,
    ready: state.ready,
    labels: LABELS,
  })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const accountId = body.accountId as string | undefined
  if (!accountId) return NextResponse.json({ error: "accountId required" }, { status: 400 })

  const auth = await authorizeAccount(req, accountId)
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const admin = auth.admin

  const state = await computeState(admin, accountId)
  if (!state) return NextResponse.json({ error: "account_not_found" }, { status: 404 })

  if (!state.ready) {
    const missing = (Object.keys(state.checklist) as (keyof Checklist)[])
      .filter(k => !state.checklist[k])
      .map(k => LABELS[k])
    return NextResponse.json({ ok: false, ready: false, checklist: state.checklist, missing }, { status: 409 })
  }

  // HARD-GATE pasado → activar (idempotente). Captura { error } en cada write.
  const { error: accErr } = await admin
    .from("linkedin_accounts")
    .update({ status: "active" })
    .eq("id", accountId)
  if (accErr) return NextResponse.json({ error: accErr.message }, { status: 500 })

  const { error: campErr } = await admin
    .from("campaigns")
    .update({ is_active: true })
    .eq("id", state.campaign!.id)
  if (campErr) return NextResponse.json({ error: campErr.message }, { status: 500 })

  // Marca el onboarding del DUEÑO (no del admin) como done.
  await admin
    .from("profiles")
    .update({ onboarding_step: "done" })
    .eq("linkedin_account_id", accountId)

  return NextResponse.json({ ok: true, ready: true, accountId, campaignId: state.campaign!.id })
}
