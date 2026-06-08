"use client"

import { useState } from "react"
import Link from "next/link"
import { ErrorClassBadge } from "@/components/ui/error-class-badge"

type PhaseEntry = { name?: string; ts?: number; elapsed?: number; state?: string; extra?: any }
type CommandTimeline = {
  id: string
  action: string
  status: string | null
  error: string | null
  created_at: string
  micro_phase_log: PhaseEntry[] | null
}

type Insight = {
  id: number
  detected_at: string
  category: string
  severity: string
  phase_name: string | null
  account_id: string | null
  metric_value: number | null
  window_hours: number | null
  sample_size: number | null
  message: string
  recommended_action: string | null
  auto_applied: boolean | null
  acknowledged: boolean
  applied_value: any
  rollback_value: any
  details: any
}

type Ticket = { id: number; phase_name: string; status: string; created_at: string }
type LearnedSelector = {
  id: number
  label: string
  phase_name: string | null
  selector: string
  hit_count: number
  miss_count: number
  enabled: boolean
  priority: number
}
type RuntimeConfig = { key: string; value: any; updated_at: string; updated_by: string; reason: string | null }

const SEVERITY_COLORS: Record<string, string> = {
  critical: "border-red-600 bg-red-950/40 text-red-200",
  warning: "border-amber-500 bg-amber-950/40 text-amber-200",
  info: "border-blue-500 bg-blue-950/40 text-blue-200",
}
const CATEGORY_ICONS: Record<string, string> = {
  low_send_success: "📉",
  selector_drift: "🧭",
  latency_drift: "🐢",
  send_method_shift: "🔄",
  lead_stuck: "🚧",
  timeout_too_tight: "⏱️",
  selector_suggestion: "💡",
  send_method_auto_reorder: "🎯",
  page_error_auto_classify: "🏷️",
}

export function AutoLearningClient({
  insights,
  tickets,
  learnedSelectors,
  runtimeConfig,
  timelines = [],
}: {
  insights: Insight[]
  tickets: Ticket[]
  learnedSelectors: LearnedSelector[]
  runtimeConfig: RuntimeConfig[]
  timelines?: CommandTimeline[]
}) {
  const [tab, setTab] = useState<"insights" | "learned" | "config" | "tickets" | "timeline">("insights")
  const [filterSeverity, setFilterSeverity] = useState<string>("all")
  const [showAcked, setShowAcked] = useState(false)
  const [msg, setMsg] = useState("")

  const visibleInsights = insights.filter(i => {
    if (!showAcked && i.acknowledged) return false
    if (filterSeverity !== "all" && i.severity !== filterSeverity) return false
    return true
  })

  const ackInsight = async (id: number) => {
    setMsg("Acknowledging...")
    const r = await fetch("/api/dashboard/phase-analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ insightId: id, by: "dashboard" }),
    })
    if (r.ok) {
      setMsg(`✅ Acked #${id}`)
      setTimeout(() => location.reload(), 500)
    } else {
      setMsg(`❌ Error`)
    }
  }

  const ackAllNoise = async () => {
    if (!confirm(`Acknowledge ${visibleInsights.length} insights visibles? Sólo recomienda para limpiar noise — revisar antes.`)) return
    setMsg("Ack en bulk...")
    for (const i of visibleInsights) {
      await fetch("/api/dashboard/phase-analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ insightId: i.id, by: "dashboard_bulk" }),
      })
    }
    location.reload()
  }

  const unacked = insights.filter(i => !i.acknowledged).length
  const critical = insights.filter(i => !i.acknowledged && i.severity === "critical").length

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-100">🧬 Auto-Learning</h1>
          <p className="text-sm text-gray-400 mt-1">
            Insights detectados por el phase-analyzer (cron 1h). Selectores aprendidos. Config dinámico aplicado.
          </p>
        </div>
        <div className="flex gap-2 text-sm">
          <div className="px-3 py-2 bg-gray-800 rounded">
            <div className="text-gray-400 text-xs">Pendientes</div>
            <div className="text-xl font-bold text-amber-400">{unacked}</div>
          </div>
          <div className="px-3 py-2 bg-gray-800 rounded">
            <div className="text-gray-400 text-xs">Críticos</div>
            <div className="text-xl font-bold text-red-400">{critical}</div>
          </div>
          <div className="px-3 py-2 bg-gray-800 rounded">
            <div className="text-gray-400 text-xs">Tickets visuales</div>
            <div className="text-xl font-bold text-purple-400">
              {tickets.filter(t => t.status === "open").length}
            </div>
          </div>
          <div className="px-3 py-2 bg-gray-800 rounded">
            <div className="text-gray-400 text-xs">Selectores activos</div>
            <div className="text-xl font-bold text-green-400">
              {learnedSelectors.filter(s => s.enabled).length}
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-4 border-b border-gray-700">
        {(["insights", "learned", "config", "tickets", "timeline"] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              tab === t
                ? "text-blue-400 border-b-2 border-blue-400"
                : "text-gray-400 hover:text-gray-200"
            }`}
          >
            {t === "insights" && `📊 Insights (${unacked})`}
            {t === "learned" && `🎯 Selectores aprendidos (${learnedSelectors.length})`}
            {t === "config" && `⚙️ Runtime Config (${runtimeConfig.length})`}
            {t === "tickets" && `🖼️ Tickets visuales (${tickets.length})`}
            {t === "timeline" && `⏱️ Timeline FSM (${timelines.length})`}
          </button>
        ))}
      </div>

      {/* Insights tab */}
      {tab === "insights" && (
        <>
          <div className="flex gap-2 mb-4 items-center">
            <label className="text-sm text-gray-400">Severidad:</label>
            <select
              value={filterSeverity}
              onChange={e => setFilterSeverity(e.target.value)}
              className="bg-gray-800 text-sm px-2 py-1 rounded border border-gray-700"
            >
              <option value="all">Todas</option>
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
              <option value="info">Info</option>
            </select>
            <label className="text-sm text-gray-400 ml-4">
              <input
                type="checkbox"
                checked={showAcked}
                onChange={e => setShowAcked(e.target.checked)}
                className="mr-1"
              />
              Mostrar acknowledged
            </label>
            <button
              onClick={ackAllNoise}
              className="ml-auto px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs text-gray-200"
            >
              📭 Ack todos los visibles
            </button>
          </div>
          {msg && <div className="text-xs text-amber-300 mb-2">{msg}</div>}
          <div className="space-y-2">
            {visibleInsights.length === 0 && (
              <div className="text-center py-12 text-gray-500">
                ✨ Sin insights pendientes en este filtro.
              </div>
            )}
            {visibleInsights.map(i => (
              <div
                key={i.id}
                className={`border rounded-lg p-3 ${SEVERITY_COLORS[i.severity] ?? "border-gray-700"} ${
                  i.acknowledged ? "opacity-50" : ""
                }`}
              >
                <div className="flex items-start gap-3">
                  <span className="text-2xl">{CATEGORY_ICONS[i.category] ?? "📌"}</span>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs px-2 py-0.5 bg-black/30 rounded font-mono">
                        {i.category}
                      </span>
                      <span className="text-xs">{i.severity.toUpperCase()}</span>
                      {i.phase_name && (
                        <span className="text-xs px-2 py-0.5 bg-black/20 rounded">
                          {i.phase_name}
                        </span>
                      )}
                      {i.auto_applied && (
                        <span className="text-xs px-2 py-0.5 bg-green-700 text-green-100 rounded">
                          ✓ Auto-applied
                        </span>
                      )}
                      <span className="text-xs text-gray-500 ml-auto">
                        {new Date(i.detected_at).toLocaleString("es-MX")}
                      </span>
                    </div>
                    <p className="text-sm">{i.message}</p>
                    {i.recommended_action && (
                      <p className="text-xs mt-1 opacity-80">
                        <span className="font-semibold">💡 Acción:</span> {i.recommended_action}
                      </p>
                    )}
                    {i.applied_value && (
                      <p className="text-xs mt-1 opacity-70 font-mono">
                        Aplicado: {JSON.stringify(i.applied_value)}
                      </p>
                    )}
                    {(i.sample_size || i.metric_value) && (
                      <p className="text-xs mt-1 opacity-60">
                        {i.sample_size && `n=${i.sample_size} `}
                        {i.metric_value !== null && `metric=${Number(i.metric_value).toFixed(1)} `}
                        {i.window_hours && `(${i.window_hours}h window)`}
                      </p>
                    )}
                  </div>
                  {!i.acknowledged && (
                    <button
                      onClick={() => ackInsight(i.id)}
                      className="px-2 py-1 text-xs bg-blue-700 hover:bg-blue-600 rounded shrink-0"
                    >
                      ✓ Ack
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Learned selectors tab */}
      {tab === "learned" && (
        <div className="space-y-2">
          {learnedSelectors.length === 0 && (
            <div className="text-center py-12 text-gray-500">
              🎯 Sin selectores aprendidos aún. Cuando un selector falle 3× en 1h, se crea un ticket visual.
              Pinéalo y márcalo como "promover" → aparecerá aquí.
            </div>
          )}
          {learnedSelectors.map(s => {
            const total = s.hit_count + s.miss_count
            const hitRate = total > 0 ? (s.hit_count / total) * 100 : null
            return (
              <div key={s.id} className="border border-gray-700 rounded-lg p-3 bg-gray-800/50">
                <div className="flex items-start gap-3">
                  <span className={`text-xs px-2 py-0.5 rounded ${s.enabled ? "bg-green-800 text-green-200" : "bg-gray-700 text-gray-400"}`}>
                    {s.enabled ? "ACTIVO" : "DESACTIVADO"}
                  </span>
                  <div className="flex-1">
                    <div className="text-sm font-bold">{s.label}</div>
                    {s.phase_name && (
                      <div className="text-xs text-gray-400">phase: {s.phase_name}</div>
                    )}
                    <code className="text-xs text-amber-300 break-all block mt-1">
                      {s.selector}
                    </code>
                    {hitRate !== null && (
                      <div className="text-xs mt-1">
                        <span className={hitRate > 70 ? "text-green-400" : hitRate > 40 ? "text-amber-400" : "text-red-400"}>
                          Hit rate: {hitRate.toFixed(1)}% ({s.hit_count} hits / {s.miss_count} misses)
                        </span>
                        <span className="text-gray-500 ml-2">prio={s.priority}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Runtime config tab */}
      {tab === "config" && (
        <div className="space-y-2">
          {runtimeConfig.map(c => (
            <div key={c.key} className="border border-gray-700 rounded-lg p-3 bg-gray-800/50">
              <div className="flex items-center justify-between mb-2">
                <code className="text-sm font-bold text-cyan-300">{c.key}</code>
                <span className="text-xs text-gray-500">
                  por {c.updated_by} · {new Date(c.updated_at).toLocaleString("es-MX")}
                </span>
              </div>
              {c.reason && <p className="text-xs text-gray-400 italic mb-2">{c.reason}</p>}
              <pre className="text-xs bg-black/40 p-2 rounded overflow-x-auto">
                {JSON.stringify(c.value, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}

      {/* Tickets tab */}
      {tab === "tickets" && (
        <div>
          {tickets.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              🖼️ Sin tickets visuales. Se generan cuando una phase falla 3× en 1h.
            </div>
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              {tickets.map(t => (
                <Link
                  key={t.id}
                  href={`/dashboard/visual-tickets/${t.id}`}
                  className="block p-3 bg-gray-800 hover:bg-gray-700 rounded border border-gray-700"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs px-2 py-0.5 bg-orange-900/60 text-orange-200 rounded">
                      {t.phase_name}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      t.status === "open" ? "bg-purple-800 text-purple-100" : "bg-gray-700 text-gray-400"
                    }`}>
                      {t.status}
                    </span>
                  </div>
                  <div className="text-xs text-gray-400">#{t.id}</div>
                  <div className="text-xs text-gray-500 mt-1">
                    {new Date(t.created_at).toLocaleString("es-MX")}
                  </div>
                </Link>
              ))}
            </div>
          )}
          <Link
            href="/dashboard/visual-tickets"
            className="inline-block mt-4 text-sm text-blue-400 hover:underline"
          >
            → Ver todos los tickets visuales
          </Link>
        </div>
      )}

      {/* Timeline FSM tab — waterfall de micro_phase_log (los checkpoints instrumentados) */}
      {tab === "timeline" && (
        <div className="space-y-3">
          <p className="text-xs text-gray-400">
            Checkpoints FSM de comandos recientes. Muestra dónde se detiene cada comando y cuánto tarda cada paso (typing, send, confirm) — la misma traza usada para cazar el throttle de background.
          </p>
          {timelines.length === 0 ? (
            <div className="text-center py-12 text-gray-500">⏱️ Sin timelines recientes con micro_phase_log.</div>
          ) : (
            timelines.map((cmd) => {
              const log = Array.isArray(cmd.micro_phase_log) ? cmd.micro_phase_log : []
              const last = log.length ? (log[log.length - 1].elapsed ?? 0) : 0
              return (
                <div key={cmd.id} className="bg-gray-800/60 border border-gray-700 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-200">{cmd.action}</span>
                      <span className="text-xs text-gray-500 font-mono">{cmd.id.slice(0, 8)}</span>
                      <ErrorClassBadge error={cmd.error} status={cmd.status} />
                    </div>
                    <span className="text-xs text-gray-500">
                      {new Date(cmd.created_at).toLocaleString("es-MX")} · total {(last / 1000).toFixed(1)}s
                    </span>
                  </div>
                  <div className="space-y-1">
                    {log.map((e, i) => {
                      const prev = i > 0 ? (log[i - 1].elapsed ?? 0) : 0
                      const delta = (e.elapsed ?? 0) - prev
                      const pct = last > 0 ? Math.min(100, ((e.elapsed ?? 0) / last) * 100) : 0
                      const slow = delta > 8000
                      return (
                        <div key={i} className="flex items-center gap-2 text-[11px]">
                          <span className="w-48 truncate text-gray-300 font-mono">{e.name ?? "?"}</span>
                          <div className="flex-1 h-1.5 bg-gray-900 rounded overflow-hidden">
                            <div className="h-full rounded" style={{ width: `${pct}%`, backgroundColor: slow ? "#f97316" : "rgba(59,130,246,0.6)" }} />
                          </div>
                          <span className="w-14 text-right text-gray-400 tabular-nums">{((e.elapsed ?? 0) / 1000).toFixed(1)}s</span>
                          <span className={`w-14 text-right tabular-nums ${slow ? "text-orange-400" : "text-gray-600"}`}>{delta > 0 ? `+${(delta / 1000).toFixed(1)}s` : ""}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
