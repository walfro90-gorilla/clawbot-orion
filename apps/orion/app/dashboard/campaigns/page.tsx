"use server"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { getSessionUser } from "@/lib/auth/role"
import { redirect } from "next/navigation"
import Link from "next/link"

// ── Server Actions ─────────────────────────────────────────────────────────────

async function toggleJobPause(formData: FormData) {
  "use server"
  const admin  = createAdminClient()
  const id     = formData.get("campaign_id") as string
  const field  = formData.get("field") as string          // batch_paused | search_paused | follow_up_paused
  const current = formData.get("current") === "true"

  const allowed = ["batch_paused", "search_paused", "follow_up_paused"]
  if (!allowed.includes(field)) return

  const updateData = field === "batch_paused"
    ? { batch_paused: !current }
    : field === "search_paused"
    ? { search_paused: !current }
    : { follow_up_paused: !current }
  await admin.from("campaigns").update(updateData).eq("id", id)
  redirect("/dashboard/campaigns")
}

async function toggleInboxPause(formData: FormData) {
  "use server"
  const admin   = createAdminClient()
  const id      = formData.get("account_id") as string
  const current = formData.get("current") === "true"
  await admin.from("linkedin_accounts").update({ inbox_paused: !current }).eq("id", id)
  redirect("/dashboard/campaigns")
}

async function updateSchedulerSettings(formData: FormData) {
  "use server"
  const admin = createAdminClient()
  const id = formData.get("campaign_id") as string
  await admin.from("campaigns").update({
    daily_invite_target:   Number(formData.get("daily_invite_target")),
    min_batch_gap_min:     Number(formData.get("min_batch_gap_min")),
    min_pending_threshold: Number(formData.get("min_pending_threshold")),
  }).eq("id", id)
  redirect("/dashboard/campaigns")
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Risk level based on warmup_status
function riskLevel(warmup: string | null): "low" | "medium" | "high" {
  if (warmup === "hot" || warmup === "warm") return "low"
  if (warmup === "warming") return "medium"
  return "high" // cold or unknown
}

const RISK_LABEL: Record<string, string> = {
  low:    "✅ Bajo riesgo",
  medium: "⚠️ Riesgo medio",
  high:   "🔴 Riesgo alto",
}
const RISK_COLOR: Record<string, string> = {
  low:    "text-green-400",
  medium: "text-yellow-400",
  high:   "text-red-400",
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function CampaignsPage() {
  const supabase = await createClient()
  const admin    = createAdminClient()
  const me       = await getSessionUser()

  const isRestricted    = me?.role === "user" || me?.role === "viewer"
  const linkedAccountId = me?.linkedin_account_id ?? null

  // Full campaigns data (not view — we need pause fields)
  let campQuery = admin
    .from("campaigns")
    .select(`
      id, name, is_active,
      batch_paused, search_paused, follow_up_paused,
      daily_invite_target, min_batch_gap_min, min_pending_threshold,
      last_batch_at, last_searched_at, last_followup_at,
      follow_up_message, follow_up_step2_message,
      linkedin_account_id,
      linkedin_accounts (
        id, label, status, warmup_status, inbox_paused, inbox_gap_min
      )
    `)
    .order("created_at", { ascending: false })

  if (isRestricted && linkedAccountId) {
    campQuery = campQuery.eq("linkedin_account_id", linkedAccountId)
  }

  // Funnel stats from view
  let statsQuery = supabase
    .from("v_campaign_stats")
    .select("campaign_id, total_leads, in_queue, disqualified, invited, connected, messaged, replied, meetings, invite_rate_pct, acceptance_rate_pct, last_sent_at")

  if (isRestricted && linkedAccountId) {
    statsQuery = statsQuery.eq("linkedin_account_id", linkedAccountId)
  }

  // Scheduler logs
  const logsQuery = supabase
    .from("scheduler_log")
    .select("campaign_id, job_type, status, skip_reason, leads_sent, leads_found, created_at")
    .order("created_at", { ascending: false })
    .limit(200)

  const [{ data: camps }, { data: statsData }, { data: logs }] = await Promise.all([
    campQuery, statsQuery, logsQuery,
  ])

  const statsMap  = new Map((statsData ?? []).map((s: any) => [s.campaign_id, s]))
  const logMap: Record<string, any[]> = {}
  for (const log of logs ?? []) {
    if (!log.campaign_id) continue
    if (!logMap[log.campaign_id]) logMap[log.campaign_id] = []
    if (logMap[log.campaign_id].length < 4) logMap[log.campaign_id].push(log)
  }

  const campaigns = (camps ?? []) as any[]

  return (
    <div className="p-4 sm:p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Campañas</h1>
          <p className="text-gray-400 text-sm mt-0.5">{campaigns.length} campañas</p>
        </div>
        {!isRestricted && (
          <Link href="/dashboard/campaigns/new"
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-lg transition-colors">
            + Nueva campaña
          </Link>
        )}
      </div>

      {/* Legend */}
      <div className="bg-gray-900/60 border border-gray-800 rounded-xl px-4 py-3 text-xs text-gray-400 space-y-1">
        <p className="font-semibold text-gray-300 mb-1">¿Qué hace cada automatización?</p>
        <div className="grid sm:grid-cols-2 gap-x-8 gap-y-1">
          <p><span className="text-purple-400 font-medium">🔍 Búsqueda</span> — scraping de perfiles LinkedIn + calificación Gemini. <span className="text-green-400">Sin riesgo</span> — no envía nada.</p>
          <p><span className="text-blue-400 font-medium">✉️ Envíos</span> — invitaciones de conexión con nota. <span className="text-yellow-400">Riesgo medio/alto</span> — pausa en cuentas frías.</p>
          <p><span className="text-indigo-400 font-medium">📨 Follow-ups</span> — mensajes de seguimiento día 5 y 12. <span className="text-red-400">Riesgo alto</span> — solo con cuenta caliente.</p>
          <p><span className="text-gray-400 font-medium">📥 Inbox</span> — lee respuestas y genera draft IA. <span className="text-green-400">Sin riesgo</span> — solo lectura.</p>
        </div>
        <p className="text-gray-600 pt-1">💡 Modo seguro para cuenta nueva: activa solo Búsqueda. Los leads quedan en cola (<span className="text-gray-300">pending</span>) y un usuario los envía manualmente cuando la cuenta esté caliente.</p>
      </div>

      <div className="space-y-4">
        {campaigns.length === 0 && (
          <div className="text-center py-16 text-gray-500">
            No hay campañas.{" "}
            <Link href="/dashboard/campaigns/new" className="text-blue-400 hover:underline">Crea la primera.</Link>
          </div>
        )}

        {campaigns.map((c: any) => {
          const acct   = c.linkedin_accounts
          const stats  = statsMap.get(c.id) as any
          const risk   = riskLevel(acct?.warmup_status)
          const campLogs = logMap[c.id] ?? []

          const batchPaused  = c.batch_paused   === true
          const searchPaused = c.search_paused  === true
          const fuPaused     = c.follow_up_paused === true
          const inboxPaused  = acct?.inbox_paused === true

          // Overall status indicator
          const allPaused = batchPaused && searchPaused && fuPaused
          const somePaused = batchPaused || searchPaused || fuPaused || inboxPaused

          return (
            <div key={c.id} className={`bg-gray-900 border rounded-xl p-5 space-y-4 ${
              allPaused ? "border-gray-700" : somePaused ? "border-yellow-800/50" : "border-gray-800"
            }`}>
              {/* Header */}
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3 min-w-0">
                  <span className={`w-2.5 h-2.5 rounded-full mt-0.5 shrink-0 ${
                    !c.is_active ? "bg-gray-600" :
                    allPaused   ? "bg-gray-500" :
                    somePaused  ? "bg-yellow-400" :
                                  "bg-green-400 animate-pulse"
                  }`} />
                  <div className="min-w-0">
                    <h2 className="text-white font-semibold truncate">{c.name}</h2>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap text-xs">
                      <span className={`px-2 py-0.5 rounded-full font-medium ${
                        acct?.status === "active"       ? "bg-green-500/15 text-green-400" :
                        acct?.status === "rate_limited" ? "bg-yellow-500/15 text-yellow-400" :
                        acct?.status === "banned"       ? "bg-red-500/15 text-red-400" :
                                                          "bg-gray-500/15 text-gray-400"
                      }`}>
                        {acct?.label ?? "Sin cuenta"}
                      </span>
                      <span className={`font-medium ${RISK_COLOR[risk]}`}>
                        {RISK_LABEL[risk]} ({acct?.warmup_status ?? "cold"})
                      </span>
                      {allPaused && <span className="text-gray-500">⏸ Todo pausado</span>}
                    </div>
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Link href={`/dashboard/leads?campaign=${c.id}`}
                    className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs rounded-lg transition-colors">
                    Ver leads
                  </Link>
                  <Link href={`/dashboard/campaigns/${c.id}/edit`}
                    className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs rounded-lg transition-colors">
                    Editar
                  </Link>
                </div>
              </div>

              {/* ── Job toggles ──────────────────────────────────────────────── */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <JobToggle
                  action={toggleJobPause}
                  campaignId={c.id}
                  field="search_paused"
                  paused={searchPaused}
                  label="Búsqueda"
                  icon="🔍"
                  riskWhenActive="none"
                  description={searchPaused ? "Pausada — no busca leads" : "Activa — scraping + Gemini"}
                />
                <JobToggle
                  action={toggleJobPause}
                  campaignId={c.id}
                  field="batch_paused"
                  paused={batchPaused}
                  label="Envíos"
                  icon="✉️"
                  riskWhenActive={risk === "high" ? "high" : risk === "medium" ? "medium" : "none"}
                  description={batchPaused
                    ? `${stats?.in_queue ?? 0} leads en cola — pausados`
                    : `${stats?.in_queue ?? 0} en cola · ${c.daily_invite_target}/día`}
                />
                <JobToggle
                  action={toggleJobPause}
                  campaignId={c.id}
                  field="follow_up_paused"
                  paused={fuPaused}
                  label="Follow-ups"
                  icon="📨"
                  riskWhenActive={risk === "high" ? "high" : "medium"}
                  description={fuPaused
                    ? "Pausados — FU1 y FU2 detenidos"
                    : c.follow_up_message ? "Activos — FU1" + (c.follow_up_step2_message ? " + FU2" : "") : "Sin mensaje configurado"}
                />
                {/* Inbox toggle — account level */}
                <form action={toggleInboxPause}>
                  <input type="hidden" name="account_id" value={acct?.id ?? ""} />
                  <input type="hidden" name="current"    value={String(inboxPaused)} />
                  <button type="submit" className={`w-full h-full min-h-[72px] flex flex-col items-start gap-1 px-3 py-2.5 rounded-xl border text-left transition-colors ${
                    inboxPaused
                      ? "bg-gray-800/40 border-gray-700 opacity-60"
                      : "bg-gray-800/60 border-gray-700 hover:border-gray-600"
                  }`}>
                    <div className="flex items-center justify-between w-full">
                      <span className="text-xs font-semibold text-gray-200 flex items-center gap-1.5">
                        📥 Inbox
                        <span className="text-[9px] text-green-400 font-normal">sin riesgo</span>
                      </span>
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                        inboxPaused ? "bg-gray-700 text-gray-400" : "bg-green-500/20 text-green-400"
                      }`}>
                        {inboxPaused ? "OFF" : "ON"}
                      </span>
                    </div>
                    <span className="text-[10px] text-gray-500 leading-tight">
                      {inboxPaused ? "Pausado — no lee respuestas" : `Activo — cada ${acct?.inbox_gap_min ?? 60} min`}
                    </span>
                    <span className={`mt-auto text-[10px] font-medium ${inboxPaused ? "text-green-400" : "text-yellow-400"}`}>
                      {inboxPaused ? "▶ Activar" : "⏸ Pausar"}
                    </span>
                  </button>
                </form>
              </div>

              {/* Funnel stats */}
              {stats && (
                <div className="grid grid-cols-4 sm:grid-cols-8 gap-1.5">
                  {[
                    { label: "Total",     value: stats.total_leads  ?? 0, color: "text-gray-300" },
                    { label: "Cola",      value: stats.in_queue     ?? 0, color: batchPaused ? "text-yellow-400" : "text-gray-400" },
                    { label: "Descal.",   value: stats.disqualified ?? 0, color: "text-red-400"   },
                    { label: "Invitados", value: stats.invited      ?? 0, color: "text-blue-400"  },
                    { label: "Cnx.",      value: stats.connected    ?? 0, color: "text-green-400" },
                    { label: "FU",        value: stats.messaged     ?? 0, color: "text-purple-400"},
                    { label: "Replies",   value: stats.replied      ?? 0, color: "text-orange-400"},
                    { label: "Reuniones", value: stats.meetings     ?? 0, color: "text-yellow-400"},
                  ].map(({ label, value, color }) => (
                    <div key={label} className="bg-gray-800/60 rounded-lg py-2 px-1 text-center">
                      <div className={`text-lg font-bold ${color}`}>{value}</div>
                      <div className="text-gray-600 text-[10px] mt-0.5">{label}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Rates + timestamps */}
              <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-gray-500 border-t border-gray-800 pt-3">
                <span>Inv. rate: <span className="text-gray-300">{stats?.invite_rate_pct ?? 0}%</span></span>
                <span>Acceptance: <span className="text-gray-300">{stats?.acceptance_rate_pct ?? 0}%</span></span>
                {stats?.last_sent_at && (
                  <span>Último envío: <span className="text-gray-300">{new Date(stats.last_sent_at).toLocaleString("es-MX", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span></span>
                )}
                {c.last_searched_at && (
                  <span>Último search: <span className="text-gray-300">{new Date(c.last_searched_at).toLocaleString("es-MX", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span></span>
                )}
              </div>

              {/* Scheduler settings + log (collapsible) */}
              <details className="group">
                <summary className="text-xs text-gray-600 hover:text-gray-400 cursor-pointer list-none flex items-center gap-1 select-none">
                  <span className="group-open:rotate-90 transition-transform inline-block">▶</span>
                  Parámetros anti-ban
                  <span className="ml-2 text-gray-700">{c.daily_invite_target} inv/día · gap {c.min_batch_gap_min}min</span>
                </summary>
                <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <form action={updateSchedulerSettings} className="bg-gray-800/50 rounded-xl p-4 space-y-3">
                    <input type="hidden" name="campaign_id" value={c.id} />
                    <div className="grid grid-cols-3 gap-3">
                      <div className="space-y-1">
                        <label className="block text-xs text-gray-500">Inv/día</label>
                        <input name="daily_invite_target" type="number" min="1" max="20"
                          defaultValue={c.daily_invite_target ?? 8}
                          className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      </div>
                      <div className="space-y-1">
                        <label className="block text-xs text-gray-500">Gap (min)</label>
                        <input name="min_batch_gap_min" type="number" min="30" max="480"
                          defaultValue={c.min_batch_gap_min ?? 120}
                          className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      </div>
                      <div className="space-y-1">
                        <label className="block text-xs text-gray-500">Umbral cola</label>
                        <input name="min_pending_threshold" type="number" min="5" max="100"
                          defaultValue={c.min_pending_threshold ?? 15}
                          className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      </div>
                    </div>
                    <button type="submit"
                      className="w-full py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-colors">
                      Guardar
                    </button>
                  </form>

                  <div className="bg-gray-800/50 rounded-xl p-4">
                    <p className="text-xs text-gray-500 font-medium uppercase tracking-wider mb-2">Log reciente</p>
                    {campLogs.length === 0 ? (
                      <p className="text-xs text-gray-600 italic">Sin actividad registrada</p>
                    ) : (
                      <ul className="space-y-2">
                        {campLogs.map((log: any, i: number) => (
                          <li key={i} className="flex items-start gap-2 text-xs">
                            <span className={`mt-0.5 shrink-0 w-1.5 h-1.5 rounded-full ${
                              log.job_type === "batch"    ? "bg-blue-400" :
                              log.job_type === "search"   ? "bg-purple-400" :
                              log.job_type === "followup" ? "bg-indigo-400" :
                              log.job_type === "inbox"    ? "bg-gray-500" :
                              log.status === "skipped"    ? "bg-gray-700" : "bg-gray-600"
                            }`} />
                            <div>
                              <span className="text-gray-300">{log.job_type}</span>
                              <span className={`ml-1 ${
                                log.status === "completed" || log.status === "ok" ? "text-green-500" :
                                log.status === "skipped"   ? "text-gray-600" :
                                log.status === "error"     ? "text-red-400" : "text-yellow-500"
                              }`}>{log.status}</span>
                              {log.skip_reason && <span className="text-gray-600 ml-1">— {log.skip_reason}</span>}
                              {log.leads_sent  != null && log.leads_sent  > 0 && <span className="text-blue-400 ml-1">· {log.leads_sent} enviados</span>}
                              {log.leads_found != null && log.leads_found > 0 && <span className="text-purple-400 ml-1">· {log.leads_found} encontrados</span>}
                              <div className="text-gray-700">{new Date(log.created_at).toLocaleString("es-MX", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </details>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── JobToggle component ────────────────────────────────────────────────────────

function JobToggle({
  action, campaignId, field, paused, label, icon, riskWhenActive, description,
}: {
  action: (f: FormData) => Promise<void>
  campaignId: string
  field: string
  paused: boolean
  label: string
  icon: string
  riskWhenActive: "none" | "medium" | "high"
  description: string
}) {
  const riskBadge = !paused && riskWhenActive !== "none"
    ? riskWhenActive === "high"
      ? <span className="text-[9px] text-red-400 font-normal">riesgo alto</span>
      : <span className="text-[9px] text-yellow-400 font-normal">riesgo medio</span>
    : !paused
      ? <span className="text-[9px] text-green-400 font-normal">sin riesgo</span>
      : null

  return (
    <form action={action}>
      <input type="hidden" name="campaign_id" value={campaignId} />
      <input type="hidden" name="field"       value={field} />
      <input type="hidden" name="current"     value={String(paused)} />
      <button type="submit" className={`w-full h-full min-h-[72px] flex flex-col items-start gap-1 px-3 py-2.5 rounded-xl border text-left transition-colors ${
        paused
          ? "bg-gray-800/40 border-gray-700 opacity-60 hover:opacity-80"
          : riskWhenActive === "high"
            ? "bg-red-950/20 border-red-800/40 hover:border-red-700/60"
            : riskWhenActive === "medium"
              ? "bg-yellow-950/20 border-yellow-800/30 hover:border-yellow-700/50"
              : "bg-gray-800/60 border-gray-700 hover:border-gray-600"
      }`}>
        <div className="flex items-center justify-between w-full">
          <span className="text-xs font-semibold text-gray-200 flex items-center gap-1.5">
            {icon} {label}
            {riskBadge}
          </span>
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
            paused ? "bg-gray-700 text-gray-400" : "bg-green-500/20 text-green-400"
          }`}>
            {paused ? "OFF" : "ON"}
          </span>
        </div>
        <span className="text-[10px] text-gray-500 leading-tight">{description}</span>
        <span className={`mt-auto text-[10px] font-medium ${paused ? "text-green-400" : "text-yellow-400"}`}>
          {paused ? "▶ Activar" : "⏸ Pausar"}
        </span>
      </button>
    </form>
  )
}
