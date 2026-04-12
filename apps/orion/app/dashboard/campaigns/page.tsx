import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { redirect } from "next/navigation"
import Link from "next/link"
// Note: createAdminClient is kept for server actions (write ops that need to bypass RLS)

// ── Server Actions ─────────────────────────────────────────────────────────────

async function togglePause(formData: FormData) {
  "use server"
  const supabase = createAdminClient()
  const id = formData.get("campaign_id") as string
  const current = formData.get("batch_paused") === "true"
  await supabase.from("campaigns").update({ batch_paused: !current }).eq("id", id)
  redirect("/dashboard/campaigns")
}

async function updateSchedulerSettings(formData: FormData) {
  "use server"
  const supabase = createAdminClient()
  const id = formData.get("campaign_id") as string
  await supabase.from("campaigns").update({
    daily_invite_target:    Number(formData.get("daily_invite_target")),
    min_batch_gap_min:      Number(formData.get("min_batch_gap_min")),
    min_pending_threshold:  Number(formData.get("min_pending_threshold")),
  }).eq("id", id)
  redirect("/dashboard/campaigns")
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function CampaignsPage() {
  const supabase = await createClient()

  const { data } = await supabase
    .from("v_campaign_stats")
    .select("*")
    .order("created_at", { ascending: false })

  const campaigns = (data ?? []) as any[]

  // Fetch latest scheduler log per campaign (RLS filters to user's own campaigns)
  const { data: logs } = await supabase
    .from("scheduler_log")
    .select("campaign_id, job_type, status, skip_reason, leads_sent, leads_found, created_at")
    .order("created_at", { ascending: false })
    .limit(200)

  // Group last 3 logs per campaign
  const logMap: Record<string, any[]> = {}
  for (const log of logs ?? []) {
    const cid = log.campaign_id
    if (!cid) continue
    if (!logMap[cid]) logMap[cid] = []
    if (logMap[cid].length < 3) logMap[cid].push(log)
  }

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Campañas</h1>
          <p className="text-gray-400 text-sm mt-0.5">{campaigns.length} campañas</p>
        </div>
        <Link
          href="/dashboard/campaigns/new"
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          + Nueva campaña
        </Link>
      </div>

      <div className="space-y-4">
        {campaigns.length === 0 && (
          <div className="text-center py-16 text-gray-500">
            No hay campañas.{" "}
            <Link href="/dashboard/campaigns/new" className="text-blue-400 hover:underline">
              Crea la primera.
            </Link>
          </div>
        )}

        {campaigns.map((c) => {
          const paused = c.batch_paused === true
          const campaignLogs = logMap[c.campaign_id] ?? []

          return (
            <div key={c.campaign_id} className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
              {/* Header */}
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <span className={`w-2.5 h-2.5 rounded-full mt-1 shrink-0 ${
                    !c.is_active ? "bg-gray-600" :
                    paused       ? "bg-yellow-400" :
                                   "bg-green-400"
                  }`} />
                  <div>
                    <h2 className="text-white font-semibold">{c.campaign_name}</h2>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${
                        c.account_status === "active"       ? "bg-green-500/15 text-green-400" :
                        c.account_status === "rate_limited" ? "bg-yellow-500/15 text-yellow-400" :
                        c.account_status === "banned"       ? "bg-red-500/15 text-red-400" :
                                                              "bg-gray-500/15 text-gray-400"
                      }`}>
                        {c.account_label ?? c.account_profile_url?.replace("https://www.linkedin.com/in/", "") ?? "Sin cuenta"}
                      </span>
                      {c.account_status && (
                        <span className="text-xs text-gray-500">{c.account_status}</span>
                      )}
                      {paused && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400 border border-yellow-500/30">
                          ⏸ batch pausado
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex gap-2 shrink-0">
                  {/* Pause / Resume */}
                  <form action={togglePause}>
                    <input type="hidden" name="campaign_id" value={c.campaign_id} />
                    <input type="hidden" name="batch_paused" value={String(paused)} />
                    <button
                      type="submit"
                      className={`px-3 py-1.5 text-xs rounded-lg transition-colors font-medium ${
                        paused
                          ? "bg-green-600/20 hover:bg-green-600/40 text-green-400 border border-green-500/30"
                          : "bg-yellow-600/20 hover:bg-yellow-600/40 text-yellow-400 border border-yellow-500/30"
                      }`}
                    >
                      {paused ? "▶ Reanudar" : "⏸ Pausar"}
                    </button>
                  </form>
                  <Link
                    href={`/dashboard/leads?campaign=${c.campaign_id}`}
                    className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs rounded-lg transition-colors"
                  >
                    Ver leads
                  </Link>
                  <Link
                    href={`/dashboard/campaigns/${c.campaign_id}/edit`}
                    className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs rounded-lg transition-colors"
                  >
                    Editar
                  </Link>
                </div>
              </div>

              {/* Funnel stats */}
              <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
                {[
                  { label: "Total",      value: c.total_leads  ?? 0, color: "text-gray-300" },
                  { label: "En cola",    value: c.in_queue     ?? 0, color: "text-gray-400" },
                  { label: "Descal.",    value: c.disqualified ?? 0, color: "text-red-400"  },
                  { label: "Invitados",  value: c.invited      ?? 0, color: "text-blue-400" },
                  { label: "Conectados", value: c.connected    ?? 0, color: "text-green-400"},
                  { label: "Mensajes",   value: c.messaged     ?? 0, color: "text-purple-400"},
                  { label: "Replies",    value: c.replied      ?? 0, color: "text-orange-400"},
                  { label: "Reuniones",  value: c.meetings     ?? 0, color: "text-yellow-400"},
                ].map(({ label, value, color }) => (
                  <div key={label} className="bg-gray-800/60 rounded-lg py-2 px-2 text-center">
                    <div className={`text-xl font-bold ${color}`}>{value}</div>
                    <div className="text-gray-500 text-xs mt-0.5">{label}</div>
                  </div>
                ))}
              </div>

              {/* Rates + timestamps */}
              <div className="flex flex-wrap gap-x-6 gap-y-1 pt-2 border-t border-gray-800 text-xs text-gray-400">
                <span>Inv. rate: <span className="text-white font-medium">{c.invite_rate_pct ?? 0}%</span></span>
                <span>Acceptance: <span className="text-white font-medium">{c.acceptance_rate_pct ?? 0}%</span></span>
                {c.last_sent_at && (
                  <span>Último envío: <span className="text-white">{new Date(c.last_sent_at).toLocaleString("es-MX")}</span></span>
                )}
                {c.last_batch_at && (
                  <span>Último batch: <span className="text-white">{new Date(c.last_batch_at).toLocaleString("es-MX")}</span></span>
                )}
                {c.last_searched_at && (
                  <span>Último search: <span className="text-white">{new Date(c.last_searched_at).toLocaleString("es-MX")}</span></span>
                )}
              </div>

              {/* Scheduler settings + log */}
              <details className="group">
                <summary className="text-xs text-gray-500 hover:text-gray-300 cursor-pointer list-none flex items-center gap-1 select-none">
                  <span className="group-open:rotate-90 transition-transform inline-block">▶</span>
                  Configuración scheduler
                  <span className="ml-2 text-gray-600">
                    {c.daily_invite_target} inv/día · gap {c.min_batch_gap_min}min · umbral {c.min_pending_threshold}
                  </span>
                </summary>

                <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Settings form */}
                  <form action={updateSchedulerSettings} className="bg-gray-800/50 rounded-xl p-4 space-y-3">
                    <input type="hidden" name="campaign_id" value={c.campaign_id} />
                    <p className="text-xs text-gray-400 font-medium uppercase tracking-wider mb-2">Parámetros anti-ban</p>
                    <div className="grid grid-cols-3 gap-3">
                      <div className="space-y-1">
                        <label className="block text-xs text-gray-500">Inv/día</label>
                        <input
                          name="daily_invite_target"
                          type="number" min="1" max="20"
                          defaultValue={c.daily_invite_target ?? 8}
                          className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="block text-xs text-gray-500">Gap (min)</label>
                        <input
                          name="min_batch_gap_min"
                          type="number" min="30" max="480"
                          defaultValue={c.min_batch_gap_min ?? 120}
                          className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="block text-xs text-gray-500">Umbral cola</label>
                        <input
                          name="min_pending_threshold"
                          type="number" min="5" max="100"
                          defaultValue={c.min_pending_threshold ?? 15}
                          className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                    </div>
                    <button
                      type="submit"
                      className="w-full py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-colors"
                    >
                      Guardar
                    </button>
                  </form>

                  {/* Scheduler log */}
                  <div className="bg-gray-800/50 rounded-xl p-4">
                    <p className="text-xs text-gray-400 font-medium uppercase tracking-wider mb-2">Log reciente</p>
                    {campaignLogs.length === 0 ? (
                      <p className="text-xs text-gray-600 italic">Sin actividad registrada</p>
                    ) : (
                      <ul className="space-y-2">
                        {campaignLogs.map((log, i) => (
                          <li key={i} className="flex items-start gap-2 text-xs">
                            <span className={`mt-0.5 shrink-0 w-1.5 h-1.5 rounded-full ${
                              log.job_type === "batch"  ? "bg-blue-400" :
                              log.job_type === "search" ? "bg-purple-400" :
                              log.status   === "skipped" ? "bg-gray-600" :
                              "bg-gray-500"
                            }`} />
                            <div>
                              <span className="text-gray-300">{log.job_type}</span>
                              <span className={`ml-1 ${log.status === "ok" ? "text-green-500" : "text-yellow-500"}`}>
                                {log.status}
                              </span>
                              {log.skip_reason && <span className="text-gray-500 ml-1">— {log.skip_reason}</span>}
                              {log.leads_sent != null && log.leads_sent > 0 && (
                                <span className="text-blue-400 ml-1">· {log.leads_sent} enviados</span>
                              )}
                              <div className="text-gray-600">{new Date(log.created_at!).toLocaleString("es-MX")}</div>
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
