"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"

type OracleResponse = {
  lead: any
  timeline: { events: any[]; commands: any[]; audit: any[] }
  smart_sync: { kind: string; reason: string; update?: any; new_status?: string }
  scheduler_decision: {
    next_action: string; will_run: boolean; reason: string; recommendation: string | null
  }
  diff: { success_cmd: any; fail_cmd: any }
}

export function LeadDrawer({
  leadId, isAdmin, onClose,
}: { leadId: string; isAdmin: boolean; onClose: () => void }) {
  const router = useRouter()
  const [data, setData] = useState<OracleResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const r = await fetch(`/api/crm/lead/${leadId}/oracle`, { cache: "no-store" })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = await r.json()
      setData(j)
      setError(null)
    } catch (err: any) {
      setError(err?.message ?? "load failed")
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [leadId])

  // Keyboard: Esc cierra
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const action = async (endpoint: string, body?: any, opts?: { allowOwner?: boolean }) => {
    // allowOwner: acciones no-destructivas (ej. pausar automatización) que el dueño
    // de la cuenta puede ejecutar sobre SUS contactos. La API valida el ownership.
    if (!isAdmin && !opts?.allowOwner) return alert("Solo admin puede ejecutar esta acción")
    if (acting) return
    setActing(true)
    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error ?? "action failed")
      await load()
      router.refresh()
    } catch (err: any) {
      alert(`Error: ${err?.message}`)
    } finally {
      setActing(false)
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-40" onClick={onClose} />
      <aside className="fixed right-0 top-0 bottom-0 w-full md:w-[55%] lg:w-[50%] bg-gray-950 border-l border-gray-800 z-50 overflow-y-auto">
        <header className="sticky top-0 bg-gray-950 border-b border-gray-800 px-5 py-3 flex items-center justify-between z-10">
          <div>
            <h2 className="font-bold text-lg flex items-center gap-2">
              {data?.lead?.full_name ?? "Cargando…"}
              {data?.lead?.automation_paused && (
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40">
                  ⏸️ AUTOMATIZACIÓN PAUSADA
                </span>
              )}
            </h2>
            {data?.lead && (
              <div className="text-xs text-gray-400 mt-0.5">
                {data.lead.status} · {data.lead.account_label} · {data.lead.campaign_name}
              </div>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-100 text-xl px-2">✕</button>
        </header>

        {loading && <div className="p-8 text-center text-gray-500">Cargando oracle…</div>}
        {error && <div className="p-5 text-red-400">Error: {error}</div>}

        {data && (
          <div className="p-5 space-y-5">
            {/* 1. SCHEDULER DECISION CARD */}
            <section className="bg-gray-900 border border-gray-800 rounded-lg p-4">
              <div className="text-xs uppercase text-gray-500 mb-2">Decisión actual del scheduler</div>
              <div className="text-sm">
                <span className="text-gray-300">Próximo paso esperable:</span>{" "}
                <span className="font-semibold">{data.scheduler_decision.next_action}</span>
              </div>
              <div className="text-sm mt-1">
                <span className="text-gray-300">¿Se ejecutará?</span>{" "}
                <span className={data.scheduler_decision.will_run ? "text-green-400" : "text-red-400"}>
                  {data.scheduler_decision.will_run ? "SÍ" : "NO"}
                </span>
              </div>
              <div className="text-sm mt-1 text-gray-400">
                <span className="text-gray-300">Razón:</span> {data.scheduler_decision.reason}
              </div>
              {data.scheduler_decision.recommendation && (
                <div className="mt-2 text-sm text-amber-300">
                  💡 {data.scheduler_decision.recommendation}
                </div>
              )}
            </section>

            {/* 2. SMART SYNC CARD */}
            {data.smart_sync.kind !== "noop" && (
              <section className="bg-purple-900/20 border border-purple-700 rounded-lg p-4">
                <div className="text-xs uppercase text-purple-400 mb-2">Smart sync detectó</div>
                <div className="text-sm font-semibold text-purple-200">
                  {data.smart_sync.kind === "mark_replied" ? "Marcar como replied" :
                   data.smart_sync.kind === "advance_followup" ? `Avanzar a ${data.smart_sync.new_status}` :
                   data.smart_sync.kind}
                </div>
                <div className="text-xs text-gray-400 mt-1">{data.smart_sync.reason}</div>
                {isAdmin && (
                  <button
                    disabled={acting}
                    onClick={() => action(`/api/crm/lead/${leadId}/smart-sync`)}
                    className="mt-3 px-3 py-1.5 bg-purple-700 hover:bg-purple-600 rounded text-sm disabled:opacity-50"
                  >
                    {acting ? "Aplicando…" : "Aplicar smart-sync"}
                  </button>
                )}
              </section>
            )}

            {/* 3. KEY METRICS */}
            <section className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <Metric label="Outbound" value={data.lead.outbound_count} cls="text-cyan-400" />
              <Metric label="Inbound" value={data.lead.inbound_count} cls="text-green-400" />
              <Metric label="Failures 7d" value={data.lead.recent_error_count_7d} cls={data.lead.recent_error_count_7d >= 5 ? "text-red-400" : "text-gray-400"} />
              <Metric label="Skip count" value={data.lead.lockout_skip_count ?? 0} cls={data.lead.lockout_skip_count > 0 ? "text-orange-400" : "text-gray-400"} />
            </section>

            {/* 4. ACTIONS */}
            <section className="flex flex-wrap gap-2">
              {/* Pausar/Reanudar automatización — disponible para el DUEÑO de la cuenta
                  (no solo admin). La API (authorize "user" + ownership) valida que solo
                  pueda tocar SUS propios contactos. */}
              <ActionBtn
                onClick={() => action(`/api/crm/lead/${leadId}/toggle-automation`, undefined, { allowOwner: true })}
                disabled={acting}
                cls={data.lead.automation_paused ? "bg-green-800 hover:bg-green-700" : "bg-amber-800 hover:bg-amber-700"}>
                {data.lead.automation_paused ? "▶️ Reanudar automatización" : "⏸️ Pausar automatización"}
              </ActionBtn>
              {data.lead.linkedin_url && (
                <a href={data.lead.linkedin_url} target="_blank" rel="noopener noreferrer"
                  className="px-3 py-1.5 bg-blue-800 hover:bg-blue-700 rounded text-xs">↗ LinkedIn</a>
              )}
              {/* Acciones destructivas — solo admin */}
              {isAdmin && (
                <>
                  <ActionBtn onClick={() => action(`/api/crm/lead/${leadId}/reset-skip`)} disabled={acting}
                    cls="bg-orange-800 hover:bg-orange-700">Reset skip</ActionBtn>
                  <ActionBtn onClick={() => action(`/api/crm/lead/${leadId}/mark-replied`)} disabled={acting}
                    cls="bg-green-800 hover:bg-green-700">Mark replied</ActionBtn>
                  <ActionBtn onClick={() => {
                    const reason = prompt("Razón para mark dead?")
                    if (reason) action(`/api/crm/lead/${leadId}/mark-dead`, { dead_reason: reason })
                  }} disabled={acting} cls="bg-red-800 hover:bg-red-700">Mark dead</ActionBtn>
                </>
              )}
            </section>

            {/* 5. DIFF SUCCESS vs FAIL */}
            {(data.diff.success_cmd || data.diff.fail_cmd) && (
              <section>
                <div className="text-xs uppercase text-gray-500 mb-2">Diff último éxito vs fallo</div>
                <div className="grid md:grid-cols-2 gap-3">
                  <DiffCard label="✓ Éxito" cmd={data.diff.success_cmd} ok />
                  <DiffCard label="✗ Fallo" cmd={data.diff.fail_cmd} />
                </div>
              </section>
            )}

            {/* 6. TIMELINE UNIFICADO */}
            <section>
              <div className="text-xs uppercase text-gray-500 mb-2">Timeline cronológico</div>
              <div className="space-y-1 max-h-96 overflow-y-auto pr-2 text-xs font-mono">
                {mergeTimeline(data.timeline).slice(0, 60).map((item, i) => (
                  <TimelineItem key={i} item={item} />
                ))}
              </div>
            </section>

            {/* 7. AUDIT LOG con undo */}
            {data.timeline.audit.length > 0 && (
              <section>
                <div className="text-xs uppercase text-gray-500 mb-2">Audit log (acciones CRM)</div>
                <div className="space-y-1 text-xs">
                  {data.timeline.audit.slice(0, 10).map(a => (
                    <div key={a.id} className="bg-gray-900 border border-gray-800 rounded p-2 flex justify-between items-center">
                      <div>
                        <span className="text-purple-400 font-mono">{a.action}</span>
                        <span className="text-gray-500 ml-2">{a.actor_email ?? "system"}</span>
                        <span className="text-gray-500 ml-2">{new Date(a.created_at).toLocaleString("es-MX", { timeZone: "America/Mexico_City" })}</span>
                      </div>
                      {isAdmin && !a.reverted_at && (
                        <button onClick={() => action(`/api/crm/lead/${leadId}/undo`, { audit_id: a.id })}
                          disabled={acting} className="text-gray-400 hover:text-amber-400 text-xs">↶ undo</button>
                      )}
                      {a.reverted_at && <span className="text-gray-600 text-[10px]">revertido</span>}
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </aside>
    </>
  )
}

function Metric({ label, value, cls }: { label: string; value: any; cls: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded p-2">
      <div className="text-[10px] uppercase text-gray-500">{label}</div>
      <div className={`text-xl font-bold tabular-nums ${cls}`}>{value}</div>
    </div>
  )
}

function ActionBtn({ children, onClick, disabled, cls }: any) {
  return (
    <button onClick={onClick} disabled={disabled} className={`px-3 py-1.5 rounded text-xs disabled:opacity-50 ${cls}`}>{children}</button>
  )
}

function DiffCard({ label, cmd, ok }: any) {
  if (!cmd) return <div className="bg-gray-900 border border-gray-800 rounded p-2 text-xs text-gray-500">{label}: ninguno</div>
  return (
    <div className={`bg-gray-900 border rounded p-2 text-xs ${ok ? "border-emerald-800" : "border-red-800"}`}>
      <div className="font-semibold mb-1">{label}</div>
      <div className="text-gray-400">phase: <span className="text-gray-200">{cmd.current_phase ?? "—"}</span></div>
      <div className="text-gray-400">result: <span className="text-gray-200">{(cmd.result as any)?.status ?? "—"}</span></div>
      {cmd.error && <div className="text-red-400 mt-1 truncate" title={cmd.error}>err: {cmd.error}</div>}
      <div className="text-gray-500 mt-1">{new Date(cmd.created_at).toLocaleString("es-MX", { timeZone: "America/Mexico_City" })}</div>
    </div>
  )
}

function mergeTimeline(tl: { events: any[]; commands: any[]; audit: any[] }) {
  type Item = { ts: string; kind: string; source: string; data: any }
  const items: Item[] = []
  for (const e of tl.events) items.push({ ts: e.sent_at, kind: e.event_type, source: "event", data: e })
  for (const c of tl.commands) items.push({ ts: c.created_at, kind: c.action, source: "cmd", data: c })
  for (const a of tl.audit) items.push({ ts: a.created_at, kind: a.action, source: "audit", data: a })
  return items.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
}

function TimelineItem({ item }: { item: any }) {
  const t = new Date(item.ts).toLocaleString("es-MX", { timeZone: "America/Mexico_City", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
  const colors = { event: "text-cyan-400", cmd: "text-purple-400", audit: "text-amber-400" } as any
  const icons = { event: "💬", cmd: "📤", audit: "📝" } as any
  return (
    <div className="flex gap-2 py-0.5">
      <span className="text-gray-600 w-24 shrink-0">{t}</span>
      <span>{icons[item.source]}</span>
      <span className={`${colors[item.source]} font-semibold shrink-0`}>{item.kind}</span>
      <span className="text-gray-400 truncate">
        {item.source === "event" && item.data.content?.slice(0, 80)}
        {item.source === "cmd" && (
          <>
            <span className="text-gray-500">phase=</span>{item.data.current_phase ?? "—"}
            {item.data.status === "error" && <span className="text-red-400 ml-2">err:{item.data.error?.slice(0, 40)}</span>}
            {(item.data.result as any)?.status === "sent_confirmed" && <span className="text-green-400 ml-2">✓ confirmed</span>}
          </>
        )}
        {item.source === "audit" && (
          <span className="text-amber-300">by {item.data.actor_email ?? "system"}{item.data.reason ? ` · ${item.data.reason}` : ""}</span>
        )}
      </span>
    </div>
  )
}
