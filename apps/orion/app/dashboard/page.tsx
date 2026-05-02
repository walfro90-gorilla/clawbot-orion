import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { getSessionUser } from "@/lib/auth/role"
import Link from "next/link"
import { DashboardFiltersBar } from "@/components/dashboard-filters"
import { RefreshButton } from "@/components/refresh-button"
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

// ── Cookie health thresholds (days since last update) ─────────────────────────
// LinkedIn li_at cookies duran ~1 año pero para automatización rotarlas regularmente
// reduce riesgo de detección. Umbrales recomendados:
const COOKIE_WARNING_DAYS  = 30   // 🟡 Planear renovación
const COOKIE_CRITICAL_DAYS = 60   // 🔴 Riesgo alto

function cookieHealth(updatedAt: string | null): {
  status: "ok" | "warning" | "critical" | "unknown"
  days: number | null
  label: string
  daysUntilWarning: number | null
} {
  if (!updatedAt) return { status: "unknown", days: null, label: "Sin registro", daysUntilWarning: null }
  const days = Math.floor((Date.now() - new Date(updatedAt).getTime()) / 86_400_000)
  if (days >= COOKIE_CRITICAL_DAYS) return { status: "critical", days, label: `${days} días`, daysUntilWarning: null }
  if (days >= COOKIE_WARNING_DAYS)  return { status: "warning",  days, label: `${days} días`, daysUntilWarning: COOKIE_CRITICAL_DAYS - days }
  return { status: "ok", days, label: `${days} días`, daysUntilWarning: COOKIE_WARNING_DAYS - days }
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
        .select("id, label, status, li_at_cookie_updated_at, proxy_url")
        .eq("id", linkedAccountId)
    : admin.from("linkedin_accounts")
        .select("id, label, status, li_at_cookie_updated_at, proxy_url")
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

  const [
    { data: campaigns },
    { data: accounts },
    { data: rawAccounts },
    { data: alerts },
  ] = await Promise.all([
    campaignsQuery,
    accountsQuery,
    rawAccountsQuery,
    alertsQuery,
  ])

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

  const stats    = campaigns as CampaignStats[] ?? []
  const accs     = accounts  as AccountToday[]  ?? []
  const rawAccs  = rawAccounts ?? []
  const activeAlerts = alerts ?? []

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

  // Group by FM stage
  const fm1: any[] = [], fm2: any[] = [], fm3: any[] = []
  for (const l of fmLeads ?? []) {
    const turn = (l.conversations as any)?.[0]?.conversation_turn ?? 0
    if (turn === 0)       fm1.push(l)
    else if (turn <= 2)   fm2.push(l)
    else                  fm3.push(l)
  }

  const criticalAlerts = activeAlerts.filter(a => a.severity === "critical")
  const warningAlerts  = activeAlerts.filter(a => a.severity === "warning")

  const displayTotals = filteredTotals ?? totals

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
          <RefreshButton />
          <DashboardFiltersBar initialRange={range} initialFrom={spFrom} initialTo={spTo} />
        </div>
      </div>

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

      {/* ── KPI cards ─────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label={range ? "Leads nuevos" : "Total Leads"}
          value={displayTotals.leads}    color="blue"   icon="👥"
          subtitle={range ? "creados en período" : undefined}
        />
        <KpiCard
          label="Invitados"
          value={displayTotals.invited}  color="indigo" icon="✉️"
          subtitle={range ? "enviadas en período" : undefined}
        />
        <KpiCard
          label="Respondieron"
          value={displayTotals.replied}  color="orange" icon="📩"
          subtitle={range ? "respuestas recibidas" : undefined}
        />
        <KpiCard
          label="Reuniones"
          value={displayTotals.meetings} color="green"  icon="📅"
          subtitle={range ? "agendadas en período" : undefined}
        />
      </div>

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

      {/* ── Cookie health monitor ─────────────────────────────────────────────── */}
      {rawAccs.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Salud de cookies li_at</h2>
            <span className="text-xs text-gray-600">
              ⚡ Recomendado renovar cada {COOKIE_WARNING_DAYS}–{COOKIE_CRITICAL_DAYS} días
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {rawAccs.map((acc: any) => (
              <CookieHealthCard key={acc.id} account={acc} />
            ))}
          </div>
          <p className="text-xs text-gray-600 text-right">
            Actualiza las cookies en{" "}
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

// ── Cookie health card ────────────────────────────────────────────────────────

const HEALTH_STYLES = {
  ok:       { ring: "border-green-500/30",  bg: "bg-green-500/10",  text: "text-green-400",  dot: "bg-green-400",  label: "OK" },
  warning:  { ring: "border-yellow-500/30", bg: "bg-yellow-500/10", text: "text-yellow-400", dot: "bg-yellow-400", label: "Renovar pronto" },
  critical: { ring: "border-red-500/40",    bg: "bg-red-500/10",    text: "text-red-400",    dot: "bg-red-500 animate-pulse", label: "Urgente" },
  unknown:  { ring: "border-gray-600/40",   bg: "bg-gray-700/20",   text: "text-gray-400",   dot: "bg-gray-500",  label: "Sin registro" },
}

function CookieHealthCard({ account }: { account: any }) {
  const health = cookieHealth(account.li_at_cookie_updated_at)
  const s = HEALTH_STYLES[health.status]

  const statusDot: Record<string, string> = {
    active:       "bg-green-400",
    rate_limited: "bg-yellow-400",
    banned:       "bg-red-500",
    disconnected: "bg-gray-500",
  }

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

      {/* Cookie age bar */}
      <div className="space-y-1.5">
        <div className="flex justify-between items-center text-xs">
          <span className="text-gray-400">Cookie li_at</span>
          <span className={`font-medium ${s.text}`}>{health.label}</span>
        </div>

        {/* Progress bar — días usados sobre 60 días */}
        <div className="w-full bg-gray-800 rounded-full h-2">
          <div
            className={`h-2 rounded-full transition-all ${
              health.status === "critical" ? "bg-red-500" :
              health.status === "warning"  ? "bg-yellow-500" :
              health.status === "unknown"  ? "bg-gray-600" :
              "bg-green-500"
            }`}
            style={{ width: `${health.days !== null ? Math.min(Math.round(health.days / COOKIE_CRITICAL_DAYS * 100), 100) : 100}%` }}
          />
        </div>

        <div className="flex justify-between text-xs text-gray-600">
          <span>Actualizada hace {health.days !== null ? `${health.days}d` : "?"}</span>
          {health.status === "ok" && health.daysUntilWarning !== null && (
            <span>🟡 en ~{health.daysUntilWarning}d</span>
          )}
          {health.status === "warning" && health.daysUntilWarning !== null && (
            <span className="text-yellow-600">🔴 en ~{health.daysUntilWarning}d</span>
          )}
          {(health.status === "critical" || health.status === "unknown") && (
            <Link href="/dashboard/accounts" className="text-red-400 hover:text-red-300 font-medium">
              Renovar ahora →
            </Link>
          )}
        </div>
      </div>

      {/* Proxy status */}
      <div className="flex items-center gap-1.5 text-xs">
        {account.proxy_url ? (
          <><span className="w-1.5 h-1.5 rounded-full bg-green-400" /><span className="text-gray-500">Proxy configurado</span></>
        ) : (
          <><span className="w-1.5 h-1.5 rounded-full bg-red-500" /><span className="text-red-400/80">Sin proxy — riesgo alto</span></>
        )}
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
  { value: "follow_up_sent",   label: "FU1",        icon: "📨", color: "#818cf8", indent: false },
  { value: "follow_up_sent_2", label: "FU2",        icon: "📩", color: "#c084fc", indent: false },
  { value: "follow_up_sent_3", label: "FU3",        icon: "📬", color: "#e879f9", indent: false },
  { value: "follow_up_sent_4", label: "FU4",        icon: "📮", color: "#f472b6", indent: false },
  { value: "follow_up_sent_5", label: "FU5",        icon: "🔔", color: "#fb7185", indent: false },
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
  // maxVal excluye sub-etapas FM para que las barras principales mantengan proporción
  const maxVal = Math.max(...activeStages.filter(s => !s.value.startsWith("_fm")).map(s => counts[s.value] ?? 0), 1)
  const dead = counts["dead"] ?? 0
  const disq = counts["disqualified"] ?? 0
  const totalInPipeline = activeStages.reduce((s, st) => s + (counts[st.value] ?? 0), 0)

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
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-2">
        {activeStages.map((stage, i) => {
          const val     = counts[stage.value] ?? 0
          const isFm    = stage.value.startsWith("_fm")
          // Para las sub-etapas FM, no comparar conversión con la etapa anterior
          const prev    = (!isFm && i > 0 && !activeStages[i - 1].value.startsWith("_fm"))
            ? (counts[activeStages[i - 1].value] ?? 0)
            : null
          const pct     = Math.round((val / maxVal) * 100)
          const conv    = prev !== null && prev > 0 ? Math.round((val / prev) * 100) : null
          const href    = isFm ? "/dashboard/conversations" : `/dashboard/leads?status=${stage.value}`
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
              <div className="w-12 text-right shrink-0">
                {conv !== null ? (
                  <span className={`text-[10px] font-medium ${conv >= 50 ? "text-green-400" : conv >= 20 ? "text-yellow-400" : "text-red-400"}`}>
                    {conv}%
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
          </div>
        )}
      </div>
    </section>
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
                    const conv = lead.conversations?.[0]
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
