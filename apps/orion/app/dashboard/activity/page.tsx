import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import Link from "next/link"
import { redirect } from "next/navigation"

// ── Label maps ────────────────────────────────────────────────────────────────

const ACTION_LABEL: Record<string, { label: string; icon: string }> = {
  batch_process:       { label: "Invitación",    icon: "📤" },
  batch_completed:     { label: "Fin de lote",   icon: "📦" },
  invite_sent:         { label: "Confirmación",  icon: "✅" },
  search_completed:    { label: "Búsqueda",      icon: "🔍" },
  search_started:      { label: "Búsqueda",      icon: "🔍" },
  followup_sent:       { label: "Seguimiento",   icon: "💬" },
  followup_skipped:    { label: "FU omitido",    icon: "⏭" },
  inbox_scrape_failed: { label: "Error inbox",   icon: "❌" },
  inbox_completed:     { label: "Inbox",         icon: "📥" },
  tick:                { label: "Tick",          icon: "⏱" },
  auto_reply_sent:     { label: "Auto-reply",    icon: "🤖" },
}

// outcome → { label, badge class }
const OUTCOME_STYLE: Record<string, { label: string; cls: string; dot: string }> = {
  sent:         { label: "Enviado",       cls: "bg-green-500/15 text-green-400 border-green-500/30",   dot: "bg-green-400" },
  success:      { label: "OK",            cls: "bg-green-500/15 text-green-400 border-green-500/30",   dot: "bg-green-400" },
  dry_run:      { label: "Omitido",       cls: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30", dot: "bg-yellow-400" },
  disqualified: { label: "Descalificado", cls: "bg-orange-500/15 text-orange-400 border-orange-500/30", dot: "bg-orange-400" },
  error:        { label: "Error",         cls: "bg-red-500/15 text-red-400 border-red-500/30",         dot: "bg-red-400" },
  skipped:      { label: "Omitido",       cls: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30", dot: "bg-yellow-400" },
  warning:      { label: "Advertencia",   cls: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30", dot: "bg-yellow-400" },
  started:      { label: "Iniciado",      cls: "bg-blue-500/15 text-blue-400 border-blue-500/30",      dot: "bg-blue-400" },
}

function getOutcome(log: any): string {
  const outcome = log.details?.outcome as string | undefined
  if (outcome) return outcome
  if (log.result === "error") return "error"
  if (log.result === "success") return "success"
  return "success"
}

function getBatchDetail(details: any): string | null {
  if (!details) return null
  const parts: string[] = []
  if (details.sent      != null) parts.push(`${details.sent} enviados`)
  if (details.errors    != null && details.errors > 0) parts.push(`${details.errors} errores`)
  if (details.leads_found != null) parts.push(`${details.leads_found} leads`)
  if (details.pages_scraped != null) parts.push(`${details.pages_scraped} págs`)
  if (details.cta_type === "quick-connect") parts.push("sin nota")
  if (details.cta_type === "connect")       parts.push("con nota")
  if (parts.length) return parts.join(" · ")
  if (details.skip_reason) return `Motivo: ${details.skip_reason}`
  return null
}

// ── Row background tint ───────────────────────────────────────────────────────
function rowBg(outcome: string) {
  if (["error", "inbox_scrape_failed"].includes(outcome)) return "bg-red-500/5"
  if (["sent"].includes(outcome)) return "bg-green-500/5"
  if (["dry_run", "skipped", "disqualified"].includes(outcome)) return "bg-yellow-500/5"
  return ""
}

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; action?: string; date?: string }>
}) {
  const sp      = await searchParams
  const supabase = await createClient()
  const admin   = createAdminClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single()
  const role = profile?.role ?? "viewer"

  const page      = parseInt(sp.page ?? "1")
  const PAGE_SIZE = 100

  // Date filter — default to today (Mexico City)
  const mxNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Mexico_City" }))
  const todayStr  = mxNow.toISOString().slice(0, 10)
  const dateFilter = sp.date ?? todayStr

  const dayStart = new Date(dateFilter + "T00:00:00-06:00").toISOString()
  const dayEnd   = new Date(dateFilter + "T23:59:59-06:00").toISOString()

  let query = admin
    .from("activity_log")
    .select("*, leads(full_name, linkedin_url), linkedin_accounts(label)")
    .order("created_at", { ascending: false })
    .gte("created_at", dayStart)
    .lte("created_at", dayEnd)

  // Role filter: non-admins only see their own account's activity
  if (!["god_admin", "admin"].includes(role)) {
    const { data: acct } = await admin
      .from("linkedin_accounts")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle()
    if (acct) query = query.eq("linkedin_account_id", acct.id)
  }

  if (sp.action) query = query.eq("action", sp.action)

  query = query.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)

  const { data: logs } = await query

  // ── Daily summary ─────────────────────────────────────────────────────────
  const summary = (logs ?? []).reduce(
    (acc: any, log: any) => {
      const outcome = getOutcome(log)
      if (outcome === "sent")  acc.sent++
      if (outcome === "error") acc.errors++
      if (outcome === "dry_run" || outcome === "skipped") acc.skipped++
      if (log.action === "batch_completed" && log.result === "success") acc.batches++
      return acc
    },
    { sent: 0, skipped: 0, errors: 0, batches: 0 }
  )

  const ACTIONS = [
    "batch_process", "batch_completed", "invite_sent",
    "search_completed", "followup_sent", "inbox_scrape_failed",
  ]

  // Build date options: today + last 6 days
  const dateOptions = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(mxNow)
    d.setDate(d.getDate() - i)
    return d.toISOString().slice(0, 10)
  })

  return (
    <div className="p-6 max-w-7xl space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-50">Monitor de actividad</h1>
          <p className="text-gray-400 text-sm mt-0.5">Operaciones del worker en tiempo real</p>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-green-500/10 border border-green-500/25 rounded-xl px-4 py-3 flex items-center gap-3">
          <span className="text-2xl">🟢</span>
          <div>
            <p className="text-green-400 text-2xl font-bold leading-none">{summary.sent}</p>
            <p className="text-green-300/70 text-xs mt-0.5">Enviados</p>
          </div>
        </div>
        <div className="bg-yellow-500/10 border border-yellow-500/25 rounded-xl px-4 py-3 flex items-center gap-3">
          <span className="text-2xl">🟡</span>
          <div>
            <p className="text-yellow-400 text-2xl font-bold leading-none">{summary.skipped}</p>
            <p className="text-yellow-300/70 text-xs mt-0.5">Omitidos</p>
          </div>
        </div>
        <div className="bg-red-500/10 border border-red-500/25 rounded-xl px-4 py-3 flex items-center gap-3">
          <span className="text-2xl">🔴</span>
          <div>
            <p className="text-red-400 text-2xl font-bold leading-none">{summary.errors}</p>
            <p className="text-red-300/70 text-xs mt-0.5">Errores</p>
          </div>
        </div>
        <div className="bg-blue-500/10 border border-blue-500/25 rounded-xl px-4 py-3 flex items-center gap-3">
          <span className="text-2xl">📦</span>
          <div>
            <p className="text-blue-400 text-2xl font-bold leading-none">{summary.batches}</p>
            <p className="text-blue-300/70 text-xs mt-0.5">Lotes</p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <form method="GET" className="flex flex-wrap gap-3 items-center">
        {/* Date picker */}
        <select
          name="date"
          defaultValue={dateFilter}
          className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {dateOptions.map(d => (
            <option key={d} value={d}>
              {d === todayStr ? `Hoy (${d})` : d}
            </option>
          ))}
        </select>

        <select
          name="action"
          defaultValue={sp.action ?? ""}
          className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">Todas las acciones</option>
          {ACTIONS.map(a => (
            <option key={a} value={a}>{ACTION_LABEL[a]?.label ?? a}</option>
          ))}
        </select>

        <button
          type="submit"
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          Filtrar
        </button>
        {(sp.action || sp.date) && (
          <Link
            href="/dashboard/activity"
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm rounded-lg transition-colors"
          >
            Hoy
          </Link>
        )}
      </form>

      {/* Log table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 bg-gray-900/80">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Estado</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Acción</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Lead</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Detalle</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Hora</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider">Duración</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/60">
              {!logs || logs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-gray-500">
                    <p className="text-2xl mb-2">📭</p>
                    Sin actividad registrada para este día.
                  </td>
                </tr>
              ) : logs.map((log: any) => {
                const outcome     = getOutcome(log)
                const style       = OUTCOME_STYLE[outcome] ?? OUTCOME_STYLE["success"]
                const actionMeta  = ACTION_LABEL[log.action] ?? { label: log.action, icon: "•" }
                const detail      = getBatchDetail(log.details)
                const bg          = rowBg(outcome)
                const timeStr     = new Date(log.created_at).toLocaleString("es-MX", {
                  hour: "2-digit", minute: "2-digit", second: "2-digit",
                })

                return (
                  <tr key={log.id} className={`hover:bg-gray-800/50 transition-colors ${bg}`}>
                    {/* Status badge */}
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-xs font-medium ${style.cls}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
                        {style.label}
                      </span>
                    </td>

                    {/* Action */}
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className="text-gray-300 text-xs">
                        {actionMeta.icon}{" "}
                        <span className="text-gray-200 font-medium">{actionMeta.label}</span>
                      </span>
                      {log.linkedin_accounts?.label && (
                        <p className="text-gray-600 text-xs mt-0.5">{log.linkedin_accounts.label}</p>
                      )}
                    </td>

                    {/* Lead */}
                    <td className="px-4 py-2.5">
                      {log.leads ? (
                        <Link
                          href={`/dashboard/leads/${log.lead_id}`}
                          className="text-blue-400 hover:text-blue-300 hover:underline text-xs transition-colors"
                        >
                          {log.leads.full_name}
                        </Link>
                      ) : (
                        <span className="text-gray-600 text-xs">—</span>
                      )}
                    </td>

                    {/* Detail */}
                    <td className="px-4 py-2.5 max-w-xs">
                      {detail ? (
                        <span className="text-gray-400 text-xs">{detail}</span>
                      ) : (
                        <span className="text-gray-700 text-xs">—</span>
                      )}
                    </td>

                    {/* Time */}
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className="text-gray-500 text-xs font-mono">{timeStr}</span>
                    </td>

                    {/* Duration */}
                    <td className="px-4 py-2.5 text-right">
                      {log.duration_ms ? (
                        <span className={`text-xs font-mono ${log.duration_ms > 60000 ? "text-yellow-500" : "text-gray-500"}`}>
                          {log.duration_ms >= 60000
                            ? `${(log.duration_ms / 60000).toFixed(1)}m`
                            : `${(log.duration_ms / 1000).toFixed(1)}s`}
                        </span>
                      ) : (
                        <span className="text-gray-700 text-xs">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {(page > 1 || (logs && logs.length === PAGE_SIZE)) && (
        <div className="flex gap-2">
          {page > 1 && (
            <Link
              href={`?page=${page - 1}&action=${sp.action ?? ""}&date=${dateFilter}`}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg text-sm transition-colors"
            >
              ← Anterior
            </Link>
          )}
          {logs && logs.length === PAGE_SIZE && (
            <Link
              href={`?page=${page + 1}&action=${sp.action ?? ""}&date=${dateFilter}`}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg text-sm transition-colors"
            >
              Siguiente →
            </Link>
          )}
        </div>
      )}
    </div>
  )
}
