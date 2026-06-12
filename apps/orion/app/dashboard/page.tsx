import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { getSessionUser } from "@/lib/auth/role"
import Link from "next/link"
import { readFileSync } from "fs"
import { DashboardFiltersBar } from "@/components/dashboard-filters"
import { RefreshButton } from "@/components/refresh-button"
import { InboxSweepBtn } from "@/components/inbox-sweep-btn"
import type { CampaignStats, AccountToday } from "@clawbot/db-types"

// ── Date range helpers ────────────────────────────────────────────────────────
type Range = "" | "today" | "yesterday" | "7d" | "custom"

function getMxDateRange(
  range: Range,
  customFrom?: string,
  customTo?: string,
): { from: string; to: string } | null {
  if (!range) return null
  // Mexico City — CDT (UTC-5) Apr–Oct, CST (UTC-6) Nov–Mar
  // We snap to UTC-5 offset; ±1h is acceptable for dashboard stats.
  const TZ_OFFSET = "-05:00"
  const now = new Date()
  const mxDateStr = now.toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" }) // "2026-04-30"
  const yday = new Date(now.getTime() - 86_400_000)
  const mxYdayStr = yday.toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" })
  const ago7 = new Date(now.getTime() - 7 * 86_400_000)
  const mx7dStr = ago7.toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" })

  switch (range) {
    case "today":
      return { from: `${mxDateStr}T00:00:00${TZ_OFFSET}`, to: `${mxDateStr}T23:59:59${TZ_OFFSET}` }
    case "yesterday":
      return { from: `${mxYdayStr}T00:00:00${TZ_OFFSET}`, to: `${mxYdayStr}T23:59:59${TZ_OFFSET}` }
    case "7d":
      return { from: `${mx7dStr}T00:00:00${TZ_OFFSET}`, to: now.toISOString() }
    case "custom":
      if (!customFrom || !customTo) return null
      return { from: `${customFrom}T00:00:00${TZ_OFFSET}`, to: `${customTo}T23:59:59${TZ_OFFSET}` }
    default:
      return null
  }
}

function rangeLabel(range: Range, from?: string, to?: string): string {
  switch (range) {
    case "today":     return "Hoy"
    case "yesterday": return "Ayer"
    case "7d":        return "Últimos 7 días"
    case "custom":    return from && to ? `${from} → ${to}` : "Personalizado"
    default:          return "Histórico total"
  }
}

// ── Extension health thresholds (minutos desde último heartbeat) ─────────────
// La extension MV3 dispara un heartbeat al WebSocket. Si el Chrome del usuario
// está cerrado o la extension dormida, no llegan comandos. Umbrales:
const EXT_WARNING_MIN  = 30      // 🟡 Heartbeat stale (Chrome idle)
const EXT_CRITICAL_MIN = 60 * 6  // 🔴 6h sin contacto = offline

function extensionHealth(lastSeenAt: string | null, paused: boolean | null): {
  status: "ok" | "warning" | "critical" | "unknown" | "paused"
  minutes: number | null
  label: string
} {
  if (paused) return { status: "paused", minutes: null, label: "Pausada por usuario" }
  if (!lastSeenAt) return { status: "unknown", minutes: null, label: "Nunca conectada" }
  const mins = Math.floor((Date.now() - new Date(lastSeenAt).getTime()) / 60_000)
  if (mins >= EXT_CRITICAL_MIN) return { status: "critical", minutes: mins, label: `Offline ${Math.floor(mins/60)}h` }
  if (mins >= EXT_WARNING_MIN)  return { status: "warning",  minutes: mins, label: `Stale ${mins} min` }
  if (mins < 1) return { status: "ok", minutes: mins, label: "En línea" }
  return { status: "ok", minutes: mins, label: `Hace ${mins} min` }
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string }>
}) {
  const sp       = await searchParams
  const range    = (sp.range ?? "") as Range
  const spFrom   = sp.from ?? ""
  const spTo     = sp.to   ?? ""
  const dateRange = getMxDateRange(range, spFrom, spTo)

  const supabase = await createClient()
  const admin    = createAdminClient()
  const me       = await getSessionUser()

  const isRestricted    = me?.role === "user" || me?.role === "viewer"
  const linkedAccountId = me?.linkedin_account_id ?? null
  const isAdmin         = me?.role === "god_admin" || me?.role === "admin"

  // ── Queries ──────────────────────────────────────────────────────────────────
  let campaignsQuery = supabase.from("v_campaign_stats").select("*").order("created_at", { ascending: false })
  let accountsQuery  = supabase.from("v_account_today").select("*")

  if (isRestricted && linkedAccountId) {
    campaignsQuery = campaignsQuery.eq("linkedin_account_id", linkedAccountId)
    accountsQuery  = accountsQuery.eq("account_id", linkedAccountId)
  }

  // Accounts for cookie health: admin sees all, user sees only their own
  const rawAccountsQuery = isRestricted && linkedAccountId
    ? admin.from("linkedin_accounts")
        .select("id, label, status, extension_last_seen_at, extension_paused, warmup_status")
        .eq("id", linkedAccountId)
    : admin.from("linkedin_accounts")
        .select("id, label, status, extension_last_seen_at, extension_paused, warmup_status")
        .order("label")

  // Active alerts (admin sees all, users see only their account's)
  const alertsQuery = isRestricted && linkedAccountId
    ? supabase.from("account_alerts")
        .select("id, alert_type, severity, message, created_at, linkedin_account_id")
        .eq("linkedin_account_id", linkedAccountId)
        .is("resolved_at", null)
        .order("created_at", { ascending: false })
        .limit(10)
    : supabase.from("account_alerts")
        .select("id, alert_type, severity, message, created_at, linkedin_account_id")
        .is("resolved_at", null)
        .order("created_at", { ascending: false })
        .limit(10)

  // Drift detection: manual replies en LinkedIn (fuera de Orion) últimos 7d
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString()
  const manualDriftBaseQ = admin
    .from("conversation_events")
    .select("conversation_id, sent_at, conversations(linkedin_account_id, linkedin_accounts(label))")
    .eq("sent_via", "linkedin_manual")
    .gte("sent_at", sevenDaysAgo)
    .order("sent_at", { ascending: false })
    .limit(50)
  const manualDriftQuery = (isRestricted && linkedAccountId)
    ? manualDriftBaseQ   // RLS-filtered downstream; we'll filter in memory
    : manualDriftBaseQ

  const [
    { data: campaigns },
    { data: accounts },
    { data: rawAccounts },
    { data: alerts },
    { data: manualDriftEvents },
  ] = await Promise.all([
    campaignsQuery,
    accountsQuery,
    rawAccountsQuery,
    alertsQuery,
    manualDriftQuery,
  ])

  // Agrupa manual drift por cuenta
  const driftByAccount: Record<string, { label: string; count: number; lastAt: string }> = {}
  for (const ev of (manualDriftEvents ?? []) as any[]) {
    const acctId = ev?.conversations?.linkedin_account_id as string | undefined
    const label  = ev?.conversations?.linkedin_accounts?.label as string | undefined
    if (!acctId || !label) continue
    if (isRestricted && linkedAccountId && acctId !== linkedAccountId) continue
    if (!driftByAccount[acctId]) {
      driftByAccount[acctId] = { label, count: 0, lastAt: ev.sent_at as string }
    }
    driftByAccount[acctId].count++
  }
  const driftAccounts = Object.values(driftByAccount).filter(d => d.count > 0)

  // ── Date-filtered KPI queries ─────────────────────────────────────────────
  let filteredTotals: { leads: number; invited: number; replied: number; meetings: number } | null = null

  if (dateRange) {
    let leadsBaseQ = admin.from("leads").select("id", { count: "exact", head: true })
      .gte("created_at", dateRange.from).lte("created_at", dateRange.to)
    let inviteBaseQ = admin.from("leads").select("id", { count: "exact", head: true })
      .gte("sent_at", dateRange.from).lte("sent_at", dateRange.to).not("sent_at", "is", null)
    let repliesBaseQ = admin.from("conversation_events").select("id", { count: "exact", head: true })
      .in("event_type", ["reply_received"])
      .gte("sent_at", dateRange.from).lte("sent_at", dateRange.to)
    let meetingsBaseQ = admin.from("leads").select("id", { count: "exact", head: true })
      .eq("status", "meeting_booked")
      .gte("created_at", dateRange.from).lte("created_at", dateRange.to)

    // Restrict to account's campaigns if non-admin
    if (isRestricted && linkedAccountId) {
      const { data: acctCamps2 } = await admin
        .from("campaigns").select("id").eq("linkedin_account_id", linkedAccountId)
      const ids2 = (acctCamps2 ?? []).map((c: any) => c.id)
      if (ids2.length > 0) {
        leadsBaseQ  = (leadsBaseQ  as any).in("campaign_id", ids2)
        inviteBaseQ = (inviteBaseQ as any).in("campaign_id", ids2)
        meetingsBaseQ = (meetingsBaseQ as any).in("campaign_id", ids2)
      }
    }

    const [
      { count: leadsCount },
      { count: inviteCount },
      { count: repliesCount },
      { count: meetingsCount },
    ] = await Promise.all([leadsBaseQ, inviteBaseQ, repliesBaseQ, meetingsBaseQ])

    filteredTotals = {
      leads:    leadsCount   ?? 0,
      invited:  inviteCount  ?? 0,
      replied:  repliesCount ?? 0,
      meetings: meetingsCount ?? 0,
    }
  }

  // ── Resumen del DÍA (hoy en hora CDMX) ─────────────────────────────────────
  // Métricas en vivo: lo que ha pasado en las últimas horas. Útil para ver el
  // ritmo del día sin tener que abrir el monitor o consultar la DB.
  // RLS aplica via admin client; god_admin/admin ve global, user ve solo su cuenta.
  const todayCDMX = (() => {
    const d = new Date()
    // YYYY-MM-DD en CDMX (UTC-6)
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Mexico_City",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d)  // "2026-05-17"
  })()
  const yesterdayCDMX = (() => {
    const d = new Date(Date.now() - 86_400_000)
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Mexico_City",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d)
  })()
  // Convertir CDMX date → rango UTC [00:00 CDMX, 24:00 CDMX] como ISO válido.
  // CDMX = UTC-6, así que 00:00 CDMX = 06:00 UTC del mismo día,
  // y 24:00 CDMX = 06:00 UTC del DÍA SIGUIENTE.
  const addOneDayIso = (yyyyMmDd: string) => {
    const [y, m, d] = yyyyMmDd.split("-").map(Number)
    const next = new Date(Date.UTC(y, m - 1, d + 1))
    return next.toISOString().slice(0, 10)  // "YYYY-MM-DD"
  }
  const todayStartUtc     = `${todayCDMX}T06:00:00.000Z`
  const todayEndUtc       = `${addOneDayIso(todayCDMX)}T06:00:00.000Z`
  const yesterdayStartUtc = `${yesterdayCDMX}T06:00:00.000Z`
  const yesterdayEndUtc   = `${addOneDayIso(yesterdayCDMX)}T06:00:00.000Z`
  const last14StartUtc    = new Date(Date.now() - 14 * 86_400_000).toISOString()

  const acctFilter = (q: any) => (isRestricted && linkedAccountId)
    ? q.eq("linkedin_account_id", linkedAccountId)
    : q

  // Helper: cuenta eventos hoy filtrando por cuenta vía FK join (sin .in con cientos de UUIDs).
  // Si god_admin (no restricted), no se aplica filtro por cuenta.
  const countEventsToday = (build: (q: any) => any) => {
    let q: any = admin.from("conversation_events").select(
      isRestricted && linkedAccountId
        ? "id, conversations!inner(linkedin_account_id)"
        : "id",
      { count: "exact", head: true },
    )
    q = q.gte("sent_at", todayStartUtc).lt("sent_at", todayEndUtc)
    if (isRestricted && linkedAccountId) {
      q = q.eq("conversations.linkedin_account_id", linkedAccountId)
    }
    return build(q)
  }

  const [
    invitesToday,
    fusToday,
    autoRepliesToday,
    manualRepliesToday,
    repliesReceivedToday,
    activeConvosCount,
    pendingInvitesCount,
  ] = await Promise.all([
    countEventsToday(q => q.eq("event_type", "invite_sent")),
    countEventsToday(q => q.like("event_type", "follow_up_sent%")),
    countEventsToday(q => q.eq("event_type", "reply_sent").eq("sent_via", "orion_auto")),
    countEventsToday(q => q.eq("event_type", "reply_sent").eq("sent_via", "orion_manual")),
    countEventsToday(q => q.eq("event_type", "reply_received")),
    acctFilter(admin.from("conversations").select("id", { count: "exact", head: true }))
      .gt("conversation_turn", 0),
    (async () => {
      const acctCamps = await (async () => {
        const cq = admin.from("campaigns").select("id, linkedin_account_id")
        const { data } = isRestricted && linkedAccountId
          ? await cq.eq("linkedin_account_id", linkedAccountId)
          : await cq
        return (data ?? []).map((c: any) => c.id)
      })()
      if (!acctCamps.length) return { count: 0 }
      return admin.from("leads")
        .select("id", { count: "exact", head: true })
        .in("campaign_id", acctCamps)
        .eq("status", "pending")
        .is("sent_at", null)
    })(),
  ])

  const todaySummary = {
    invites:        invitesToday.count ?? 0,
    fus:            fusToday.count ?? 0,
    autoReplies:    autoRepliesToday.count ?? 0,
    manualReplies:  manualRepliesToday.count ?? 0,
    repliesIn:      repliesReceivedToday.count ?? 0,
    activeConvos:   activeConvosCount.count ?? 0,
    pendingQueue:   pendingInvitesCount.count ?? 0,
  }

  // ── Hero gamificado: invites de ayer + streak por cuenta ─────────────────
  // invites_sent_today ya viene de v_account_today.
  // Aquí calculamos: invites ayer (comparación) + activeDays últimos 14d (streak).
  const heroAccountIds = (await (async () => {
    const cq = admin.from("conversations").select("linkedin_account_id")
    const { data } = isRestricted && linkedAccountId
      ? await cq.eq("linkedin_account_id", linkedAccountId)
      : await cq
    return Array.from(new Set((data ?? []).map((c: any) => c.linkedin_account_id).filter(Boolean)))
  })()) as string[]

  const heroByAccount: Record<string, { yesterday: number; activeDays: Set<string> }> = {}
  for (const id of heroAccountIds) heroByAccount[id] = { yesterday: 0, activeDays: new Set() }

  if (heroAccountIds.length > 0) {
    // Convos del usuario para mapear event → cuenta (sin .in con cientos de UUIDs)
    const { data: convoMap } = await admin
      .from("conversations")
      .select("id, linkedin_account_id")
      .in("linkedin_account_id", heroAccountIds)
    const convoToAcct = new Map<string, string>()
    for (const c of convoMap ?? []) convoToAcct.set((c as any).id, (c as any).linkedin_account_id)

    // Invite events últimos 14d para esas convos
    const { data: inviteEvents } = await admin
      .from("conversation_events")
      .select("conversation_id, sent_at")
      .eq("event_type", "invite_sent")
      .gte("sent_at", last14StartUtc)
      .order("sent_at", { ascending: false })
      .limit(1000)

    for (const ev of inviteEvents ?? []) {
      const acctId = convoToAcct.get((ev as any).conversation_id)
      if (!acctId) continue
      const bucket = heroByAccount[acctId]
      if (!bucket) continue
      const sentAt = (ev as any).sent_at as string
      // Día CDMX
      const dayCDMX = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date(sentAt))
      bucket.activeDays.add(dayCDMX)
      if (sentAt >= yesterdayStartUtc && sentAt < yesterdayEndUtc) bucket.yesterday++
    }
  }

  // Streak = días consecutivos hacia atrás desde HOY (o desde AYER si hoy=0)
  function calcStreak(activeDays: Set<string>): number {
    let streak = 0
    let cursor = new Date()
    // Si hoy aún no tiene actividad, empezar a contar desde ayer
    const todayKey = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(cursor)
    if (!activeDays.has(todayKey)) cursor = new Date(cursor.getTime() - 86_400_000)
    for (let i = 0; i < 30; i++) {
      const k = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit",
      }).format(cursor)
      if (activeDays.has(k)) { streak++; cursor = new Date(cursor.getTime() - 86_400_000) }
      else break
    }
    return streak
  }

  const heroCards = ((accounts as AccountToday[]) ?? []).map(a => {
    const bucket = heroByAccount[a.account_id ?? ""] ?? { yesterday: 0, activeDays: new Set<string>() }
    const todayInvites = (a.invites_sent_today ?? 0)
    const target = a.daily_connection_limit ?? 0
    const pctTarget = target > 0 ? Math.min(Math.round(todayInvites / target * 100), 100) : 0
    return {
      accountId: a.account_id ?? "unknown",
      label: a.label ?? "Cuenta",
      status: a.status,
      invitesToday: todayInvites,
      messagesToday: a.messages_sent_today ?? 0,
      remaining: a.remaining_quota ?? 0,
      target,
      pctTarget,
      yesterday: bucket.yesterday,
      streak: calcStreak(bucket.activeDays),
    }
  })

  const stats    = campaigns as CampaignStats[] ?? []
  const accs     = accounts  as AccountToday[]  ?? []
  const rawAccs  = rawAccounts ?? []
  // Deduplicate by (account_id + alert_type) — keep most recent only
  const _seenAlertKeys = new Set<string>()
  const activeAlerts = (alerts ?? []).filter((a: any) => {
    const key = `${a.linkedin_account_id ?? "global"}::${a.alert_type}`
    if (_seenAlertKeys.has(key)) return false
    _seenAlertKeys.add(key)
    return true
  })

  const totals = stats.reduce(
    (acc, c) => ({
      leads:    acc.leads    + (c.total_leads ?? 0),
      invited:  acc.invited  + (c.invited     ?? 0),
      replied:  acc.replied  + (c.replied     ?? 0),
      meetings: acc.meetings + (c.meetings    ?? 0),
    }),
    { leads: 0, invited: 0, replied: 0, meetings: 0 }
  )

  // ── Pipeline funnel ───────────────────────────────────────────────────────
  // Without date filter: all leads (current state snapshot)
  // With date filter: leads whose invite was sent in that period (cohort view)
  let pipelineQuery = admin
    .from("leads")
    .select("status, campaign_id, sent_at, created_at")

  if (isRestricted && linkedAccountId) {
    const { data: acctCamps } = await admin
      .from("campaigns").select("id").eq("linkedin_account_id", linkedAccountId)
    const ids = (acctCamps ?? []).map((c: any) => c.id)
    if (ids.length > 0) pipelineQuery = pipelineQuery.in("campaign_id", ids)
  }

  if (dateRange) {
    // Show status distribution for leads whose invite was sent in the period
    // Leads without sent_at (pending) are included if created in the period
    pipelineQuery = (pipelineQuery as any).or(
      `and(sent_at.gte.${dateRange.from},sent_at.lte.${dateRange.to}),` +
      `and(sent_at.is.null,created_at.gte.${dateRange.from},created_at.lte.${dateRange.to})`
    )
  }

  const { data: pipelineRaw } = await pipelineQuery
  const pipelineCounts: Record<string, number> = {}
  for (const l of pipelineRaw ?? []) {
    pipelineCounts[l.status ?? "unknown"] = (pipelineCounts[l.status ?? "unknown"] ?? 0) + 1
  }

  // ── FM pipeline: leads replied con su conversation_turn ──────────────────
  let fmQuery = admin
    .from("leads")
    .select(`
      id, full_name, status, replied_at, source, inbound_signal,
      profile_data,
      conversations ( conversation_turn, last_message_text, last_message_at, ai_reply_scheduled_at, ai_reply_draft )
    `)
    .eq("status", "replied")
    .order("replied_at", { ascending: false })
    .limit(60)

  if (isRestricted && linkedAccountId) {
    const { data: acctCamps3 } = await admin
      .from("campaigns").select("id").eq("linkedin_account_id", linkedAccountId)
    const ids3 = (acctCamps3 ?? []).map((c: any) => c.id)
    if (ids3.length > 0) fmQuery = fmQuery.in("campaign_id", ids3)
  }

  const { data: fmLeads } = await fmQuery

  // Group by FM stage. Supabase devuelve `conversations` como OBJETO cuando la
  // relación es uno-a-uno (FK + UNIQUE), no como array. El [0] anterior daba
  // undefined → todos los leads caían a FM1 con turn=0. Soportamos ambos.
  const fm1: any[] = [], fm2: any[] = [], fm3: any[] = []
  for (const l of fmLeads ?? []) {
    const conv = Array.isArray(l.conversations) ? l.conversations[0] : l.conversations
    const turn = conv?.conversation_turn ?? 0
    if (turn === 0)       fm1.push(l)
    else if (turn <= 2)   fm2.push(l)
    else                  fm3.push(l)
  }

  const criticalAlerts = activeAlerts.filter(a => a.severity === "critical")
  const warningAlerts  = activeAlerts.filter(a => a.severity === "warning")

  const displayTotals = filteredTotals ?? totals

  // ── Activity timeline (14 días) ──────────────────────────────────────────
  // Eventos agrupados por día y tipo. Scoped al user via convos.linkedin_account_id.
  const timelineSince = new Date(Date.now() - 14 * 86_400_000).toISOString()
  let timelineQuery: any = admin.from("conversation_events").select(
    isRestricted && linkedAccountId
      ? "event_type, sent_at, conversations!inner(linkedin_account_id)"
      : "event_type, sent_at",
  )
    .gte("sent_at", timelineSince)
    .order("sent_at", { ascending: true })
    .limit(2000)
  if (isRestricted && linkedAccountId) {
    timelineQuery = timelineQuery.eq("conversations.linkedin_account_id", linkedAccountId)
  }
  const { data: timelineRaw } = await timelineQuery

  // Bucketize: invites | fus | auto_replies | replies_in
  type TimelineDay = { day: string; invites: number; fus: number; autoReplies: number; repliesIn: number }
  const timelineMap = new Map<string, TimelineDay>()
  // Seed 14 días vacíos (incluso si no hay actividad)
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000)
    const key = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d)
    timelineMap.set(key, { day: key, invites: 0, fus: 0, autoReplies: 0, repliesIn: 0 })
  }
  for (const ev of (timelineRaw ?? []) as any[]) {
    const dayKey = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(ev.sent_at))
    const bucket = timelineMap.get(dayKey)
    if (!bucket) continue
    const t = ev.event_type as string
    if (t === "invite_sent") bucket.invites++
    else if (t?.startsWith("follow_up_sent")) bucket.fus++
    else if (t === "reply_sent") bucket.autoReplies++
    else if (t === "reply_received") bucket.repliesIn++
  }
  const timeline = Array.from(timelineMap.values())

  // ── Conversion rates (all-time, scoped a user) ──────────────────────────
  // Defino "ever invited" = leads con sent_at no nulo
  // "ever accepted" = leads que están en connected, follow_up_*, replied, meeting_booked
  let convQ: any = admin.from("leads").select("status, sent_at, replied_at, meeting_booked_at")
  if (isRestricted && linkedAccountId) {
    const { data: ucIds } = await admin.from("campaigns").select("id").eq("linkedin_account_id", linkedAccountId)
    const ids = (ucIds ?? []).map((c: any) => c.id)
    if (ids.length > 0) convQ = convQ.in("campaign_id", ids)
  }
  const { data: convLeads } = await convQ
  const everInvited  = (convLeads ?? []).filter((l: any) => l.sent_at != null).length
  const everAccepted = (convLeads ?? []).filter((l: any) =>
    ["connected", "follow_up_sent", "replied", "meeting_booked"].includes(l.status ?? "")
  ).length
  const everReplied  = (convLeads ?? []).filter((l: any) => l.replied_at != null).length
  const everMeetings = (convLeads ?? []).filter((l: any) => l.meeting_booked_at != null || l.status === "meeting_booked").length

  const conv = {
    acceptRate:  everInvited > 0  ? Math.round((everAccepted / everInvited)  * 100) : 0,
    replyRate:   everAccepted > 0 ? Math.round((everReplied  / everAccepted) * 100) : 0,
    meetingRate: everReplied > 0  ? Math.round((everMeetings / everReplied)  * 100) : 0,
    overall:     everInvited > 0  ? Math.round((everMeetings / everInvited)  * 100 * 10) / 10 : 0,
    everInvited, everAccepted, everReplied, everMeetings,
  }

  // ── Connectivity timeline 24h (uptime de extensions por cuenta) ─────────
  const connSince = new Date(Date.now() - 24 * 3600_000).toISOString()
  let connQ: any = admin.from("account_connectivity_log")
    .select("linkedin_account_id, event_type, created_at, linkedin_accounts!inner(label)")
    .gte("created_at", connSince)
    .order("created_at", { ascending: true })
    .limit(500)
  if (isRestricted && linkedAccountId) {
    connQ = connQ.eq("linkedin_account_id", linkedAccountId)
  }
  const { data: connEvents } = await connQ

  // Construir uptime buckets por cuenta
  type ConnBucket = "up" | "down" | "unknown"
  const connByAccount: Record<string, { label: string; buckets: ConnBucket[]; lastUp: string | null; lastDown: string | null }> = {}
  const nowMs = Date.now()
  for (const ev of (connEvents ?? []) as any[]) {
    const aid = ev.linkedin_account_id as string
    const lbl = ev.linkedin_accounts?.label as string ?? aid.slice(0,8)
    if (!connByAccount[aid]) {
      connByAccount[aid] = { label: lbl, buckets: Array(24).fill("unknown"), lastUp: null, lastDown: null }
    }
  }
  // Para cada cuenta, fill buckets desde events
  for (const aid in connByAccount) {
    const evts = (connEvents ?? []).filter((e: any) => e.linkedin_account_id === aid)
    let isUp = false
    let prevTs: number | null = null
    const b = connByAccount[aid].buckets
    for (const ev of evts) {
      const ts = new Date(ev.created_at as string).getTime()
      if (prevTs !== null) {
        for (let h = 0; h < 24; h++) {
          const bs = nowMs - (24 - h) * 3600_000
          const be = nowMs - (23 - h) * 3600_000
          if (ts < bs || prevTs > be) continue
          const ov = Math.min(ts, be) - Math.max(prevTs, bs)
          if (ov <= 0) continue
          if (b[h] === "up") continue
          if (isUp && ov >= 180_000) b[h] = "up"
          else if (!isUp && b[h] === "unknown") b[h] = "down"
        }
      }
      if (ev.event_type === "connected") {
        isUp = true
        connByAccount[aid].lastUp = ev.created_at as string
      } else if (ev.event_type === "disconnected") {
        isUp = false
        connByAccount[aid].lastDown = ev.created_at as string
      }
      prevTs = ts
    }
    // Hasta now
    if (prevTs !== null) {
      for (let h = 0; h < 24; h++) {
        const bs = nowMs - (24 - h) * 3600_000
        const be = nowMs - (23 - h) * 3600_000
        if (nowMs < bs || prevTs > be) continue
        const ov = Math.min(nowMs, be) - Math.max(prevTs, bs)
        if (ov <= 0) continue
        if (b[h] === "up") continue
        if (isUp && ov >= 180_000) b[h] = "up"
        else if (!isUp && b[h] === "unknown") b[h] = "down"
      }
    }
  }
  const connTimelineRows = Object.entries(connByAccount).map(([aid, v]) => {
    const known = v.buckets.filter(x => x !== "unknown").length
    const up = v.buckets.filter(x => x === "up").length
    return {
      accountId: aid,
      label: v.label,
      buckets: v.buckets,
      uptimePct: known > 0 ? Math.round((up / known) * 100) : null,
      lastUp: v.lastUp,
      lastDown: v.lastDown,
    }
  })

  // ── Extension version check (latest deployada vs cada cuenta) ──────────
  let latestExtVersion: string | null = null
  try {
    const m = JSON.parse(readFileSync("/opt/orion-public/manifest.json", "utf8"))
    latestExtVersion = m?.version ?? null
  } catch {}

  let extVerQ: any = admin.from("linkedin_accounts")
    .select("id, label, ext_version, extension_last_seen_at")
  if (isRestricted && linkedAccountId) extVerQ = extVerQ.eq("id", linkedAccountId)
  const { data: extVerAccounts } = await extVerQ

  const cmpVer = (a: string | null, b: string | null) => {
    if (!a || !b) return 0
    const pa = a.split(".").map(Number)
    const pb = b.split(".").map(Number)
    for (let i = 0; i < 3; i++) {
      if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1
      if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1
    }
    return 0
  }
  const outdatedExtensions = (extVerAccounts ?? [])
    .filter((a: any) => a.ext_version && latestExtVersion && cmpVer(a.ext_version, latestExtVersion) < 0)
    .map((a: any) => ({
      label: a.label as string,
      current: a.ext_version as string,
      latest: latestExtVersion as string,
      lastSeen: a.extension_last_seen_at as string | null,
    }))

  // ── Orphan conversations (conversaciones NO matcheadas a leads) ─────────
  let orphansQ: any = admin.from("orphan_conversations")
    .select("id, scraped_name, snippet, unread_count, linkedin_thread_id, last_activity_label, occurrence_count, last_seen_at, status, linkedin_account_id")
    .eq("status", "pending")
    .order("last_seen_at", { ascending: false })
    .limit(20)
  if (isRestricted && linkedAccountId) {
    orphansQ = orphansQ.eq("linkedin_account_id", linkedAccountId)
  }
  const { data: orphanRows } = await orphansQ
  const orphans = (orphanRows ?? []) as any[]

  return (
    <div className="p-4 sm:p-8 space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-50">Dashboard</h1>
          <p className="text-gray-400 text-sm mt-1">
            {rangeLabel(range, spFrom, spTo)}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <InboxSweepBtn />
          <RefreshButton />
          <DashboardFiltersBar initialRange={range} initialFrom={spFrom} initialTo={spTo} />
        </div>
      </div>

      {/* ── Banner: extensions con versión vieja ─────────────────────────────── */}
      {outdatedExtensions.length > 0 && (
        <section>
          <div className="bg-amber-950/40 border border-amber-500/40 rounded-xl p-4 flex items-start gap-3">
            <span className="text-2xl">⬆️</span>
            <div className="flex-1">
              <div className="text-amber-300 font-semibold">
                Nueva versión de Orion Sync disponible (v{latestExtVersion})
              </div>
              <ul className="text-amber-200/80 text-sm mt-1 space-y-0.5">
                {outdatedExtensions.map((o: { label: string; current: string; latest: string; lastSeen: string | null }) => (
                  <li key={o.label}>
                    <strong>{o.label}</strong> corriendo v{o.current}
                    {o.lastSeen && <span className="text-amber-200/50 ml-2 text-xs">
                      (último heartbeat {new Date(o.lastSeen).toLocaleString("es-MX", { day:"2-digit", month:"short", hour:"2-digit", minute:"2-digit" })})
                    </span>}
                  </li>
                ))}
              </ul>
              <p className="text-amber-200/70 text-xs mt-2">
                Reinstala desde el popup de la extensión (banner amarillo) o copia el comando de actualización.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* ── Alertas críticas ──────────────────────────────────────────────────── */}
      {activeAlerts.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
            Alertas activas
            <span className="text-xs font-normal normal-case text-gray-500">({activeAlerts.length})</span>
          </h2>
          <div className="space-y-2">
            {criticalAlerts.map(a => (
              <AlertCard key={a.id} alert={a} />
            ))}
            {warningAlerts.slice(0, isAdmin ? 5 : 3).map(a => (
              <AlertCard key={a.id} alert={a} />
            ))}
            {activeAlerts.length > (criticalAlerts.length + Math.min(warningAlerts.length, isAdmin ? 5 : 3)) && (
              <p className="text-xs text-gray-500 text-center">
                +{activeAlerts.length - criticalAlerts.length - Math.min(warningAlerts.length, isAdmin ? 5 : 3)} alertas más en{" "}
                <Link href="/dashboard/monitor" className="text-blue-400 hover:text-blue-300">Monitor</Link>
              </p>
            )}
          </div>
        </section>
      )}

      {/* ── Drift detection: respuestas manuales fuera de Orion ────────────────── */}
      {driftAccounts.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
            📱 Actividad manual fuera de Orion
            <span className="text-xs font-normal normal-case text-gray-500">
              (últimos 7 días)
            </span>
          </h2>
          <div className="bg-orange-950/30 border border-orange-500/30 rounded-xl p-4">
            <p className="text-orange-300 text-sm mb-3">
              Detectamos mensajes que se enviaron desde LinkedIn directamente, sin pasar por Orion.
              Esto es normal si respondiste manualmente, pero puede indicar drift entre tu operación y el sistema.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              {driftAccounts.map(d => (
                <div key={d.label} className="bg-gray-900 border border-orange-500/20 rounded-lg p-3 flex items-center justify-between">
                  <div>
                    <div className="text-gray-50 text-sm font-semibold">{d.label}</div>
                    <div className="text-gray-500 text-xs mt-0.5">
                      Última: {new Date(d.lastAt).toLocaleString("es-MX", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-orange-400 text-2xl font-bold leading-none">{d.count}</div>
                    <div className="text-orange-300 text-[10px] uppercase tracking-wider">mensaje{d.count !== 1 ? "s" : ""}</div>
                  </div>
                </div>
              ))}
            </div>
            <Link href="/dashboard/conversations?tab=linkedin_manual" className="inline-block mt-3 text-xs text-orange-400 hover:text-orange-300">
              Ver conversaciones afectadas →
            </Link>
          </div>
        </section>
      )}

      {/* ── HOY · Hero gamificado por cuenta ────────────────────────────────── */}
      {heroCards.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
              🎯 Hoy
              <span className="text-xs font-normal normal-case text-gray-500">
                {new Date().toLocaleDateString("es-MX", { timeZone: "America/Mexico_City", weekday: "long", day: "numeric", month: "long" })}
              </span>
            </h2>
            <span className="text-[10px] text-gray-600">
              Meta = límite diario de la cuenta · 🔥 = racha de días seguidos enviando
            </span>
          </div>
          <div className={`grid gap-3 ${heroCards.length === 1 ? "grid-cols-1" : "grid-cols-1 md:grid-cols-2"}`}>
            {heroCards.map(h => <TodayHeroCard key={h.accountId} hero={h} />)}
          </div>

          {/* Mini-KPIs secundarios (fuera del hero, datos agregados) */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            <MiniMetric icon="📨" label="Follow-ups hoy"     value={todaySummary.fus}          tone="indigo" />
            <MiniMetric icon="💬" label="Respuestas recibidas" value={todaySummary.repliesIn}  tone="purple" />
            <MiniMetric icon="🤖" label="Auto-replies Gemini" value={todaySummary.autoReplies} tone="green"
              hint={todaySummary.manualReplies > 0 ? `+ ${todaySummary.manualReplies} manuales` : undefined} />
            <MiniMetric icon="🗣️" label="Conversaciones activas" value={todaySummary.activeConvos} tone="cyan"
              hint="≥1 turno con respuesta" />
          </div>
        </section>
      )}

      {/* ── Cohort del período (solo si hay filtro de fecha) ───────────────── */}
      {dateRange && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
            📈 Cohort · {rangeLabel(range, spFrom, spTo)}
          </h2>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <KpiCard label="Leads nuevos"  value={displayTotals.leads}    color="blue"   icon="👥" subtitle="creados en período" />
            <KpiCard label="Invitados"     value={displayTotals.invited}  color="indigo" icon="✉️" subtitle="enviadas en período" />
            <KpiCard label="Respondieron"  value={displayTotals.replied}  color="orange" icon="📩" subtitle="respuestas recibidas" />
            <KpiCard label="Reuniones"     value={displayTotals.meetings} color="green"  icon="📅" subtitle="agendadas en período" />
          </div>
        </section>
      )}

      {/* ── Pipeline Funnel ──────────────────────────────────────────────────── */}
      <PipelineFunnel
        counts={{ ...pipelineCounts, _fm1: fm1.length, _fm2: fm2.length, _fm3: fm3.length }}
        filtered={!!dateRange}
        filterLabel={rangeLabel(range, spFrom, spTo)}
      />

      {/* ── FM Pipeline ─────────────────────────────────────────────────────��───── */}
      {(fm1.length + fm2.length + fm3.length) > 0 && (
        <FmPipeline fm1={fm1} fm2={fm2} fm3={fm3} />
      )}

      {/* ── Conversion rates (all-time) ──────────────────────────────────────── */}
      {conv.everInvited > 0 && <ConversionRates conv={conv} />}

      {/* ── Activity timeline 14 días ────────────────────────────────────────── */}
      <ActivityTimeline timeline={timeline} />

      {/* ── Connectivity timeline 24h ─────────────────────────────────────── */}
      {connTimelineRows.length > 0 && <ConnectivityTimeline rows={connTimelineRows} />}

      {/* ── Orphan conversations (no matcheadas a leads) ─────────────────────── */}
      {orphans.length > 0 && <OrphanConversations orphans={orphans} />}

      {/* ── Extension health monitor ───────────────────────────────────────────── */}
      {rawAccs.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Salud de extensiones</h2>
            <span className="text-xs text-gray-600">
              ⚡ Chrome con extension abierto = automatización viva
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {rawAccs.map((acc: any) => (
              <ExtensionHealthCard key={acc.id} account={acc} />
            ))}
          </div>
          <p className="text-xs text-gray-600 text-right">
            Detalles en{" "}
            <Link href="/dashboard/accounts" className="text-blue-400 hover:text-blue-300">
              Cuentas LinkedIn →
            </Link>
          </p>
        </section>
      )}

      {/* ── Accounts quota ────────────────────────────────────────────────────── */}
      {accs.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Cuentas LinkedIn — Hoy</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {accs.map((a) => (
              <AccountCard key={a.account_id} account={a} />
            ))}
          </div>
        </section>
      )}

      {/* ── Campaigns ─────────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Campañas</h2>
        {stats.length === 0 ? (
          <p className="text-gray-500 text-sm">No hay campañas aún.</p>
        ) : (
          <div className="space-y-3">
            {stats.map((c) => <CampaignRow key={c.campaign_id} campaign={c} />)}
          </div>
        )}
      </section>
    </div>
  )
}

// ── Alert card ────────────────────────────────────────────────────────────────

const ALERT_TYPE_ICON: Record<string, string> = {
  captcha:       "🤖",
  rate_limited:  "⚡",
  banned:        "🚫",
  cookie_expiry: "🔑",
  error_spike:   "💥",
}
const ALERT_TYPE_LABEL: Record<string, string> = {
  captcha:       "Captcha detectado",
  rate_limited:  "Rate limit / Authwall",
  banned:        "Cuenta baneada",
  cookie_expiry: "Cookie expirando",
  error_spike:   "Error en automatización",
}
const ALERT_SEVERITY_STYLE: Record<string, string> = {
  critical: "bg-red-950/60 border-red-500/40 text-red-300",
  warning:  "bg-yellow-950/60 border-yellow-500/30 text-yellow-300",
  info:     "bg-blue-950/60 border-blue-500/30 text-blue-300",
}
const ALERT_BADGE_STYLE: Record<string, string> = {
  critical: "bg-red-500/20 text-red-300 border-red-500/40",
  warning:  "bg-yellow-500/20 text-yellow-300 border-yellow-500/40",
  info:     "bg-blue-500/20 text-blue-300 border-blue-500/30",
}

function AlertCard({ alert }: { alert: any }) {
  const style = ALERT_SEVERITY_STYLE[alert.severity] ?? ALERT_SEVERITY_STYLE.warning
  const badge = ALERT_BADGE_STYLE[alert.severity]    ?? ALERT_BADGE_STYLE.warning
  const icon  = ALERT_TYPE_ICON[alert.alert_type]    ?? "⚠️"
  const label = ALERT_TYPE_LABEL[alert.alert_type]   ?? alert.alert_type
  const mins  = Math.floor((Date.now() - new Date(alert.created_at).getTime()) / 60_000)
  const timeAgo = mins < 2 ? "Ahora" : mins < 60 ? `Hace ${mins} min` : mins < 1440 ? `Hace ${Math.floor(mins/60)}h` : `Hace ${Math.floor(mins/1440)}d`

  return (
    <div className={`flex items-start gap-3 px-4 py-3 rounded-xl border text-sm ${style}`}>
      <span className="text-lg shrink-0 mt-0.5">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${badge}`}>{label}</span>
          <span className="text-xs opacity-60">{timeAgo}</span>
        </div>
        <p className="mt-1 text-xs leading-snug opacity-90">{alert.message}</p>
      </div>
    </div>
  )
}

// ── Extension health card ────────────────────────────────────────────────────

const HEALTH_STYLES = {
  ok:       { ring: "border-green-500/30",  bg: "bg-green-500/10",  text: "text-green-400",  label: "Conectada" },
  warning:  { ring: "border-yellow-500/30", bg: "bg-yellow-500/10", text: "text-yellow-400", label: "Stale" },
  critical: { ring: "border-red-500/40",    bg: "bg-red-500/10",    text: "text-red-400",    label: "Offline" },
  unknown:  { ring: "border-gray-600/40",   bg: "bg-gray-700/20",   text: "text-gray-400",   label: "Sin registro" },
  paused:   { ring: "border-blue-500/30",   bg: "bg-blue-500/10",   text: "text-blue-400",   label: "Pausada" },
}

const WARMUP_LABEL: Record<string, string> = {
  cold:    "❄️ Cold (cap bajo)",
  warming: "🌡️ Warming",
  warm:    "🔥 Warm",
  hot:     "🚀 Hot",
}

function ExtensionHealthCard({ account }: { account: any }) {
  const health = extensionHealth(account.extension_last_seen_at, account.extension_paused)
  const s = HEALTH_STYLES[health.status]

  const statusDot: Record<string, string> = {
    active:       "bg-green-400",
    rate_limited: "bg-yellow-400",
    banned:       "bg-red-500",
    disconnected: "bg-gray-500",
  }

  // Progress bar: 0 min = 0%, 6h = 100% (stale ratio)
  const stalePct = health.minutes !== null
    ? Math.min(Math.round((health.minutes / EXT_CRITICAL_MIN) * 100), 100)
    : 100

  return (
    <div className={`bg-gray-900 border ${s.ring} rounded-xl p-4 space-y-3`}>
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot[account.status] ?? "bg-gray-500"}`} />
          <span className="text-gray-50 text-sm font-medium truncate">{account.label ?? "Sin nombre"}</span>
        </div>
        <span className={`text-xs px-2 py-0.5 rounded-full border font-semibold ${s.bg} ${s.text} ${s.ring}`}>
          {s.label}
        </span>
      </div>

      {/* Heartbeat row */}
      <div className="space-y-1.5">
        <div className="flex justify-between items-center text-xs">
          <span className="text-gray-400">Heartbeat extension</span>
          <span className={`font-medium ${s.text}`}>{health.label}</span>
        </div>

        {/* Progress bar inverted: full=stale, empty=fresh */}
        <div className="w-full bg-gray-800 rounded-full h-2">
          <div
            className={`h-2 rounded-full transition-all ${
              health.status === "critical" ? "bg-red-500" :
              health.status === "warning"  ? "bg-yellow-500" :
              health.status === "unknown" || health.status === "paused"  ? "bg-gray-600" :
              "bg-green-500"
            }`}
            style={{ width: `${health.status === "ok" ? Math.max(10, 100 - stalePct) : stalePct}%` }}
          />
        </div>

        <div className="flex justify-between text-xs text-gray-600">
          <span>{WARMUP_LABEL[account.warmup_status as string] ?? account.warmup_status ?? "—"}</span>
          {(health.status === "critical" || health.status === "unknown") && (
            <Link href="/dashboard/accounts" className="text-red-400 hover:text-red-300 font-medium">
              Reconectar →
            </Link>
          )}
          {health.status === "paused" && (
            <Link href="/dashboard/accounts" className="text-blue-400 hover:text-blue-300 font-medium">
              Configurar →
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Today hero card (gamificado por cuenta) ────────────────────────────────

const STATUS_STYLE: Record<string, { dot: string; label: string; text: string }> = {
  active:       { dot: "bg-green-400",  label: "Activa",       text: "text-green-400"  },
  rate_limited: { dot: "bg-yellow-400", label: "Rate-limited", text: "text-yellow-400" },
  banned:       { dot: "bg-red-500",    label: "Baneada",      text: "text-red-400"    },
  disconnected: { dot: "bg-gray-500",   label: "Desconectada", text: "text-gray-400"   },
}

function TodayHeroCard({ hero }: {
  hero: {
    accountId: string; label: string; status: string | null;
    invitesToday: number; messagesToday: number; remaining: number; target: number;
    pctTarget: number; yesterday: number; streak: number;
  }
}) {
  const st = STATUS_STYLE[hero.status ?? ""] ?? STATUS_STYLE.disconnected
  const delta = hero.invitesToday - hero.yesterday
  const trendColor = delta > 0 ? "text-green-400" : delta < 0 ? "text-red-400" : "text-gray-500"
  const trendArrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "→"
  const barColor =
    hero.pctTarget >= 90 ? "bg-green-500" :
    hero.pctTarget >= 60 ? "bg-blue-500"  :
    hero.pctTarget >= 30 ? "bg-indigo-500":
    "bg-gray-700"
  const targetReached = hero.target > 0 && hero.invitesToday >= hero.target

  return (
    <div className="bg-gradient-to-br from-gray-900 to-gray-900/60 border border-gray-800 rounded-2xl p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full shrink-0 ${st.dot}`} />
          <span className="text-gray-50 font-semibold truncate">{hero.label}</span>
          <span className={`text-[10px] ${st.text}`}>· {st.label}</span>
        </div>
        {hero.streak > 0 && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-400 border border-orange-500/30 font-bold whitespace-nowrap">
            🔥 {hero.streak} día{hero.streak === 1 ? "" : "s"} seguidos
          </span>
        )}
      </div>

      {/* Main number + progress vs goal */}
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-5xl font-bold text-gray-50 leading-none">{hero.invitesToday}</span>
            <span className="text-sm text-gray-500">/ {hero.target || "?"} invites</span>
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs">
            <span className={trendColor + " font-bold"}>{trendArrow} {Math.abs(delta)}</span>
            <span className="text-gray-600">vs ayer ({hero.yesterday})</span>
          </div>
        </div>
        {targetReached && (
          <span className="text-3xl" title="¡Meta del día completada!">🏆</span>
        )}
      </div>

      {/* Progress bar */}
      {hero.target > 0 && (
        <div className="space-y-1">
          <div className="w-full bg-gray-800 rounded-full h-2.5 overflow-hidden">
            <div className={`h-2.5 rounded-full transition-all ${barColor}`} style={{ width: `${hero.pctTarget}%` }} />
          </div>
          <div className="flex justify-between text-[10px] text-gray-500">
            <span>{hero.pctTarget}% de la meta</span>
            <span>{hero.remaining} restantes</span>
          </div>
        </div>
      )}

      {/* Secondary stats */}
      <div className="flex gap-4 text-xs text-gray-400 pt-1 border-t border-gray-800/60">
        <div>
          <span className="text-gray-50 font-semibold">{hero.messagesToday}</span>
          <span className="ml-1 text-gray-500">FU/replies</span>
        </div>
        <div className="ml-auto">
          <Link href="/dashboard/accounts" className="text-blue-400 hover:text-blue-300">Ver cuenta →</Link>
        </div>
      </div>
    </div>
  )
}

// ── Mini metric (secundario) ──────────────────────────────────────────────

function MiniMetric({ icon, label, value, tone, hint }: {
  icon: string; label: string; value: number; tone: "indigo" | "purple" | "green" | "cyan"; hint?: string
}) {
  const tones: Record<string, string> = {
    indigo: "border-indigo-500/20 hover:border-indigo-500/40",
    purple: "border-purple-500/20 hover:border-purple-500/40",
    green:  "border-green-500/20  hover:border-green-500/40",
    cyan:   "border-cyan-500/20   hover:border-cyan-500/40",
  }
  return (
    <div className={`bg-gray-900/60 border rounded-xl px-3 py-2.5 transition-colors ${tones[tone]}`}>
      <div className="flex items-center gap-2">
        <span className="text-base">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-bold text-gray-50 leading-none">{value}</span>
            {hint && <span className="text-[9px] text-gray-500 truncate">{hint}</span>}
          </div>
          <div className="text-[10px] text-gray-500 mt-0.5 truncate">{label}</div>
        </div>
      </div>
    </div>
  )
}

// ── KPI card ─────────────────────────────────────────────────────────────────

function KpiCard({ label, value, color, icon, subtitle }: {
  label: string; value: number; color: string; icon: string; subtitle?: string
}) {
  const colors: Record<string, string> = {
    blue:   "bg-blue-500/10 border-blue-500/20 text-blue-400",
    indigo: "bg-indigo-500/10 border-indigo-500/20 text-indigo-400",
    orange: "bg-orange-500/10 border-orange-500/20 text-orange-400",
    green:  "bg-green-500/10 border-green-500/20 text-green-400",
  }
  return (
    <div className={`rounded-xl border p-5 ${colors[color]}`}>
      <div className="flex items-center justify-between">
        <span className="text-2xl">{icon}</span>
        <span className="text-3xl font-bold text-gray-50">{value}</span>
      </div>
      <p className="text-sm mt-2 font-medium">{label}</p>
      {subtitle && <p className="text-[10px] mt-0.5 opacity-60">{subtitle}</p>}
    </div>
  )
}

// ── Account card (daily quota) ────────────────────────────────────────────────

function AccountCard({ account: a }: { account: AccountToday }) {
  const pct = a.daily_connection_limit
    ? Math.round(((a.invites_sent_today ?? 0) + (a.messages_sent_today ?? 0)) / a.daily_connection_limit * 100)
    : 0

  const statusColor: Record<string, string> = {
    active:       "text-green-400",
    rate_limited: "text-yellow-400",
    banned:       "text-red-400",
    disconnected: "text-gray-400",
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-50">
          {a.label ?? a.linkedin_profile_url ?? "Cuenta sin nombre"}
        </span>
        <span className={`text-xs font-medium ${statusColor[a.status ?? ""] ?? "text-gray-400"}`}>
          {a.status}
        </span>
      </div>
      <div className="space-y-1">
        <div className="flex justify-between text-xs text-gray-400">
          <span>{(a.invites_sent_today ?? 0) + (a.messages_sent_today ?? 0)} enviados</span>
          <span>{a.remaining_quota ?? 0} restantes</span>
        </div>
        <div className="w-full bg-gray-800 rounded-full h-1.5">
          <div
            className={`h-1.5 rounded-full transition-all ${pct >= 90 ? "bg-red-500" : pct >= 60 ? "bg-yellow-500" : "bg-blue-500"}`}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>
      </div>
    </div>
  )
}

// ── Pipeline Funnel ───────────────────────────────────────────────────────────

const FUNNEL_STAGES = [
  { value: "pending",          label: "En cola",    icon: "⏳", color: "#64748b", indent: false },
  { value: "invite_sent",      label: "Invitados",  icon: "✉️", color: "#60a5fa", indent: false },
  { value: "connected",        label: "Conectados", icon: "🤝", color: "#34d399", indent: false },
  { value: "follow_up_sent",   label: "Seguimiento", icon: "📨", color: "#818cf8", indent: false },
  { value: "replied",          label: "Respondió",  icon: "💬", color: "#fb923c", indent: false },
  { value: "_fm1",             label: "↳ FM1 Rapport",    icon: "🔵", color: "#60a5fa", indent: true },
  { value: "_fm2",             label: "↳ FM2 Profundizar", icon: "🟡", color: "#fbbf24", indent: true },
  { value: "_fm3",             label: "↳ FM3 Cierre",     icon: "🟢", color: "#34d399", indent: true },
  { value: "meeting_booked",   label: "Reunión",    icon: "📅", color: "#facc15", indent: false },
  { value: "dead",             label: "Perdidos",   icon: "💀", color: "#6b7280", indent: false },
]

function PipelineFunnel({ counts, filtered, filterLabel }: {
  counts: Record<string, number>
  filtered?: boolean
  filterLabel?: string
}) {
  const activeStages = FUNNEL_STAGES.filter(s => s.value !== "dead")
  const dead = counts["dead"] ?? 0
  const disq = counts["disqualified"] ?? 0
  const totalInPipeline = activeStages.reduce((s, st) => s + (counts[st.value] ?? 0), 0)

  // Conversion anclada al cohort de "Invitados": cuántos llegaron a cada etapa.
  // "En cola" NO entra en el cálculo (no son parte del cohort enviado).
  // Las sub-etapas FM también se comparan contra Invitados.
  const invitedBase = (counts["invite_sent"] ?? 0)
    + (counts["connected"] ?? 0)
    + (counts["follow_up_sent"] ?? 0)
    + (counts["replied"] ?? 0) + (counts["meeting_booked"] ?? 0) + dead
  // Para la barra: la etapa con más leads define la escala
  const maxVal = Math.max(...activeStages.filter(s => !s.value.startsWith("_fm")).map(s => counts[s.value] ?? 0), 1)

  // Funnel cohort: cuántos del cohort "invited" llegaron HASTA esta etapa.
  // Se calcula como suma de la etapa actual + todas las posteriores (las
  // etapas más avanzadas implican que pasaron por la actual).
  const stageOrder: Record<string, number> = {
    "invite_sent": 0, "connected": 1,
    "follow_up_sent": 2,
    "replied": 7, "meeting_booked": 8,
  }
  function cohortReached(stage: string): number {
    const minIdx = stageOrder[stage]
    if (minIdx === undefined) return 0
    let total = 0
    for (const [s, idx] of Object.entries(stageOrder)) {
      if (idx >= minIdx) total += (counts[s] ?? 0)
    }
    // replied y meeting_booked también cuentan al haber "pasado" por etapas previas
    return total
  }

  // Tasas clave (cohort %)
  const acceptanceRate = invitedBase > 0
    ? Math.round((cohortReached("connected") / invitedBase) * 100)
    : 0
  const responseRate = invitedBase > 0
    ? Math.round(((counts["replied"] ?? 0) + (counts["meeting_booked"] ?? 0)) / invitedBase * 100)
    : 0
  const meetingRate = ((counts["replied"] ?? 0) + (counts["meeting_booked"] ?? 0)) > 0
    ? Math.round((counts["meeting_booked"] ?? 0) / ((counts["replied"] ?? 0) + (counts["meeting_booked"] ?? 0)) * 100)
    : 0

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Pipeline de leads</h2>
          {filtered && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/30 font-medium">
              {filterLabel} · {totalInPipeline} leads
            </span>
          )}
        </div>
        <Link href="/dashboard/leads" className="text-xs text-blue-400 hover:text-blue-300">Ver todos →</Link>
      </div>

      {/* Tasas clave (gamificación de rendimiento) */}
      <div className="grid grid-cols-3 gap-2">
        <RatePill icon="🤝" label="Acceptance" value={acceptanceRate}
          subtitle={`${cohortReached("connected")} de ${invitedBase} invitados`}
          benchmarks={{ great: 30, ok: 15 }} />
        <RatePill icon="💬" label="Response"   value={responseRate}
          subtitle={`${(counts["replied"] ?? 0) + (counts["meeting_booked"] ?? 0)} respondieron`}
          benchmarks={{ great: 10, ok: 5 }} />
        <RatePill icon="📅" label="Meeting"    value={meetingRate}
          subtitle={`${counts["meeting_booked"] ?? 0} de los que respondieron`}
          benchmarks={{ great: 40, ok: 20 }} />
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-2">
        {activeStages.map((stage) => {
          const val   = counts[stage.value] ?? 0
          const isFm  = stage.value.startsWith("_fm")
          const isQueue = stage.value === "pending"
          // % cohort: para etapas del funnel (no En cola, no FM), cuántos del
          // cohort de invitados llegaron a esta etapa o más adelante.
          const cohortPct = !isFm && !isQueue && invitedBase > 0 && stageOrder[stage.value] !== undefined
            ? Math.round((cohortReached(stage.value) / invitedBase) * 100)
            : null
          const pct   = Math.round((val / maxVal) * 100)
          const href  = isFm ? "/dashboard/conversations" : `/dashboard/leads?status=${stage.value}`
          return (
            <Link key={stage.value} href={href}
              className={`flex items-center gap-3 group hover:bg-gray-800/40 rounded-lg px-2 py-1.5 -mx-2 transition-colors ${isFm ? "ml-4 opacity-80" : ""}`}>
              <div className={`text-right text-xs text-gray-400 shrink-0 ${isFm ? "w-28" : "w-20"}`}>
                <span className="text-[10px]">{stage.icon}</span>{" "}
                <span className={isFm ? "text-gray-500" : ""}>{stage.label}</span>
              </div>
              <div className="flex-1 h-4 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${pct}%`, backgroundColor: stage.color, opacity: val === 0 ? 0.15 : isFm ? 0.6 : 0.8 }}
                />
              </div>
              <div className={`w-8 text-right font-bold text-gray-50 shrink-0 ${isFm ? "text-xs" : "text-sm"}`}>{val}</div>
              <div className="w-12 text-right shrink-0" title="% del cohort de invitados que llegó a esta etapa">
                {cohortPct !== null ? (
                  <span className={`text-[10px] font-medium ${cohortPct >= 30 ? "text-green-400" : cohortPct >= 10 ? "text-yellow-400" : "text-gray-500"}`}>
                    {cohortPct}%
                  </span>
                ) : <span className="text-[10px] text-gray-700">—</span>}
              </div>
            </Link>
          )
        })}
        {(dead > 0 || disq > 0) && (
          <div className="border-t border-gray-800 pt-2 mt-2 flex gap-4 text-xs text-gray-500 px-2">
            {dead > 0 && (
              <Link href="/dashboard/leads?status=dead" className="hover:text-gray-300 transition-colors">
                💀 {dead} perdidos
              </Link>
            )}
            {disq > 0 && (
              <Link href="/dashboard/leads?status=disqualified" className="hover:text-gray-300 transition-colors">
                🚫 {disq} descalificados
              </Link>
            )}
            <span className="ml-auto text-[10px] text-gray-700">
              % = del cohort de {invitedBase} invitados
            </span>
          </div>
        )}
      </div>
    </section>
  )
}

// ── Rate pill (gamificado) ────────────────────────────────────────────────

function RatePill({ icon, label, value, subtitle, benchmarks }: {
  icon: string; label: string; value: number; subtitle: string;
  benchmarks: { great: number; ok: number }
}) {
  const tier =
    value >= benchmarks.great ? "great" :
    value >= benchmarks.ok    ? "ok"    :
    value > 0                 ? "low"   : "zero"
  const styles: Record<string, { ring: string; text: string; bg: string; emoji: string }> = {
    great: { ring: "border-green-500/40",  text: "text-green-400",  bg: "bg-green-500/5",  emoji: "🚀" },
    ok:    { ring: "border-blue-500/30",   text: "text-blue-400",   bg: "bg-blue-500/5",   emoji: "👍" },
    low:   { ring: "border-yellow-500/30", text: "text-yellow-400", bg: "bg-yellow-500/5", emoji: "⚠️" },
    zero:  { ring: "border-gray-700",      text: "text-gray-500",   bg: "bg-gray-900/40",  emoji: "·"  },
  }
  const s = styles[tier]
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${s.ring} ${s.bg}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm">{icon}</span>
          <span className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold truncate">{label}</span>
        </div>
        <span className="text-sm">{s.emoji}</span>
      </div>
      <div className="flex items-baseline gap-1 mt-0.5">
        <span className={`text-2xl font-bold ${s.text}`}>{value}%</span>
      </div>
      <div className="text-[9px] text-gray-500 truncate">{subtitle}</div>
    </div>
  )
}

// ── FM Pipeline ───────────────────────────────────────────────────────────────

const FM_STAGES = [
  {
    key: "fm1", label: "FM1 — Rapport", icon: "🔵",
    desc: "Primera respuesta. Construyendo confianza.",
    cls: "border-blue-500/30 bg-blue-500/5",
    badge: "bg-blue-500/15 border-blue-500/30 text-blue-400",
    bar: "bg-blue-500",
  },
  {
    key: "fm2", label: "FM2 — Profundizar", icon: "🟡",
    desc: "Mostrando valor. Cerca del interés.",
    cls: "border-yellow-500/30 bg-yellow-500/5",
    badge: "bg-yellow-500/15 border-yellow-500/30 text-yellow-400",
    bar: "bg-yellow-500",
  },
  {
    key: "fm3", label: "FM3 — Cierre", icon: "🟢",
    desc: "Propuesta de reunión + Cal.com.",
    cls: "border-green-500/30 bg-green-500/5",
    badge: "bg-green-500/15 border-green-500/30 text-green-400",
    bar: "bg-green-500",
  },
]

function FmPipeline({ fm1, fm2, fm3 }: { fm1: any[]; fm2: any[]; fm3: any[] }) {
  const groups = [fm1, fm2, fm3]
  const total = fm1.length + fm2.length + fm3.length

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
            Flujo de conversaciones activas
          </h2>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-400 border border-orange-500/30 font-medium">
            {total} en curso
          </span>
        </div>
        <Link href="/dashboard/conversations" className="text-xs text-blue-400 hover:text-blue-300">
          Ver bandeja →
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {FM_STAGES.map((stage, i) => {
          const leads = groups[i]
          return (
            <div key={stage.key} className={`rounded-xl border p-4 space-y-3 ${stage.cls}`}>
              {/* Stage header */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-gray-50">{stage.icon} {stage.label}</p>
                  <p className="text-[10px] text-gray-500 mt-0.5">{stage.desc}</p>
                </div>
                <span className={`text-lg font-bold px-2.5 py-0.5 rounded-full border ${stage.badge}`}>
                  {leads.length}
                </span>
              </div>

              {/* Progress bar */}
              {total > 0 && (
                <div className="w-full bg-gray-800 rounded-full h-1">
                  <div
                    className={`h-1 rounded-full ${stage.bar}`}
                    style={{ width: `${Math.round((leads.length / total) * 100)}%` }}
                  />
                </div>
              )}

              {/* Lead cards */}
              <div className="space-y-2 max-h-72 overflow-y-auto pr-0.5">
                {leads.length === 0 ? (
                  <p className="text-gray-600 text-xs text-center py-3">Sin prospectos en esta etapa</p>
                ) : (
                  leads.slice(0, 8).map((lead: any) => {
                    const conv = Array.isArray(lead.conversations) ? lead.conversations[0] : lead.conversations
                    const turn = conv?.conversation_turn ?? 0
                    const lastMsg = conv?.last_message_text
                    const hasDraft = !!(conv?.ai_reply_draft || conv?.ai_reply_scheduled_at)
                    const isInbound = lead.source === "inbound"
                    const headline = (lead.profile_data as any)?.headline ?? null

                    return (
                      <Link
                        key={lead.id}
                        href={`/dashboard/conversations/${lead.id}`}
                        className="block bg-gray-900/80 hover:bg-gray-800/80 border border-gray-700/50 hover:border-gray-600 rounded-lg p-3 transition-colors group"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-gray-50 text-xs font-semibold group-hover:text-blue-300 transition-colors truncate">
                                {lead.full_name ?? "—"}
                              </span>
                              {isInbound && (
                                <span className="text-[8px] px-1 py-0.5 rounded bg-purple-500/20 text-purple-400 font-bold shrink-0">IN</span>
                              )}
                            </div>
                            {headline && (
                              <p className="text-gray-500 text-[10px] mt-0.5 truncate">{headline}</p>
                            )}
                            {lastMsg && (
                              <p className="text-gray-400 text-[10px] mt-1 line-clamp-2 leading-snug">
                                {lastMsg.startsWith("[Tú]:") ? (
                                  <span className="text-gray-600">{lastMsg.slice(0, 80)}</span>
                                ) : (
                                  `"${lastMsg.slice(0, 80)}${lastMsg.length > 80 ? "…" : ""}"`
                                )}
                              </p>
                            )}
                          </div>
                          <div className="flex flex-col items-end gap-1 shrink-0">
                            <span className={`text-[8px] px-1.5 py-0.5 rounded-full border font-bold ${stage.badge}`}>
                              T{turn}
                            </span>
                            {hasDraft && (
                              <span className="text-[8px] px-1 py-0.5 rounded bg-yellow-500/15 text-yellow-400 font-bold">
                                ✨
                              </span>
                            )}
                          </div>
                        </div>
                        {conv?.last_message_at && (
                          <p className="text-gray-700 text-[9px] mt-1.5">
                            {new Date(conv.last_message_at).toLocaleDateString("es-MX", {
                              day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
                            })}
                          </p>
                        )}
                      </Link>
                    )
                  })
                )}
                {leads.length > 8 && (
                  <Link
                    href="/dashboard/conversations"
                    className="block text-center text-[10px] text-gray-500 hover:text-gray-300 py-1 transition-colors"
                  >
                    +{leads.length - 8} más →
                  </Link>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Summary bar */}
      {total > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-3 flex flex-wrap gap-6 text-xs text-gray-400">
          <div>
            <span className="font-semibold text-gray-50">{total}</span> prospectos en conversación activa
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-blue-500" />
            <span>FM1: {fm1.length}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-yellow-500" />
            <span>FM2: {fm2.length}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            <span>FM3+: {fm3.length}</span>
          </div>
          <div className="ml-auto">
            <Link href="/dashboard/conversations" className="text-blue-400 hover:text-blue-300">
              Ver todos con drafts pendientes →
            </Link>
          </div>
        </div>
      )}
    </section>
  )
}

// ── Campaign row ──────────────────────────────────────────────────────────────

function CampaignRow({ campaign: c }: { campaign: CampaignStats }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${c.is_active ? "bg-green-400" : "bg-gray-600"}`} />
            <span className="text-gray-50 font-medium text-sm">{c.campaign_name}</span>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            {c.account_label ?? "Sin cuenta asignada"}
          </p>
        </div>
        <div className="text-right text-xs text-gray-400">
          <div>{c.invite_rate_pct ?? 0}% inv. rate</div>
          <div>{c.acceptance_rate_pct ?? 0}% accept.</div>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-5 gap-2 text-center">
        {[
          { label: "En cola",    value: c.in_queue  ?? 0, color: "text-gray-300"  },
          { label: "Invitados",  value: c.invited   ?? 0, color: "text-blue-400"  },
          { label: "Conectados", value: c.connected ?? 0, color: "text-green-400" },
          { label: "Replies",    value: c.replied   ?? 0, color: "text-orange-400"},
          { label: "Reuniones",  value: c.meetings  ?? 0, color: "text-yellow-400"},
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-gray-800/50 rounded-lg py-2 px-1">
            <div className={`text-lg font-bold ${color}`}>{value}</div>
            <div className="text-gray-500 text-xs mt-0.5">{label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── ConversionRates panel ──────────────────────────────────────────────────
function ConversionRates({ conv }: {
  conv: {
    acceptRate: number; replyRate: number; meetingRate: number; overall: number
    everInvited: number; everAccepted: number; everReplied: number; everMeetings: number
  }
}) {
  const cards = [
    {
      label: "Accept rate",
      sub: `${conv.everAccepted} / ${conv.everInvited} invitados`,
      pct: conv.acceptRate, color: "text-blue-400", ring: "border-blue-500/30", bar: "bg-blue-500",
      benchmark: "Bench: 25-40%",
    },
    {
      label: "Reply rate",
      sub: `${conv.everReplied} / ${conv.everAccepted} conectados`,
      pct: conv.replyRate, color: "text-orange-400", ring: "border-orange-500/30", bar: "bg-orange-500",
      benchmark: "Bench: 15-30%",
    },
    {
      label: "Meeting rate",
      sub: `${conv.everMeetings} / ${conv.everReplied} respondieron`,
      pct: conv.meetingRate, color: "text-green-400", ring: "border-green-500/30", bar: "bg-green-500",
      benchmark: "Bench: 20-50%",
    },
    {
      label: "Overall conversion",
      sub: `${conv.everMeetings} reuniones / ${conv.everInvited} invitados`,
      pct: conv.overall, color: "text-purple-400", ring: "border-purple-500/30", bar: "bg-purple-500",
      benchmark: "Bench: 1-3%",
      isDecimal: true,
    },
  ]
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
          📊 Tasas de conversión <span className="text-xs font-normal normal-case text-gray-500">(all-time)</span>
        </h2>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.map(c => (
          <div key={c.label} className={`bg-gray-900 border ${c.ring} rounded-xl p-4 space-y-2`}>
            <div className="flex justify-between items-baseline">
              <span className="text-xs text-gray-400 font-medium">{c.label}</span>
              <span className={`text-2xl font-bold ${c.color}`}>
                {c.isDecimal ? c.pct.toFixed(1) : c.pct}<span className="text-sm">%</span>
              </span>
            </div>
            <div className="w-full bg-gray-800 rounded-full h-1.5">
              <div className={`h-1.5 rounded-full ${c.bar}`} style={{ width: `${Math.min(c.pct, 100)}%` }} />
            </div>
            <div className="flex justify-between text-[10px] text-gray-600">
              <span>{c.sub}</span>
              <span className="text-gray-700">{c.benchmark}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

// ── ActivityTimeline (SVG inline, 14 días) ────────────────────────────────
function ActivityTimeline({ timeline }: {
  timeline: { day: string; invites: number; fus: number; autoReplies: number; repliesIn: number }[]
}) {
  if (!timeline || timeline.length === 0) return null
  const W = 760
  const H = 200
  const padL = 32, padR = 8, padT = 12, padB = 28
  const innerW = W - padL - padR
  const innerH = H - padT - padB
  const barGroupWidth = innerW / timeline.length
  const barW = Math.max(2, (barGroupWidth - 6) / 4)
  const maxVal = Math.max(
    1,
    ...timeline.flatMap(d => [d.invites, d.fus, d.autoReplies, d.repliesIn]),
  )
  const yScale = (v: number) => innerH - (v / maxVal) * innerH

  const series = [
    { key: "invites" as const,     color: "#6366f1", label: "Invites",     dotColor: "bg-indigo-500" },
    { key: "fus" as const,         color: "#8b5cf6", label: "Follow-ups",  dotColor: "bg-violet-500" },
    { key: "autoReplies" as const, color: "#10b981", label: "AI replies",  dotColor: "bg-emerald-500" },
    { key: "repliesIn" as const,   color: "#f59e0b", label: "Replies in",  dotColor: "bg-amber-500" },
  ]

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
          📈 Actividad últimos 14 días
        </h2>
        <div className="flex items-center gap-3 text-xs flex-wrap">
          {series.map(s => (
            <span key={s.key} className="flex items-center gap-1.5 text-gray-400">
              <span className={`w-2.5 h-2.5 rounded-sm ${s.dotColor}`} />
              {s.label}
            </span>
          ))}
        </div>
      </div>
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="w-full min-w-[560px] h-[200px]">
          {/* Grid lines + Y labels */}
          {[0, 0.25, 0.5, 0.75, 1].map(t => {
            const y = padT + innerH * (1 - t)
            const v = Math.round(maxVal * t)
            return (
              <g key={t}>
                <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="#1f2937" strokeWidth={1} />
                <text x={padL - 6} y={y + 4} textAnchor="end" fontSize="9" fill="#6b7280">{v}</text>
              </g>
            )
          })}
          {/* Bars + X labels */}
          {timeline.map((d, i) => {
            const groupX = padL + i * barGroupWidth
            const dayLabel = d.day.slice(5)  // MM-DD
            return (
              <g key={d.day}>
                {series.map((s, si) => {
                  const v = d[s.key]
                  const h = innerH - yScale(v)
                  const x = groupX + 3 + si * barW
                  return (
                    <rect
                      key={s.key}
                      x={x}
                      y={padT + yScale(v)}
                      width={barW - 1}
                      height={h}
                      fill={s.color}
                      opacity={v > 0 ? 0.9 : 0.15}
                      rx={1}
                    >
                      <title>{`${d.day} · ${s.label}: ${v}`}</title>
                    </rect>
                  )
                })}
                <text
                  x={groupX + barGroupWidth / 2}
                  y={H - padB + 14}
                  textAnchor="middle"
                  fontSize="9"
                  fill="#6b7280"
                >
                  {dayLabel}
                </text>
              </g>
            )
          })}
        </svg>
        <p className="text-[10px] text-gray-600 text-right mt-1">Pasa el mouse sobre cada barra para ver el detalle</p>
      </div>
    </section>
  )
}

// ── Orphan conversations panel ─────────────────────────────────────────────
function OrphanConversations({ orphans }: {
  orphans: Array<{
    id: string; scraped_name: string; snippet: string | null; unread_count: number | null
    linkedin_thread_id: string | null; last_activity_label: string | null
    occurrence_count: number; last_seen_at: string
  }>
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
          🔍 Conversaciones orphan (no en Orion)
          <span className="text-xs font-normal normal-case text-gray-500">
            ({orphans.length})
          </span>
        </h2>
        <span className="text-[10px] text-gray-600">
          Contactos con quienes chateaste en LinkedIn pero no están en tu pipeline
        </span>
      </div>
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-800/50 text-xs text-gray-400 uppercase tracking-wider">
            <tr>
              <th className="px-3 py-2 text-left">Contacto</th>
              <th className="px-3 py-2 text-left">Último mensaje</th>
              <th className="px-3 py-2 text-right">No leído</th>
              <th className="px-3 py-2 text-right">Visto</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {orphans.map(o => (
              <tr key={o.id} className="hover:bg-gray-800/30">
                <td className="px-3 py-2">
                  <div className="text-gray-50 font-medium">{o.scraped_name}</div>
                  {o.last_activity_label && (
                    <div className="text-[10px] text-gray-500 mt-0.5">{o.last_activity_label}</div>
                  )}
                </td>
                <td className="px-3 py-2 text-gray-400 text-xs truncate max-w-md">
                  {o.snippet ?? <span className="text-gray-600 italic">sin snippet</span>}
                </td>
                <td className="px-3 py-2 text-right">
                  {(o.unread_count ?? 0) > 0
                    ? <span className="text-[10px] px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-300 border border-orange-500/30 font-bold">{o.unread_count}</span>
                    : <span className="text-gray-600">—</span>}
                </td>
                <td className="px-3 py-2 text-right text-[10px] text-gray-500">
                  {new Date(o.last_seen_at).toLocaleString("es-MX", {
                    timeZone: "America/Mexico_City",
                    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
                  })}
                  {o.occurrence_count > 1 && <span className="ml-2 text-gray-700">×{o.occurrence_count}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-gray-600 text-right">
        💡 Dispara "Barrer inbox 15 días" arriba para detectar más conversaciones históricas.
      </p>
    </section>
  )
}

// ── ConnectivityTimeline (24h uptime por cuenta) ─────────────────────────
function ConnectivityTimeline({ rows }: {
  rows: Array<{
    accountId: string; label: string
    buckets: Array<"up" | "down" | "unknown">
    uptimePct: number | null
    lastUp: string | null; lastDown: string | null
  }>
}) {
  const colors = { up: "bg-green-500", down: "bg-red-500", unknown: "bg-gray-700" }
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
          📡 Conectividad extensions (24h)
        </h2>
        <div className="flex items-center gap-3 text-[10px] text-gray-500">
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-green-500"/> Online</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-red-500"/> Offline</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-gray-700"/> Sin datos</span>
        </div>
      </div>
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
        {rows.map(r => (
          <div key={r.accountId}>
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="text-gray-50 font-semibold">{r.label}</span>
              <div className="flex items-center gap-3 text-gray-500">
                {r.uptimePct !== null && (
                  <span className={r.uptimePct >= 70 ? "text-green-400" : r.uptimePct >= 40 ? "text-yellow-400" : "text-red-400"}>
                    {r.uptimePct}% uptime
                  </span>
                )}
                {r.lastUp && (
                  <span>↑ {new Date(r.lastUp).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}</span>
                )}
              </div>
            </div>
            <div className="flex gap-0.5 h-3 rounded-sm overflow-hidden">
              {r.buckets.map((b, i) => (
                <div
                  key={i}
                  className={`flex-1 ${colors[b]} hover:opacity-70 transition`}
                  title={`Hace ${24 - i}h — ${b}`}
                />
              ))}
            </div>
            <div className="flex justify-between text-[9px] text-gray-600 mt-1">
              <span>hace 24h</span>
              <span>hace 12h</span>
              <span>ahora</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
